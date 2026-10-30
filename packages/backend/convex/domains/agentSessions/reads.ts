/* ============================================================================
   How far each member has read each session.

   Unread is a fact about a *reader*, not about a row: several people read the
   same agent's work, and a badge that cleared for everyone the moment one of
   them looked would be worse than no badge. So the cursor is keyed on
   `(workspaceId, userId, sessionId)` and nothing about it lives on the session.

   ---- the write is a maximum, not an assignment ----
   `lastReadSeq` only ever moves forward. That is what makes the client's
   coalescing window safe: it may drop intermediate observations freely, because
   the one that lands carries everything below it. It also makes a retry
   harmless, and makes two tabs racing each other a non-event.

   ---- agent reads never mark read ----
   A workspace API key resolves to a user. If an agent polling a session
   advanced that user's cursor, an agent watching its own work would clear a
   human's badge — so only the explicit read endpoint writes here, and it is
   reached with a session credential rather than a workspace one.
   ========================================================================= */
import { getDocumentSize } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { requireSessionPointFromDb } from './access'
import { throwSessionError } from './errors'
import { assertSessionIdentityAttribution, type SessionRequestIdentity } from './identity'

/**
 * Move one member's cursor forward on one session.
 *
 * Idempotent and monotonic: a `seq` at or below what is already stored is
 * accepted and changes nothing, so a late flush from a backgrounded tab cannot
 * un-read what a later one already read.
 *
 * **If a human can read this point, they can mark it read.** Central point
 * admission handles both workspace membership and the session audience. A
 * workspace principal has no personal cursor and is refused after that point
 * check, so a valid workspace request gets 403 without turning malformed or
 * hidden session ids into an existence oracle.
 *
 * The session is checked to belong to the workspace for the usual reason: an id
 * from another workspace must not become a row in this one.
 */
export async function markSessionReadImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    actorId: Id<'users'>
    sessionId: string
    seq: number
    now?: number
    identity: SessionRequestIdentity
  },
): Promise<{ lastReadSeq: number }> {
  assertSessionIdentityAttribution(args.identity, args.actorId)
  const { session } = await requireSessionPointFromDb(ctx, args)
  if (args.identity.principal.kind !== 'human') throwSessionError('forbidden')
  const now = args.now ?? Date.now()
  const userId = args.identity.principal.userId
  const existing = await ctx.db
    .query('sessionReads')
    .withIndex('by_workspace_user_session', q =>
      q.eq('workspaceId', args.workspaceId).eq('userId', userId).eq('sessionId', session._id),
    )
    .unique()

  const seq = Math.max(0, Math.floor(args.seq))
  if (existing === null) {
    await ctx.db.insert('sessionReads', {
      workspaceId: args.workspaceId,
      userId,
      sessionId: session._id,
      lastReadSeq: seq,
      updatedAt: now,
    })
    return { lastReadSeq: seq }
  }
  /* Nothing is written when the cursor would go backwards — not even
     `updatedAt`. The row's timestamp says when this member last read something
     new, and touching it on a no-op would make "last read" mean "last asked". */
  if (seq <= existing.lastReadSeq) return { lastReadSeq: existing.lastReadSeq }
  await ctx.db.patch(existing._id, { lastReadSeq: seq, updatedAt: now })
  return { lastReadSeq: seq }
}

/**
 * Delete one batch of a session's cursors, for the delete cascade.
 *
 * This is why `by_session` exists. The upsert key leads with the workspace and
 * the member, so a session's rows cannot be found by session without it — and
 * the failure would be silent: every member's cursor for a deleted session left
 * behind, keyed to an id nothing will ever resolve again.
 */
export async function deleteSessionReadsBatch(
  ctx: MutationCtx,
  sessionId: Id<'agentSessions'>,
  limit: number,
): Promise<number> {
  const rows = await ctx.db
    .query('sessionReads')
    .withIndex('by_session', q => q.eq('sessionId', sessionId))
    .take(limit)
  for (const row of rows) await ctx.db.delete(row._id)
  return rows.length
}

/* ---------------------------------------------------------------------------
   The projection.

   `unread` is server-owned. The SPA never compares sequence numbers, because
   the comparison needs the floor below, and a floor the client had to be told
   about is a second place for it to be wrong.
   ------------------------------------------------------------------------ */

/**
 * Is this row unread by a member whose cursor is `cursor` and whose floor is
 * `floorAt`?
 *
 * ---- why the floor exists ----
 * "No cursor row means unread" has to be true: the case the whole feature is
 * for is a job an agent started that you never opened, and requiring a prior
 * open would make exactly that case invisible forever.
 *
 * Taken alone, though, it marks a workspace with any history *entirely* unread
 * on day one, badging every agent permanently. So the predicate is bounded
 * below by when the reader joined — work that predates them was never theirs to
 * miss.
 */
function isUnread(
  row: { lastEventSeq: number; updatedAt: number },
  cursor: number | undefined,
  floorAt: number,
): boolean {
  return row.updatedAt > floorAt && (cursor === undefined || cursor < row.lastEventSeq)
}

/**
 * `unread` for a page of rows, for one reader.
 *
 * The batched half of the cursor lookup: `by_workspace_user_session` is an
 * exact key, so a page of sessions is a page of point reads rather than a scan.
 *
 * Absent for two different reasons, both answering `false`:
 *
 * - **No actor.** An internal-key caller is not a person, and "unread" is a
 *   fact about a person. There is nobody for it to be true of.
 * - **No membership.** The reader is not in this workspace, so there is no
 *   floor and no work that was ever theirs to miss.
 */
export async function unreadBySession(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'> | undefined,
  rows: readonly { _id: Id<'agentSessions'>; lastEventSeq: number; updatedAt: number }[],
): Promise<Map<Id<'agentSessions'>, boolean>> {
  const unread = new Map<Id<'agentSessions'>, boolean>()
  if (userId === undefined || rows.length === 0) return unread
  const floorAt = await readFloorFor(ctx, workspaceId, userId)
  if (floorAt === undefined) return unread
  for (const row of rows) {
    const cursor = await ctx.db
      .query('sessionReads')
      .withIndex('by_workspace_user_session', q =>
        q.eq('workspaceId', workspaceId).eq('userId', userId).eq('sessionId', row._id),
      )
      .unique()
    unread.set(row._id, isUnread(row, cursor?.lastReadSeq, floorAt))
  }
  return unread
}

export async function unreadForSessionAtFloor(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
  floorAt: number,
  row: { _id: Id<'agentSessions'>; lastEventSeq: number; updatedAt: number },
): Promise<boolean> {
  const cursor = await ctx.db
    .query('sessionReads')
    .withIndex('by_workspace_user_session', q =>
      q.eq('workspaceId', workspaceId).eq('userId', userId).eq('sessionId', row._id),
    )
    .unique()
  return isUnread(row, cursor?.lastReadSeq, floorAt)
}

export async function unreadForSessionAtFloorWithReadBytes(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
  floorAt: number,
  row: { _id: Id<'agentSessions'>; lastEventSeq: number; updatedAt: number },
): Promise<{ unread: boolean; readCost: { ranges: number; documents: number; bytes: number } }> {
  const cursor = await ctx.db
    .query('sessionReads')
    .withIndex('by_workspace_user_session', q =>
      q.eq('workspaceId', workspaceId).eq('userId', userId).eq('sessionId', row._id),
    )
    .unique()
  return {
    unread: isUnread(row, cursor?.lastReadSeq, floorAt),
    readCost: {
      ranges: 1,
      documents: cursor === null ? 0 : 1,
      bytes: cursor === null ? 0 : getDocumentSize(cursor),
    },
  }
}

/**
 * When this member's unread history starts, or `undefined` if they are not one.
 *
 * The membership row's own `_creationTime`, and deliberately nothing else. That
 * placement is what makes a removed-then-reinvited member safe *by
 * construction*: they get a new row with a new creation time, so months-old
 * sessions cannot resurrect as already-read. A floor stored anywhere with a
 * longer life than the membership would have to defend against that by hand.
 */
async function readFloorFor(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
): Promise<number | undefined> {
  const membership = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspaceId).eq('userId', userId))
    .unique()
  return membership?._creationTime
}
