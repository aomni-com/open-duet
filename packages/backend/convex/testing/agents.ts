import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'

export const rawAgentsForTest = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.query('agents').take(10_000)
  },
})

export const deleteAgentRowWithoutSessionCleanupForTest = mutation({
  args: { internalKey: v.string(), agentId: v.id('agents') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.delete(args.agentId)
  },
})

export const insertReplicaForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    anchorId: v.id('anchors'),
    sourceShareId: v.id('shares'),
    sourceAgentId: v.id('agents'),
    createdByUserId: v.id('users'),
    slug: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.insert('agents', {
      workspaceId: args.workspaceId,
      anchorId: args.anchorId,
      sourceShareId: args.sourceShareId,
      sourceAgentId: args.sourceAgentId,
      slug: args.slug,
      createdByUserId: args.createdByUserId,
      createdAt: args.now,
      updatedAt: args.now,
    })
  },
})

export const fillWorkspaceAgentsForLimitTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    anchorId: v.id('anchors'),
    createdByUserId: v.id('users'),
    count: v.number(),
    prefix: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    for (let index = 0; index < args.count; index += 1) {
      await ctx.db.insert('agents', {
        workspaceId: args.workspaceId,
        anchorId: args.anchorId,
        slug: `${args.prefix}-${index}`,
        createdByUserId: args.createdByUserId,
        createdAt: args.now,
        updatedAt: args.now,
      })
    }
  },
})
