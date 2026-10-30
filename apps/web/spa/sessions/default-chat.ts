import { queryOptions, type QueryClient } from '@tanstack/react-query'

import {
  ROOT_AGENT_SCOPE,
  type SessionActivityResponse,
  type SessionSnapshot,
} from '@repo/contract'

import type { SpaApi } from '../context'
import { sessionKeys } from './session-data'

/* ============================================================================
   An owner's default chat — the one conversation a surface opens it on.

   "Owner" is an agent or the drive root, which is the same pair the backend
   points at from `agents.defaultSessionId` and `workspaces.rootDefaultSessionId`
   (sessions-and-jobs, D10/D26). Both are spelled as slugs here, root under its
   reserved `root` — the same token the wire, the job filters and the session
   picker use.

   It is addressed by **alias** and never by an id the client first has to find
   (D27). That is the whole point: an id has to come from somewhere, and the
   only somewhere available to a client is the agent's session list — which
   holds every conversation the agent has had, including the ones its own
   subagents opened. Picking out of that list is what this module exists to
   stop, so the list is not a fallback here; there is no fallback.
   ========================================================================= */

/**
 * The alias's owner for a requested scope.
 *
 * The drive root is an owner like any agent — the centre of the map is clicked
 * the same way a face is — but it is not a row in `agents`, so its pointer
 * lives on the workspace (`rootDefaultSessionId`, D10). It is nonetheless
 * *addressed* like every other owner, under the reserved slug `root`, so that
 * is what this returns: an owner token, never a hole. Nothing downstream — the
 * query key, the api client, the URL — has a null branch to get wrong.
 *
 * Note what is deliberately NOT here: `undefined`. A host that does not yet
 * know which agent it is on must not ask at all, because folding it in with
 * root would answer an agent's panel with the drive's own conversation. That
 * distinction is the caller's, and it survives precisely because root has a
 * name of its own rather than being spelled "absent".
 */
export function defaultChatAgentSlug(requested: string | null): string {
  return requested === null || requested === '' ? ROOT_AGENT_SCOPE : requested
}

export function defaultChatQueryOptions(api: SpaApi, workspaceSlug: string, agentSlug: string) {
  return queryOptions({
    queryKey: sessionKeys.default(workspaceSlug, agentSlug),
    // `null` is the read's ordinary answer — no default chat yet — so the
    // composer opens from settled data, never from an error branch.
    queryFn: ({ signal }) => api.getDefaultSession(workspaceSlug, agentSlug, signal),
    // A real failure surfaces as `unavailable` with a retry affordance of its
    // own; retrying here would only delay that verdict.
    retry: false,
  })
}

/**
 * What the id the first message minted is stamped with.
 *
 * The owner, because a host can swap owners underneath a live instance — flying
 * from one face to the next does exactly that — and a bare id would then mount
 * one agent's panel on another agent's conversation.
 *
 * And `archivedAt`, because archiving is the *same* swap: the pointer this tab
 * stamped is gone, the conversation is an ordinary session now, and a held id
 * would keep the archived thread on screen for the one person who started it —
 * the panel is keyed by agent, so it never remounts to shake the id loose.
 * Folded into the key rather than checked separately so there is one answer to
 * "is this still the chat on screen", and so nothing has to reorder the
 * precedence in {@link defaultChatMount}, whose whole reason for putting
 * `created` first is the blink it prevents.
 */
export function defaultChatOwnerKey(
  workspaceSlug: string,
  agentSlug: string,
  archivedAt?: number,
): string {
  return `${workspaceSlug}/${agentSlug}/${archivedAt ?? 0}`
}

/** The just-minted id, if it is still about the chat this surface is showing. */
export function defaultChatCreatedId(
  created: { owner: string; sessionId: string } | undefined,
  ownerKey: string,
): string | undefined {
  return created?.owner === ownerKey ? created.sessionId : undefined
}

export type DefaultChatMount =
  /** the read is in flight and nothing is known yet */
  | { kind: 'loading' }
  /** open this conversation */
  | { kind: 'session'; sessionId: string }
  /** there is no default chat yet; offer to start one */
  | { kind: 'compose' }
  /** the read failed for a reason that is not "none yet" */
  | { kind: 'unavailable' }

/**
 * What the surface shows for an owner's default chat.
 *
 * `created` is the id the first message just minted, held by the caller. It
 * wins over the query because it is strictly newer: the same request that
 * created the row stamped the pointer, so a refetch can only agree with it, and
 * waiting for that refetch would blink the just-started conversation out.
 */
export function defaultChatMount(state: {
  isPending: boolean
  /** `null` is the settled "no chat yet" answer; `undefined` is not-known-yet */
  session?: Pick<SessionSnapshot, 'id'> | null
  created?: string
  error?: unknown
}): DefaultChatMount {
  if (state.created !== undefined) return { kind: 'session', sessionId: state.created }
  if (state.session != null) return { kind: 'session', sessionId: state.session.id }
  if (state.error !== undefined && state.error !== null) return { kind: 'unavailable' }
  return state.isPending ? { kind: 'loading' } : { kind: 'compose' }
}

/**
 * Record the chat a first message just minted, before anyone re-asks.
 *
 * The pointer moved on the server and this client has the row it moved to — the
 * create response carries the whole snapshot — so there is a window here that
 * invalidation alone cannot close. Between the send resolving and the refetches
 * landing, every reader of "which session is this owner's chat" answers *none*,
 * and the conversation that just started streams through the optimistic
 * patchers as ordinary work: a job row in the dialog built to withhold it, and
 * a bead on the face for the conversation the reader is having.
 *
 * So both places that answer the question are told at once. The alias is this
 * owner's own answer; the drive-wide read is where the map and the splicer look,
 * and the owner is keyed there by agent id — which the snapshot carries, so the
 * slug the alias is addressed by never has to be translated.
 *
 * Optimistic, and then confirmed: {@link invalidateDefaultChatPointer} re-asks
 * immediately after, and the server's answer replaces this one.
 */
export function stampDefaultChat(
  queryClient: QueryClient,
  workspaceSlug: string,
  agentSlug: string,
  snapshot: SessionSnapshot,
): void {
  queryClient.setQueryData<SessionSnapshot | null>(
    sessionKeys.default(workspaceSlug, agentSlug),
    snapshot,
  )
  const ownerId = snapshot.agent?.id ?? ROOT_AGENT_SCOPE
  queryClient.setQueryData<SessionActivityResponse>(
    sessionKeys.activity(workspaceSlug),
    current => {
      if (current === undefined) return current
      const owners = current.owners.map(owner =>
        owner.agentId === ownerId
          ? {
              ...owner,
              /* Out of the work in the same breath. A first message can only
                 mint, so the row cannot already be there — but the two halves
                 of an owner must never both hold it, whatever put it there. */
              sessions: owner.sessions.filter(session => session.id !== snapshot.id),
              chat: snapshot,
            }
          : owner,
      )
      return {
        owners: owners.some(owner => owner.agentId === ownerId)
          ? owners
          : [...owners, { agentId: ownerId, sessions: [], truncated: false, chat: snapshot }],
      }
    },
  )
}

/**
 * Re-ask everything that was answered while the pointer was somewhere else.
 *
 * Three things move the pointer, and the backend's single writer names them:
 * delivery stamps it on the first message, the demote gesture clears it, and
 * deleting a session clears it too (`writeDefaultSessionPointer`). All three are
 * the same event to every reader downstream — *which session is this owner's
 * chat* has changed — so the two that a person performs share this one refresh.
 *
 * Delete does not, and deliberately: it is not a re-ask but a removal, and the
 * row is taken out of these same families by id where the deletion is committed
 * (`commitRemovedSessionCache`). Re-asking there would spend three requests to
 * be told about a row this client already knows is gone.
 *
 * Three families, and they are deliberately not one prefix: the alias
 * (`defaults`) and the map's activity read both sit *outside* `lists()` because
 * neither has filters or a cursor. A refresh aimed at one prefix would leave
 * the other two holding the old answer.
 *
 * All three in the same tick, because all three carry the answer: the activity
 * read names each owner's chat beside its work, the alias names one owner's,
 * and the jobs lists are drawn by withholding whichever id those two report.
 * Leave any one of them holding the old pointer and it contradicts the others —
 * most visibly in the lists, where the optimistic splicer decides
 * `excludeDefault` from exactly these cached answers.
 *
 * Invalidation rather than a hand-patch: the answer this changes is the alias's
 * own, and patching it would be telling the pointer where the pointer just
 * moved.
 */
export function invalidateDefaultChatPointer(
  queryClient: QueryClient,
  workspaceSlug: string,
): void {
  void queryClient.invalidateQueries({ queryKey: sessionKeys.defaults(workspaceSlug) })
  void queryClient.invalidateQueries({ queryKey: sessionKeys.activity(workspaceSlug) })
  void queryClient.invalidateQueries({ queryKey: sessionKeys.lists(workspaceSlug) })
}
