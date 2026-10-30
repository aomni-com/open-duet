import { ConvexError, type Infer } from 'convex/values'

import { priceTierUsageMicroUsd, tierBillsAtFlatRate } from '@repo/contract'

import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { billingUserForWorkspaceOrNull } from '../credits/creditsShared'
import { applyLedgerEntryWithDb } from '../credits/ledger'
import { releaseReservationWithDb, settleReservationWithDb } from '../credits/reservations'
import {
  enqueueSettlement,
  generationSettlement,
  retryFailedSettlement,
} from '../credits/settlementQueue'
import { spendableBalance, walletOf } from '../credits/wallet'
import { scheduleReconcile } from './generations'
import type {
  markGenerationChargeFailedArgs,
  releaseGenerationArgs,
  settleGenerationArgs,
  settleRoutedGenerationArgs,
  sweepMissedChargesArgs,
} from './model'

type GenerationStatus = Doc<'gatewayGenerations'>['status']

export async function settleGenerationImpl(
  ctx: MutationCtx,
  args: Infer<typeof settleGenerationArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const generation = await ctx.db.get(args.generationId)
  if (generation === null) throw new Error('Generation not found')
  if (
    generation.status === 'settled' ||
    generation.status === 'released' ||
    generation.status === 'upstream_failed'
  ) {
    return { accepted: true as const }
  }
  const queued = await generationSettlement(ctx, generation._id)
  if (queued?.status === 'pending') return { accepted: true as const }
  await ctx.db.patch(generation._id, {
    upstreamCostMicroUsd: Math.max(0, args.upstreamCostMicroUsd),
    upstreamMetadata: args.upstreamMetadata,
    updatedAt: args.now ?? Date.now(),
  })
  if (queued !== null) await retryFailedSettlement(ctx, queued._id)
  else
    await enqueueSettlement(ctx, {
      kind: 'generation',
      generationId: generation._id,
      occurredAt: args.now ?? Date.now(),
    })
  return { accepted: true as const }
}

/** Settle a configured route from native provider usage without Vercel cost lookup. */
export async function settleRoutedGenerationImpl(
  ctx: MutationCtx,
  args: Infer<typeof settleRoutedGenerationArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const generation = await ctx.db.get(args.generationId)
  if (generation === null) throw new Error('Generation not found')
  if (
    generation.status === 'settled' ||
    generation.status === 'released' ||
    generation.status === 'upstream_failed'
  )
    return { accepted: true as const }
  if (generation.tier === undefined || !tierBillsAtFlatRate(generation.tier, generation.model)) {
    throw new Error('Configured route requires a flat-rate tier generation')
  }
  const counts = [
    args.usage.uncachedInputTokens,
    args.usage.cachedInputTokens,
    args.usage.outputTokens,
    args.cacheCreationInputTokens ?? 0,
  ]
  if (counts.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Invalid routed usage')
  }
  if (
    generation.upstreamGenerationId !== undefined &&
    generation.upstreamGenerationId !== args.upstreamGenerationId
  ) {
    throw new Error('Generation already recorded a different upstream id')
  }
  const now = args.now ?? Date.now()
  const queued = await generationSettlement(ctx, generation._id)
  if (queued?.status === 'pending') return { accepted: true as const }
  const routedMetadata = {
    provider: args.provider,
    routeSource: 'configured_upstream' as const,
    usage: args.usage,
    ...(args.cacheCreationInputTokens === undefined
      ? {}
      : { cacheCreationInputTokens: args.cacheCreationInputTokens }),
  }
  await ctx.db.patch(generation._id, {
    upstreamGenerationId: args.upstreamGenerationId,
    upstreamMetadata: routedMetadata,
    updatedAt: now,
  })
  if (queued !== null) await retryFailedSettlement(ctx, queued._id)
  else
    await enqueueSettlement(ctx, {
      kind: 'generation',
      generationId: generation._id,
      occurredAt: now,
    })
  return { accepted: true as const }
}

export async function markGenerationChargeFailedImpl(
  ctx: MutationCtx,
  args: Infer<typeof markGenerationChargeFailedArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const generation = await ctx.db.get(args.generationId)
  if (generation === null) throw new Error(`Generation ${args.generationId} not found`)
  if (generation.status === 'settled' || generation.status === 'released') return null
  if ((await generationSettlement(ctx, generation._id)) !== null) return null
  await ctx.db.patch(generation._id, {
    status: 'charge_failed',
    error: args.error,
    ...(args.upstreamCostMicroUsd === undefined
      ? {}
      : { upstreamCostMicroUsd: Math.max(0, args.upstreamCostMicroUsd) }),
    ...(args.upstreamMetadata === undefined ? {} : { upstreamMetadata: args.upstreamMetadata }),
    updatedAt: args.now ?? Date.now(),
  })
  return null
}

export async function releaseGenerationImpl(
  ctx: MutationCtx,
  args: Infer<typeof releaseGenerationArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const generation = await ctx.db.get(args.generationId)
  if (generation === null) throw new Error('Generation not found')
  return await releaseGenerationWithDb(ctx, generation, args.reason ?? 'upstream_failed', args.now)
}

// No legitimate request forwards for an hour; anything older lost its
// upstream id and is unreconcilable.
export const STRANDED_FORWARDING_THRESHOLD_MS = 60 * 60 * 1000

export async function sweepMissedChargesImpl(
  ctx: MutationCtx,
  args: Infer<typeof sweepMissedChargesArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const limit = Math.min(args.limit ?? 100, 500)
  const candidates = await unsettledCandidates(ctx, limit)
  let settlementQueued = 0
  let released = 0
  let failed = 0
  let reconcileQueued = 0
  for (const generation of candidates) {
    try {
      if (generation.status === 'forwarding') {
        // Stranded: the upstream generation id was never recorded (a transient
        // write failure after the response streamed), so there is nothing to
        // reconcile cost against and the row can never bill honestly. Release
        // stale rows outright — no charge, no parked state (David,
        // 2026-07-31). Fresh rows are still in flight; leave them alone.
        const now = args.now ?? Date.now()
        if (now - generation.createdAt >= STRANDED_FORWARDING_THRESHOLD_MS) {
          const result = await releaseGenerationWithDb(
            ctx,
            generation,
            'upstream_id_never_recorded',
            args.now,
          )
          if (result.released) released += 1
        } else {
          await ctx.db.patch(generation._id, { updatedAt: now })
        }
      } else if (generation.status === 'upstream_failed') {
        const result = await releaseGenerationWithDb(
          ctx,
          generation,
          generation.error ?? 'upstream_failed',
          args.now,
        )
        if (result.released) released += 1
      } else if (
        generation.status === 'reconciling' &&
        generation.upstreamCostMicroUsd === undefined
      ) {
        await scheduleReconcile(ctx, generation._id, 0)
        await ctx.db.patch(generation._id, { updatedAt: args.now ?? Date.now() })
        reconcileQueued += 1
      } else {
        const existing = await generationSettlement(ctx, generation._id)
        if (existing === null) {
          await enqueueSettlement(ctx, {
            kind: 'generation',
            generationId: generation._id,
            occurredAt: args.now ?? Date.now(),
          })
          settlementQueued += 1
        } else if (existing.status === 'failed') failed += 1
        await ctx.db.patch(generation._id, { updatedAt: args.now ?? Date.now() })
      }
    } catch (error) {
      failed += 1
      await ctx.db.patch(generation._id, {
        status: 'charge_failed',
        error: error instanceof Error ? error.message : 'settlement_failed',
        updatedAt: args.now ?? Date.now(),
      })
    }
  }
  return { settlementQueued, released, failed, reconcileQueued }
}

export async function applyGenerationSettlement(
  ctx: MutationCtx,
  generation: Doc<'gatewayGenerations'>,
  now = Date.now(),
): Promise<void> {
  if (
    generation.status === 'settled' ||
    generation.status === 'released' ||
    generation.status === 'upstream_failed'
  )
    return
  if (
    generation.upstreamGenerationId === undefined ||
    (generation.upstreamCostMicroUsd === undefined &&
      generation.upstreamMetadata?.routeSource !== 'configured_upstream')
  ) {
    throw new Error(`Generation ${generation._id} is missing upstream settlement data`)
  }

  const billing = billedCostForGeneration(generation, generation.upstreamCostMicroUsd)
  if (!billing.ok) {
    throw new ConvexError(billing.error)
  }
  const billedCostMicroUsd = billing.billedCostMicroUsd

  if (generation.chargeToWorkspace === false) {
    await ctx.db.patch(generation._id, {
      billedCostMicroUsd: 0,
      status: 'settled',
      settledAt: now,
      updatedAt: now,
    })
    return
  }

  const workspace = await ctx.db.get(generation.workspaceId)
  if (workspace === null) {
    throw new Error(
      `Workspace ${generation.workspaceId} not found for generation ${generation._id}`,
    )
  }
  if (
    generation.billingMode !== 'reservation' &&
    (workspace.status === 'deleted' || workspace.status === 'retired') &&
    (await billingUserForWorkspaceOrNull(ctx, workspace)) === null
  ) {
    // Nobody can ever be charged: the workspace is gone and its billing membership
    // was purged (staging E2E identity retirement). Void the charge instead of
    // failing settlement forever.
    await ctx.db.patch(generation._id, {
      status: 'released',
      error: 'billing_unresolvable',
      settledAt: now,
      updatedAt: now,
    })
    return
  }

  const usageRollup = {
    ...(generation.appId === undefined ? {} : { appId: generation.appId }),
    ...(generation.appSlug === undefined ? {} : { appSlug: generation.appSlug }),
    ...(generation.upstreamMetadata?.usage === undefined
      ? {}
      : {
          inputTokens:
            generation.upstreamMetadata.usage.uncachedInputTokens +
            generation.upstreamMetadata.usage.cachedInputTokens,
          outputTokens: generation.upstreamMetadata.usage.outputTokens,
        }),
  }
  const metadata = {
    generationId: generation._id,
    upstreamGenerationId: generation.upstreamGenerationId,
    modality: generation.modality,
    model: generation.model,
    ...(generation.upstreamCostMicroUsd === undefined
      ? {}
      : { upstreamCostMicroUsd: generation.upstreamCostMicroUsd }),
    ...(generation.upstreamMetadata?.provider === undefined
      ? {}
      : { provider: generation.upstreamMetadata.provider }),
    ...(generation.upstreamMetadata?.routeSource === undefined
      ? {}
      : { routeSource: generation.upstreamMetadata.routeSource }),
    ...(generation.upstreamMetadata?.usage === undefined
      ? {}
      : { usage: generation.upstreamMetadata.usage }),
    ...(generation.upstreamMetadata?.cacheCreationInputTokens === undefined
      ? {}
      : { cacheCreationInputTokens: generation.upstreamMetadata.cacheCreationInputTokens }),
    ...usageRollup,
  }
  if (generation.billingMode === 'reservation') {
    if (generation.reservationId === undefined)
      throw new Error('Media generation is missing reservation')
    await settleReservationWithDb(ctx, {
      workspaceId: generation.workspaceId,
      reservationId: generation.reservationId,
      actualCostMicroUsd: billedCostMicroUsd,
      userId: generation.userId,
      metadata,
      usageRollup,
      now,
    })
  } else {
    await applyLedgerEntryWithDb(ctx, {
      workspaceId: generation.workspaceId,
      amountMicroUsd: billedCostMicroUsd === 0 ? 0 : -billedCostMicroUsd,
      type: 'usage',
      reference: `ai_generation:${generation.upstreamGenerationId}`,
      userId: generation.userId,
      metadata,
      transactionMetadata: generation.tier === undefined ? undefined : { tier: generation.tier },
      usageRollup,
      now,
    })
  }

  await ctx.db.patch(generation._id, {
    billedCostMicroUsd,
    status: 'settled',
    settledAt: now,
    updatedAt: now,
  })
}

function billedCostForGeneration(
  generation: Doc<'gatewayGenerations'>,
  upstreamCostMicroUsd: number | undefined,
): { ok: true; billedCostMicroUsd: number } | { ok: false; error: string } {
  if (generation.upstreamMetadata?.routeSource === 'configured_upstream') {
    const tier = generation.tier
    if (
      tier === undefined ||
      !tierBillsAtFlatRate(tier, generation.model) ||
      generation.upstreamMetadata.usage === undefined
    ) {
      return { ok: false, error: 'routed generation is missing flat-rate usage' }
    }
    return {
      ok: true,
      billedCostMicroUsd: priceTierUsageMicroUsd(tier, generation.upstreamMetadata.usage),
    }
  }
  if (upstreamCostMicroUsd === undefined) {
    return { ok: false, error: 'generation is missing upstream cost' }
  }
  // No tier is a legacy/internal generation; the services tier is a deliberate
  // one. Both bill what the model actually cost, because neither is a person
  // choosing capability from a ladder — there is no route to cover, only a
  // pinned model. A user tier bills the same way for a model outside the set
  // its rate was priced against.
  if (generation.tier === undefined || !tierBillsAtFlatRate(generation.tier, generation.model)) {
    return { ok: true, billedCostMicroUsd: upstreamCostMicroUsd }
  }
  if (generation.upstreamMetadata?.usage === undefined) {
    return { ok: false, error: 'tiered generation is missing token telemetry' }
  }
  return {
    ok: true,
    billedCostMicroUsd: priceTierUsageMicroUsd(generation.tier, generation.upstreamMetadata.usage),
  }
}

async function releaseGenerationWithDb(
  ctx: MutationCtx,
  generation: Doc<'gatewayGenerations'>,
  reason: string,
  now = Date.now(),
): Promise<{ released: boolean; balanceMicroUsd: number }> {
  if (generation.status === 'settled' || generation.status === 'released') {
    return { released: false, balanceMicroUsd: await bestEffortBalance(ctx, generation) }
  }
  if ((await generationSettlement(ctx, generation._id)) !== null) {
    return { released: false, balanceMicroUsd: await bestEffortBalance(ctx, generation) }
  }
  if (generation.billingMode !== 'reservation' || generation.reservationId === undefined) {
    const balanceMicroUsd = await bestEffortBalance(ctx, generation)
    await ctx.db.patch(generation._id, {
      status: 'released',
      error: reason,
      settledAt: now,
      updatedAt: now,
    })
    return { released: true, balanceMicroUsd }
  }
  const result = await releaseReservationWithDb(ctx, {
    workspaceId: generation.workspaceId,
    reservationId: generation.reservationId,
    reason,
    userId: generation.userId,
    now,
  })
  await ctx.db.patch(generation._id, {
    status: 'released',
    error: reason,
    settledAt: now,
    updatedAt: now,
  })
  return result
}

/**
 * Balance reporting must not block terminal transitions: a generation on a dead
 * workspace whose billing membership was purged has no resolvable wallet, and
 * these paths only echo the balance back to internal reconciliation callers.
 */
async function bestEffortBalance(
  ctx: MutationCtx,
  generation: Doc<'gatewayGenerations'>,
): Promise<number> {
  const workspace = await ctx.db.get(generation.workspaceId)
  if (workspace === null) return 0
  const user = await billingUserForWorkspaceOrNull(ctx, workspace)
  return user === null ? 0 : spendableBalance(walletOf(user))
}

export async function unsettledCandidates(
  ctx: MutationCtx,
  limit: number,
): Promise<Array<Doc<'gatewayGenerations'>>> {
  const statuses: GenerationStatus[] = [
    'reconciling',
    'charge_failed',
    'upstream_failed',
    'forwarding',
  ]
  const rows = await Promise.all(
    statuses.map(
      async status =>
        await ctx.db
          .query('gatewayGenerations')
          .withIndex('by_status_updated', q => q.eq('status', status))
          .order('asc')
          .take(limit),
    ),
  )
  return rows
    .flat()
    .sort(
      (left, right) => left.updatedAt - right.updatedAt || left._creationTime - right._creationTime,
    )
    .slice(0, limit)
}
