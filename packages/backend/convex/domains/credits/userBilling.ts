import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import {
  DEFAULT_AUTO_TOPUP_AMOUNT_MICRO_USD,
  HARD_BLOCK_FLOOR_MICRO_USD,
  SUBSCRIPTION_PLANS,
  VM_IMAGE_HEADROOM_GB,
  vmDiskGbForPlan,
  type BillingWorkspace,
  type SubscriptionPlanId,
  type SubscriptionStatus,
} from '@repo/contract'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { requireApiInternalKey } from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { isLiveWorkspace } from '../workspaces/authorization'
import { storagePlanForUser } from '../workspaces/vmDiskPolicy'
import {
  assertValidAutoTopupThreshold,
  currentPeriodSpend,
  effectiveAutoTopupThreshold,
  spendableCreditBalances,
} from './creditsShared'
import { isSubscriber } from './subscriptions'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>

export interface BillingSessionAccount {
  userId: string
  email: string
  stripeCustomerId?: string
  paymentMethodReady: boolean
  paymentMethodReadyAt?: number
  onboardingPaymentAttemptId?: string
  onboardingPaymentIntentId?: string
  onboardingPaymentStatus?: string
  workspaceId: string
  workspaceSlug: string
  subscription?: {
    stripeSubscriptionId: string
    stripePriceId: string
    plan: SubscriptionPlanId
    status: SubscriptionStatus
    cancelAtPeriodEnd: boolean
    pendingPlan?: SubscriptionPlanId
    latestLifecycleEventId: string
  }
}

export async function userBillingOverview(
  ctx: QueryCtx,
  args: { internalKey: string; actorId: Id<'users'>; now?: number },
) {
  requireApiInternalKey(args.internalKey)
  const user = await ctx.db.get(args.actorId)
  if (user === null) throw new Error('User not found')
  const workspaces = await payerWorkspaces(ctx, args.actorId)
  const billing = user.billing ?? {}
  const now = args.now ?? Date.now()
  const balances = spendableCreditBalances(user, now)
  const subscription = billing.subscription
  const trialStatus =
    billing.subscriptionEverActivatedAt !== undefined ||
    (billing.trialExpiresAt !== undefined && now >= billing.trialExpiresAt)
      ? 'ended'
      : balances.balanceMicroUsd > HARD_BLOCK_FLOOR_MICRO_USD
        ? 'available'
        : 'exhausted'
  return {
    autoTopupEnabled: billing.autoTopupEnabled ?? false,
    autoTopupThresholdMicroUsd: effectiveAutoTopupThreshold(user),
    autoTopupAmountMicroUsd: billing.autoTopupAmountMicroUsd ?? DEFAULT_AUTO_TOPUP_AMOUNT_MICRO_USD,
    maxMonthlySpendMicroUsd: billing.maxMonthlySpendMicroUsd,
    monthlySpendMicroUsd: currentPeriodSpend(user),
    monthlySpendPeriodKey: billing.monthlySpendPeriodKey,
    balanceMicroUsd: balances.balanceMicroUsd,
    paidCreditBalanceMicroUsd: balances.paidCreditBalanceMicroUsd,
    monthlyCreditBalanceMicroUsd: balances.monthlyCreditBalanceMicroUsd,
    subscription:
      subscription === undefined
        ? null
        : {
            plan: subscription.plan,
            status: subscription.status,
            isActive: isSubscriber(user),
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            creditsExpireAt: billing.monthlyCreditExpiresAt ?? subscription.currentPeriodStart,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            ...(subscription.pendingPlan === undefined
              ? {}
              : { pendingPlan: subscription.pendingPlan }),
          },
    trial: { status: trialStatus },
    lastTopupError: billing.lastTopupError,
    consecutiveTopupFailures: billing.consecutiveTopupFailures ?? 0,
    firstPaidAt: billing.firstPaidAt,
    hasPaymentMethod: billing.paymentMethodReadyAt !== undefined,
    workspaces: await Promise.all(
      workspaces.map(async workspace => ({
        id: workspace._id,
        slug: workspace.slug,
        name: workspace.name,
        storage: await workspaceStorage(ctx, workspace, user),
      })),
    ),
  }
}

const DECIMAL_GB_BYTES = 1_000_000_000

async function workspaceStorage(ctx: QueryCtx, workspace: Doc<'workspaces'>, payer: Doc<'users'>) {
  const plan = storagePlanForUser(payer)
  const hasVm = workspace.status !== 'archived' && workspace.vmName !== undefined
  const sample = hasVm
    ? await ctx.db
        .query('vmTelemetrySamples')
        .withIndex('by_workspace_at', q => q.eq('workspaceId', workspace._id))
        .order('desc')
        .first()
    : null

  return projectWorkspaceStorage({
    plan,
    hasVm,
    vmDiskGb: workspace.vmDiskGb,
    sample: sample === null ? undefined : sample,
  })
}

/**
 * THE storage quota projection.
 *
 * `usedBytes` subtracts the image from the provider's raw filesystem figure,
 * because `usableGb` below has ALREADY excluded the same headroom — the plan
 * provisions `storageGb + VM_IMAGE_HEADROOM_GB` and only advertises the former.
 * Feeding raw `fsUsedGb` against that denominator would show ~7.4 GB used on a
 * brand-new empty workspace and fire the 90% warning about 8 GB early. It fails
 * silently: no error, just a bar that lies.
 *
 * The clamp is load-bearing in a second way. Today's image measures 7.449 GB
 * against a constant of 8, so without `max(0, …)` a fresh VM reads negative.
 * When the image eventually crosses 8 GB this under-reports instead — which is
 * why `user-billing-storage.test.ts` pins the 7.449 case by name, so that day
 * produces a failing test rather than a quietly wrong number.
 *
 * This is the only place the subtraction happens. The telemetry chart shows the
 * raw filesystem figure on purpose: it answers "what is on the disk", while
 * this answers "how much of your allowance have you used".
 */
export function projectWorkspaceStorage(args: {
  plan: SubscriptionPlanId
  hasVm: boolean
  vmDiskGb?: number
  sample?: Pick<Doc<'vmTelemetrySamples'>, 'at' | 'fsUsedGb'>
}): BillingWorkspace['storage'] {
  const rawDiskGb = args.hasVm
    ? (args.vmDiskGb ?? vmDiskGbForPlan(args.plan))
    : vmDiskGbForPlan(args.plan)
  const usableGb = rawDiskGb - VM_IMAGE_HEADROOM_GB
  // A retained larger disk (D4) can already cover the next tier's storage —
  // an upgrade step that grows nothing is suppressed, not advertised.
  const candidateNextPlan = nextStoragePlan(args.plan)
  const nextPlan =
    candidateNextPlan !== undefined && SUBSCRIPTION_PLANS[candidateNextPlan].storageGb > usableGb
      ? candidateNextPlan
      : undefined
  const sample = args.hasVm ? args.sample : undefined

  return {
    usableGb,
    plan: args.plan,
    ...(nextPlan === undefined
      ? {}
      : { nextPlan, nextUsableGb: SUBSCRIPTION_PLANS[nextPlan].storageGb }),
    ...(sample === undefined
      ? {}
      : {
          sampledAt: sample.at,
          ...(sample.fsUsedGb === undefined
            ? {}
            : {
                usedBytes: Math.max(0, sample.fsUsedGb - VM_IMAGE_HEADROOM_GB) * DECIMAL_GB_BYTES,
              }),
        }),
  }
}

function nextStoragePlan(plan: SubscriptionPlanId): SubscriptionPlanId | undefined {
  if (plan === 'starter') return 'pro'
  if (plan === 'pro') return 'max'
  return undefined
}

export async function updateUserBilling(
  ctx: MutationCtx,
  args: {
    internalKey: string
    actorId: Id<'users'>
    workspaceId: Id<'workspaces'>
    autoTopupEnabled?: boolean
    autoTopupThresholdMicroUsd?: number
    autoTopupAmountMicroUsd?: number
    maxMonthlySpendMicroUsd?: number | null
    now: number
  },
) {
  requireApiInternalKey(args.internalKey)
  await requirePayerWorkspace(ctx, args.workspaceId, args.actorId)
  const user = await ctx.db.get(args.actorId)
  if (user === null) throw new Error('User not found')
  assertValidAutoTopupThreshold(args.autoTopupThresholdMicroUsd)
  if (args.autoTopupEnabled === true && user.billing?.paymentMethodReadyAt === undefined) {
    throw new Error('Payment method required')
  }
  await ctx.db.patch(args.actorId, {
    billing: {
      ...user.billing,
      ...(args.autoTopupEnabled === undefined ? {} : { autoTopupEnabled: args.autoTopupEnabled }),
      ...(args.autoTopupThresholdMicroUsd === undefined
        ? {}
        : { autoTopupThresholdMicroUsd: args.autoTopupThresholdMicroUsd }),
      ...(args.autoTopupAmountMicroUsd === undefined
        ? {}
        : { autoTopupAmountMicroUsd: args.autoTopupAmountMicroUsd }),
      ...(args.maxMonthlySpendMicroUsd === undefined
        ? {}
        : { maxMonthlySpendMicroUsd: args.maxMonthlySpendMicroUsd ?? undefined }),
    },
    updatedAt: args.now,
  })
  for (const workspace of await payerWorkspaces(ctx, args.actorId)) {
    await writeAuditEvent(ctx, {
      workspaceId: workspace._id,
      event: 'billing.settings_updated',
      actorId: args.actorId,
      at: args.now,
    })
  }
}

export async function billingHistory(
  ctx: QueryCtx,
  args: {
    internalKey: string
    actorId: Id<'users'>
    paginationOpts: { cursor: string | null; numItems: number }
  },
) {
  requireApiInternalKey(args.internalKey)
  const result = await ctx.db
    .query('creditTransactions')
    .withIndex('by_user_created_id', q => q.eq('userId', args.actorId))
    .order('desc')
    .paginate(args.paginationOpts)
  return {
    ...result,
    page: result.page.map(transaction => {
      if (transaction.workspaceId !== undefined && transaction.workspaceName === undefined) {
        throw new Error('Workspace billing transaction is missing its workspace snapshot')
      }
      return {
        id: transaction._id,
        ...(transaction.workspaceId === undefined
          ? { scope: 'account' as const }
          : {
              scope: 'workspace' as const,
              workspaceId: transaction.workspaceId,
              workspaceName: transaction.workspaceName!,
            }),
        amountMicroUsd: transaction.amountMicroUsd,
        type: transaction.type,
        /* The only metadata this projection carries. It exists so billing
           history can tell a VM compute fee from model spend; the reference and
           the rest of the metadata stay private. */
        ...(transaction.metadata?.usageKind === undefined
          ? {}
          : { usageKind: transaction.metadata.usageKind }),
        createdAt: transaction.createdAt,
      }
    }),
  }
}

export async function billingSessionAccount(
  ctx: QueryCtx,
  args: { internalKey: string; actorId: Id<'users'>; workspaceId: Id<'workspaces'> },
): Promise<BillingSessionAccount> {
  requireApiInternalKey(args.internalKey)
  const workspace = await requirePayerWorkspace(ctx, args.workspaceId, args.actorId)
  const user = await ctx.db.get(args.actorId)
  if (user === null) throw new Error('User not found')
  return {
    userId: user._id,
    email: user.email,
    stripeCustomerId: user.billing?.stripeCustomerId,
    paymentMethodReady: user.billing?.paymentMethodReadyAt !== undefined,
    paymentMethodReadyAt: user.billing?.paymentMethodReadyAt,
    onboardingPaymentAttemptId: user.billing?.onboardingPaymentAttemptId,
    onboardingPaymentIntentId: user.billing?.onboardingPaymentIntentId,
    onboardingPaymentStatus: user.billing?.onboardingPaymentStatus,
    workspaceId: workspace._id,
    workspaceSlug: workspace.slug,
    subscription: user.billing?.subscription,
  }
}

export async function onboardingPaymentStatus(
  ctx: QueryCtx,
  args: { internalKey: string; actorId: Id<'users'>; workspaceId: Id<'workspaces'> },
) {
  requireApiInternalKey(args.internalKey)
  await requirePayerWorkspace(ctx, args.workspaceId, args.actorId)
  const user = await ctx.db.get(args.actorId)
  if (user === null) throw new Error('User not found')
  const billing = user.billing
  return {
    ready: billing?.paymentMethodReadyAt !== undefined,
    ...(billing?.paymentMethodReadyAt === undefined
      ? {}
      : { paymentMethodReadyAt: billing.paymentMethodReadyAt }),
    ...(billing?.onboardingPaymentAttemptId === undefined
      ? {}
      : { attemptId: billing.onboardingPaymentAttemptId }),
    ...(billing?.onboardingPaymentIntentId === undefined
      ? {}
      : { paymentIntentId: billing.onboardingPaymentIntentId }),
    ...(billing?.onboardingPaymentStatus === undefined
      ? {}
      : { status: billing.onboardingPaymentStatus }),
  }
}

export async function recordOnboardingPaymentAttempt(
  ctx: MutationCtx,
  args: {
    internalKey: string
    actorId: Id<'users'>
    workspaceId: Id<'workspaces'>
    attemptId: string
    paymentIntentId: string
    status: string
    now: number
  },
) {
  requireApiInternalKey(args.internalKey)
  await requirePayerWorkspace(ctx, args.workspaceId, args.actorId)
  const user = await ctx.db.get(args.actorId)
  if (user === null) throw new Error('User not found')
  await ctx.db.patch(args.actorId, {
    billing: {
      ...user.billing,
      onboardingPaymentAttemptId: args.attemptId,
      onboardingPaymentIntentId: args.paymentIntentId,
      onboardingPaymentStatus: args.status,
    },
    updatedAt: args.now,
  })
}

export async function markOnboardingPaymentReady(
  ctx: MutationCtx,
  args: {
    internalKey: string
    actorId: Id<'users'>
    workspaceId: Id<'workspaces'>
    attemptId: string
    paymentIntentId: string
    now: number
  },
) {
  requireApiInternalKey(args.internalKey)
  await requirePayerWorkspace(ctx, args.workspaceId, args.actorId)
  const user = await ctx.db.get(args.actorId)
  if (user === null) throw new Error('User not found')
  if (user.billing?.paymentMethodReadyAt !== undefined) return user.billing.paymentMethodReadyAt
  await ctx.db.patch(args.actorId, {
    billing: {
      ...user.billing,
      paymentMethodReadyAt: args.now,
      onboardingPaymentAttemptId: args.attemptId,
      onboardingPaymentIntentId: args.paymentIntentId,
      onboardingPaymentStatus: 'ready',
    },
    updatedAt: args.now,
  })
  return args.now
}

export async function attachStripeCustomer(
  ctx: MutationCtx,
  args: {
    internalKey: string
    actorId: Id<'users'>
    workspaceId: Id<'workspaces'>
    stripeCustomerId: string
    now: number
  },
) {
  requireApiInternalKey(args.internalKey)
  await requirePayerWorkspace(ctx, args.workspaceId, args.actorId)
  const user = await ctx.db.get(args.actorId)
  if (user === null) throw new Error('User not found')
  if (user.billing?.stripeCustomerId !== undefined) return user.billing.stripeCustomerId
  await ctx.db.patch(args.actorId, {
    billing: { ...user.billing, stripeCustomerId: args.stripeCustomerId },
    updatedAt: args.now,
  })
  for (const workspace of await payerWorkspaces(ctx, args.actorId)) {
    await writeAuditEvent(ctx, {
      workspaceId: workspace._id,
      event: 'billing.customer_created',
      actorId: args.actorId,
      at: args.now,
    })
  }
  return args.stripeCustomerId
}

async function payerWorkspaces(
  ctx: QueryCtx | MutationCtx,
  actorId: Id<'users'>,
): Promise<Doc<'workspaces'>[]> {
  const candidates = await ctx.db
    .query('workspaces')
    .withIndex('by_billing_user', q => q.eq('billingUserId', actorId))
    .take(100)
  const result: Doc<'workspaces'>[] = []
  for (const workspace of candidates) {
    if (!isLiveWorkspace(workspace.status)) continue
    const membership = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', workspace._id).eq('userId', actorId),
      )
      .unique()
    if (membership?.role === 'owner') result.push(workspace)
  }
  return result
}

async function requirePayerWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<'workspaces'>,
  actorId: Id<'users'>,
): Promise<Doc<'workspaces'>> {
  const workspace = await ctx.db.get(workspaceId)
  if (
    workspace === null ||
    !isLiveWorkspace(workspace.status) ||
    workspace.billingUserId !== actorId
  ) {
    throw new Error('Billing payer required')
  }
  const membership = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspaceId).eq('userId', actorId))
    .unique()
  if (membership?.role !== 'owner') throw new Error('Billing payer required')
  return workspace
}
