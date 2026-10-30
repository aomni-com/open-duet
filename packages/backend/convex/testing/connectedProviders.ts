import { v } from 'convex/values'

import { query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'

export const rawRowsForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('connectedProviders')
      .withIndex('by_workspace_and_provider', q => q.eq('workspaceId', args.workspaceId))
      .collect()
  },
})

export const rawConnectIntentsForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('connectedProviderConnectIntents')
      .withIndex('by_workspace_and_provider', q => q.eq('workspaceId', args.workspaceId))
      .collect()
  },
})
