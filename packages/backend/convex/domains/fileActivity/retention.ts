import { v, type Infer } from 'convex/values'

import { FILE_EVENT_RETENTION_MS } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import { mutation, type MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { fnMutation } from '../credits/creditsShared'

/**
 * Bounded so one pass fits a transaction; the remainder reschedules itself.
 * Each event drags its scope rows with it, and an event owns roughly one per
 * path segment, so the real write count per pass is several times this.
 */
export const FILE_EVENT_PRUNE_BATCH_SIZE = 200

export const pruneFileEventsArgs = v.object({
  internalKey: v.string(),
  now: v.optional(v.number()),
  limit: v.optional(v.number()),
})

/**
 * Retention's one owner. Folding bounds how many rows a burst can create;
 * this bounds how long any of them live, so neither table grows without end.
 *
 * Scopes are deleted with their event, never separately: an event owns roughly
 * one scope row per path segment, and an orphaned scope leaves the subtree feed
 * pointing at an event that is gone. The projector tolerates the sequence gaps
 * this leaves behind — it advances its cursor past a missing seq rather than
 * stalling on it — so nothing here needs to compensate for them.
 */
export async function pruneFileEventsImpl(
  ctx: MutationCtx,
  args: Infer<typeof pruneFileEventsArgs>,
): Promise<{ pruned: number; done: boolean }> {
  requireApiInternalKey(args.internalKey)
  const limit = args.limit ?? FILE_EVENT_PRUNE_BATCH_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > FILE_EVENT_PRUNE_BATCH_SIZE) {
    throw new Error(`limit must be an integer from 1 to ${FILE_EVENT_PRUNE_BATCH_SIZE}`)
  }
  const now = args.now ?? Date.now()
  // Strictly older than the cutoff: an event exactly at the boundary is still
  // inside the retention window.
  const expired = await ctx.db
    .query('fileEvents')
    .withIndex('by_at', q => q.lt('at', now - FILE_EVENT_RETENTION_MS))
    .take(limit)
  for (const event of expired) {
    await deleteEventScopes(ctx, event._id)
    await ctx.db.delete(event._id)
  }
  // The batch ledger only exists to make a relay retry a no-op, and a retry
  // lands within seconds — its backoff caps at 30s. A record this old can never
  // be replayed against, so keeping it forever buys nothing and costs a row per
  // delivery, which on an active workspace outruns the events themselves.
  const staleBatches = await ctx.db
    .query('fileEventBatches')
    .withIndex('by_recorded', q => q.lt('recordedAt', now - FILE_EVENT_RETENTION_MS))
    .take(limit)
  for (const batch of staleBatches) {
    await ctx.db.delete(batch._id)
  }
  const done = expired.length < limit && staleBatches.length < limit
  if (!done) {
    await ctx.scheduler.runAfter(0, fnMutation('domains/fileActivity/retention:pruneFileEvents'), {
      internalKey: args.internalKey,
      now,
      ...(args.limit === undefined ? {} : { limit }),
    })
  }
  return { pruned: expired.length, done }
}

async function deleteEventScopes(ctx: MutationCtx, eventId: Id<'fileEvents'>): Promise<void> {
  const scopes = await ctx.db
    .query('fileEventScopes')
    .withIndex('by_event_scope', q => q.eq('eventId', eventId))
    .collect()
  for (const scope of scopes) {
    await ctx.db.delete(scope._id)
  }
}

export const pruneFileEvents = mutation({
  args: pruneFileEventsArgs,
  returns: v.object({ pruned: v.number(), done: v.boolean() }),
  handler: (ctx, args) => pruneFileEventsImpl(ctx, args),
})
