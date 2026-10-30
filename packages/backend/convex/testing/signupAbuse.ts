import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { grantTrialCreditsForAccount } from '../domains/credits/grants'
import { claimDeviceForUser, type DeviceClaim } from '../domains/signupAbuse/model'

/**
 * Drive the device claim directly. The production path reaches it only through
 * a verified Fingerprint event, which a test cannot mint — but the claim is the
 * anti-farming decision itself, so it needs to be exercisable on its own.
 */
export const claimDeviceForTest = mutation({
  args: { internalKey: v.string(), userId: v.id('users'), visitorId: v.string() },
  handler: async (ctx, args): Promise<DeviceClaim> => {
    requireApiInternalKey(args.internalKey)
    return await claimDeviceForUser(ctx, { userId: args.userId, visitorId: args.visitorId })
  },
})

export const grantTrialForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    actorId: v.id('users'),
    source: v.union(v.literal('signup'), v.literal('workspace_create'), v.literal('vm_register')),
  },
  handler: async (ctx, args): Promise<{ granted: boolean }> => {
    requireApiInternalKey(args.internalKey)
    return await grantTrialCreditsForAccount(ctx, {
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      source: args.source,
    })
  },
})

export const signupSignalsForTest = query({
  args: { internalKey: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const rows = await ctx.db
      .query('signupSignals')
      .withIndex('by_email', q => q.eq('email', args.email))
      .collect()
    return rows.map(row => ({ reason: row.reason, visitorId: row.visitorId }))
  },
})

export const signupAbuseUserForTest = query({
  args: { internalKey: v.string(), userId: v.id('users') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const user = await ctx.db.get(args.userId)
    if (user === null) throw new Error('User not found')
    return {
      visitorId: user.visitorId,
      canonicalEmail: user.canonicalEmail,
      trialGrantWithheldAt: user.trialGrantWithheldAt,
    }
  },
})
