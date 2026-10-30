import { expect, test } from 'bun:test'

import type { SubscriptionPlanId } from '@repo/contract'

import type { Doc } from '../convex/_generated/dataModel'
import { desiredServicingStatus, fundingOf } from '../convex/domains/credits/subscriptions'

const NOW = Date.UTC(2035, 6, 14)
const DAY = 24 * 60 * 60 * 1_000

test('a trialing payer funds their workspaces without a plan', () => {
  expect(fundingOf(payer({ trialExpiresAt: NOW + 3 * DAY }), NOW)).toEqual({
    plan: null,
    active: true,
    trialEndsAt: NOW + 3 * DAY,
  })
})

test('a subscriber funds by plan, with no trial deadline left to report', () => {
  expect(
    fundingOf(
      payer({
        subscription: { plan: 'pro', status: 'active' },
        monthlyCreditExpiresAt: NOW + DAY,
        subscriptionEverActivatedAt: NOW - 90 * DAY,
        // A stale trial timestamp survives on the row forever; converting must
        // not leave the agent counting down to a deadline that stopped meaning
        // anything the day the first invoice was paid.
        trialExpiresAt: NOW + 3 * DAY,
      }),
      NOW,
    ),
  ).toEqual({ plan: 'pro', active: true })
})

test('a lapsed payer funds nothing, and their plan does not linger', () => {
  const lapsed = payer({
    subscription: { plan: 'max', status: 'canceled' },
    monthlyCreditExpiresAt: NOW - DAY,
    subscriptionEverActivatedAt: NOW - 90 * DAY,
    trialExpiresAt: NOW + 3 * DAY,
  })

  expect(fundingOf(lapsed, NOW)).toEqual({ plan: null, active: false })
  // The trial is not a second chance: it is spent the moment a subscription
  // ever activated, so a churned payer never falls back into one.
  expect(desiredServicingStatus(lapsed, NOW)).toBe('paused')
})

test('a trial with nothing spendable left is over before its deadline', () => {
  const broke = payer({ trialExpiresAt: NOW + 3 * DAY }, 0)

  expect(fundingOf(broke, NOW)).toEqual({
    plan: null,
    active: false,
    trialEndsAt: NOW + 3 * DAY,
  })
  expect(desiredServicingStatus(broke, NOW)).toBe('paused')
})

// The reason this derivation is shared rather than copied: the refusal a human
// meets and the block their agent reads have to name the same plan.
test.each(['starter', 'pro', 'max'] as const)(
  'a live %s subscription is what capacity reads back',
  plan => {
    expect(
      fundingOf(
        payer({ subscription: { plan, status: 'active' }, monthlyCreditExpiresAt: NOW + DAY }),
        NOW,
      ).plan,
    ).toBe(plan)
  },
)

// Funding and servicing answer different questions, and a member needs both:
// this payer IS entitled, and their workspaces are still being cut off.
test('a payment dispute pauses servicing without unfunding the workspace', () => {
  const disputed = payer({
    subscription: { plan: 'pro', status: 'active' },
    monthlyCreditExpiresAt: NOW + DAY,
    subscriptionEverActivatedAt: NOW - 90 * DAY,
    disputeFlaggedAt: NOW - DAY,
  })

  expect(fundingOf(disputed, NOW)).toEqual({ plan: 'pro', active: true })
  expect(desiredServicingStatus(disputed, NOW)).toBe('paused')
})

function payer(
  billing: {
    subscription?: { plan: SubscriptionPlanId; status: 'active' | 'canceled' }
    monthlyCreditExpiresAt?: number
    subscriptionEverActivatedAt?: number
    trialExpiresAt?: number
    disputeFlaggedAt?: number
  },
  paidCreditBalanceMicroUsd = 25_000_000,
): Doc<'users'> {
  return {
    billing,
    paidCreditBalanceMicroUsd,
    monthlyCreditBalanceMicroUsd: 0,
  } as unknown as Doc<'users'>
}
