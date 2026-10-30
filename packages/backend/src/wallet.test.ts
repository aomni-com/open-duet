import { expect, test } from 'bun:test'

import type { Doc, Id } from '../convex/_generated/dataModel'
import type { MutationCtx } from '../convex/_generated/server'
import { allocateSpend, applyWalletDelta, bucketFor } from '../convex/domains/credits/wallet'

// SUBS-IMPL-02
test('allocateSpend drains a monthly-only wallet without touching paid credit', () => {
  expect(allocateSpend({ monthlyMicroUsd: 5_000, paidMicroUsd: 0 }, 3_000)).toEqual({
    monthlyDebitMicroUsd: 3_000,
    paidDebitMicroUsd: 0,
  })
})

test.each([
  ['paid-only', { monthlyMicroUsd: 0, paidMicroUsd: 5_000 }, 3_000, [0, 3_000]],
  ['exact monthly boundary', { monthlyMicroUsd: 3_000, paidMicroUsd: 5_000 }, 3_000, [3_000, 0]],
  ['monthly-to-paid spill', { monthlyMicroUsd: 2_000, paidMicroUsd: 5_000 }, 3_000, [2_000, 1_000]],
  ['zero debit', { monthlyMicroUsd: 2_000, paidMicroUsd: 5_000 }, 0, [0, 0]],
  ['paid overdraft', { monthlyMicroUsd: 2_000, paidMicroUsd: 500 }, 3_000, [2_000, 1_000]],
] as const)('allocateSpend handles %s', (_name, wallet, debit, expected) => {
  expect(allocateSpend(wallet, debit)).toEqual({
    monthlyDebitMicroUsd: expected[0],
    paidDebitMicroUsd: expected[1],
  })
})

test('bucketFor keeps generic credits paid and subscription lifecycle entries monthly', () => {
  expect((['grant', 'topup', 'adjustment'] as const).map(bucketFor)).toEqual([
    'paid',
    'paid',
    'paid',
  ])
  expect((['subscription_grant', 'subscription_expiry'] as const).map(bucketFor)).toEqual([
    'monthly',
    'monthly',
  ])
})

test('applyWalletDelta applies paid-balance arithmetic and persists the result', async () => {
  const user = {
    _id: 'user-1' as Id<'users'>,
    paidCreditBalanceMicroUsd: 1_250,
    monthlyCreditBalanceMicroUsd: 400,
  } as Doc<'users'>
  const patches: Array<{ id: Id<'users'>; patch: unknown }> = []
  const ctx = {
    db: {
      patch: async (id: Id<'users'>, patch: unknown) => {
        patches.push({ id, patch })
      },
    },
  } as unknown as Pick<MutationCtx, 'db'>

  await expect(
    applyWalletDelta(ctx, user, {
      paidDeltaMicroUsd: -275,
      monthlyDeltaMicroUsd: 0,
    }),
  ).resolves.toEqual({ paidMicroUsd: 975, monthlyMicroUsd: 400 })
  expect(patches).toEqual([
    {
      id: user._id,
      patch: { paidCreditBalanceMicroUsd: 975, monthlyCreditBalanceMicroUsd: 400 },
    },
  ])
})

test('applyWalletDelta rejects generic positive monthly credit', async () => {
  const user = {
    _id: 'user-1' as Id<'users'>,
    paidCreditBalanceMicroUsd: 1_250,
    monthlyCreditBalanceMicroUsd: 400,
  } as Doc<'users'>
  const ctx = { db: { patch: async () => undefined } } as unknown as Pick<MutationCtx, 'db'>

  await expect(
    applyWalletDelta(ctx, user, { paidDeltaMicroUsd: 0, monthlyDeltaMicroUsd: 1 }),
  ).rejects.toThrow('Positive monthly credit is only allowed through resetMonthlyCreditsWithDb')
})
