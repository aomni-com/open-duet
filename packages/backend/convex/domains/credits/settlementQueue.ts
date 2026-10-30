import { ping, vBatchQueryArgs, vBatchResult } from '@convex-dev/batch-worker'
import { ConvexError, v, type Infer } from 'convex/values'

import { CreditTransactionReferenceSchema } from '@repo/contract'

import { components, internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import { internalMutation, internalQuery, type MutationCtx } from '../../_generated/server'
import { applyLedgerEntryWithDb } from './ledger'
import { creditTransactionMetadata } from './metadata'
import { settlementOperationValidator } from './settlementTypes'

const BATCH_SIZE = 8
const BATCH_DEBOUNCE_MS = 100
type SettlementOperation = Infer<typeof settlementOperationValidator>

export async function enqueueSettlement(ctx: MutationCtx, operation: SettlementOperation) {
  if (operation.kind === 'generation') {
    const existing = await generationSettlement(ctx, operation.generationId)
    if (existing !== null) return { accepted: true as const, settlementId: existing._id }
    await ctx.db.patch(operation.generationId, { status: 'reconciling', error: undefined })
  }
  if (operation.kind === 'service') {
    if (!Number.isFinite(operation.amountMicroUsd) || operation.amountMicroUsd <= 0) {
      throw new Error('Service charge must be a positive finite amount')
    }
    CreditTransactionReferenceSchema.parse(operation.reference)
    creditTransactionMetadata(operation.metadata)
  }
  const billingUserId = await settlementBillingUser(ctx, operation)
  const settlementId = await ctx.db.insert('billingSettlements', {
    billingUserId,
    operation,
    status: 'pending',
  })
  await wakeSettlements(ctx, billingUserId)
  return { accepted: true as const, settlementId }
}

export async function generationSettlement(
  ctx: MutationCtx,
  generationId: Id<'gatewayGenerations'>,
) {
  return await ctx.db
    .query('billingSettlements')
    .withIndex('by_generation', q => q.eq('operation.generationId', generationId))
    .unique()
}

async function wakeSettlements(ctx: MutationCtx, billingUserId: Id<'users'>) {
  await ping(ctx, components.billingWorker, {
    name: billingUserId,
    workQuery: internal.domains.credits.settlementQueue.nextBatch,
    workerMutation: internal.domains.credits.settlementQueue.applyBatch,
    config: { debounceMs: BATCH_DEBOUNCE_MS },
  })
}

async function settlementBillingUser(
  ctx: MutationCtx,
  operation: SettlementOperation,
): Promise<Id<'users'>> {
  let workspaceId
  if (operation.kind === 'service') workspaceId = operation.workspaceId
  else {
    const generation = await ctx.db.get(operation.generationId)
    if (generation === null) throw new Error('Generation not found')
    workspaceId = generation.workspaceId
  }
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  return workspace.billingUserId
}

export const nextBatch = internalQuery({
  args: vBatchQueryArgs,
  returns: vBatchResult(v.object({ ids: v.array(v.id('billingSettlements')) })),
  handler: async (ctx, { name }) => {
    const billingUserId = ctx.db.normalizeId('users', name)
    if (billingUserId === null) throw new Error('Invalid billing worker account')
    const rows = await ctx.db
      .query('billingSettlements')
      .withIndex('by_account_status', q =>
        q.eq('billingUserId', billingUserId).eq('status', 'pending'),
      )
      .take(BATCH_SIZE)
    return rows.length === 0
      ? { kind: 'idle' as const, cooldownMs: 1_000, pollIntervalMs: 250 }
      : { kind: 'work' as const, batch: { ids: rows.map(row => row._id) } }
  },
})

export const applyBatch = internalMutation({
  args: { ids: v.array(v.id('billingSettlements')) },
  handler: async (ctx, { ids }) => {
    for (const settlementId of ids) {
      try {
        // A nested mutation is a savepoint: a rejected item cannot leave a
        // partial debit behind or prevent the rest of the batch from advancing.
        await ctx.runMutation(internal.domains.credits.settlementQueue.applyOne, { settlementId })
      } catch (error) {
        const message =
          error instanceof ConvexError && typeof error.data === 'string'
            ? error.data
            : error instanceof Error
              ? error.message
              : 'Settlement failed'
        await ctx.db.patch(settlementId, { status: 'failed', error: message.slice(0, 2_000) })
        const row = await ctx.db.get(settlementId)
        if (row?.operation.kind === 'generation') {
          const generation = await ctx.db.get(row.operation.generationId)
          if (
            generation !== null &&
            generation.status !== 'settled' &&
            generation.status !== 'released'
          ) {
            await ctx.db.patch(generation._id, {
              status: 'charge_failed',
              error: message.slice(0, 2_000),
              updatedAt: Date.now(),
            })
          }
        }
        console.error('[billing-settlement] Failed item', { settlementId, error: message })
      }
    }
    return { debounceMs: BATCH_DEBOUNCE_MS }
  },
})

export const applyOne = internalMutation({
  args: { settlementId: v.id('billingSettlements') },
  handler: async (ctx, { settlementId }) => {
    const row = await ctx.db.get(settlementId)
    if (row === null || row.status !== 'pending') return null
    const billingUserId = await settlementBillingUser(ctx, row.operation)
    if (billingUserId !== row.billingUserId) {
      await ctx.db.patch(settlementId, { billingUserId })
      await wakeSettlements(ctx, billingUserId)
      return null
    }
    await applySettlement(ctx, row)
    await ctx.db.delete(settlementId)
    return null
  },
})

export const retryFailed = internalMutation({
  args: { settlementId: v.id('billingSettlements') },
  handler: async (ctx, { settlementId }) => {
    await retryFailedSettlement(ctx, settlementId)
    return null
  },
})

export async function retryFailedSettlement(
  ctx: MutationCtx,
  settlementId: Id<'billingSettlements'>,
) {
  const row = await ctx.db.get(settlementId)
  if (row === null) return
  if (row.status === 'failed') {
    await ctx.db.patch(settlementId, { status: 'pending', error: undefined })
    if (row.operation.kind === 'generation') {
      const generation = await ctx.db.get(row.operation.generationId)
      if (generation?.status === 'charge_failed') {
        await ctx.db.patch(generation._id, { status: 'reconciling', error: undefined })
      }
    }
  }
  await wakeSettlements(ctx, row.billingUserId)
}

async function applySettlement(ctx: MutationCtx, row: Doc<'billingSettlements'>) {
  const operation = row.operation
  if (operation.kind === 'generation') {
    await ctx.runMutation(internal.domains.modelGateway.model.applyQueuedSettlement, {
      generationId: operation.generationId,
      now: operation.occurredAt,
    })
    return
  }
  // A service job belongs to its workspace even if its payer changes while
  // duplicate reports are queued. The wallet's per-user key cannot detect that replay.
  const charged = await ctx.db
    .query('creditTransactions')
    .withIndex('by_workspace_reference', q =>
      q.eq('workspaceId', operation.workspaceId).eq('reference', operation.reference),
    )
    .first()
  if (charged !== null) return
  await applyLedgerEntryWithDb(ctx, {
    workspaceId: operation.workspaceId,
    userId: operation.userId,
    amountMicroUsd: -operation.amountMicroUsd,
    type: 'usage',
    reference: operation.reference,
    metadata: operation.metadata,
    now: operation.occurredAt,
  })
}
