import { v } from 'convex/values'

import { internalMutation } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { createShareForActor, reshareForActor, revokeShareAfterDeliveryFailure } from './model'

const shareMode = v.union(v.literal('read'), v.literal('write'))

export const createFromApi = internalMutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    fromWorkspaceId: v.id('workspaces'),
    toEmail: v.string(),
    path: v.string(),
    mode: shareMode,
    ignorePatterns: v.optional(v.array(v.string())),
    invitationToken: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await createShareForActor(ctx, args)
  },
})

export const reshareFromApi = internalMutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    parentShareId: v.id('shares'),
    fromWorkspaceId: v.id('workspaces'),
    toEmail: v.string(),
    mode: shareMode,
    ignorePatterns: v.optional(v.array(v.string())),
    invitationToken: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await reshareForActor(ctx, args)
  },
})

export const revokeAfterDeliveryFailure = internalMutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    shareId: v.id('shares'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await revokeShareAfterDeliveryFailure(ctx, args)
  },
})
