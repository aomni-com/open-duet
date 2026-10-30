import type { AgentActivity, SessionListPage } from '@repo/contract'

import { workConversationFiltersForAgent } from './work-destination'

export const WORK_CONVERSATION_PRESENCE_CONCURRENCY = 6

export type WorkConversationPresenceQuery = ReturnType<typeof workConversationFiltersForAgent> & {
  agentId: string
  limit: 1
}

export type WorkConversationPresence = {
  visibleOwnerIds: readonly string[]
  failedOwnerIds: readonly string[]
}

/**
 * The owners whose work has something the reader has not seen.
 *
 * Read off the activity poll rather than fetched: activity already answers for
 * every owner in one request, expanded or not, and every session it returns
 * carries its own `unread`. The sidebar collapses an owner's conversations
 * behind a single row, and a collapsed row that says nothing makes new work
 * invisible until the reader opens each owner in turn to look for it.
 *
 * Only `sessions` — the owner's own chat is a row of its own further up the
 * sidebar with a dot of its own, so counting it here would mark a group for a
 * conversation that group does not contain.
 *
 * One caveat this cannot fix from the client: activity returns an owner's work
 * whatever its lineage, while the group below lists only the top-level rows. So
 * a delegated child with something unread marks its owner, and expanding shows
 * no row for it — that conversation is reached through the run that spawned it.
 * The dot is honest about "this owner has something new" and imprecise about
 * where; making it exact needs the activity summary to say whether a session is
 * top-level.
 */
export function unreadWorkOwnerIds(owners: readonly AgentActivity[]): ReadonlySet<string> {
  return new Set(
    owners
      .filter(owner => owner.sessions.some(session => session.unread))
      .map(owner => owner.agentId),
  )
}

/**
 * Activity is the cheap workspace-wide prefilter. A default chat alone is not
 * a Work-sidebar conversation, while a truncated owner still needs checking
 * because the bounded activity response cannot prove what it omitted.
 */
export function candidateWorkConversationOwners(
  owners: readonly AgentActivity[],
): readonly AgentActivity[] {
  return owners.filter(owner => owner.sessions.length > 0 || owner.truncated)
}

/**
 * Stable evidence for the presence cache. The activity poll changes this only
 * when a candidate's bounded work changes, so an unchanged poll does not fan
 * out another request per owner.
 */
export function workConversationPresenceFingerprint(
  owners: readonly AgentActivity[],
): readonly string[] {
  return owners.map(
    owner =>
      `${owner.agentId}:${owner.truncated ? 'more' : 'all'}:${owner.sessions
        .map(session => `${session.id}@${session.updatedAt}`)
        .join(',')}`,
  )
}

/**
 * Confirm candidates against the same filtered collection the sidebar opens.
 * The small worker pool keeps a large agent roster from becoming an unbounded
 * browser burst, and `limit: 1` makes each owner exactly one presence request.
 */
export async function verifyWorkConversationOwners({
  owners,
  request,
  signal,
  concurrency = WORK_CONVERSATION_PRESENCE_CONCURRENCY,
}: {
  owners: readonly AgentActivity[]
  request: (query: WorkConversationPresenceQuery) => Promise<SessionListPage>
  signal?: AbortSignal
  concurrency?: number
}): Promise<WorkConversationPresence> {
  const visible = Array.from<string | undefined>({ length: owners.length })
  const failed = Array.from<string | undefined>({ length: owners.length })
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < owners.length) {
      signal?.throwIfAborted()
      const index = nextIndex
      nextIndex += 1
      const owner = owners[index]
      if (owner === undefined) continue
      try {
        const page = await request({
          ...workConversationFiltersForAgent(owner.agentId),
          limit: 1,
        })
        if (page.items.length > 0) visible[index] = owner.agentId
      } catch {
        signal?.throwIfAborted()
        failed[index] = owner.agentId
      }
    }
  }

  const workerCount = Math.min(owners.length, Math.max(1, Math.floor(concurrency)))
  await Promise.all(Array.from({ length: workerCount }, worker))
  return {
    visibleOwnerIds: visible.filter((agentId): agentId is string => agentId !== undefined),
    failedOwnerIds: failed.filter((agentId): agentId is string => agentId !== undefined),
  }
}
