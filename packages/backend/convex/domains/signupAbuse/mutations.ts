import { v } from 'convex/values'

import { internalMutation } from '../../_generated/server'
import { claimDeviceForUser, withholdTrial, type DeviceClaim } from './model'

export const claimDevice = internalMutation({
  args: { userId: v.id('users'), visitorId: v.string() },
  handler: async (ctx, args): Promise<DeviceClaim> => await claimDeviceForUser(ctx, args),
})

/** The email- and device-evidence rules' consequence. Same one the limit uses. */
export const withholdTrialForSignup = internalMutation({
  args: {
    userId: v.id('users'),
    email: v.string(),
    reason: v.string(),
    visitorId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => await withholdTrial(ctx, args),
})
