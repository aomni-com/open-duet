import { ConvexError, v } from 'convex/values'

import { COLLECTION_PAGE_MAX_LIMIT, IntegrationSlugSchema, ROOT_AGENT_SCOPE } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'

const workspaceArgs = {
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
}

const policyKeyArgs = {
  ...workspaceArgs,
  toolkitSlug: v.string(),
}

export const setIntegrationAgentPolicy = mutation({
  args: {
    ...policyKeyArgs,
    allowedAgentIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const toolkitSlug = IntegrationSlugSchema.parse(args.toolkitSlug)
    const allowedAgentIds = await canonicalAllowedAgentIds(
      ctx,
      args.workspaceId,
      args.allowedAgentIds,
    )
    const existing = await policyByToolkit(ctx, args.workspaceId, toolkitSlug)
    const now = Date.now()
    if (existing === null) {
      await ctx.db.insert('integrationAgentPolicies', {
        workspaceId: args.workspaceId,
        toolkitSlug,
        allowedAgentIds,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      await ctx.db.patch(existing._id, { allowedAgentIds, updatedAt: now })
    }
    return { integration: toolkitSlug, allowedAgentIds }
  },
})

export const clearIntegrationAgentPolicy = mutation({
  args: policyKeyArgs,
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const toolkitSlug = IntegrationSlugSchema.parse(args.toolkitSlug)
    const existing = await policyByToolkit(ctx, args.workspaceId, toolkitSlug)
    if (existing !== null) await ctx.db.delete(existing._id)
    return { integration: toolkitSlug }
  },
})

export const integrationAgentPoliciesForToolkits = query({
  args: { ...workspaceArgs, toolkitSlugs: v.array(v.string()) },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (args.toolkitSlugs.length > COLLECTION_PAGE_MAX_LIMIT) {
      throw new Error('Too many integration toolkits requested')
    }
    const toolkitSlugs = [
      ...new Set(args.toolkitSlugs.map(slug => IntegrationSlugSchema.parse(slug))),
    ]
    const rows = await Promise.all(
      toolkitSlugs.map(toolkitSlug => policyByToolkit(ctx, args.workspaceId, toolkitSlug)),
    )
    return rows
      .filter(row => row !== null)
      .map(row => ({ integration: row.toolkitSlug, allowedAgentIds: row.allowedAgentIds }))
  },
})

async function canonicalAllowedAgentIds(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  input: string[],
): Promise<Array<typeof ROOT_AGENT_SCOPE | Id<'agents'>>> {
  const unique = [...new Set(input)]
  const agentIds = unique
    .filter(id => id !== ROOT_AGENT_SCOPE)
    .map(id => ctx.db.normalizeId('agents', id))
  const normalizedAgentIds = agentIds.filter((id): id is Id<'agents'> => id !== null)
  if (normalizedAgentIds.length !== agentIds.length) {
    throw new ConvexError({ error: 'invalid_agent' })
  }
  const agents = await Promise.all(normalizedAgentIds.map(agentId => ctx.db.get(agentId)))
  if (agents.some(agent => agent === null || agent.workspaceId !== workspaceId)) {
    throw new ConvexError({ error: 'invalid_agent' })
  }
  normalizedAgentIds.sort((left, right) => left.localeCompare(right))
  return unique.includes(ROOT_AGENT_SCOPE)
    ? [ROOT_AGENT_SCOPE, ...normalizedAgentIds]
    : normalizedAgentIds
}

async function policyByToolkit(
  ctx: MutationCtx | QueryCtx,
  workspaceId: Id<'workspaces'>,
  toolkitSlug: string,
) {
  return await ctx.db
    .query('integrationAgentPolicies')
    .withIndex('by_workspace_and_toolkit', q =>
      q.eq('workspaceId', workspaceId).eq('toolkitSlug', toolkitSlug),
    )
    .unique()
}
