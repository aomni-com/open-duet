import { makeFunctionReference, type FunctionReference } from 'convex/server'
import type { Infer } from 'convex/values'

import {
  RECONCILE_BACKOFF_MS,
  type BillingMode,
  type GenerationModality,
  type AttributionTierId,
} from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { generationSettlement } from '../credits/settlementQueue'
import type {
  getGenerationArgs,
  recordUpstreamFailureArgs,
  recordUpstreamGenerationIdArgs,
} from './model'

export async function recordUpstreamGenerationIdImpl(
  ctx: MutationCtx,
  args: Infer<typeof recordUpstreamGenerationIdArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const generation = await ctx.db.get(args.generationId)
  if (generation === null) throw new Error('Generation not found')
  if (
    generation.upstreamGenerationId !== undefined &&
    generation.upstreamGenerationId !== args.upstreamGenerationId
  ) {
    throw new Error('Generation already recorded a different upstream id')
  }
  if (generation.status === 'forwarding') {
    await ctx.db.patch(args.generationId, {
      upstreamGenerationId: args.upstreamGenerationId,
      status: 'reconciling',
      updatedAt: args.now ?? Date.now(),
    })
    await scheduleReconcile(ctx, args.generationId, 1, RECONCILE_BACKOFF_MS[0])
  }
  return null
}

export async function recordUpstreamFailureImpl(
  ctx: MutationCtx,
  args: Infer<typeof recordUpstreamFailureArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const generation = await ctx.db.get(args.generationId)
  if (generation === null) throw new Error('Generation not found')
  if (generation.status === 'settled' || generation.status === 'released') return null
  if ((await generationSettlement(ctx, generation._id)) !== null) return null
  await ctx.db.patch(args.generationId, {
    error: args.error,
    status: 'upstream_failed',
    updatedAt: args.now ?? Date.now(),
  })
  return null
}

export async function getGenerationImpl(ctx: QueryCtx, args: Infer<typeof getGenerationArgs>) {
  requireApiInternalKey(args.internalKey)
  return await ctx.db.get(args.generationId)
}

export async function createPendingGenerationWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    userId: Id<'users'>
    modality: GenerationModality
    model: string
    tier?: AttributionTierId
    billingMode: BillingMode
    chargeToWorkspace: boolean
    reservationId?: string
    appId?: Id<'apps'>
    appSlug?: string
    now?: number
  },
): Promise<{ generationId: Id<'gatewayGenerations'> }> {
  const now = args.now ?? Date.now()
  const generationId = await ctx.db.insert('gatewayGenerations', {
    workspaceId: args.workspaceId,
    userId: args.userId,
    modality: args.modality,
    model: args.model,
    tier: args.tier,
    billingMode: args.billingMode,
    chargeToWorkspace: args.chargeToWorkspace,
    status: 'forwarding',
    reservationId: args.reservationId,
    appId: args.appId,
    appSlug: args.appSlug,
    createdAt: now,
    updatedAt: now,
  })
  return { generationId }
}

export async function scheduleReconcile(
  ctx: MutationCtx,
  generationId: Id<'gatewayGenerations'>,
  attempt: number,
  delayMs = 0,
): Promise<void> {
  await ctx.scheduler.runAfter(
    delayMs,
    fnAction('domains/modelGateway/actions:reconcileGeneration'),
    {
      internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
      generationId,
      attempt,
    },
  )
}

function fnAction(name: string): FunctionReference<'action'> {
  return makeFunctionReference(name) as FunctionReference<'action'>
}
