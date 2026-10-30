import { v } from 'convex/values'

import { createApprovedModelCatalog, type ApprovedModel } from '@repo/contract'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { workspaceMonthlySpend } from '../domains/credits/workspaceSpend'
import { createPendingGenerationWithDb } from '../domains/modelGateway/generations'
import { gatewayPreflightArgs } from '../domains/modelGateway/model'
import { gatewayPreflightImpl } from '../domains/modelGateway/preflight'
import { attributionTierIdValidator } from '../validators'

export const createPendingGeneration = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    modality: v.union(
      v.literal('text'),
      v.literal('image'),
      v.literal('video'),
      v.literal('audio'),
    ),
    model: v.string(),
    tier: v.optional(attributionTierIdValidator),
    billingMode: v.union(v.literal('post_response'), v.literal('reservation')),
    chargeToWorkspace: v.boolean(),
    reservationId: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await createPendingGenerationWithDb(ctx, args)
  },
})

export const gatewayPreflightWithFixtureCatalog = mutation({
  args: {
    preflight: gatewayPreflightArgs,
    fixturePolicy: v.union(v.literal('standard'), v.literal('free'), v.literal('uncatalogued')),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.preflight.internalKey)
    if (args.preflight.requestKind !== 'generation' || args.preflight.model === undefined) {
      throw new Error('Fixture model policy requires generation preflight with a model')
    }
    const fixtureModelId =
      args.fixturePolicy === 'uncatalogued'
        ? `fixture-other-${crypto.randomUUID()}`
        : args.preflight.model
    const entry: ApprovedModel = {
      id: 'fixture:chat',
      gatewayModelId: fixtureModelId,
      kind: 'chat',
      name: 'Fixture chat',
      simpleName: 'Fixture',
      description: 'Isolated model-gateway policy fixture.',
      ...(args.fixturePolicy === 'free' ? { isFree: true } : {}),
    }
    const catalog = createApprovedModelCatalog([entry])
    return await gatewayPreflightImpl(ctx, args.preflight, catalog)
  },
})

export const listGenerationsForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('gatewayGenerations')
      .withIndex('by_workspace_created', q => q.eq('workspaceId', args.workspaceId))
      .order('asc')
      .collect()
  },
})

export const workspaceUsageSnapshotForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    const billingUser = await ctx.db.get(workspace.billingUserId)
    if (billingUser === null) throw new Error('Billing user not found')
    const daily = await ctx.db
      .query('usageRollups')
      .withIndex('by_workspace_granularity_period', q =>
        q.eq('workspaceId', args.workspaceId).eq('granularity', 'daily'),
      )
      .take(1000)
    const monthly = await ctx.db
      .query('usageRollups')
      .withIndex('by_workspace_granularity_period', q =>
        q.eq('workspaceId', args.workspaceId).eq('granularity', 'monthly'),
      )
      .take(1000)
    return {
      workspaceMonthlySpendMicroUsd: await workspaceMonthlySpend(ctx, workspace),
      accountMonthlySpendMicroUsd: billingUser.billing?.monthlySpendMicroUsd,
      daily,
      monthly,
    }
  },
})
