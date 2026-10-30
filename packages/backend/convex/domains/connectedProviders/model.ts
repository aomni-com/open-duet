import { ConvexError, v } from 'convex/values'

import {
  ConnectedProviderIdSchema,
  ConnectedProviderStatusSchema,
  type ConnectedProviderId,
  type ConnectedProviderStatus,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { assertActorRole, assertRole } from '../workspaces/authorization'

export const connectedProviderIdValidator = v.union(
  v.literal('openai-codex'),
  v.literal('github-copilot'),
)

export const connectedProviderObservationValidator = v.object({
  provider: connectedProviderIdValidator,
  state: v.union(
    v.literal('connected'),
    v.literal('plan_ineligible'),
    v.literal('reconnect_needed'),
  ),
  connectedAt: v.number(),
  connectedByUserId: v.optional(v.string()),
  connectedByLabel: v.optional(v.string()),
  eligibilityCheckedAt: v.optional(v.number()),
})

const actorArgs = {
  workspaceId: v.id('workspaces'),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
}

const CONNECT_INTENT_TTL_MS = 60 * 60 * 1000

export const authorizeConnect = mutation({
  args: { ...actorArgs, provider: connectedProviderIdValidator },
  handler: async (ctx, args) => {
    const actorId = await mutationActor(ctx, args)
    const provider = ConnectedProviderIdSchema.parse(args.provider)
    const existing = await connectIntentByProvider(ctx, args.workspaceId, provider)
    const value = {
      workspaceId: args.workspaceId,
      provider,
      initiatedByUserId: actorId,
      startedAt: Date.now(),
    }
    if (existing === null) {
      await ctx.db.insert('connectedProviderConnectIntents', value)
    } else {
      await ctx.db.patch(existing._id, value)
    }
    return { ok: true as const }
  },
})

export const completeConnect = mutation({
  args: {
    workspaceId: v.id('workspaces'),
    internalKey: v.string(),
    actorId: v.id('users'),
    connection: connectedProviderObservationValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const { userId: actorId } = await assertActorRole(ctx, args.workspaceId, args.actorId, 'viewer')
    const connection = ConnectedProviderStatusSchema.parse(args.connection)
    const initiatedByUserId = await consumeConnectIntent(
      ctx,
      args.workspaceId,
      connection.provider,
      Date.now(),
    )
    return await upsertConnection(ctx, {
      workspaceId: args.workspaceId,
      actorId: initiatedByUserId ?? actorId,
      connection,
    })
  },
})

export const requestDisconnect = mutation({
  args: { ...actorArgs, provider: connectedProviderIdValidator },
  handler: async (ctx, args) => {
    const actor = await mutationActorWithRole(ctx, args)
    const provider = ConnectedProviderIdSchema.parse(args.provider)
    const [connection, connectIntent] = await Promise.all([
      connectionByProvider(ctx, args.workspaceId, provider),
      connectIntentByProvider(ctx, args.workspaceId, provider),
    ])
    const pendingConnectorId =
      connectIntent !== null && Date.now() - connectIntent.startedAt <= CONNECT_INTENT_TTL_MS
        ? connectIntent.initiatedByUserId
        : undefined
    const connectedByUserId = connection?.connectedByUserId ?? pendingConnectorId
    if (
      connectedByUserId !== undefined &&
      actor.role !== 'owner' &&
      connectedByUserId !== actor.userId
    ) {
      throw new ConvexError({ error: 'disconnect_forbidden' })
    }
    if (connectIntent !== null) await ctx.db.delete(connectIntent._id)
    if (connection === null || connection.state === 'disconnect_requested') {
      return { ok: true as const }
    }
    await ctx.db.patch(connection._id, { state: 'disconnect_requested' })
    return { ok: true as const }
  },
})

/**
 * Fold a live VM reading into the stored rows. The VM is the only authority on
 * which providers are connected, but its answer must survive the VM being
 * paused or unreachable — so a reading taken on demand is written through here
 * and the stored rows serve every read.
 */
export const applyObservation = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    connectedProviders: v.array(connectedProviderObservationValidator),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await applyObservationImpl(ctx, {
      workspaceId: args.workspaceId,
      connectedProviders: ConnectedProviderStatusSchema.array().parse(args.connectedProviders),
      now: args.now ?? Date.now(),
    })
  },
})

export const listForWorkspace = query({
  args: actorArgs,
  handler: async (ctx, args) => {
    const actor = await queryActorWithRole(ctx, args)
    const rows = await ctx.db
      .query('connectedProviders')
      .withIndex('by_workspace_and_provider', q => q.eq('workspaceId', args.workspaceId))
      .collect()
    const visible = rows.filter(row => row.state !== 'disconnect_requested')
    return await Promise.all(
      visible.map(async row => {
        const user = await ctx.db.get(row.connectedByUserId)
        return {
          provider: row.provider,
          state: row.state,
          connectedAt: row.connectedAt,
          connectedByUserId: row.connectedByUserId,
          connectedByLabel: displayName(user),
          ...(row.eligibilityCheckedAt === undefined
            ? {}
            : { eligibilityCheckedAt: row.eligibilityCheckedAt }),
          canDisconnect: actor.role === 'owner' || actor.userId === row.connectedByUserId,
        }
      }),
    )
  },
})

export async function applyObservationImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    connectedProviders: ConnectedProviderStatus[]
    now: number
  },
): Promise<void> {
  const connectIntents = await ctx.db
    .query('connectedProviderConnectIntents')
    .withIndex('by_workspace_and_provider', q => q.eq('workspaceId', args.workspaceId))
    .collect()
  for (const intent of connectIntents) {
    if (args.now - intent.startedAt > CONNECT_INTENT_TTL_MS) {
      await ctx.db.delete(intent._id)
    }
  }

  const observed = new Map(
    args.connectedProviders.map(connection => [connection.provider, connection] as const),
  )
  const existing = await ctx.db
    .query('connectedProviders')
    .withIndex('by_workspace_and_provider', q => q.eq('workspaceId', args.workspaceId))
    .collect()
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')

  for (const row of existing) {
    const connection = observed.get(row.provider)
    observed.delete(row.provider)
    if (row.state === 'disconnect_requested') {
      if (connection === undefined) await ctx.db.delete(row._id)
      continue
    }
    if (connection === undefined) {
      if (row.state === 'connected') {
        await ctx.db.patch(row._id, { state: 'reconnect_needed' })
      }
      continue
    }
    const initiatedByUserId = await consumeConnectIntent(
      ctx,
      args.workspaceId,
      connection.provider,
      args.now,
    )
    await ctx.db.patch(row._id, {
      state: connection.state,
      connectedAt: connection.connectedAt,
      eligibilityCheckedAt: connection.eligibilityCheckedAt,
      ...(initiatedByUserId === undefined ? {} : { connectedByUserId: initiatedByUserId }),
    })
  }

  // A VM-side connection may predate connect-intent tracking. Only those
  // unclaimed observations fall back to the workspace owner.
  for (const connection of observed.values()) {
    const initiatedByUserId = await consumeConnectIntent(
      ctx,
      args.workspaceId,
      connection.provider,
      args.now,
    )
    await ctx.db.insert('connectedProviders', {
      workspaceId: args.workspaceId,
      provider: connection.provider,
      state: connection.state,
      connectedByUserId: initiatedByUserId ?? workspace.billingUserId,
      connectedAt: connection.connectedAt,
      ...(connection.eligibilityCheckedAt === undefined
        ? {}
        : { eligibilityCheckedAt: connection.eligibilityCheckedAt }),
    })
  }
}

export async function disconnectDirectivesForWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<ConnectedProviderId[]> {
  const rows = await ctx.db
    .query('connectedProviders')
    .withIndex('by_workspace_and_provider', q => q.eq('workspaceId', workspaceId))
    .collect()
  return rows
    .filter(row => row.state === 'disconnect_requested')
    .map(row => ConnectedProviderIdSchema.parse(row.provider))
}

async function upsertConnection(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    actorId: Id<'users'>
    connection: ConnectedProviderStatus
  },
) {
  const existing = await connectionByProvider(ctx, args.workspaceId, args.connection.provider)
  const value = {
    workspaceId: args.workspaceId,
    provider: args.connection.provider,
    state: args.connection.state,
    connectedByUserId: args.actorId,
    connectedAt: args.connection.connectedAt,
    eligibilityCheckedAt: args.connection.eligibilityCheckedAt,
  }
  if (existing === null) return await ctx.db.insert('connectedProviders', value)
  await ctx.db.patch(existing._id, value)
  return existing._id
}

async function connectionByProvider(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  provider: ConnectedProviderId,
) {
  return await ctx.db
    .query('connectedProviders')
    .withIndex('by_workspace_and_provider', q =>
      q.eq('workspaceId', workspaceId).eq('provider', provider),
    )
    .unique()
}

async function connectIntentByProvider(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  provider: ConnectedProviderId,
) {
  return await ctx.db
    .query('connectedProviderConnectIntents')
    .withIndex('by_workspace_and_provider', q =>
      q.eq('workspaceId', workspaceId).eq('provider', provider),
    )
    .unique()
}

async function consumeConnectIntent(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  provider: ConnectedProviderId,
  now: number,
): Promise<Id<'users'> | undefined> {
  const intent = await connectIntentByProvider(ctx, workspaceId, provider)
  if (intent === null) return undefined
  await ctx.db.delete(intent._id)
  if (now - intent.startedAt > CONNECT_INTENT_TTL_MS) return undefined
  return intent.initiatedByUserId
}

async function mutationActor(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; internalKey?: string; actorId?: Id<'users'> },
): Promise<Id<'users'>> {
  return (await mutationActorWithRole(ctx, args)).userId
}

async function mutationActorWithRole(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; internalKey?: string; actorId?: Id<'users'> },
) {
  if (args.internalKey === undefined) {
    if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
    return await assertRole(ctx, args.workspaceId, 'viewer')
  }
  requireApiInternalKey(args.internalKey)
  if (args.actorId === undefined) throw new Error('actorId is required')
  return await assertActorRole(ctx, args.workspaceId, args.actorId, 'viewer')
}

async function queryActorWithRole(
  ctx: QueryCtx,
  args: { workspaceId: Id<'workspaces'>; internalKey?: string; actorId?: Id<'users'> },
) {
  if (args.internalKey === undefined) {
    if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
    return await assertRole(ctx, args.workspaceId, 'viewer')
  }
  requireApiInternalKey(args.internalKey)
  if (args.actorId === undefined) throw new Error('actorId is required')
  return await assertActorRole(ctx, args.workspaceId, args.actorId, 'viewer')
}

function displayName(user: Doc<'users'> | null): string {
  if (user === null) return 'Unknown member'
  return user.name?.trim() || user.email
}
