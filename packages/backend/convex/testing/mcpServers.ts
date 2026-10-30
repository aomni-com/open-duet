import { v } from 'convex/values'

import { query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'

export const rawServersForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('mcpServers')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .collect()
  },
})

export const rawCredentialsForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('mcpServerCredentials')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .collect()
  },
})

export const rawPoliciesForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('mcpServerAgentPolicies')
      .withIndex('by_workspace_and_server', q => q.eq('workspaceId', args.workspaceId))
      .collect()
  },
})

export const rawAuthorizationsForTest = query({
  args: { internalKey: v.string(), serverId: v.id('mcpServers') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('mcpOAuthAuthorizations')
      .withIndex('by_server', q => q.eq('serverId', args.serverId))
      .collect()
  },
})

export const rawRegistrationsForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('mcpClientRegistrations')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .collect()
  },
})
