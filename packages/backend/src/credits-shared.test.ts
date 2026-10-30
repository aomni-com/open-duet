import { expect, test } from 'bun:test'

import {
  currentMonthKey,
  dollarsToMicroUsd,
  LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
} from '@repo/contract'

import type { Doc } from '../convex/_generated/dataModel'
import { authorizeSpend, workspaceCreditRecovery } from '../convex/domains/credits/creditsShared'

test('active subscriber recovery starts at the inclusive configured combined balance', () => {
  const now = Date.UTC(2035, 6, 14)
  const activeSubscriber = {
    paidCreditBalanceMicroUsd: LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD - 1,
    monthlyCreditBalanceMicroUsd: 1,
    billing: {
      monthlyCreditExpiresAt: now + 1_000,
      subscription: {
        stripeSubscriptionId: 'sub_low_credit',
        stripePriceId: 'price_pro',
        plan: 'pro',
        status: 'active',
        currentPeriodStart: now - 1_000,
        currentPeriodEnd: now + 1_000,
        cancelAtPeriodEnd: false,
        latestLifecycleEventCreatedAt: now - 1_000,
        latestLifecycleEventId: 'evt_low_credit',
      },
    },
  }

  expect(workspaceCreditRecovery(activeSubscriber as Doc<'users'>, 'active', now)).toBe('topup')
  expect(
    workspaceCreditRecovery(
      {
        ...activeSubscriber,
        paidCreditBalanceMicroUsd: LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
      } as Doc<'users'>,
      'active',
      now,
    ),
  ).toBeNull()
  expect(
    workspaceCreditRecovery(
      {
        ...activeSubscriber,
        billing: {
          ...activeSubscriber.billing,
          subscription: { ...activeSubscriber.billing.subscription, status: 'past_due' },
        },
      } as Doc<'users'>,
      'active',
      now,
    ),
  ).toBe('subscribe')
})

test('recovery counts monthly credit only until its expiry and sends a trial to subscribe', () => {
  const now = Date.UTC(2035, 6, 14)
  const trial = {
    paidCreditBalanceMicroUsd: LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
    monthlyCreditBalanceMicroUsd: 1,
    billing: {
      trialExpiresAt: now + 10_000,
      monthlyCreditExpiresAt: now - 1,
    },
  } as Doc<'users'>

  expect(workspaceCreditRecovery(trial, 'active', now)).toBe('subscribe')
  expect(
    workspaceCreditRecovery(
      {
        ...trial,
        billing: { ...trial.billing, monthlyCreditExpiresAt: now + 1 },
      } as Doc<'users'>,
      'active',
      now,
    ),
  ).toBeNull()
})

test('automatic top-up and non-active servicing suppress recovery unconditionally', () => {
  const now = Date.UTC(2035, 6, 14)
  const lowTrial = {
    paidCreditBalanceMicroUsd: LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
    monthlyCreditBalanceMicroUsd: 0,
    billing: {
      autoTopupEnabled: true,
      consecutiveTopupFailures: 3,
      trialExpiresAt: now + 10_000,
    },
  } as Doc<'users'>

  expect(workspaceCreditRecovery(lowTrial, 'active', now)).toBeNull()
  expect(
    workspaceCreditRecovery(
      { ...lowTrial, billing: { ...lowTrial.billing, autoTopupEnabled: false } } as Doc<'users'>,
      'paused',
      now,
    ),
  ).toBeNull()
  expect(
    workspaceCreditRecovery(
      { ...lowTrial, billing: { ...lowTrial.billing, autoTopupEnabled: false } } as Doc<'users'>,
      'banned',
      now,
    ),
  ).toBeNull()
})

test('workspace monthly cap blocks while the account monthly cap allows spend', () => {
  const now = Date.UTC(2035, 6, 14)
  const workspace = {
    billing: {
      maxMonthlySpendMicroUsd: dollarsToMicroUsd(1),
      monthlySpendMicroUsd: dollarsToMicroUsd(1),
      monthlySpendPeriodKey: currentMonthKey(now),
    },
  } as Doc<'workspaces'>
  const user = {
    paidCreditBalanceMicroUsd: dollarsToMicroUsd(100),
    monthlyCreditBalanceMicroUsd: 0,
    billing: {
      subscriptionEverActivatedAt: now - 1_000,
      monthlyCreditExpiresAt: now + 1_000,
      subscription: {
        stripeSubscriptionId: 'sub_active',
        stripePriceId: 'price_starter',
        plan: 'starter',
        status: 'active',
        currentPeriodStart: now - 1_000,
        currentPeriodEnd: now + 1_000,
        cancelAtPeriodEnd: false,
        latestLifecycleEventCreatedAt: now - 1_000,
        latestLifecycleEventId: 'evt_active',
      },
      maxMonthlySpendMicroUsd: dollarsToMicroUsd(50),
      monthlySpendMicroUsd: dollarsToMicroUsd(1),
      monthlySpendPeriodKey: currentMonthKey(now),
    },
  } as Doc<'users'>

  expect(
    authorizeSpend(workspace, user, {
      workspaceMonthlySpendMicroUsd: workspace.billing?.monthlySpendMicroUsd ?? 0,
      estimatedCostMicroUsd: 1,
      now,
    }),
  ).toMatchObject({
    proceed: false,
    reason: 'monthly_cap',
    tier: 'workspace',
    accountMonthlyCapMicroUsd: dollarsToMicroUsd(50),
    workspaceMonthlyCapMicroUsd: dollarsToMicroUsd(1),
  })
})

test('a lapsed subscriber cannot spend its old monthly bucket even before that bucket expires', () => {
  const now = Date.UTC(2035, 6, 14)
  const workspace = {
    billing: {
      maxMonthlySpendMicroUsd: 1,
      monthlySpendMicroUsd: 2,
      monthlySpendPeriodKey: currentMonthKey(now),
    },
  } as Doc<'workspaces'>
  const user = {
    paidCreditBalanceMicroUsd: dollarsToMicroUsd(100),
    monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(20),
    billing: {
      subscriptionEverActivatedAt: now - 1_000,
      monthlyCreditExpiresAt: now + 1_000,
      maxMonthlySpendMicroUsd: 1,
      monthlySpendMicroUsd: 2,
      monthlySpendPeriodKey: currentMonthKey(now),
      subscription: {
        stripeSubscriptionId: 'sub_lapsed',
        stripePriceId: 'price_starter',
        plan: 'starter',
        status: 'past_due',
        currentPeriodStart: now - 10_000,
        currentPeriodEnd: now - 1,
        cancelAtPeriodEnd: false,
        latestLifecycleEventCreatedAt: now - 10_000,
        latestLifecycleEventId: 'evt_lapsed',
      },
    },
  } as Doc<'users'>

  expect(
    authorizeSpend(workspace, user, {
      workspaceMonthlySpendMicroUsd: workspace.billing?.monthlySpendMicroUsd ?? 0,
      estimatedCostMicroUsd: 1,
      now,
    }),
  ).toMatchObject({
    proceed: false,
    reason: 'subscription_required',
    balanceMicroUsd: dollarsToMicroUsd(100),
    monthlyCreditBalanceMicroUsd: 0,
    paidCreditBalanceMicroUsd: dollarsToMicroUsd(100),
  })
})

test('an exhausted signup trial needs a subscription instead of reporting low credits', () => {
  const now = Date.UTC(2032, 0, 1)
  const workspace = {} as Doc<'workspaces'>
  const user = {
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    billing: { trialExpiresAt: now + 1_000 },
  } as Doc<'users'>

  expect(authorizeSpend(workspace, user, { workspaceMonthlySpendMicroUsd: 0, now })).toMatchObject({
    proceed: false,
    reason: 'subscription_required',
  })
})
