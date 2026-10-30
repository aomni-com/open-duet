import { describe, expect, test } from 'bun:test'

import { COLLECTION_PAGE_DEFAULT_LIMIT } from '../pagination/index'

import {
  MIN_AUTO_TOPUP_AMOUNT_MICRO_USD,
  MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
} from '../ledger/index'
import {
  BillingHistoryPageSchema,
  BillingHostedSessionResponseSchema,
  type BillingHistoryResponse,
  BillingTopupConfigSchema,
  CreditTransactionReferenceSchema,
  MAX_CREDIT_TRANSACTION_REFERENCE_UTF8_BYTES,
  SubscriptionPlanChangeRequestSchema,
  SubscriptionPlanChangeResponseSchema,
  SubscriptionCheckoutRequestSchema,
  SubscriptionStatusSchema,
  TransactionTypeSchema,
  UserBillingConfigRequestSchema,
  type UserBillingOverview,
  UserBillingOverviewSchema,
  UserSubscriptionSchema,
  WorkspaceLedgerEntrySchema,
  WorkspaceLedgerPageSchema,
  WorkspaceLedgerQuerySchema,
  type SubscriptionStatus,
} from './index'

describe('billing top-up config contract', () => {
  test('bounds persisted transaction references by UTF-8 bytes', () => {
    expect(
      CreditTransactionReferenceSchema.safeParse(
        'a'.repeat(MAX_CREDIT_TRANSACTION_REFERENCE_UTF8_BYTES),
      ).success,
    ).toBe(true)
    expect(
      CreditTransactionReferenceSchema.safeParse(
        `${'a'.repeat(MAX_CREDIT_TRANSACTION_REFERENCE_UTF8_BYTES - 3)}🚀`,
      ).success,
    ).toBe(false)
  })

  test('requires usable top-up amounts, a five-dollar threshold, and nonnegative cap values', () => {
    expect(
      BillingTopupConfigSchema.safeParse({
        autoTopupAmountMicroUsd: MIN_AUTO_TOPUP_AMOUNT_MICRO_USD,
        autoTopupThresholdMicroUsd: MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
        maxMonthlySpendMicroUsd: 0,
      }).success,
    ).toBe(true)
    expect(BillingTopupConfigSchema.safeParse({ autoTopupAmountMicroUsd: 1 }).success).toBe(false)
    expect(
      BillingTopupConfigSchema.safeParse({
        autoTopupThresholdMicroUsd: MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD - 1,
      }).success,
    ).toBe(false)
    expect(BillingTopupConfigSchema.safeParse({ autoTopupThresholdMicroUsd: 0 }).success).toBe(
      false,
    )
    expect(BillingTopupConfigSchema.safeParse({ maxMonthlySpendMicroUsd: -1 }).success).toBe(false)
  })

  test('payer settings can explicitly clear a monthly limit without widening money inputs', () => {
    expect(
      UserBillingConfigRequestSchema.parse({
        workspaceSlug: 'acme',
        maxMonthlySpendMicroUsd: null,
      }),
    ).toEqual({ workspaceSlug: 'acme', maxMonthlySpendMicroUsd: null })
    expect(
      UserBillingConfigRequestSchema.safeParse({
        workspaceSlug: 'acme',
        maxMonthlySpendMicroUsd: -1,
      }).success,
    ).toBe(false)
  })

  test('rejects the deleted low-credit acknowledgement input', () => {
    expect(
      UserBillingConfigRequestSchema.safeParse({
        workspaceSlug: 'acme',
        acknowledgeLowCreditWarningPeriodStart: 1_700_000_000_000,
      }).success,
    ).toBe(false)
  })
})

describe('subscription billing contract', () => {
  test('pages workspace ledger entries with the universal collection envelope', () => {
    expect(WorkspaceLedgerQuerySchema.parse({})).toEqual({ limit: COLLECTION_PAGE_DEFAULT_LIMIT })
    expect(
      WorkspaceLedgerPageSchema.parse({
        items: [
          {
            id: 'transaction_2',
            amountMicroUsd: -1,
            type: 'usage',
            createdAt: 2,
          },
        ],
        nextCursor: 'next',
        entries: [{ id: 'legacy' }],
      }),
    ).toEqual({
      items: [
        {
          id: 'transaction_2',
          amountMicroUsd: -1,
          type: 'usage',
          createdAt: 2,
        },
      ],
      nextCursor: 'next',
    })
    expect(WorkspaceLedgerQuerySchema.safeParse({ unknown: 'value' }).success).toBe(false)
  })
  test('preserves per-workspace storage measurements and server-derived plan steps', () => {
    const overview = {
      monthlySpendMicroUsd: 0,
      autoTopupThresholdMicroUsd: MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
      balanceMicroUsd: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      consecutiveTopupFailures: 0,
      hasPaymentMethod: false,
      workspaces: [
        {
          id: 'workspace_1',
          slug: 'acme',
          name: 'Acme',
          storage: {
            usableGb: 50,
            usedBytes: 12_345_678,
            sampledAt: 1_700_000_000_000,
            plan: 'pro',
            nextPlan: 'max',
            nextUsableGb: 100,
          },
        },
        {
          id: 'workspace_2',
          slug: 'maximum',
          name: 'Maximum',
          storage: { usableGb: 100, plan: 'max' },
        },
      ],
      subscription: null,
      trial: { status: 'available' },
    } satisfies UserBillingOverview

    expect(UserBillingOverviewSchema.parse(overview)).toEqual(overview)
  })

  test('preserves a route-created Stripe resource id for staging cleanup', () => {
    expect(
      BillingHostedSessionResponseSchema.parse({
        url: 'https://billing.stripe.com/session/test',
        sessionId: 'bps_test_123',
      }),
    ).toEqual({
      url: 'https://billing.stripe.com/session/test',
      sessionId: 'bps_test_123',
    })
  })

  test('accepts subscription grant and expiry ledger entries', () => {
    expect(TransactionTypeSchema.parse('subscription_grant')).toBe('subscription_grant')
    expect(TransactionTypeSchema.parse('subscription_expiry')).toBe('subscription_expiry')
  })

  test('round-trips Stripe status, subscription, overview, and checkout projections', () => {
    const statusLabels = {
      incomplete: 'Incomplete',
      incomplete_expired: 'Incomplete expired',
      trialing: 'Trialing',
      active: 'Active',
      past_due: 'Past due',
      canceled: 'Canceled',
      unpaid: 'Unpaid',
      paused: 'Paused',
    } satisfies Record<SubscriptionStatus, string>
    expect(SubscriptionStatusSchema.options).toEqual(
      Object.keys(statusLabels) as SubscriptionStatus[],
    )
    for (const status of SubscriptionStatusSchema.options) {
      expect(SubscriptionStatusSchema.parse(status)).toBe(status)
    }

    const subscription = {
      plan: 'pro',
      status: 'active',
      isActive: true,
      currentPeriodStart: 1_700_000_000_000,
      currentPeriodEnd: 1_702_592_000_000,
      creditsExpireAt: 1_702_592_000_000,
      cancelAtPeriodEnd: false,
      pendingPlan: 'starter',
    } as const
    expect(UserSubscriptionSchema.parse(subscription)).toEqual(subscription)

    for (const trialStatus of ['available', 'exhausted', 'ended'] as const) {
      const overview = {
        monthlySpendMicroUsd: 1_000_000,
        autoTopupThresholdMicroUsd: MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
        balanceMicroUsd: 7_000_000,
        paidCreditBalanceMicroUsd: 5_000_000,
        monthlyCreditBalanceMicroUsd: 2_000_000,
        consecutiveTopupFailures: 0,
        hasPaymentMethod: true,
        workspaces: [],
        subscription,
        trial: { status: trialStatus },
      }
      expect(UserBillingOverviewSchema.parse(overview)).toEqual(overview)
    }

    expect(
      UserBillingOverviewSchema.safeParse({
        monthlySpendMicroUsd: 0,
        autoTopupThresholdMicroUsd: MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
        balanceMicroUsd: 8,
        paidCreditBalanceMicroUsd: 5,
        monthlyCreditBalanceMicroUsd: 2,
        consecutiveTopupFailures: 0,
        hasPaymentMethod: false,
        workspaces: [],
        subscription: null,
        trial: { status: 'available' },
      }).success,
    ).toBe(false)

    const checkout = { workspaceSlug: 'acme', plan: 'max' } as const
    expect(SubscriptionCheckoutRequestSchema.parse(checkout)).toEqual(checkout)
    expect(
      SubscriptionPlanChangeRequestSchema.parse({ workspaceSlug: 'acme', plan: 'pro' }),
    ).toEqual({ workspaceSlug: 'acme', plan: 'pro' })
    expect(
      SubscriptionPlanChangeRequestSchema.parse({ workspaceSlug: 'acme', cancel: true }),
    ).toEqual({ workspaceSlug: 'acme', cancel: true })
    expect(
      SubscriptionPlanChangeRequestSchema.parse({ workspaceSlug: 'acme', resume: true }),
    ).toEqual({ workspaceSlug: 'acme', resume: true })
    expect(SubscriptionPlanChangeResponseSchema.parse({ ok: true })).toEqual({ ok: true })
  })

  test('billing history declares account or workspace scope without private Stripe fields', () => {
    const history: BillingHistoryResponse = {
      items: [
        {
          id: 'tx_account',
          scope: 'account',
          amountMicroUsd: 20_000_000,
          type: 'subscription_grant',
          createdAt: 1,
        },
        {
          id: 'tx_workspace',
          scope: 'workspace',
          workspaceId: 'workspace_1',
          workspaceName: 'Acme',
          amountMicroUsd: -1_000_000,
          type: 'usage',
          createdAt: 2,
        },
      ],
      nextCursor: null,
    }
    expect(BillingHistoryPageSchema.parse(history)).toEqual(history)
  })

  test('billing history round-trips usageKind and treats its absence as model spend', () => {
    const vmCompute = {
      id: 'tx_vm_compute',
      scope: 'workspace' as const,
      workspaceId: 'workspace_1',
      workspaceName: 'Acme',
      amountMicroUsd: -4_200,
      type: 'usage' as const,
      usageKind: 'vm_compute' as const,
      createdAt: 3,
    }
    const modelSpend = { ...vmCompute, id: 'tx_model_spend', usageKind: undefined }
    const parsed = BillingHistoryPageSchema.parse({
      items: [vmCompute, modelSpend],
      nextCursor: null,
    })
    expect(parsed.items[0]).toEqual(vmCompute)
    expect(parsed.items[1]?.usageKind).toBeUndefined()

    // A kind this client does not know about is a rejected row, not a mislabelled
    // one: the label switch treats "not vm_compute" as model spend.
    expect(
      BillingHistoryPageSchema.safeParse({
        items: [{ ...vmCompute, usageKind: 'storage' }],
        nextCursor: null,
      }).success,
    ).toBe(false)
  })

  test('workspace ledger entries expose a model tier without private margin telemetry', () => {
    expect(
      WorkspaceLedgerEntrySchema.parse({
        id: 'tx_tiered_usage',
        amountMicroUsd: -3_750,
        type: 'usage',
        actorUserId: 'user_1',
        tier: 'balanced',
        model: 'openai/gpt-5.6-luna',
        upstreamCostMicroUsd: 2_125,
        provider: 'openrouter',
        createdAt: 1,
      }),
    ).toEqual({
      id: 'tx_tiered_usage',
      amountMicroUsd: -3_750,
      type: 'usage',
      actorUserId: 'user_1',
      tier: 'balanced',
      createdAt: 1,
    })
  })
})
