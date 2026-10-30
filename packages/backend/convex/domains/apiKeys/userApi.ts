import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { mutation, query } from '../../_generated/server'
import { requireApiInternalKey } from './model'
import { issueUserKey, listUserKeys, revokeUserKey } from './userKeys'

export const issue = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    name: v.string(),
    expiresAt: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await issueUserKey(ctx, args)
  },
})

export const list = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await listUserKeys(ctx, args.actorId, args.paginationOpts)
  },
})

export const revoke = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    keyId: v.id('apiKeys'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await revokeUserKey(ctx, args)
  },
})
