import { v } from 'convex/values'

import { mutation, query } from '../../_generated/server'
import { approveDeviceApproval, denyDeviceApproval, inspectDeviceApproval } from './deviceApproval'
import { requireApiInternalKey } from './model'

export const inspect = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    userCode: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await inspectDeviceApproval(ctx, args)
  },
})

export const approve = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    userCode: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await approveDeviceApproval(ctx, args)
  },
})

export const deny = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    userCode: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await denyDeviceApproval(ctx, args)
  },
})
