import type { Infer } from 'convex/values'

import {
  AUTO_TOPUP_IDEMPOTENCY_WINDOW_MS,
  DEFAULT_AUTO_TOPUP_AMOUNT_MICRO_USD,
} from '@repo/contract'
import type { TransactionType } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { assertActorRole } from '../workspaces/authorization'
import {
  AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD,
  effectiveAutoTopupThreshold,
  billingUserForWorkspace,
  assertLedgerReader,
  assertLedgerWriter,
  authorizeSpend,
  fnAction,
  fnMutation,
  monthlySpendPatch,
  spendableCreditBalances,
} from './creditsShared'
import type {
  applyLedgerEntryArgs,
  workspaceLedgerArgs,
  runPreflightArgs,
  setMonthlyCapArgs,
} from './internal'
import { creditTransactionMetadata, type CreditTransactionMetadataFields } from './metadata'
import { insertCreditTransaction } from './storage'
import { ensureCurrentEntitlementWithDb, isSubscriber } from './subscriptions'
import { transactionByReference } from './transactionByReference'
import { bindCreditTransactionPagination } from './transactionPagination'
import { scheduleUsageRollup, type UsageRollupProjection } from './usageRollups'
import {
  allocateSpend,
  applyWalletDelta,
  bucketFor,
  reservationAllocationForSpend,
  spendableBalance,
  walletLedgerAmountsForDebit,
  walletOf,
  type Wallet,
} from './wallet'
import { adjustWorkspaceMonthlySpend, workspaceMonthlySpend } from './workspaceSpend'

export async function applyLedgerEntryWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    amountMicroUsd: number
    type: TransactionType
    reference: string
    userId?: Id<'users'>
    metadata?: unknown
    transactionMetadata?: CreditTransactionMetadataFields
    usageRollup?: UsageRollupProjection
    now?: number
    idempotencyScope?: 'account' | 'global'
  },
): Promise<{
  applied: boolean
  newBalanceMicroUsd: number
  balances: Wallet
  transactionId?: Id<'creditTransactions'>
}> {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  const user = await billingUserForWorkspace(ctx, workspace)
  const existing = await transactionByReference(ctx, {
    reference: args.reference,
    userId: args.idempotencyScope === 'global' ? undefined : user._id,
  })

  if (existing !== null) {
    const current = walletOf(user)
    return {
      applied: false,
      newBalanceMicroUsd: spendableBalance(current),
      balances: current,
    }
  }

  const walletAllocation =
    args.type === 'reservation' && args.amountMicroUsd < 0
      ? reservationAllocationForSpend(user, -args.amountMicroUsd)
      : undefined
  const split =
    walletAllocation === undefined
      ? splitLedgerAmount(walletOf(user), args.type, args.amountMicroUsd)
      : walletLedgerAmountsForDebit(walletAllocation)
  const wallet = await applyWalletDelta(ctx, user, {
    paidDeltaMicroUsd: split.paidAmountMicroUsd,
    monthlyDeltaMicroUsd: split.monthlyAmountMicroUsd,
  })

  if ((args.type === 'usage' || args.type === 'reservation') && args.amountMicroUsd < 0) {
    await ctx.db.patch(user._id, {
      billing: monthlySpendPatch(user, -args.amountMicroUsd, args.now),
    })
    await adjustWorkspaceMonthlySpend(ctx, workspace, -args.amountMicroUsd, args.now)
  }

  const createdAt = args.now ?? Date.now()
  const transactionId = await insertCreditTransaction(ctx, {
    workspaceId: args.workspaceId,
    amountMicroUsd: args.amountMicroUsd,
    monthlyAmountMicroUsd: split.monthlyAmountMicroUsd,
    paidAmountMicroUsd: split.paidAmountMicroUsd,
    type: args.type,
    reference: args.reference,
    userId: user._id,
    actorUserId: args.userId ?? user._id,
    metadata: creditTransactionMetadata(args.metadata, {
      ...args.transactionMetadata,
      ...(walletAllocation === undefined ? {} : { walletAllocation }),
    }),
    createdAt,
  })
  await bindCreditTransactionPagination(ctx, transactionId)

  if (args.type === 'usage' && args.amountMicroUsd < 0) {
    await scheduleUsageRollup(ctx, {
      workspaceId: args.workspaceId,
      spendMicroUsd: -args.amountMicroUsd,
      createdAt,
      userId: args.userId ?? user._id,
      dimensions: args.usageRollup ?? {},
    })
  }

  return {
    applied: true,
    newBalanceMicroUsd: spendableBalance(wallet),
    balances: wallet,
    transactionId,
  }
}

export async function applyAccountLedgerEntryWithDb(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    actorUserId?: Id<'users'>
    amountMicroUsd: number
    type: TransactionType
    reference: string
    metadata?: unknown
    now?: number
    idempotencyScope?: 'account' | 'global'
  },
): Promise<{ applied: boolean; balances: ReturnType<typeof walletOf> }> {
  const user = await ctx.db.get(args.userId)
  if (user === null) throw new Error('Account wallet not found')
  const existing = await transactionByReference(ctx, {
    reference: args.reference,
    userId: args.idempotencyScope === 'global' ? undefined : args.userId,
  })
  if (existing !== null) return { applied: false, balances: walletOf(user) }

  const split = splitLedgerAmount(walletOf(user), args.type, args.amountMicroUsd)
  const balances = await applyWalletDelta(ctx, user, {
    paidDeltaMicroUsd: split.paidAmountMicroUsd,
    monthlyDeltaMicroUsd: split.monthlyAmountMicroUsd,
  })
  const transactionId = await insertCreditTransaction(ctx, {
    userId: args.userId,
    actorUserId: args.actorUserId ?? args.userId,
    amountMicroUsd: args.amountMicroUsd,
    monthlyAmountMicroUsd: split.monthlyAmountMicroUsd,
    paidAmountMicroUsd: split.paidAmountMicroUsd,
    type: args.type,
    reference: args.reference,
    metadata: creditTransactionMetadata(args.metadata),
    createdAt: args.now ?? Date.now(),
  })
  await bindCreditTransactionPagination(ctx, transactionId)
  return { applied: true, balances }
}

function splitLedgerAmount(
  wallet: ReturnType<typeof walletOf>,
  type: TransactionType,
  amountMicroUsd: number,
): { monthlyAmountMicroUsd: number; paidAmountMicroUsd: number } {
  if (amountMicroUsd < 0) {
    const allocation = allocateSpend(wallet, -amountMicroUsd)
    return {
      monthlyAmountMicroUsd: negateWithoutNegativeZero(allocation.monthlyDebitMicroUsd),
      paidAmountMicroUsd: negateWithoutNegativeZero(allocation.paidDebitMicroUsd),
    }
  }
  if (bucketFor(type) === 'monthly') {
    throw new Error('Positive monthly credit is only allowed through resetMonthlyCreditsWithDb')
  }
  return { monthlyAmountMicroUsd: 0, paidAmountMicroUsd: amountMicroUsd }
}

function negateWithoutNegativeZero(value: number): number {
  return value === 0 ? 0 : -value
}

export async function applyLedgerEntryImpl(
  ctx: MutationCtx,
  args: Infer<typeof applyLedgerEntryArgs>,
) {
  await assertLedgerWriter(ctx, args)
  const result = await applyLedgerEntryWithDb(ctx, {
    ...args,
    userId: args.userId ?? args.actorId,
  })
  return {
    applied: result.applied,
    newBalanceMicroUsd: result.newBalanceMicroUsd,
    ...(result.transactionId === undefined ? {} : { transactionId: result.transactionId }),
  }
}

export async function runPreflightImpl(ctx: MutationCtx, args: Infer<typeof runPreflightArgs>) {
  await assertLedgerReader(ctx, args)
  return await runPreflightWithDb(ctx, { ...args, userId: args.userId ?? args.actorId })
}

// The member-facing projection of the ledger: newest first, no internal
// references or metadata. Raw idempotency probes live on the testing seam
// (testing/credits:listWorkspaceTransactionsForTest).
export async function workspaceLedgerImpl(ctx: QueryCtx, args: Infer<typeof workspaceLedgerArgs>) {
  await assertLedgerReader(ctx, args)
  const rows = await ctx.db
    .query('creditTransactions')
    .withIndex('by_workspace_created_id', q => q.eq('workspaceId', args.workspaceId))
    .order('desc')
    .paginate(args.paginationOpts)
  return {
    ...rows,
    page: rows.page.map(row => ({
      id: row._id,
      amountMicroUsd: row.amountMicroUsd,
      type: row.type,
      actorUserId: row.actorUserId,
      ...(row.metadata?.tier === undefined ? {} : { tier: row.metadata.tier }),
      createdAt: row.createdAt,
    })),
  }
}

export async function setWorkspaceMonthlyCapImpl(
  ctx: MutationCtx,
  args: Infer<typeof setMonthlyCapArgs>,
) {
  await assertLedgerWriter(ctx, args)
  if (args.actorId !== undefined) {
    await assertActorRole(ctx, args.workspaceId, args.actorId, 'owner')
  }
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  await ctx.db.patch(args.workspaceId, {
    billing: {
      ...workspace.billing,
      maxMonthlySpendMicroUsd: args.maxMonthlySpendMicroUsd,
    },
  })
  return null
}

export async function runPreflightWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    userId?: Id<'users'>
    estimatedCostMicroUsd?: number
    now?: number
  },
): Promise<{
  proceed: boolean
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
  await scheduleAutoTopupIfNeeded(ctx, workspace, user, args.now)
  const decision = authorizeSpend(workspace, user, {
    workspaceMonthlySpendMicroUsd: await workspaceMonthlySpend(ctx, workspace, args.now),
    estimatedCostMicroUsd: args.estimatedCostMicroUsd,
    now: args.now,
  })
  await scheduleReconcileServicingStatusIfRequired(ctx, user, decision)
  return decision
}

export async function scheduleReconcileServicingStatusIfRequired(
  ctx: MutationCtx,
  user: Doc<'users'>,
  decision: { proceed: boolean; reason?: string },
): Promise<void> {
  if (decision.proceed || decision.reason !== 'subscription_required') return
  await ctx.scheduler.runAfter(0, fnMutation('domains/credits/internal:reconcileServicingStatus'), {
    userId: user._id,
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
  })
}

async function scheduleAutoTopupIfNeeded(
  ctx: MutationCtx,
  workspace: Doc<'workspaces'>,
  user: Doc<'users'>,
  now = Date.now(),
): Promise<void> {
  const billing = user.billing
  if ((billing?.autoTopupEnabled ?? false) !== true) return
  if (billing?.stripeCustomerId === undefined) return
  if ((billing?.consecutiveTopupFailures ?? 0) >= AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD) return
  if (!isSubscriber(user)) return
  const balance = spendableCreditBalances(user, now).balanceMicroUsd
  const threshold = effectiveAutoTopupThreshold(user)
  if (balance >= threshold) return
  const amount = billing?.autoTopupAmountMicroUsd ?? DEFAULT_AUTO_TOPUP_AMOUNT_MICRO_USD
  const bucket = Math.floor(now / AUTO_TOPUP_IDEMPOTENCY_WINDOW_MS)
  await ctx.scheduler.runAfter(0, fnAction('domains/credits/actions:attemptTopup'), {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
    workspaceId: workspace._id,
    userId: user._id,
    amountMicroUsd: amount,
    idempotencyKey: `topup:${user._id}:${bucket}`,
    now,
  })
}
