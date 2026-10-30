import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'

export const rawAppsForTest = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.query('apps').collect()
  },
})

export const forcePortForTest = mutation({
  args: {
    internalKey: v.string(),
    appId: v.id('apps'),
    port: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.appId, { port: args.port })
  },
})

export const forceDisabledAtForTest = mutation({
  args: {
    internalKey: v.string(),
    appId: v.id('apps'),
    disabledAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.appId, { disabledAt: args.disabledAt })
  },
})

export const seedWorkspaceAppsForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    createdByUserId: v.id('users'),
    count: v.number(),
    matchingPath: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    for (let index = 0; index < args.count; index += 1) {
      const slug = `seed-${index.toString().padStart(3, '0')}`
      const path = index === 0 ? `${args.matchingPath}/${slug}` : `outside/${slug}`
      const anchorId = await ctx.db.insert('anchors', {
        workspaceId: args.workspaceId,
        path,
        kind: 'app',
        settings: {},
        state: 'active',
        markerNonce: `marker-${index}`,
        createdAt: index,
        updatedAt: index,
      })
      await ctx.db.insert('apps', {
        workspaceId: args.workspaceId,
        anchorId,
        command: 'bun run start',
        apiScopes: [],
        port: 10_000 + index,
        slug,
        visibility: 'folder',
        runtimeStatus: 'reconciled',
        createdByUserId: args.createdByUserId,
        createdAt: index,
        updatedAt: index,
      })
    }
  },
})
