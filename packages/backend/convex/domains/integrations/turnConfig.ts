import { v } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../../_generated/server'
import { effectiveSessionPrincipal, principalDenied } from '../agentAccess/policy'
import { requireWorkspaceSessionPointFromDb } from '../agentSessions/access'
import { requireApiInternalKey } from '../apiKeys/model'

const PERMISSION_FINGERPRINT_VERSION = 'duet-integration-permissions-v1'

export async function projectIntegrationTurnConfig(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    duetSessionId: Id<'agentSessions'>
    agentId?: Id<'agents'>
    now: number
  },
): Promise<{ ready: boolean } | null> {
  const principal = await effectiveSessionPrincipal(ctx, args.workspaceId, args.agentId)
  const policies = await ctx.db
    .query('integrationAgentPolicies')
    .withIndex('by_workspace_and_toolkit', q => q.eq('workspaceId', args.workspaceId))
    .collect()
  const disabledToolkitSlugs = canonicalToolkitSlugs(
    policies
      .filter(policy => principalDenied(policy.allowedAgentIds, principal))
      .map(policy => policy.toolkitSlug),
  )
  const permissionFingerprint = await integrationPermissionFingerprint(disabledToolkitSlugs)
  const existing = await ctx.db
    .query('composioToolRouterSessions')
    .withIndex('by_duet_session', q => q.eq('duetSessionId', args.duetSessionId))
    .unique()
  if (existing !== null) {
    if (existing.workspaceId !== args.workspaceId) return null
    if (existing.permissionFingerprint !== permissionFingerprint) {
      await ctx.db.patch(existing._id, { permissionFingerprint, disabledToolkitSlugs })
    }
    // Ready when a provider session exists and already reflects the
    // permissions just projected; anything else needs the API's synchronize.
    return {
      ready:
        existing.providerSessionId !== undefined &&
        existing.appliedPermissionFingerprint === permissionFingerprint,
    }
  }
  await ctx.db.insert('composioToolRouterSessions', {
    workspaceId: args.workspaceId,
    duetSessionId: args.duetSessionId,
    permissionFingerprint,
    disabledToolkitSlugs,
    createdAt: args.now,
  })
  return { ready: false }
}

export const projectToolRouterConfigForSession = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    duetSessionId: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.union(v.literal(true), v.null()),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const { session } = await requireWorkspaceSessionPointFromDb(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.duetSessionId,
    })
    const projected = await projectIntegrationTurnConfig(ctx, {
      workspaceId: args.workspaceId,
      duetSessionId: session._id,
      agentId: session.agentId,
      now: args.now ?? Date.now(),
    })
    return projected === null ? null : true
  },
})

const toolRouterConfigArgs = {
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  duetSessionId: v.string(),
}

export const getToolRouterSession = query({
  args: toolRouterConfigArgs,
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const config = await toolRouterConfig(ctx, args.workspaceId, args.duetSessionId)
    if (config === null) return { status: 'not_found' as const }
    return {
      status: 'found' as const,
      duetSessionId: config.duetSessionId,
      permissionFingerprint: config.permissionFingerprint,
      disabledToolkitSlugs: config.disabledToolkitSlugs,
      providerSessionId: config.providerSessionId,
      appliedPermissionFingerprint: config.appliedPermissionFingerprint,
      mcpUrl: config.mcpUrl,
      toolsList: config.toolsList,
    }
  },
})

export const adoptToolRouterSession = mutation({
  args: {
    ...toolRouterConfigArgs,
    expectedProviderSessionId: v.union(v.string(), v.null()),
    providerSessionId: v.string(),
    permissionFingerprint: v.string(),
    mcpUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const config = await toolRouterConfig(ctx, args.workspaceId, args.duetSessionId)
    if (config === null) return { status: 'not_found' as const }
    if ((config.providerSessionId ?? null) !== args.expectedProviderSessionId) {
      return { status: 'changed' as const }
    }
    if (args.providerSessionId.length === 0) throw new Error('Provider session identity is empty')
    const applied = config.permissionFingerprint === args.permissionFingerprint
    await ctx.db.patch(config._id, {
      providerSessionId: args.providerSessionId,
      appliedPermissionFingerprint: applied ? args.permissionFingerprint : undefined,
      mcpUrl: args.mcpUrl,
      // A new provider session answers for itself; its predecessor's list
      // says nothing about it.
      toolsList: undefined,
    })
    return { status: 'adopted' as const, applied }
  },
})

/**
 * What the proxy learned about the current provider session — its endpoint
 * when the row predates the field, and the tool list it last returned. Only
 * the session named is patched: a lesson about a replaced session is stale by
 * definition and must not overwrite its successor's.
 */
export const rememberToolRouterSessionDetails = mutation({
  args: {
    ...toolRouterConfigArgs,
    providerSessionId: v.string(),
    mcpUrl: v.optional(v.string()),
    toolsList: v.optional(v.object({ permissionFingerprint: v.string(), resultJson: v.string() })),
    now: v.number(),
  },
  returns: v.object({ remembered: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const config = await toolRouterConfig(ctx, args.workspaceId, args.duetSessionId)
    if (config === null || config.providerSessionId !== args.providerSessionId) {
      return { remembered: false }
    }
    await ctx.db.patch(config._id, {
      ...(args.mcpUrl === undefined ? {} : { mcpUrl: args.mcpUrl }),
      ...(args.toolsList === undefined
        ? {}
        : {
            toolsList: {
              providerSessionId: args.providerSessionId,
              permissionFingerprint: args.toolsList.permissionFingerprint,
              resultJson: args.toolsList.resultJson,
              learnedAt: args.now,
            },
          }),
    })
    return { remembered: true }
  },
})

export const markToolRouterSessionPermissionsApplied = mutation({
  args: {
    ...toolRouterConfigArgs,
    providerSessionId: v.string(),
    permissionFingerprint: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const config = await toolRouterConfig(ctx, args.workspaceId, args.duetSessionId)
    if (config === null || config.providerSessionId !== args.providerSessionId) {
      return { applied: false }
    }
    if (config.permissionFingerprint !== args.permissionFingerprint) {
      // The provider update already happened. A late update for an older
      // fingerprint must invalidate readiness so MCP fails closed until the
      // current projection is applied again.
      await ctx.db.patch(config._id, { appliedPermissionFingerprint: undefined })
      return { applied: false }
    }
    await ctx.db.patch(config._id, { appliedPermissionFingerprint: args.permissionFingerprint })
    return { applied: true }
  },
})

export async function integrationPermissionFingerprint(toolkitSlugs: string[]): Promise<string> {
  const disabledToolkitSlugs = canonicalToolkitSlugs(toolkitSlugs)
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: PERMISSION_FINGERPRINT_VERSION, disabledToolkitSlugs }),
  )
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function canonicalToolkitSlugs(toolkitSlugs: string[]): string[] {
  return [...new Set(toolkitSlugs)].sort((left, right) => left.localeCompare(right))
}

async function toolRouterConfig(
  ctx: MutationCtx | QueryCtx,
  workspaceId: Id<'workspaces'>,
  inputDuetSessionId: string,
) {
  const duetSessionId = ctx.db.normalizeId('agentSessions', inputDuetSessionId)
  if (duetSessionId === null) return null
  const session = await ctx.db.get(duetSessionId)
  if (session === null || session.workspaceId !== workspaceId) return null
  const config = await ctx.db
    .query('composioToolRouterSessions')
    .withIndex('by_duet_session', q => q.eq('duetSessionId', duetSessionId))
    .unique()
  if (config === null || config.workspaceId !== workspaceId) return null
  return session.archiveState === 'deleting' ? null : config
}
