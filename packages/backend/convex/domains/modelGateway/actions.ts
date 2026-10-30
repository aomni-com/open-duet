'use node'

import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { dollarsToMicroUsd, RECONCILE_BACKOFF_MS } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import { internalAction, type ActionCtx } from '../../_generated/server'
import { aiGatewayBaseUrl } from '../../config'
import { fetchAiGatewayGenerationInfo } from '../../services/aiGateway'
import { requireApiInternalKey } from '../apiKeys/model'

export const reconcileGeneration = internalAction({
  args: {
    internalKey: v.string(),
    generationId: v.id('gatewayGenerations'),
    attempt: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  returns: v.object({ done: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const generation = (await ctx.runQuery(fnQuery('domains/modelGateway/model:getGeneration'), {
      internalKey: args.internalKey,
      generationId: args.generationId,
    })) as {
      status: string
      billingMode?: string
      tier?: string
      upstreamGenerationId?: string
    } | null
    if (generation === null) return { done: true, reason: 'missing_generation' }
    if (generation.status !== 'reconciling') return { done: true, reason: 'not_reconciling' }
    if (generation.upstreamGenerationId === undefined) {
      await releaseGeneration(ctx, args, 'missing_upstream_generation_id')
      return { done: true, reason: 'missing_upstream_generation_id' }
    }

    const attempt = args.attempt ?? 0
    if (attempt >= RECONCILE_BACKOFF_MS.length) {
      await releaseGeneration(ctx, args, 'reconcile_timeout')
      return { done: true, reason: 'reconcile_timeout' }
    }

    const apiKey = process.env.AI_GATEWAY_API_KEY
    if (!apiKey)
      throw new Error('AI_GATEWAY_API_KEY is required to reconcile model gateway generations')
    const result = await fetchAiGatewayGenerationInfo({
      apiKey,
      generationId: generation.upstreamGenerationId,
      baseUrl: aiGatewayBaseUrl(),
    })
    if (result.ready) {
      const { upstreamCostUsd, ...upstreamMetadata } = result.info
      const upstreamCostMicroUsd = dollarsToMicroUsd(upstreamCostUsd)
      if (
        upstreamCostMicroUsd === 0 &&
        generation.billingMode === 'reservation' &&
        generation.tier === undefined
      ) {
        await releaseGeneration(ctx, args, 'zero_cost')
        return { done: true, reason: 'zero_cost' }
      }
      try {
        await ctx.runMutation(fnMutation('domains/modelGateway/model:settleGeneration'), {
          internalKey: args.internalKey,
          generationId: args.generationId,
          upstreamCostMicroUsd,
          upstreamMetadata,
          now: args.now,
        })
      } catch (error) {
        // Persist the cost and park the generation as charge_failed so the sweep
        // retries a fully-specified settle instead of re-queueing this reconcile
        // (and dying on the same error) forever.
        await ctx.runMutation(fnMutation('domains/modelGateway/model:markGenerationChargeFailed'), {
          internalKey: args.internalKey,
          generationId: args.generationId,
          error: error instanceof Error ? error.message : 'settlement_failed',
          upstreamCostMicroUsd,
          upstreamMetadata,
          now: args.now,
        })
        return { done: true, reason: 'charge_failed' }
      }
      return { done: true, reason: 'settlement_accepted' }
    }

    await ctx.scheduler.runAfter(
      RECONCILE_BACKOFF_MS[attempt]!,
      fnAction('domains/modelGateway/actions:reconcileGeneration'),
      {
        internalKey: args.internalKey,
        generationId: args.generationId,
        attempt: attempt + 1,
        now: args.now,
      },
    )
    return { done: false, reason: 'not_ready' }
  },
})

async function releaseGeneration(
  ctx: ActionCtx,
  args: { internalKey: string; generationId: Id<'gatewayGenerations'>; now?: number },
  reason: string,
): Promise<void> {
  await ctx.runMutation(fnMutation('domains/modelGateway/model:releaseGeneration'), {
    internalKey: args.internalKey,
    generationId: args.generationId,
    reason,
    now: args.now,
  })
}

function fnQuery(name: string): FunctionReference<'query'> {
  return makeFunctionReference(name) as FunctionReference<'query'>
}

function fnMutation(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}

function fnAction(name: string): FunctionReference<'action'> {
  return makeFunctionReference(name) as FunctionReference<'action'>
}
