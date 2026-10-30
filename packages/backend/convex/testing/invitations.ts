import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import {
  createInviteForActor,
  listInvitesForActor,
  revokeInviteForActor,
} from '../domains/invitations/model'
import { requireCurrentUserId } from '../domains/workspaces/authorization'

export const createForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    email: v.string(),
    role: v.union(v.literal('editor'), v.literal('viewer')),
    token: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await createInviteForActor(ctx, { ...args, actorId: await requireCurrentUserId(ctx) })
  },
})

export const rawInvites = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('workspaceInvites')
      .withIndex('by_workspace_createdAt', q => q.eq('workspaceId', args.workspaceId))
      .take(100)
  },
})

export const clearPaginationForTest = mutation({
  args: { internalKey: v.string(), inviteId: v.id('workspaceInvites') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.inviteId, { paginationId: undefined })
  },
})

export const listForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const result = await listInvitesForActor(
      ctx,
      args.workspaceId,
      await requireCurrentUserId(ctx),
      { cursor: null, numItems: 100 },
    )
    return result.page
  },
})

export const revokeForTest = mutation({
  args: { internalKey: v.string(), inviteId: v.id('workspaceInvites'), now: v.number() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await revokeInviteForActor(ctx, args.inviteId, await requireCurrentUserId(ctx), args.now)
  },
})

export const emailDeliveries = query({
  args: { internalKey: v.string(), to: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('emailDeliveries')
      .withIndex('by_to', q => q.eq('to', args.to))
      .take(100)
  },
})
