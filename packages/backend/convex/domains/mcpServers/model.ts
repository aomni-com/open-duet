import { ConvexError, v } from 'convex/values'

import {
  MAX_MCP_SERVERS_PER_WORKSPACE,
  McpDroppedToolNamesSchema,
  McpServerLabelSchema,
  McpServerNameSchema,
  McpServerUrlSchema,
  ROOT_AGENT_SCOPE,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { deleteCredentialsForServer } from './credentials'
import { deleteAuthorizationsForServer } from './oauth'

/**
 * Durable rows for the remote MCP servers a workspace attached itself.
 *
 * Everything here is gated by the API's internal key: `apps/api` owns the
 * user-facing authorization, exactly as it does for the Composio catalog. These
 * functions are the only writers of `mcpServers` apart from the proxy's health
 * signal in `health.ts`.
 */

const workspaceArgs = {
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
}

const authKindValidator = v.union(v.literal('none'), v.literal('oauth'), v.literal('static'))

/**
 * A newly registered server is usable immediately unless it still owes a human
 * a consent click. `static` counts as ready because the token arrives with the
 * registration request; only the OAuth branch has a round trip left to make.
 */
function initialState(authKind: 'none' | 'oauth' | 'static'): Doc<'mcpServers'>['state'] {
  return authKind === 'oauth' ? 'needs_auth' : 'ready'
}

export const registerMcpServer = mutation({
  args: {
    ...workspaceArgs,
    actorId: v.id('users'),
    name: v.string(),
    url: v.string(),
    label: v.optional(v.string()),
    authKind: authKindValidator,
    // D6's probe measurements, carried through from the probe that preceded
    // this call. A turn never recomputes them.
    toolCount: v.optional(v.number()),
    estimatedPromptBytes: v.optional(v.number()),
    droppedToolNames: v.optional(v.array(v.string())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const name = McpServerNameSchema.parse(args.name)
    const url = McpServerUrlSchema.parse(args.url)
    const label = McpServerLabelSchema.parse(args.label ?? name)
    const droppedToolNames =
      args.droppedToolNames === undefined
        ? undefined
        : McpDroppedToolNamesSchema.parse(args.droppedToolNames)
    if ((await mcpServerByName(ctx, args.workspaceId, name)) !== null) {
      throw new ConvexError({ error: 'duplicate_name' })
    }
    // The cap is a workspace-wide count rather than a per-turn one because the
    // launch marker carries every ready server: the ceiling that matters is
    // what one prompt can be asked to hold.
    const existing = await ctx.db
      .query('mcpServers')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .collect()
    if (existing.length >= MAX_MCP_SERVERS_PER_WORKSPACE) {
      throw new ConvexError({ error: 'server_limit' })
    }
    const now = args.now ?? Date.now()
    const serverId = await ctx.db.insert('mcpServers', {
      workspaceId: args.workspaceId,
      name,
      label,
      url,
      authKind: args.authKind,
      state: initialState(args.authKind),
      toolCount: args.toolCount,
      estimatedPromptBytes: args.estimatedPromptBytes,
      droppedToolNames,
      createdAt: now,
      createdByUserId: args.actorId,
      updatedAt: now,
    })
    return publicMcpServer((await ctx.db.get(serverId))!)
  },
})

export const listMcpServers = query({
  args: workspaceArgs,
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const servers = await ctx.db
      .query('mcpServers')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .collect()
    const policies = await ctx.db
      .query('mcpServerAgentPolicies')
      .withIndex('by_workspace_and_server', q => q.eq('workspaceId', args.workspaceId))
      .collect()
    const allowedByServer = new Map(
      policies.map(policy => [policy.serverId, policy.allowedAgentIds]),
    )
    return servers
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(server => ({
        ...publicMcpServer(server),
        // Absent stays absent: "every agent" is the missing row, and folding it
        // into an empty array here would erase the difference from "nobody".
        allowedAgentIds: allowedByServer.get(server._id),
      }))
  },
})

export const getMcpServer = query({
  args: { ...workspaceArgs, name: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const server = await mcpServerByName(ctx, args.workspaceId, args.name)
    return server === null ? null : publicMcpServer(server)
  },
})

/**
 * Removal is a cascade rather than a tombstone: the filesystem-shaped rule this
 * repo already follows is that a row's absence is the truth. Every table that
 * points at this server loses its row in the same transaction, so no reader has
 * to learn to exclude a dead parent.
 *
 * The registration row is deliberately NOT deleted here. It is shared across
 * every server behind one authorization server, and removing it needs an RFC
 * 7592 call that can fail; that is the disconnect slice's job.
 */
export const deleteMcpServer = mutation({
  args: { ...workspaceArgs, name: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const server = await mcpServerByName(ctx, args.workspaceId, args.name)
    if (server === null) return { name: args.name, removed: false }
    await deleteMcpServerRow(ctx, args.workspaceId, server)
    return { name: server.name, removed: true }
  },
})

/**
 * The cascade itself, shared with the disconnect sequence's last step so there
 * is one answer to "what does removing a server take with it".
 *
 * `deleteCredentialsForServer` is a no-op by then — the disconnect deleted the
 * credential before it went near the third party — and is called anyway,
 * because this must also be the whole cascade for the callers that never revoke
 * anything: a no-auth server, and the add path's rollback.
 */
export async function deleteMcpServerRow(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  server: Doc<'mcpServers'>,
): Promise<void> {
  await deleteCredentialsForServer(ctx, server._id)
  await deleteAuthorizationsForServer(ctx, server._id)
  const policy = await policyForServer(ctx, workspaceId, server._id)
  if (policy !== null) await ctx.db.delete(policy._id)
  await ctx.db.delete(server._id)
}

/**
 * The one writer of `state` outside registration.
 *
 * Keyed by row id rather than name because its caller is the OAuth callback,
 * which arrives with no Duet credential and no workspace slug — only the signed
 * state descriptor's server id. A name lookup there would mean trusting a name
 * carried across a third party.
 */
export const setMcpServerState = mutation({
  args: {
    ...workspaceArgs,
    serverId: v.id('mcpServers'),
    state: v.union(
      v.literal('needs_auth'),
      v.literal('ready'),
      v.literal('reauth_required'),
      v.literal('disconnecting'),
    ),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const server = await ctx.db.get(args.serverId)
    if (server === null || server.workspaceId !== args.workspaceId) {
      throw new ConvexError({ error: 'server_not_found' })
    }
    await patchMcpServerState(ctx, args.serverId, args.state, args.now ?? Date.now())
    return publicMcpServer((await ctx.db.get(args.serverId))!)
  },
})

/**
 * The one write that moves `state`, shared with the disconnect sequence's first
 * step. A second copy would be a second answer to what a state change touches.
 */
export async function patchMcpServerState(
  ctx: MutationCtx,
  serverId: Id<'mcpServers'>,
  state: Doc<'mcpServers'>['state'],
  now: number,
): Promise<void> {
  await ctx.db.patch(serverId, { state, updatedAt: now })
}

export const setMcpServerAgentPolicy = mutation({
  args: { ...workspaceArgs, name: v.string(), allowedAgentIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const server = await requireMcpServer(ctx, args.workspaceId, args.name)
    const allowedAgentIds = await canonicalAllowedAgentIds(
      ctx,
      args.workspaceId,
      args.allowedAgentIds,
    )
    const existing = await policyForServer(ctx, args.workspaceId, server._id)
    const now = Date.now()
    if (existing === null) {
      await ctx.db.insert('mcpServerAgentPolicies', {
        workspaceId: args.workspaceId,
        serverId: server._id,
        allowedAgentIds,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      await ctx.db.patch(existing._id, { allowedAgentIds, updatedAt: now })
    }
    return { name: server.name, allowedAgentIds }
  },
})

/** Clearing restores the third state — every agent — by removing the row. */
export const clearMcpServerAgentPolicy = mutation({
  args: { ...workspaceArgs, name: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const server = await requireMcpServer(ctx, args.workspaceId, args.name)
    const existing = await policyForServer(ctx, args.workspaceId, server._id)
    if (existing !== null) await ctx.db.delete(existing._id)
    return { name: server.name }
  },
})

export async function mcpServerByName(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  name: string,
): Promise<Doc<'mcpServers'> | null> {
  return await ctx.db
    .query('mcpServers')
    .withIndex('by_workspace_and_name', q => q.eq('workspaceId', workspaceId).eq('name', name))
    .unique()
}

export async function requireMcpServer(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  name: string,
): Promise<Doc<'mcpServers'>> {
  const server = await mcpServerByName(ctx, workspaceId, name)
  if (server === null) throw new ConvexError({ error: 'server_not_found' })
  return server
}

/**
 * The row as anything outside this domain may see it. There is no token to
 * strip — that is the whole point of the credential table — so this exists to
 * keep Convex's internal `_id` and `_creationTime` out of the API's hands.
 */
function publicMcpServer(server: Doc<'mcpServers'>) {
  return {
    id: server._id,
    name: server.name,
    label: server.label,
    url: server.url,
    authKind: server.authKind,
    state: server.state,
    toolCount: server.toolCount,
    estimatedPromptBytes: server.estimatedPromptBytes,
    droppedToolNames: server.droppedToolNames,
    lastSuccessAt: server.lastSuccessAt,
    lastErrorAt: server.lastErrorAt,
    lastErrorCode: server.lastErrorCode,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  }
}

async function policyForServer(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  serverId: Id<'mcpServers'>,
) {
  return await ctx.db
    .query('mcpServerAgentPolicies')
    .withIndex('by_workspace_and_server', q =>
      q.eq('workspaceId', workspaceId).eq('serverId', serverId),
    )
    .unique()
}

/**
 * Principals are canonicalized on the way in — deduplicated, `root` first, agent
 * ids sorted — so the stored list is comparable and a policy edit that changes
 * nothing writes the same array. Foreign or dangling agent ids are refused here
 * rather than silently dropped: a policy that quietly lost a principal reads as
 * a deliberate revocation.
 */
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
