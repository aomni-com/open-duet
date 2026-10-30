/* ============================================================================
   Every face's prioritized recent work, in one read.

   The read is keyed the way the ring is: one bounded list per owner. A
   workspace-wide page split in the client can truncate one busy agent ahead of
   another and falsely draw the latter as idle.

   ---- why the fan-out is here and not in the browser ----
   Each owner reads four bucket ranges from the same authorized discovery lanes
   an ordinary session page uses. Doing it here costs one request instead of one
   per face and keeps scope resolution server-owned.

   ---- why `take` and not `paginate` ----
   Nothing turns a page: the ring seats five and the drawer sorts. A cursor would
   also make the union needlessly stateful: the four buckets are four ranges and
   a cursor belongs to one. The bounded read can merge them directly in seat
   priority order.
   ========================================================================= */
import {
  MAX_AGENTS_PER_WORKSPACE,
  ROOT_AGENT_SCOPE,
  SESSION_ACTIVITY_MAX_LIMIT,
} from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { resolveSessionDiscoveryScopeFromDb } from './access'
import {
  getSessionActivityDiscovery,
  listSessionActivityDiscovery,
  type SessionActivityDiscoveryRow,
} from './discovery'
import type { SessionRequestIdentity } from './identity'
import { unreadBySession } from './reads'

/**
 * `SESSION_ACTIVITY_PRIORITY` is also the web's seat order.
 *
 * `asking` leads because the one thing that cannot proceed without a person is
 * the one that must never be pushed into "+N more". Ordering by `updatedAt`
 * alone did exactly that: an agent with five running jobs drew zero asking
 * nodes.
 *
 * Finished work comes last. It remains visible when an owner has fewer urgent
 * sessions than the caller's limit, but it can never displace work that is
 * asking, running, or waiting on a clock.
 */
/* The wire's name for "no agent", used as this map's key for the drive root. */
const ROOT_KEY: string = ROOT_AGENT_SCOPE

export async function sessionActivityImpl(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<'workspaces'>
    limitPerAgent: number
    identity: SessionRequestIdentity
  },
) {
  const resolvedScope = await resolveSessionDiscoveryScopeFromDb(ctx, args)
  const readerUserId =
    args.identity.principal.kind === 'human' ? args.identity.principal.userId : undefined
  const limit = Math.min(Math.max(1, Math.floor(args.limitPerAgent)), SESSION_ACTIVITY_MAX_LIMIT)
  const agents = await ctx.db
    .query('agents')
    .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
    .take(MAX_AGENTS_PER_WORKSPACE + 1)
  if (agents.length > MAX_AGENTS_PER_WORKSPACE) {
    throw new Error('Workspace agent limit exceeded')
  }
  /* Each owner's pointer, read off the rows this query already has in hand —
     the agents above, and the workspace for the drive root. This is the fact no
     session carries, and answering it here is the whole reason the map no
     longer asks one alias per drawn face. */
  const workspace = await ctx.db.get(args.workspaceId)
  const chatIdByOwner = new Map(agents.map(agent => [agent._id, agent.defaultSessionId]))
  const chatIdOf = (owner: Id<'agents'> | undefined): Id<'agentSessions'> | undefined =>
    owner === undefined ? workspace?.rootDefaultSessionId : chatIdByOwner.get(owner)

  /* `undefined` first, and it is not a placeholder: work no agent claimed
     belongs to the drive root, which the wire calls `ROOT_AGENT_SCOPE` and the
     map draws at the centre. It is an owner like any other here. */
  const owners: readonly (Id<'agents'> | undefined)[] = [
    undefined,
    ...agents.map(agent => agent._id),
  ]

  const collected: SessionActivityDiscoveryRow[] = []
  const perOwner: {
    agentId: string
    rows: SessionActivityDiscoveryRow[]
    chat?: SessionActivityDiscoveryRow
    truncated: boolean
    lastActiveAt: number
  }[] = []

  for (const owner of owners) {
    /* The pointer is exact, while its summary still comes from the authorized
       discovery projection. Hydrating canonical sessions here would multiply
       one grouped request by every full session document in the workspace. */
    const chatId = chatIdOf(owner)
    const chat =
      chatId === undefined
        ? undefined
        : ((await getSessionActivityDiscovery(ctx, {
            workspaceId: args.workspaceId,
            scope: resolvedScope.scope,
            sessionId: chatId,
            agentId: owner ?? null,
          })) ?? undefined)
    const work = await listSessionActivityDiscovery(ctx, {
      workspaceId: args.workspaceId,
      scope: resolvedScope.scope,
      agentId: owner ?? null,
      limit,
      ...(chatId === undefined ? {} : { excludeSessionId: chatId }),
    })
    /* An owner with nothing but a chat is still an owner: its face draws that
       conversation, and dropping it here is how a drive full of agents nobody
       has given work to comes back empty. */
    if (work.rows.length === 0 && chat === undefined) continue
    /* Taken before the seating sort and the slice: the owner's recency is its
       newest row, which priority may seat *last* — an old question outranks a
       fresh completion inside the list, but must not age the owner. Each
       bucket was read newest-first, so the newest row is always in `work` even
       when the slice below drops it. */
    const lastActiveAt = work.rows.reduce((max, row) => Math.max(max, row.updatedAt), 0)
    perOwner.push({
      agentId: owner ?? ROOT_KEY,
      rows: work.rows,
      ...(chat === undefined ? {} : { chat }),
      truncated: work.truncated,
      lastActiveAt,
    })
    collected.push(...work.rows)
    if (chat !== undefined) collected.push(chat)
  }

  /* One batch for every owner's rows at once. `unread` needs the reader's
     cursor per session, and doing it per owner would be the same reads with the
     membership lookup repeated once per face. */
  const unread = await unreadBySession(
    ctx,
    args.workspaceId,
    readerUserId,
    collected.map(row => ({
      _id: row.sessionId,
      lastEventSeq: row.lastEventSeq,
      updatedAt: row.updatedAt,
    })),
  )
  /* Most recently active owner first. The rows inside an owner are seated by
     urgency, but *between* owners recency is the only ordering that means
     anything — "who moved last" is a question about the workspace. */
  perOwner.sort((left, right) => right.lastActiveAt - left.lastActiveAt)
  return {
    owners: perOwner.map(owner => ({
      agentId: owner.agentId,
      sessions: owner.rows.map(row =>
        activitySessionSummary(row, unread.get(row.sessionId) === true),
      ),
      truncated: owner.truncated,
      ...(owner.chat === undefined
        ? {}
        : {
            chat: {
              ...activitySessionSummary(owner.chat, unread.get(owner.chat.sessionId) === true),
              ...(owner.chat.preview === undefined ? {} : { preview: owner.chat.preview }),
            },
          }),
    })),
  }
}

function activitySessionSummary(row: SessionActivityDiscoveryRow, unread: boolean) {
  return {
    id: row.sessionId,
    title: row.title,
    bucket: row.bucket,
    updatedAt: row.updatedAt,
    unread,
    ...(row.machine === undefined ? {} : { machine: row.machine }),
  }
}
