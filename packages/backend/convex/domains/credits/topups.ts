import type { Infer } from 'convex/values'

import { DEFAULT_AUTO_TOPUP_AMOUNT_MICRO_USD } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { assertActorRole, assertRole } from '../workspaces/authorization'
import {
  AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD,
  assertValidAutoTopupThreshold,
  billingUserForWorkspace,
  currentPeriodSpend,
  effectiveAutoTopupThreshold,
} from './creditsShared'
import type {
  clearTopupErrorArgs,
  createTopupAttemptArgs,
  getTopupConfigArgs,
  markTopupAttemptArgs,
  recordInvoicePaymentFailureArgs,
  recordTopupErrorArgs,
  setTopupConfigArgs,
} from './internal'
import { resetTopupFailureBilling } from './paymentRecovery'
import { reconcileServicingStatus } from './subscriptions'
import { spendableBalance, walletOf } from './wallet'

export async function setTopupConfigImpl(ctx: MutationCtx, args: Infer<typeof setTopupConfigArgs>) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  if (args.actorId !== undefined) {
    await assertActorRole(ctx, args.workspaceId, args.actorId, 'owner')
    if (workspace.billingUserId !== args.actorId) throw new Error('Billing payer required')
  }
  const user = await billingUserForWorkspace(ctx, workspace)
  assertValidAutoTopupThreshold(args.autoTopupThresholdMicroUsd)
  await ctx.db.patch(user._id, {
    billing: {
      ...user.billing,
      ...(args.stripeCustomerId === undefined ? {} : { stripeCustomerId: args.stripeCustomerId }),
      ...(args.autoTopupEnabled === undefined ? {} : { autoTopupEnabled: args.autoTopupEnabled }),
      ...(args.autoTopupThresholdMicroUsd === undefined
        ? {}
        : { autoTopupThresholdMicroUsd: args.autoTopupThresholdMicroUsd }),
      ...(args.autoTopupAmountMicroUsd === undefined
        ? {}
        : { autoTopupAmountMicroUsd: args.autoTopupAmountMicroUsd }),
      ...(args.maxMonthlySpendMicroUsd === undefined
        ? {}
        : { maxMonthlySpendMicroUsd: args.maxMonthlySpendMicroUsd }),
    },
    updatedAt: args.now ?? Date.now(),
  })
  return null
}

export async function getTopupConfigImpl(ctx: QueryCtx, args: Infer<typeof getTopupConfigArgs>) {
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId !== undefined) {
      await assertActorRole(ctx, args.workspaceId, args.actorId, 'viewer')
      const workspace = await ctx.db.get(args.workspaceId)
      if (workspace?.billingUserId !== args.actorId) throw new Error('Billing payer required')
    }
  } else {
    if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
    await assertRole(ctx, args.workspaceId, 'viewer')
  }
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  const user = await billingUserForWorkspace(ctx, workspace)
  return topupConfigResponse(user)
}

export async function markPaymentMethodReadyWithDb(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
  now: number,
  eventAt = now,
): Promise<void> {
  const workspace = await ctx.db.get(workspaceId)
  if (workspace?.billingUserId !== userId) return
  const membership = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspaceId).eq('userId', userId))
    .unique()
  if (membership?.role !== 'owner') return
  const user = await ctx.db.get(userId)
  if (user === null || user.billing?.stripeCustomerId === undefined) return
  await ctx.db.patch(userId, {
    billing: {
      ...resetTopupFailureBilling(user.billing, eventAt),
      paymentMethodReadyAt: user.billing?.paymentMethodReadyAt ?? eventAt,
    },
    updatedAt: now,
  })
  await reconcileServicingStatus(ctx, userId, now)
}

export async function createTopupAttemptImpl(
  ctx: MutationCtx,
  args: Infer<typeof createTopupAttemptArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  const user = await billingUserForWorkspace(ctx, workspace)
  const existing = await ctx.db
    .query('billingTopups')
    .withIndex('by_user_idempotencyKey', q =>
      q.eq('userId', user._id).eq('idempotencyKey', args.idempotencyKey),
    )
    .first()
  if (existing !== null)
    return { created: false as const, attempt: existing, account: topupAccount(user) }
  const now = args.now ?? Date.now()
  const id = await ctx.db.insert('billingTopups', {
    workspaceId: args.workspaceId,
    userId: user._id,
    idempotencyKey: args.idempotencyKey,
    amountMicroUsd: args.amountMicroUsd,
    status: 'created',
    createdAt: now,
    updatedAt: now,
  })
  return {
    created: true as const,
    attempt: await ctx.db.get(id),
    account: topupAccount(user),
  }
}

export async function markTopupAttemptImpl(
  ctx: MutationCtx,
  args: Infer<typeof markTopupAttemptArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const attempt = await ctx.db
    .query('billingTopups')
    .withIndex('by_user_idempotencyKey', q =>
      q.eq('userId', args.userId).eq('idempotencyKey', args.idempotencyKey),
    )
    .first()
  if (attempt === null) return null
  await ctx.db.patch(attempt._id, {
    status: args.status,
    stripeInvoiceId: args.stripeInvoiceId,
    failureCode: args.failureCode,
    failureMessage: args.failureMessage,
    updatedAt: args.now ?? Date.now(),
  })
  return null
}

export async function recordTopupErrorImpl(
  ctx: MutationCtx,
  args: Infer<typeof recordTopupErrorArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) return null
  const user = await billingUserForWorkspace(ctx, workspace)
  if (
    args.error.at <= (user.billing?.paymentRecoveredAt ?? -1) ||
    args.error.at < (user.billing?.lastTopupError?.at ?? -1)
  )
    return null
  await ctx.db.patch(user._id, {
    billing: { ...user.billing, lastTopupError: args.error },
  })
  return null
}

export async function recordInvoicePaymentFailureImpl(
  ctx: MutationCtx,
  args: Infer<typeof recordInvoicePaymentFailureArgs>,
) {
  requireApiInternalKey(args.internalKey)
  return await recordInvoicePaymentFailureWithDb(ctx, args.workspaceId, args.userId, args.error)
}

export async function clearTopupErrorImpl(
  ctx: MutationCtx,
  args: Infer<typeof clearTopupErrorArgs>,
) {
  requireApiInternalKey(args.internalKey)
  await clearTopupErrorWithDb(ctx, args.workspaceId, args.userId, args.now ?? Date.now())
  return null
}

function topupConfigResponse(user: Doc<'users'>) {
  const billing = user.billing ?? {}
  return {
    autoTopupEnabled: billing.autoTopupEnabled ?? false,
    autoTopupThresholdMicroUsd: effectiveAutoTopupThreshold(user),
    autoTopupAmountMicroUsd: billing.autoTopupAmountMicroUsd ?? DEFAULT_AUTO_TOPUP_AMOUNT_MICRO_USD,
    maxMonthlySpendMicroUsd: billing.maxMonthlySpendMicroUsd,
    stripeCustomerId: billing.stripeCustomerId,
    monthlySpendMicroUsd: currentPeriodSpend(user),
    monthlySpendPeriodKey: billing.monthlySpendPeriodKey,
    balanceMicroUsd: spendableBalance(walletOf(user)),
    lastTopupError: billing.lastTopupError,
    consecutiveTopupFailures: billing.consecutiveTopupFailures ?? 0,
    firstPaidAt: billing.firstPaidAt,
  }
}

function topupAccount(user: Doc<'users'>) {
  return {
    id: user._id,
    stripeCustomerId: user.billing?.stripeCustomerId,
    billing: user.billing,
  }
}

export async function clearTopupErrorWithDb(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
  now: number,
  eventAt = now,
): Promise<void> {
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null) return
  const user = await billingUserForWorkspace(ctx, workspace)
  await ctx.db.patch(user._id, {
    billing: {
      ...resetTopupFailureBilling(user.billing, eventAt),
      firstPaidAt: user.billing?.firstPaidAt ?? now,
    },
  })
  await reconcileServicingStatus(ctx, user._id, now)
}

export async function recordInvoicePaymentFailureWithDb(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
  error: { code: string; message: string; at: number },
  now = error.at,
): Promise<{ consecutiveFailures: number }> {
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null) return { consecutiveFailures: 0 }
  const user = await billingUserForWorkspace(ctx, workspace)
  if (error.at <= (user.billing?.paymentRecoveredAt ?? -1))
    return { consecutiveFailures: user.billing?.consecutiveTopupFailures ?? 0 }
  const topupFailureAts = [
    ...(user.billing?.topupFailureAts ??
      Array.from(
        {
          length: Math.min(
            user.billing?.consecutiveTopupFailures ?? 0,
            AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD,
          ),
        },
        () => user.billing?.lastTopupError?.at ?? error.at,
      )),
    error.at,
  ]
    .sort((a, b) => b - a)
    .slice(0, AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD)
  const consecutiveFailures = topupFailureAts.length
  await ctx.db.patch(user._id, {
    billing: {
      ...user.billing,
      lastTopupError:
        (user.billing?.lastTopupError?.at ?? -1) > error.at ? user.billing?.lastTopupError : error,
      consecutiveTopupFailures: consecutiveFailures,
      topupFailureAts,
    },
  })
  if (consecutiveFailures >= AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD) {
    await reconcileServicingStatus(ctx, user._id, now)
  }
  return { consecutiveFailures }
}
