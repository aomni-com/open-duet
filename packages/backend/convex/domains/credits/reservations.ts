import type { Infer } from 'convex/values'

import { DEFAULT_RESERVATION_ESTIMATE_MICRO_USD } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import {
  assertLedgerWriter,
  billingUserForWorkspace,
  authorizeSpend,
  monthlySpendPatch,
  spendAuthorizationState,
  type ReservationStatus,
} from './creditsShared'
import type { releaseReservationArgs, reserveCreditsArgs, settleReservationArgs } from './internal'
import { applyLedgerEntryWithDb, scheduleReconcileServicingStatusIfRequired } from './ledger'
import {
  creditTransactionMetadata,
  metadataContext,
  type CreditTransactionMetadataFields,
} from './metadata'
import { insertCreditTransaction } from './storage'
import { ensureCurrentEntitlementWithDb } from './subscriptions'
import { bindCreditTransactionPagination } from './transactionPagination'
import { scheduleUsageRollup, type UsageRollupProjection } from './usageRollups'
import {
  adjustWalletForReservationWithDb,
  spendableBalance,
  walletOf,
  type ReservationWalletAdjustment,
  type WalletAllocation,
} from './wallet'
import { adjustWorkspaceMonthlySpend, workspaceMonthlySpend } from './workspaceSpend'

export async function reserveCreditsImpl(ctx: MutationCtx, args: Infer<typeof reserveCreditsArgs>) {
  await assertLedgerWriter(ctx, args)
  return reserveCreditsWithDb(ctx, { ...args, userId: args.userId ?? args.actorId })
}

export async function settleReservationImpl(
  ctx: MutationCtx,
  args: Infer<typeof settleReservationArgs>,
) {
  await assertLedgerWriter(ctx, args)
  return settleReservationWithDb(ctx, { ...args, userId: args.userId ?? args.actorId })
}

export async function releaseReservationImpl(
  ctx: MutationCtx,
  args: Infer<typeof releaseReservationArgs>,
) {
  await assertLedgerWriter(ctx, args)
  return releaseReservationWithDb(ctx, { ...args, userId: args.userId ?? args.actorId })
}

export async function reserveCreditsWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    estimateMicroUsd?: number
    reference?: string
    userId?: Id<'users'>
    metadata?: unknown
    now?: number
  },
): Promise<{
  proceed: boolean
  reservationId?: string
  reason?: 'subscription_required' | 'insufficient_credits' | 'monthly_cap'
  tier?: 'account' | 'workspace'
  balanceMicroUsd: number
  monthlyCreditBalanceMicroUsd: number
  paidCreditBalanceMicroUsd: number
  accountMonthlySpendMicroUsd: number
  accountMonthlyCapMicroUsd?: number
  workspaceMonthlySpendMicroUsd: number
  workspaceMonthlyCapMicroUsd?: number
}> {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  const user = await ensureCurrentEntitlementWithDb(
    ctx,
    await billingUserForWorkspace(ctx, workspace),
    args.now ?? Date.now(),
  )

  const reservationId = args.reference ?? crypto.randomUUID()
  const existing = await ctx.db
    .query('creditTransactions')
    .withIndex('by_workspace_reference', q =>
      q.eq('workspaceId', args.workspaceId).eq('reference', reservationId),
    )
    .first()
  const workspaceSpend = await workspaceMonthlySpend(ctx, workspace, args.now)
  const decisionState = spendAuthorizationState(workspace, user, workspaceSpend, args.now)
  if (existing !== null) {
    if (existing.type !== 'reservation' || existing.workspaceId !== args.workspaceId)
      throw new Error('Reference already used')
    return {
      proceed: true,
      reservationId,
      ...decisionState,
    }
  }

  const estimate = Math.max(0, args.estimateMicroUsd ?? DEFAULT_RESERVATION_ESTIMATE_MICRO_USD)
  const decision = authorizeSpend(workspace, user, {
    workspaceMonthlySpendMicroUsd: workspaceSpend,
    estimatedCostMicroUsd: estimate,
    reservedCostMicroUsd: estimate,
    now: args.now,
  })
  if (!decision.proceed) {
    await scheduleReconcileServicingStatusIfRequired(ctx, user, decision)
    return decision
  }

  const result = await applyLedgerEntryWithDb(ctx, {
    workspaceId: args.workspaceId,
    amountMicroUsd: -estimate,
    type: 'reservation',
    reference: reservationId,
    userId: args.userId,
    metadata: args.metadata,
    transactionMetadata: {
      status: 'held' satisfies ReservationStatus,
      event: 'hold',
      estimateMicroUsd: estimate,
    },
    now: args.now,
  })
  return {
    proceed: true,
    reservationId,
    balanceMicroUsd: result.newBalanceMicroUsd,
    monthlyCreditBalanceMicroUsd: result.balances.monthlyMicroUsd,
    paidCreditBalanceMicroUsd: result.balances.paidMicroUsd,
    accountMonthlySpendMicroUsd:
      decision.accountMonthlySpendMicroUsd + (result.applied ? estimate : 0),
    accountMonthlyCapMicroUsd: decision.accountMonthlyCapMicroUsd,
    workspaceMonthlySpendMicroUsd:
      decision.workspaceMonthlySpendMicroUsd + (result.applied ? estimate : 0),
    workspaceMonthlyCapMicroUsd: decision.workspaceMonthlyCapMicroUsd,
  }
}

export async function settleReservationWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    reservationId: string
    actualCostMicroUsd: number
    userId?: Id<'users'>
    metadata?: unknown
    usageRollup?: UsageRollupProjection
    now?: number
  },
): Promise<{ settled: boolean; balanceMicroUsd: number }> {
  const row = await findHeldReservation(ctx, args)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  const user = await billingUserForWorkspace(ctx, workspace)
  if (row === null) return { settled: false, balanceMicroUsd: spendableBalance(walletOf(user)) }

  const estimate = reservationEstimate(row)
  const actual = Math.max(0, args.actualCostMicroUsd)
  const walletAdjustment = await adjustWalletForReservationWithDb(ctx, user, {
    allocation: reservationWalletAllocation(row),
    actualCostMicroUsd: actual,
  })
  await adjustMonthlySpend(ctx, {
    workspaceId: args.workspaceId,
    user,
    monthlySpendDeltaMicroUsd: actual - estimate,
    now: args.now,
  })
  await appendReservationTerminalEvent(ctx, {
    workspaceId: args.workspaceId,
    reservationId: args.reservationId,
    balanceDeltaMicroUsd: walletAdjustment.walletDeltaMicroUsd,
    userId: user._id,
    actorUserId: reservationActorUserId(row, args.userId),
    event: 'settle',
    context: args.metadata,
    metadata: {
      estimateMicroUsd: estimate,
      actualCostMicroUsd: actual,
      forfeitedMonthlyMicroUsd: walletAdjustment.forfeitedMonthlyMicroUsd,
    },
    now: args.now,
  })
  await projectReservationRow(ctx, row, {
    status: 'settled',
    amountMicroUsd: -actual,
    walletAdjustment,
    context: {
      ...row.metadata?.context,
      ...metadataContext(args.metadata),
    },
    metadata: {
      status: 'settled',
      estimateMicroUsd: estimate,
      actualCostMicroUsd: actual,
    },
  })
  if (actual > 0) {
    await scheduleUsageRollup(ctx, {
      workspaceId: args.workspaceId,
      spendMicroUsd: actual,
      createdAt: row.createdAt,
      userId: reservationActorUserId(row, args.userId),
      dimensions: args.usageRollup ?? {},
    })
  }

  return {
    settled: true,
    balanceMicroUsd: spendableBalance(walletAdjustment.balances),
  }
}

export async function releaseReservationWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    reservationId: string
    reason?: string
    userId?: Id<'users'>
    now?: number
  },
): Promise<{ released: boolean; balanceMicroUsd: number }> {
  const row = await findHeldReservation(ctx, args)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  const user = await billingUserForWorkspace(ctx, workspace)
  if (row === null) return { released: false, balanceMicroUsd: spendableBalance(walletOf(user)) }

  const estimate = reservationEstimate(row)
  const walletAdjustment = await adjustWalletForReservationWithDb(ctx, user, {
    allocation: reservationWalletAllocation(row),
    actualCostMicroUsd: 0,
  })
  await adjustMonthlySpend(ctx, {
    workspaceId: args.workspaceId,
    user,
    monthlySpendDeltaMicroUsd: -estimate,
    now: args.now,
  })
  await appendReservationTerminalEvent(ctx, {
    workspaceId: args.workspaceId,
    reservationId: args.reservationId,
    balanceDeltaMicroUsd: walletAdjustment.walletDeltaMicroUsd,
    userId: user._id,
    actorUserId: reservationActorUserId(row, args.userId),
    event: 'release',
    metadata: {
      releaseReason: args.reason,
      estimateMicroUsd: estimate,
      forfeitedMonthlyMicroUsd: walletAdjustment.forfeitedMonthlyMicroUsd,
    },
    now: args.now,
  })
  await projectReservationRow(ctx, row, {
    status: 'released',
    amountMicroUsd: 0,
    walletAdjustment,
    context: row.metadata?.context,
    metadata: {
      status: 'released',
      releaseReason: args.reason,
    },
  })

  return {
    released: true,
    balanceMicroUsd: spendableBalance(walletAdjustment.balances),
  }
}

async function appendReservationTerminalEvent(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    reservationId: string
    balanceDeltaMicroUsd: number
    userId: Id<'users'>
    actorUserId: Id<'users'>
    event: 'settle' | 'release'
    context?: unknown
    metadata: CreditTransactionMetadataFields
    now?: number
  },
): Promise<void> {
  const existing = await ctx.db
    .query('creditTransactions')
    .withIndex('by_workspace_reference', q =>
      q.eq('workspaceId', args.workspaceId).eq('reference', `${args.reservationId}:${args.event}`),
    )
    .first()
  if (existing !== null) return

  const transactionId = await insertCreditTransaction(ctx, {
    workspaceId: args.workspaceId,
    amountMicroUsd: 0,
    monthlyAmountMicroUsd: 0,
    paidAmountMicroUsd: 0,
    type: 'reservation',
    reference: `${args.reservationId}:${args.event}`,
    userId: args.userId,
    actorUserId: args.actorUserId,
    metadata: creditTransactionMetadata(args.context, {
      ...args.metadata,
      event: args.event,
      reservationId: args.reservationId,
      balanceDeltaMicroUsd: args.balanceDeltaMicroUsd,
    }),
    createdAt: args.now ?? Date.now(),
  })
  await bindCreditTransactionPagination(ctx, transactionId)
}

async function projectReservationRow(
  ctx: MutationCtx,
  row: Doc<'creditTransactions'>,
  args: {
    status: ReservationStatus
    amountMicroUsd: number
    context?: unknown
    metadata: CreditTransactionMetadataFields
    walletAdjustment: ReservationWalletAdjustment
  },
): Promise<void> {
  const context = metadataContext(args.context)
  const metadata = creditTransactionMetadata(context, {
    ...row.metadata,
    ...args.metadata,
    status: args.status,
  })
  await ctx.db.patch(row._id, {
    amountMicroUsd: args.amountMicroUsd,
    monthlyAmountMicroUsd: args.walletAdjustment.actualAmounts.monthlyAmountMicroUsd,
    paidAmountMicroUsd: args.walletAdjustment.actualAmounts.paidAmountMicroUsd,
    metadata,
  })
}

async function findHeldReservation(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; reservationId: string },
): Promise<Doc<'creditTransactions'> | null> {
  const row = await ctx.db
    .query('creditTransactions')
    .withIndex('by_workspace_reference', q =>
      q.eq('workspaceId', args.workspaceId).eq('reference', args.reservationId),
    )
    .first()
  if (row === null || row.workspaceId !== args.workspaceId || row.type !== 'reservation')
    return null
  if (row.metadata?.status !== 'held') return null
  return row
}

async function adjustMonthlySpend(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    user: Doc<'users'>
    monthlySpendDeltaMicroUsd: number
    now?: number
  },
): Promise<void> {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  await ctx.db.patch(args.user._id, {
    billing: monthlySpendPatch(args.user, args.monthlySpendDeltaMicroUsd, args.now),
  })
  await adjustWorkspaceMonthlySpend(ctx, workspace, args.monthlySpendDeltaMicroUsd, args.now)
}

function reservationWalletAllocation(row: Doc<'creditTransactions'>): WalletAllocation {
  const value = row.metadata?.walletAllocation
  if (value === undefined) throw new Error('Held reservation is missing wallet allocation')
  return value
}

function reservationEstimate(row: Doc<'creditTransactions'>): number {
  return row.metadata?.estimateMicroUsd ?? Math.abs(row.amountMicroUsd)
}

function reservationActorUserId(
  row: Doc<'creditTransactions'>,
  fallback?: Id<'users'>,
): Id<'users'> {
  return fallback ?? row.actorUserId
}
