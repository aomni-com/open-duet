import type { GenericMutationCtx } from 'convex/server'

import type { DataModel, Id } from '../../_generated/dataModel'
import { classifySignupIdentity } from '../users/signupIdentity'

type MutationCtx = GenericMutationCtx<DataModel>

/**
 * How many distinct mailboxes one device may register before the trial stops.
 *
 * Personal plus work is ordinary; a third is plausible on a shared machine, so
 * the third is where the free credits stop rather than where the account does.
 */
export const MAX_TRIALS_PER_DEVICE = 3

export type DeviceClaim = { withheld: boolean; distinctMailboxes: number }

/**
 * Withhold the trial and record why, in one transaction.
 *
 * Both reasons a signup loses its trial land here — an email or device the gate
 * objects to, and the device mailbox limit — so "what happens when we object"
 * has exactly one implementation.
 *
 * The row and the stamp can share a transaction because nothing throws any more:
 * the account is still created and the workspace is simply born paused, so there
 * is no rollback to lose the evidence to.
 */
export async function withholdTrial(
  ctx: MutationCtx,
  args: { userId: Id<'users'>; email: string; reason: string; visitorId?: string; now?: number },
): Promise<void> {
  const user = await ctx.db.get(args.userId)
  if (user === null) throw new Error('Unauthenticated')
  if (user.trialGrantWithheldAt === undefined) {
    await ctx.db.patch(args.userId, { trialGrantWithheldAt: args.now ?? Date.now() })
  }
  await ctx.db.insert('signupSignals', {
    email: args.email,
    reason: args.reason,
    ...(args.visitorId === undefined ? {} : { visitorId: args.visitorId }),
  })
}

/**
 * Bind a user to the device that created them and decide whether the trial is
 * still available on it.
 *
 * ATOMIC ON PURPOSE — this runs inside one mutation. If the count were read in
 * the action and the grant applied by a later mutation, two simultaneous third
 * signups on one device would both observe two mailboxes and both be granted.
 * Counting and stamping in one transaction is what makes the threshold mean
 * anything.
 *
 * Callers pass the VERIFIED visitor id, never the value the client claimed, or
 * a farmer could nominate a fresh device id per signup and never collide.
 */
export async function claimDeviceForUser(
  ctx: MutationCtx,
  args: { userId: Id<'users'>; visitorId: string; now?: number },
): Promise<DeviceClaim> {
  const user = await ctx.db.get(args.userId)
  if (user === null) throw new Error('Unauthenticated')

  const identity = classifySignupIdentity(user.email)
  // Exempt identities skip the count entirely and are never recorded against a
  // device — otherwise the live-acceptance inboxes would fill the allowance of
  // whatever machine CI happens to run on.
  if (identity.testIdentity) return { withheld: false, distinctMailboxes: 0 }

  // Fixed at first signup, never rewritten: re-binding on a later sign-in from
  // another device would reset the count for free.
  if (user.visitorId === undefined) {
    await ctx.db.patch(args.userId, {
      visitorId: args.visitorId,
      canonicalEmail: identity.canonicalEmail,
    })
  }

  const sharing = await ctx.db
    .query('users')
    .withIndex('by_visitor', q => q.eq('visitorId', args.visitorId))
    .collect()

  // Distinct MAILBOXES, not rows. `+tag` aliases of one mailbox are separate
  // users that share a canonical form and already share a grant key, so
  // counting rows would withhold on someone's third alias of a single inbox —
  // which is not farming and never was.
  const mailboxes = new Set(
    sharing.flatMap(row => (row.canonicalEmail === undefined ? [] : [row.canonicalEmail])),
  )
  mailboxes.add(identity.canonicalEmail)

  // Counting and withholding stay in this one transaction: split them and two
  // simultaneous third signups on one device both read "two" and both keep a
  // trial.
  const withheld = mailboxes.size >= MAX_TRIALS_PER_DEVICE
  if (withheld) {
    await withholdTrial(ctx, {
      userId: args.userId,
      email: user.email,
      reason: 'device-mailbox-limit',
      visitorId: args.visitorId,
      ...(args.now === undefined ? {} : { now: args.now }),
    })
  }

  return { withheld, distinctMailboxes: mailboxes.size }
}
