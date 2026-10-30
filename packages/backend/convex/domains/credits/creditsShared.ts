import { makeFunctionReference, type FunctionReference } from 'convex/server'

import {
  currentMonthKey,
  DEFAULT_AUTO_TOPUP_THRESHOLD_MICRO_USD,
  HARD_BLOCK_FLOOR_MICRO_USD,
  LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
  MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
  type WorkspaceCreditRecovery,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { assertActorRole, assertRole } from '../workspaces/authorization'
import { AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD, isSubscriber } from './subscriptions'
import { spendableBalance, walletOf } from './wallet'

export { AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD }
export const RECOVERABLE_SERVICING_STATUSES = new Set<
  Doc<'workspaces'>['servicingStatus'] | undefined
>([undefined, 'active', 'paused'])

export type ReservationStatus = 'held' | 'settled' | 'released'
export type UsageGroup = 'workspace' | 'user' | 'app'

export interface SpendAuthorizationState {
  balanceMicroUsd: number
  monthlyCreditBalanceMicroUsd: number
  paidCreditBalanceMicroUsd: number
  accountMonthlySpendMicroUsd: number
  accountMonthlyCapMicroUsd?: number
  workspaceMonthlySpendMicroUsd: number
  workspaceMonthlyCapMicroUsd?: number
}

export type SpendAuthorizationDecision = SpendAuthorizationState &
  (
    | { proceed: true }
    | { proceed: false; reason: 'subscription_required' }
    | {
        proceed: false
        reason: 'insufficient_credits' | 'monthly_cap'
        tier: 'account' | 'workspace'
      }
  )

export async function billingUserForWorkspace(
  ctx: Pick<QueryCtx, 'db'>,
  workspace: Doc<'workspaces'>,
): Promise<Doc<'users'>> {
  const membership = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q =>
      q.eq('workspaceId', workspace._id).eq('userId', workspace.billingUserId),
    )
    .unique()
  if (membership?.role !== 'owner') {
    throw new Error(
      `Billing user ${workspace.billingUserId} is not an owner of workspace ${workspace._id}`,
    )
  }
  const user = await ctx.db.get(workspace.billingUserId)
  if (user === null) {
    throw new Error(
      `Billing user wallet not found (workspace ${workspace._id}, user ${workspace.billingUserId})`,
    )
  }
  return user
}

export async function billingUserForWorkspaceOrNull(
  ctx: Pick<MutationCtx, 'db'>,
  workspace: Doc<'workspaces'>,
): Promise<Doc<'users'> | null> {
  const membership = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q =>
      q.eq('workspaceId', workspace._id).eq('userId', workspace.billingUserId),
    )
    .unique()
  if (membership?.role !== 'owner') return null
  return await ctx.db.get(workspace.billingUserId)
}

type MonthlySpendOwner = Pick<Doc<'users'>, 'billing'>

export function monthlySpendPatch(
  owner: MonthlySpendOwner,
  deltaMicroUsd: number,
  now = Date.now(),
): NonNullable<Doc<'users'>['billing']> {
  const key = currentMonthKey(now)
  const billing = owner.billing ?? {}
  // Late settlement still enters the ledger, but cannot reset a newer cap window.
  if (billing.monthlySpendPeriodKey !== undefined && billing.monthlySpendPeriodKey > key) {
    return billing
  }
  const current = billing.monthlySpendPeriodKey === key ? (billing.monthlySpendMicroUsd ?? 0) : 0
  return {
    ...billing,
    monthlySpendMicroUsd: Math.max(0, current + deltaMicroUsd),
    monthlySpendPeriodKey: key,
  }
}

export function currentPeriodSpend(owner: MonthlySpendOwner, now = Date.now()): number {
  return owner.billing?.monthlySpendPeriodKey === currentMonthKey(now)
    ? (owner.billing.monthlySpendMicroUsd ?? 0)
    : 0
}

export function spendAuthorizationState(
  workspace: Doc<'workspaces'>,
  user: Doc<'users'>,
  workspaceMonthlySpendMicroUsd: number,
  now = Date.now(),
): SpendAuthorizationState {
  const balances = spendableCreditBalances(user, now)
  return {
    balanceMicroUsd: balances.balanceMicroUsd,
    monthlyCreditBalanceMicroUsd: balances.monthlyCreditBalanceMicroUsd,
    paidCreditBalanceMicroUsd: balances.paidCreditBalanceMicroUsd,
    accountMonthlySpendMicroUsd: currentPeriodSpend(user, now),
    accountMonthlyCapMicroUsd: user.billing?.maxMonthlySpendMicroUsd,
    workspaceMonthlySpendMicroUsd,
    workspaceMonthlyCapMicroUsd: workspace.billing?.maxMonthlySpendMicroUsd,
  }
}

export function authorizeSpend(
  workspace: Doc<'workspaces'>,
  user: Doc<'users'>,
  args: {
    workspaceMonthlySpendMicroUsd: number
    estimatedCostMicroUsd?: number
    reservedCostMicroUsd?: number
    now?: number
  },
): SpendAuthorizationDecision {
  const now = args.now ?? Date.now()
  const state = spendAuthorizationState(workspace, user, args.workspaceMonthlySpendMicroUsd, now)
  // A servicing-exempt workspace is an operator-granted exception to the
  // payer's subscription gate. It still spends the billing user's wallet and
  // remains subject to the same credit and monthly-cap checks below.
  if (workspace.servicingExemptAt === undefined && !isSpendEntitledAt(user, now)) {
    return { proceed: false, reason: 'subscription_required', ...state }
  }
  if (
    state.balanceMicroUsd <= HARD_BLOCK_FLOOR_MICRO_USD ||
    (args.reservedCostMicroUsd !== undefined &&
      state.balanceMicroUsd < args.reservedCostMicroUsd + HARD_BLOCK_FLOOR_MICRO_USD)
  ) {
    return {
      proceed: false,
      reason: 'insufficient_credits',
      tier: 'account',
      ...state,
    }
  }
  if (
    state.accountMonthlyCapMicroUsd !== undefined &&
    (args.estimatedCostMicroUsd === undefined
      ? state.accountMonthlySpendMicroUsd >= state.accountMonthlyCapMicroUsd
      : state.accountMonthlySpendMicroUsd + args.estimatedCostMicroUsd >
        state.accountMonthlyCapMicroUsd)
  ) {
    return { proceed: false, reason: 'monthly_cap', tier: 'account', ...state }
  }
  if (
    state.workspaceMonthlyCapMicroUsd !== undefined &&
    (args.estimatedCostMicroUsd === undefined
      ? state.workspaceMonthlySpendMicroUsd >= state.workspaceMonthlyCapMicroUsd
      : state.workspaceMonthlySpendMicroUsd + args.estimatedCostMicroUsd >
        state.workspaceMonthlyCapMicroUsd)
  ) {
    return { proceed: false, reason: 'monthly_cap', tier: 'workspace', ...state }
  }
  return { proceed: true, ...state }
}

export function isSpendEntitledAt(user: Doc<'users'>, now: number): boolean {
  return (
    isSubscriber(user) ||
    (user.billing?.subscriptionEverActivatedAt === undefined &&
      user.billing?.trialExpiresAt !== undefined &&
      now < user.billing.trialExpiresAt &&
      spendableBalance(walletOf(user)) > HARD_BLOCK_FLOOR_MICRO_USD)
  )
}

export function spendableCreditBalances(user: Doc<'users'>, now = Date.now()) {
  const wallet = walletOf(user)
  const monthlyCreditBalanceMicroUsd =
    isSpendEntitledAt(user, now) &&
    user.billing?.monthlyCreditExpiresAt !== undefined &&
    now < user.billing.monthlyCreditExpiresAt
      ? wallet.monthlyMicroUsd
      : 0
  return {
    balanceMicroUsd: spendableBalance({
      paidMicroUsd: wallet.paidMicroUsd,
      monthlyMicroUsd: monthlyCreditBalanceMicroUsd,
    }),
    monthlyCreditBalanceMicroUsd,
    paidCreditBalanceMicroUsd: wallet.paidMicroUsd,
  }
}

export function workspaceCreditRecovery(
  user: Doc<'users'>,
  servicingStatus: 'active' | 'paused' | 'banned',
  now: number,
): WorkspaceCreditRecovery {
  if (servicingStatus !== 'active' || user.billing?.autoTopupEnabled === true) return null
  if (
    spendableCreditBalances(user, now).balanceMicroUsd > LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD
  ) {
    return null
  }
  return isSubscriber(user) ? 'topup' : 'subscribe'
}

export function effectiveAutoTopupThreshold(user: Doc<'users'>): number {
  return Math.max(
    user.billing?.autoTopupThresholdMicroUsd ?? DEFAULT_AUTO_TOPUP_THRESHOLD_MICRO_USD,
    MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
  )
}

export function assertValidAutoTopupThreshold(threshold: number | undefined): void {
  if (
    threshold !== undefined &&
    (!Number.isInteger(threshold) || threshold < MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD)
  ) {
    throw new Error('Automatic top-up threshold must be at least $5')
  }
}

export function fnMutation(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}

export function fnAction(name: string): FunctionReference<'action'> {
  return makeFunctionReference(name) as FunctionReference<'action'>
}

export async function assertLedgerReader(
  ctx: Parameters<typeof assertRole>[0],
  args: { workspaceId: Id<'workspaces'>; internalKey?: string; actorId?: Id<'users'> },
): Promise<void> {
  if (args.internalKey !== undefined) {
    requireApiInternalKey(args.internalKey)
    if (args.actorId !== undefined)
      await assertActorRole(ctx, args.workspaceId, args.actorId, 'viewer')
    return
  }
  if (args.actorId !== undefined) throw new Error('actorId requires internalKey')
  await assertRole(ctx, args.workspaceId, 'viewer')
}

export async function assertLedgerWriter(
  ctx: Parameters<typeof assertRole>[0],
  args: { workspaceId: Id<'workspaces'>; internalKey?: string; actorId?: Id<'users'> },
): Promise<void> {
  if (args.internalKey === undefined) throw new Error('Unauthorized ledger writer')
  requireApiInternalKey(args.internalKey)
  if (args.actorId !== undefined)
    await assertActorRole(ctx, args.workspaceId, args.actorId, 'editor')
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
