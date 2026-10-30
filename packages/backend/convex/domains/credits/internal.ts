import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { mutation, query } from '../../_generated/server'
import { usageRollupGranularityValidator } from '../../validators'
import { requireApiInternalKey } from '../apiKeys/model'
import {
  applyLedgerEntryImpl,
  runPreflightImpl,
  setWorkspaceMonthlyCapImpl,
  workspaceLedgerImpl,
} from './ledger'
import { releaseReservationImpl, reserveCreditsImpl, settleReservationImpl } from './reservations'
import { processStripeWebhookEventImpl } from './stripeWebhooks'
import {
  expireLapsedSubscriptionsWithDb,
  reconcileServicingStatus as reconcileServicingStatusWithDb,
} from './subscriptions'
import {
  clearTopupErrorImpl,
  createTopupAttemptImpl,
  getTopupConfigImpl,
  markTopupAttemptImpl,
  recordInvoicePaymentFailureImpl,
  recordTopupErrorImpl,
  setTopupConfigImpl,
} from './topups'
import { applyUsageRollupBatchImpl, listUsageReportImpl, pruneDailyUsageImpl } from './usageRollups'
import {
  attachStripeCustomer as attachStripeCustomerImpl,
  billingHistory,
  billingSessionAccount,
  markOnboardingPaymentReady as markOnboardingPaymentReadyImpl,
  onboardingPaymentStatus,
  recordOnboardingPaymentAttempt as recordOnboardingPaymentAttemptImpl,
  updateUserBilling as updateUserBillingImpl,
  userBillingOverview,
} from './userBilling'

const transactionTypeValidator = v.union(
  v.literal('grant'),
  v.literal('topup'),
  v.literal('usage'),
  v.literal('adjustment'),
  v.literal('reservation'),
)

const usageRollupProjectionValidator = v.object({
  appId: v.optional(v.id('apps')),
  appSlug: v.optional(v.string()),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
})

export const applyLedgerEntryArgs = v.object({
  workspaceId: v.id('workspaces'),
  amountMicroUsd: v.number(),
  type: transactionTypeValidator,
  reference: v.string(),
  userId: v.optional(v.id('users')),
  metadata: v.optional(v.any()),
  usageRollup: v.optional(usageRollupProjectionValidator),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
  now: v.optional(v.number()),
})

export const applyLedgerEntry = mutation({
  args: applyLedgerEntryArgs,
  returns: v.object({
    applied: v.boolean(),
    newBalanceMicroUsd: v.number(),
    transactionId: v.optional(v.id('creditTransactions')),
  }),
  handler: (ctx, args) => applyLedgerEntryImpl(ctx, args),
})

export const runPreflightArgs = v.object({
  workspaceId: v.id('workspaces'),
  userId: v.optional(v.id('users')),
  estimatedCostMicroUsd: v.optional(v.number()),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
  now: v.optional(v.number()),
})

export const runPreflight = mutation({
  args: runPreflightArgs,
  returns: v.object({
    proceed: v.boolean(),
    reason: v.optional(
      v.union(
        v.literal('subscription_required'),
        v.literal('insufficient_credits'),
        v.literal('monthly_cap'),
      ),
    ),
    tier: v.optional(v.union(v.literal('account'), v.literal('workspace'))),
    balanceMicroUsd: v.number(),
    monthlyCreditBalanceMicroUsd: v.number(),
    paidCreditBalanceMicroUsd: v.number(),
    accountMonthlySpendMicroUsd: v.number(),
    accountMonthlyCapMicroUsd: v.optional(v.number()),
    workspaceMonthlySpendMicroUsd: v.number(),
    workspaceMonthlyCapMicroUsd: v.optional(v.number()),
  }),
  handler: (ctx, args) => runPreflightImpl(ctx, args),
})

export const reconcileServicingStatus = mutation({
  args: { userId: v.id('users'), now: v.optional(v.number()), internalKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await reconcileServicingStatusWithDb(ctx, args.userId, args.now ?? Date.now())
    return null
  },
})

export const expireLapsedSubscriptions = mutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    now: v.optional(v.number()),
    internalKey: v.string(),
    useStoredCursor: v.optional(v.boolean()),
  },
  returns: v.object({
    cursor: v.optional(v.string()),
    done: v.boolean(),
    processed: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await expireLapsedSubscriptionsWithDb(ctx, {
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      limit: args.limit ?? 100,
      now: args.now ?? Date.now(),
      useStoredCursor: args.useStoredCursor,
    })
  },
})

export const reserveCreditsArgs = v.object({
  workspaceId: v.id('workspaces'),
  estimateMicroUsd: v.optional(v.number()),
  reference: v.optional(v.string()),
  userId: v.optional(v.id('users')),
  metadata: v.optional(v.any()),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
  now: v.optional(v.number()),
})

export const reserveCredits = mutation({
  args: reserveCreditsArgs,
  returns: v.object({
    proceed: v.boolean(),
    reservationId: v.optional(v.string()),
    reason: v.optional(
      v.union(
        v.literal('subscription_required'),
        v.literal('insufficient_credits'),
        v.literal('monthly_cap'),
      ),
    ),
    tier: v.optional(v.union(v.literal('account'), v.literal('workspace'))),
    balanceMicroUsd: v.number(),
    monthlyCreditBalanceMicroUsd: v.number(),
    paidCreditBalanceMicroUsd: v.number(),
    accountMonthlySpendMicroUsd: v.number(),
    accountMonthlyCapMicroUsd: v.optional(v.number()),
    workspaceMonthlySpendMicroUsd: v.number(),
    workspaceMonthlyCapMicroUsd: v.optional(v.number()),
  }),
  handler: (ctx, args) => reserveCreditsImpl(ctx, args),
})

export const settleReservationArgs = v.object({
  workspaceId: v.id('workspaces'),
  reservationId: v.string(),
  actualCostMicroUsd: v.number(),
  userId: v.optional(v.id('users')),
  metadata: v.optional(v.any()),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
  now: v.optional(v.number()),
})

export const settleReservation = mutation({
  args: settleReservationArgs,
  returns: v.object({ settled: v.boolean(), balanceMicroUsd: v.number() }),
  handler: (ctx, args) => settleReservationImpl(ctx, args),
})

export const releaseReservationArgs = v.object({
  workspaceId: v.id('workspaces'),
  reservationId: v.string(),
  reason: v.optional(v.string()),
  userId: v.optional(v.id('users')),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
  now: v.optional(v.number()),
})

export const releaseReservation = mutation({
  args: releaseReservationArgs,
  returns: v.object({ released: v.boolean(), balanceMicroUsd: v.number() }),
  handler: (ctx, args) => releaseReservationImpl(ctx, args),
})

export const workspaceLedgerArgs = v.object({
  workspaceId: v.id('workspaces'),
  paginationOpts: paginationOptsValidator,
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
})

export const workspaceLedger = query({
  args: workspaceLedgerArgs,
  handler: (ctx, args) => workspaceLedgerImpl(ctx, args),
})

export const setMonthlyCapArgs = v.object({
  workspaceId: v.id('workspaces'),
  maxMonthlySpendMicroUsd: v.optional(v.number()),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
  now: v.optional(v.number()),
})

export const setMonthlyCap = mutation({
  args: setMonthlyCapArgs,
  returns: v.null(),
  handler: (ctx, args) => setWorkspaceMonthlyCapImpl(ctx, args),
})

export const setTopupConfigArgs = v.object({
  workspaceId: v.id('workspaces'),
  autoTopupEnabled: v.optional(v.boolean()),
  autoTopupThresholdMicroUsd: v.optional(v.number()),
  autoTopupAmountMicroUsd: v.optional(v.number()),
  maxMonthlySpendMicroUsd: v.optional(v.number()),
  stripeCustomerId: v.optional(v.string()),
  internalKey: v.string(),
  actorId: v.optional(v.id('users')),
  now: v.optional(v.number()),
})

export const setTopupConfig = mutation({
  args: setTopupConfigArgs,
  returns: v.null(),
  handler: (ctx, args) => setTopupConfigImpl(ctx, args),
})

export const getTopupConfigArgs = v.object({
  workspaceId: v.id('workspaces'),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
})

export const getTopupConfig = query({
  args: getTopupConfigArgs,
  handler: (ctx, args) => getTopupConfigImpl(ctx, args),
})

export const listUsageReportArgs = v.object({
  workspaceId: v.id('workspaces'),
  period: usageRollupGranularityValidator,
  group: v.union(v.literal('workspace'), v.literal('user'), v.literal('app')),
  start: v.optional(v.string()),
  end: v.optional(v.string()),
  internalKey: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
})

export const listUsageReport = query({
  args: listUsageReportArgs,
  handler: (ctx, args) => listUsageReportImpl(ctx, args),
})

export const applyUsageRollupBatchArgs = v.object({
  workspaceId: v.id('workspaces'),
  periodKeys: v.object({
    daily: v.string(),
    weekly: v.string(),
    monthly: v.string(),
  }),
  spendMicroUsd: v.number(),
  userId: v.optional(v.id('users')),
  appId: v.optional(v.id('apps')),
  appSlug: v.optional(v.string()),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  internalKey: v.string(),
  now: v.optional(v.number()),
})

export const applyUsageRollupBatch = mutation({
  args: applyUsageRollupBatchArgs,
  returns: v.null(),
  handler: (ctx, args) => applyUsageRollupBatchImpl(ctx, args),
})

export const pruneDailyUsageArgs = v.object({
  internalKey: v.string(),
  now: v.optional(v.number()),
  limit: v.optional(v.number()),
})

export const pruneDailyUsage = mutation({
  args: pruneDailyUsageArgs,
  returns: v.object({ pruned: v.number() }),
  handler: (ctx, args) => pruneDailyUsageImpl(ctx, args),
})

export const createTopupAttemptArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  userId: v.optional(v.id('users')),
  amountMicroUsd: v.number(),
  idempotencyKey: v.string(),
  now: v.optional(v.number()),
})

export const createTopupAttempt = mutation({
  args: createTopupAttemptArgs,
  handler: (ctx, args) => createTopupAttemptImpl(ctx, args),
})

export const markTopupAttemptArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  userId: v.id('users'),
  idempotencyKey: v.string(),
  status: v.union(v.literal('paid'), v.literal('failed')),
  stripeInvoiceId: v.optional(v.string()),
  failureCode: v.optional(v.string()),
  failureMessage: v.optional(v.string()),
  now: v.optional(v.number()),
})

export const markTopupAttempt = mutation({
  args: markTopupAttemptArgs,
  returns: v.null(),
  handler: (ctx, args) => markTopupAttemptImpl(ctx, args),
})

export const recordTopupErrorArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  userId: v.id('users'),
  error: v.object({ code: v.string(), message: v.string(), at: v.number() }),
})

export const recordTopupError = mutation({
  args: recordTopupErrorArgs,
  returns: v.null(),
  handler: (ctx, args) => recordTopupErrorImpl(ctx, args),
})

export const recordInvoicePaymentFailureArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  userId: v.id('users'),
  error: v.object({ code: v.string(), message: v.string(), at: v.number() }),
})

export const recordInvoicePaymentFailure = mutation({
  args: recordInvoicePaymentFailureArgs,
  returns: v.object({ consecutiveFailures: v.number() }),
  handler: (ctx, args) => recordInvoicePaymentFailureImpl(ctx, args),
})

export const clearTopupErrorArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  userId: v.id('users'),
  now: v.optional(v.number()),
})

export const clearTopupError = mutation({
  args: clearTopupErrorArgs,
  returns: v.null(),
  handler: (ctx, args) => clearTopupErrorImpl(ctx, args),
})

export const processStripeWebhookEventArgs = v.object({
  internalKey: v.string(),
  eventId: v.string(),
  eventCreatedAt: v.number(),
  type: v.string(),
  object: v.any(),
  previousAttributes: v.optional(v.any()),
  subscriptionSchedule: v.optional(v.any()),
  disputeCustomerId: v.optional(v.string()),
  now: v.optional(v.number()),
})

export const processStripeWebhookEvent = mutation({
  args: processStripeWebhookEventArgs,
  returns: v.object({
    ok: v.boolean(),
    replay: v.optional(v.boolean()),
    ignored: v.optional(v.boolean()),
  }),
  handler: (ctx, args) => processStripeWebhookEventImpl(ctx, args),
})

export const getUserBillingOverview = query({
  args: { internalKey: v.string(), actorId: v.id('users'), now: v.optional(v.number()) },
  handler: (ctx, args) => userBillingOverview(ctx, args),
})

export const updateUserBilling = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    autoTopupEnabled: v.optional(v.boolean()),
    autoTopupThresholdMicroUsd: v.optional(v.number()),
    autoTopupAmountMicroUsd: v.optional(v.number()),
    maxMonthlySpendMicroUsd: v.optional(v.union(v.number(), v.null())),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateUserBillingImpl(ctx, args)
    return null
  },
})

export const getBillingHistory = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    paginationOpts: paginationOptsValidator,
  },
  handler: (ctx, args) => billingHistory(ctx, args),
})

export const getBillingSessionAccount = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
  },
  handler: (ctx, args) => billingSessionAccount(ctx, args),
})

export const attachStripeCustomer = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    stripeCustomerId: v.string(),
    now: v.number(),
  },
  handler: (ctx, args) => attachStripeCustomerImpl(ctx, args),
})

export const getOnboardingPaymentStatus = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
  },
  handler: (ctx, args) => onboardingPaymentStatus(ctx, args),
})

export const recordOnboardingPaymentAttempt = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    attemptId: v.string(),
    paymentIntentId: v.string(),
    status: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await recordOnboardingPaymentAttemptImpl(ctx, args)
    return null
  },
})

export const markOnboardingPaymentReady = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    attemptId: v.string(),
    paymentIntentId: v.string(),
    now: v.number(),
  },
  handler: (ctx, args) => markOnboardingPaymentReadyImpl(ctx, args),
})
