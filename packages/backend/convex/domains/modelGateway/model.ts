import { v } from 'convex/values'

import {
  GATEWAY_BILLING_MODES,
  GATEWAY_GENERATION_MODALITIES,
  GATEWAY_REQUEST_KINDS,
} from '@repo/contract'

import { internalMutation, mutation, query } from '../../_generated/server'
import {
  gatewayBlockValidator,
  attributionTierIdValidator,
  upstreamGenerationMetadataValidator,
} from '../../validators'
import { requireApiInternalKey } from '../apiKeys/model'
import {
  getGenerationImpl,
  recordUpstreamFailureImpl,
  recordUpstreamGenerationIdImpl,
} from './generations'
import { foldInferenceMarginImpl } from './marginRollup'
import { gatewayPreflightImpl } from './preflight'
import {
  applyGenerationSettlement,
  markGenerationChargeFailedImpl,
  releaseGenerationImpl,
  settleGenerationImpl,
  settleRoutedGenerationImpl,
  sweepMissedChargesImpl,
} from './settlement'

const modalityValidator = v.union(
  v.literal(GATEWAY_GENERATION_MODALITIES[0]),
  v.literal(GATEWAY_GENERATION_MODALITIES[1]),
  v.literal(GATEWAY_GENERATION_MODALITIES[2]),
  v.literal(GATEWAY_GENERATION_MODALITIES[3]),
)
const billingModeValidator = v.union(
  v.literal(GATEWAY_BILLING_MODES[0]),
  v.literal(GATEWAY_BILLING_MODES[1]),
)
const requestKindValidator = v.union(
  v.literal(GATEWAY_REQUEST_KINDS[0]),
  v.literal(GATEWAY_REQUEST_KINDS[1]),
)

// Convex requires a top-level object validator, so "generation requires
// model" is enforced by gatewayPreflightImpl (fail-closed), not the schema.
export const gatewayPreflightArgs = v.object({
  internalKey: v.string(),
  hashedKey: v.string(),
  workspaceSlug: v.optional(v.string()),
  requestKind: requestKindValidator,
  modality: modalityValidator,
  model: v.optional(v.string()),
  tier: v.optional(attributionTierIdValidator),
  billingMode: v.optional(billingModeValidator),
  estimateMicroUsd: v.optional(v.number()),
  now: v.optional(v.number()),
})

export const gatewayPreflight = mutation({
  args: gatewayPreflightArgs,
  returns: v.union(
    v.object({
      proceed: v.literal(true),
      workspaceId: v.id('workspaces'),
      workspaceSlug: v.string(),
      userId: v.id('users'),
      generationId: v.optional(v.id('gatewayGenerations')),
      reservationId: v.optional(v.string()),
    }),
    v.object({ proceed: v.literal(false), block: gatewayBlockValidator }),
  ),
  handler: (ctx, args) => gatewayPreflightImpl(ctx, args),
})

/** Gateway-owned read of the active global model-router policy. */
export const getModelRouterPolicy = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db
      .query('modelRouterPolicies')
      .withIndex('by_scope', q => q.eq('scope', 'global'))
      .unique()
    return row === null
      ? { version: 1 as const, rules: [], updatedAt: 0 }
      : { version: row.version, rules: row.rules, updatedAt: row.updatedAt }
  },
})

export const recordUpstreamGenerationIdArgs = v.object({
  internalKey: v.string(),
  generationId: v.id('gatewayGenerations'),
  upstreamGenerationId: v.string(),
  now: v.optional(v.number()),
})

export const recordUpstreamGenerationId = mutation({
  args: recordUpstreamGenerationIdArgs,
  returns: v.null(),
  handler: (ctx, args) => recordUpstreamGenerationIdImpl(ctx, args),
})

export const recordUpstreamFailureArgs = v.object({
  internalKey: v.string(),
  generationId: v.id('gatewayGenerations'),
  error: v.string(),
  now: v.optional(v.number()),
})

export const recordUpstreamFailure = mutation({
  args: recordUpstreamFailureArgs,
  returns: v.null(),
  handler: (ctx, args) => recordUpstreamFailureImpl(ctx, args),
})

export const settleGenerationArgs = v.object({
  internalKey: v.string(),
  generationId: v.id('gatewayGenerations'),
  upstreamCostMicroUsd: v.number(),
  upstreamMetadata: v.optional(upstreamGenerationMetadataValidator),
  now: v.optional(v.number()),
})

export const settleGeneration = mutation({
  args: settleGenerationArgs,
  returns: v.object({ accepted: v.literal(true) }),
  handler: (ctx, args) => settleGenerationImpl(ctx, args),
})

export const settleRoutedGenerationArgs = v.object({
  internalKey: v.string(),
  generationId: v.id('gatewayGenerations'),
  upstreamGenerationId: v.string(),
  provider: v.union(v.literal('openai'), v.literal('anthropic')),
  usage: v.object({
    uncachedInputTokens: v.number(),
    cachedInputTokens: v.number(),
    outputTokens: v.number(),
  }),
  cacheCreationInputTokens: v.optional(v.number()),
  now: v.optional(v.number()),
})

export const settleRoutedGeneration = mutation({
  args: settleRoutedGenerationArgs,
  returns: v.object({ accepted: v.literal(true) }),
  handler: (ctx, args) => settleRoutedGenerationImpl(ctx, args),
})

export const applyQueuedSettlement = internalMutation({
  args: { generationId: v.id('gatewayGenerations'), now: v.number() },
  handler: async (ctx, args) => {
    const generation = await ctx.db.get(args.generationId)
    if (generation === null) throw new Error('Generation not found')
    await applyGenerationSettlement(ctx, generation, args.now)
    return null
  },
})

export const markGenerationChargeFailedArgs = v.object({
  internalKey: v.string(),
  generationId: v.id('gatewayGenerations'),
  error: v.string(),
  upstreamCostMicroUsd: v.optional(v.number()),
  upstreamMetadata: v.optional(upstreamGenerationMetadataValidator),
  now: v.optional(v.number()),
})

export const markGenerationChargeFailed = mutation({
  args: markGenerationChargeFailedArgs,
  returns: v.null(),
  handler: (ctx, args) => markGenerationChargeFailedImpl(ctx, args),
})

export const releaseGenerationArgs = v.object({
  internalKey: v.string(),
  generationId: v.id('gatewayGenerations'),
  reason: v.optional(v.string()),
  now: v.optional(v.number()),
})

export const releaseGeneration = mutation({
  args: releaseGenerationArgs,
  returns: v.object({ released: v.boolean(), balanceMicroUsd: v.number() }),
  handler: (ctx, args) => releaseGenerationImpl(ctx, args),
})

export const sweepMissedChargesArgs = v.object({
  internalKey: v.string(),
  limit: v.optional(v.number()),
  now: v.optional(v.number()),
})

export const sweepMissedCharges = mutation({
  args: sweepMissedChargesArgs,
  returns: v.object({
    settlementQueued: v.number(),
    released: v.number(),
    failed: v.number(),
    reconcileQueued: v.number(),
  }),
  handler: (ctx, args) => sweepMissedChargesImpl(ctx, args),
})

export const foldInferenceMargin = mutation({
  args: { internalKey: v.string() },
  returns: v.object({ folded: v.number() }),
  handler: (ctx, args) => foldInferenceMarginImpl(ctx, args),
})

export const getGenerationArgs = v.object({
  internalKey: v.string(),
  generationId: v.id('gatewayGenerations'),
})

export const getGeneration = query({
  args: getGenerationArgs,
  handler: (ctx, args) => getGenerationImpl(ctx, args),
})
