import { v } from 'convex/values'

import type { Doc } from '../../_generated/dataModel'
import { mutation, type MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { deleteWorkspaceImpl } from '../workspaces/mutations'
import { retireUserIdentity } from './retire'

// The caller buys 6 hours by saying `ephemeral: true`, or names a deletion
// moment — but nothing outlives 24 hours from mint. The cap is the product
// rule ("ephemeral runs for 24 hrs max"), enforced here at the write so no
// caller can mint around it.
export const EPHEMERAL_DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
export const EPHEMERAL_MAX_TTL_MS = 24 * 60 * 60 * 1000
const EPHEMERAL_RETIRE_RETRY_MS = 15 * 60 * 1000

/**
 * Resolves the login-as `ephemeral` option (`true` for the default, an epoch-ms
 * timestamp for a chosen moment) into the expiry the sweep enforces. A moment
 * already in the past is a caller bug, refused rather than treated as
 * delete-immediately.
 */
export function resolveEphemeralExpiry(request: true | number, now: number): number {
  if (request !== true && request <= now) {
    throw new Error('Ephemeral expiry is in the past')
  }
  const requested = request === true ? now + EPHEMERAL_DEFAULT_TTL_MS : request
  return Math.min(requested, now + EPHEMERAL_MAX_TTL_MS)
}

/**
 * The scheduled deletion behind the option: every run erases every ephemeral
 * identity whose moment has passed — the workspaces they own (through the real
 * deletion path, so the VM-teardown rail reclaims the VM), then the identity
 * itself. Cron-driven rather than a per-mint scheduled function so a failed
 * deletion is retried on every tick instead of being lost with its one job.
 */
export const retireExpiredEphemeralUsers = mutation({
  args: { internalKey: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const now = args.now ?? Date.now()
    const due = await ctx.db
      .query('users')
      .withIndex('by_ephemeral_expiry', q =>
        q.gt('ephemeralExpiresAt', 0).lte('ephemeralExpiresAt', now),
      )
      .take(50)

    const retired: string[] = []
    const failed: Array<{ userId: string; error: string }> = []
    // One user per iteration, isolated: a user whose teardown throws (for
    // example, still a member of someone else's live workspace this tick) must
    // not block the users behind them — the next run retries whoever remains.
    for (const user of due) {
      try {
        await retireEphemeralUser(ctx, user, now)
        retired.push(user._id)
      } catch (error) {
        failed.push({ userId: user._id, error: String(error) })
        await ctx.db.patch(user._id, { ephemeralExpiresAt: now + EPHEMERAL_RETIRE_RETRY_MS })
      }
    }
    if (failed.length > 0) {
      console.error(`[ephemeral-sweep] ${failed.length} identities could not be retired`, failed)
    }
    return { retired, failed }
  },
})

async function retireEphemeralUser(
  ctx: MutationCtx,
  user: Doc<'users'>,
  now: number,
): Promise<void> {
  // Only workspaces this user OWNS are deleted. An ephemeral user invited into
  // someone else's live workspace defers this pass (retireUserIdentity refuses
  // while live memberships remain) and succeeds on a later tick, after that
  // workspace's own expiry — never by deleting a workspace the user merely
  // joined.
  const owned = await ctx.db
    .query('workspaces')
    .withIndex('by_billing_user', q => q.eq('billingUserId', user._id))
    .take(101)
  if (owned.length > 100) throw new Error('Ephemeral user owns too many workspaces')
  for (const workspace of owned) {
    if (workspace.status === 'deleted') continue
    await deleteWorkspaceImpl(ctx, { workspaceId: workspace._id, actorId: user._id, now })
  }
  await retireUserIdentity(ctx, { userId: user._id, now })
}
