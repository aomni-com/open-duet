import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import {
  DEFAULT_TRIAL_GRANT_MICRO_USD,
  HARD_BLOCK_FLOOR_MICRO_USD,
  dollarsToMicroUsd,
} from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-api-internal-key'

let convex: ConvexDevFixture
let owner: SignedInUser
let sequence = 0

describe('credits ledger core', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('credits-owner'),
      'Credits Owner',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('idempotent references apply once, including concurrent replay under OCC', async () => {
    const workspaceId = await createWorkspace('idempotent')
    const otherWorkspaceId = await createWorkspace('idempotent-other')
    const startingBalance = await balance(workspaceId)
    await grant(workspaceId, dollarsToMicroUsd(1), 'grant:sequential')
    await grant(workspaceId, dollarsToMicroUsd(1), 'grant:sequential')
    await grant(otherWorkspaceId, dollarsToMicroUsd(1), 'grant:sequential')

    await Promise.all([
      grant(workspaceId, dollarsToMicroUsd(2), 'grant:race'),
      grant(workspaceId, dollarsToMicroUsd(2), 'grant:race'),
    ])

    const transactions = await listTransactions(workspaceId)
    expect(transactions.filter(row => row.reference === 'grant:sequential')).toHaveLength(1)
    expect(transactions.filter(row => row.reference === 'grant:race')).toHaveLength(1)
    expect(await balance(workspaceId)).toBe(startingBalance + dollarsToMicroUsd(3))
    expect(await balance(otherWorkspaceId)).toBe(startingBalance + dollarsToMicroUsd(3))
    expect(
      (await listTransactions(otherWorkspaceId)).filter(
        row => row.reference === 'grant:sequential',
      ),
    ).toEqual([])
  })

  test('SUBS-IMPL-02 monthly reset expires unused credit, grants the allotment, and replays safely', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('monthly-reset'),
      'Monthly Reset',
    )
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    const periodStart = Date.now() + 60_000
    const input = {
      internalKey: INTERNAL_KEY,
      userId: account.user._id,
      invoiceId: 'in_reset_001',
      plan: 'starter',
      allotmentMicroUsd: dollarsToMicroUsd(20),
      periodStart,
      periodEnd: periodStart + 30 * 24 * 60 * 60 * 1_000,
      invoiceCreatedAt: periodStart + 1_000,
      now: periodStart + 2_000,
    } as const

    expect(await mutate(convex, 'testing/credits:resetMonthlyCreditsForTest', input)).toMatchObject(
      {
        applied: true,
        expiredMicroUsd: 0,
        grantedMicroUsd: dollarsToMicroUsd(20),
        balances: {
          monthlyMicroUsd: dollarsToMicroUsd(20),
          paidMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
        },
      },
    )
    expect(
      await Promise.all([
        mutate(convex, 'testing/credits:resetMonthlyCreditsForTest', input),
        mutate(convex, 'testing/credits:resetMonthlyCreditsForTest', input),
      ]),
    ).toEqual([
      {
        applied: false,
        expiredMicroUsd: 0,
        grantedMicroUsd: 0,
        balances: {
          monthlyMicroUsd: dollarsToMicroUsd(20),
          paidMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
        },
      },
      {
        applied: false,
        expiredMicroUsd: 0,
        grantedMicroUsd: 0,
        balances: {
          monthlyMicroUsd: dollarsToMicroUsd(20),
          paidMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
        },
      },
    ])
    expect(await wallet(workspaceId)).toEqual({
      balanceMicroUsd: dollarsToMicroUsd(25),
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(20),
      paidCreditBalanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
    })
    expect(await persistedBilling(account.user._id)).toMatchObject({
      monthlyCreditEpoch: input.invoiceId,
      monthlyCreditExpiresAt: input.periodEnd,
    })
    const rows = (await listAccountTransactions(account.user._id)).filter(row =>
      row.reference.endsWith('in_reset_001'),
    )
    expect(rows.every(row => !('workspaceId' in row))).toBe(true)
    expect(
      rows.map(row => ({
        type: row.type,
        amountMicroUsd: row.amountMicroUsd,
        monthlyAmountMicroUsd: row.monthlyAmountMicroUsd,
        paidAmountMicroUsd: row.paidAmountMicroUsd,
      })),
    ).toEqual([
      {
        type: 'subscription_expiry',
        amountMicroUsd: 0,
        monthlyAmountMicroUsd: 0,
        paidAmountMicroUsd: 0,
      },
      {
        type: 'subscription_grant',
        amountMicroUsd: dollarsToMicroUsd(20),
        monthlyAmountMicroUsd: dollarsToMicroUsd(20),
        paidAmountMicroUsd: 0,
      },
    ])

    await charge(workspaceId, dollarsToMicroUsd(18), 'usage:before-second-reset')
    expect(
      await mutate(convex, 'testing/credits:resetMonthlyCreditsForTest', {
        ...input,
        invoiceId: 'in_reset_002',
        allotmentMicroUsd: dollarsToMicroUsd(60),
      }),
    ).toMatchObject({
      applied: true,
      expiredMicroUsd: dollarsToMicroUsd(2),
      grantedMicroUsd: dollarsToMicroUsd(60),
      balances: {
        monthlyMicroUsd: dollarsToMicroUsd(60),
        paidMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
      },
    })
    expect(
      (await listAccountTransactions(account.user._id))
        .filter(row => row.reference.endsWith('in_reset_002'))
        .map(row => [
          row.type,
          row.amountMicroUsd,
          row.monthlyAmountMicroUsd,
          row.paidAmountMicroUsd,
        ]),
    ).toEqual([
      ['subscription_expiry', -dollarsToMicroUsd(2), -dollarsToMicroUsd(2), 0],
      ['subscription_grant', dollarsToMicroUsd(60), dollarsToMicroUsd(60), 0],
    ])
  })

  test('monthly reset rejects stale invoices by period end, creation time, then invoice id', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('monthly-stale'),
      'Monthly Stale',
    )
    const periodStart = Date.now() + 60_000
    const periodEnd = periodStart + 30 * 24 * 60 * 60 * 1_000
    const invoiceCreatedAt = periodStart + 1_000
    const base = {
      internalKey: INTERNAL_KEY,
      userId: account.user._id,
      plan: 'pro',
      allotmentMicroUsd: dollarsToMicroUsd(60),
      periodStart,
      now: periodStart + 2_000,
    } as const
    await mutate(convex, 'testing/credits:resetMonthlyCreditsForTest', {
      ...base,
      invoiceId: 'in_b',
      periodEnd,
      invoiceCreatedAt,
    })

    for (const stale of [
      { invoiceId: 'in_z', periodEnd: periodEnd - 1, invoiceCreatedAt: invoiceCreatedAt + 1 },
      { invoiceId: 'in_z', periodEnd, invoiceCreatedAt: invoiceCreatedAt - 1 },
      { invoiceId: 'in_a', periodEnd, invoiceCreatedAt },
    ]) {
      await expect(
        mutate(convex, 'testing/credits:resetMonthlyCreditsForTest', { ...base, ...stale }),
      ).rejects.toThrow('Stale monthly credit invoice')
    }
    expect(
      (await listAccountTransactions(account.user._id))
        .filter(row => row.reference.startsWith('subscription_'))
        .map(row => row.reference),
    ).toEqual(['subscription_expiry:invoice:in_b', 'subscription_grant:invoice:in_b'])
  })

  test('monthly expiry zeroes only monthly credit and is reference-idempotent', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('monthly-expiry'),
      'Monthly Expiry',
    )
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    await resetMonthly(account.user._id, {
      invoiceId: 'in_expiry_001',
      allotmentMicroUsd: dollarsToMicroUsd(5),
    })
    const input = {
      internalKey: INTERNAL_KEY,
      userId: account.user._id,
      reference: 'subscription_expiry:lapse:sub_001',
      reason: 'subscription_lapsed',
      now: Date.UTC(2026, 7, 1),
    }
    expect(
      await mutate(convex, 'testing/credits:expireMonthlyCreditsForTest', input),
    ).toMatchObject({
      applied: true,
      expiredMicroUsd: dollarsToMicroUsd(5),
      balances: { monthlyMicroUsd: 0, paidMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD },
    })
    expect(
      await mutate(convex, 'testing/credits:expireMonthlyCreditsForTest', input),
    ).toMatchObject({
      applied: false,
      balances: { monthlyMicroUsd: 0, paidMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD },
    })
    expect(await wallet(workspaceId)).toEqual({
      balanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
      monthlyCreditBalanceMicroUsd: 0,
      paidCreditBalanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
    })
    expect(
      (await listAccountTransactions(account.user._id))
        .filter(row => row.reference === input.reference)
        .map(row => [row.amountMicroUsd, row.monthlyAmountMicroUsd, row.paidAmountMicroUsd]),
    ).toEqual([[-dollarsToMicroUsd(5), -dollarsToMicroUsd(5), 0]])
  })

  test('SUBS-IMPL-07 expires monthly credits once while an active subscriber keeps paid reserve access', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('lapse-clock'),
      'Lapse Clock',
    )
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    const startedAt = Date.now() - 31 * 24 * 60 * 60 * 1_000
    await mutate(
      account.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
        now: startedAt,
      },
    )
    const billing = await persistedBilling(account.user._id)
    const expiresAt = billing.monthlyCreditExpiresAt as number
    const epoch = billing.monthlyCreditEpoch as string
    const subscription = billing.subscription as { stripeSubscriptionId: string }

    expect(await preflight(workspaceId, dollarsToMicroUsd(0.01), expiresAt - 1)).toMatchObject({
      proceed: true,
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(20),
    })
    expect(await preflight(workspaceId, dollarsToMicroUsd(0.01), expiresAt)).toMatchObject({
      proceed: true,
      monthlyCreditBalanceMicroUsd: 0,
      paidCreditBalanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
    })
    expect(await preflight(workspaceId, dollarsToMicroUsd(0.01), expiresAt + 1)).toMatchObject({
      proceed: true,
      monthlyCreditBalanceMicroUsd: 0,
      paidCreditBalanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
    })
    const reference = `subscription_expiry:lapse:${subscription.stripeSubscriptionId}:${epoch}`
    expect(
      (await listAccountTransactions(account.user._id)).filter(row => row.reference === reference),
    ).toEqual([
      expect.objectContaining({
        type: 'subscription_expiry',
        amountMicroUsd: -dollarsToMicroUsd(20),
      }),
    ])
    await mutate(
      account.client,
      'testing/workspaces:lapseCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const lapsedWorkspaceId = (await mutate(
      account.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('lapsed-birth'),
        name: 'Lapsed birth',
      },
    )) as string
    expect(
      (await listMine(account.client)).find(row => row.workspace._id === lapsedWorkspaceId)
        ?.workspace,
    ).toMatchObject({ servicingStatus: 'paused' })
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      servicingStatus: 'banned',
      now: 42,
    })
    await mutate(convex, 'domains/credits/internal:reconcileServicingStatus', {
      internalKey: INTERNAL_KEY,
      userId: account.user._id,
      now: expiresAt + 2,
    })
    const bannedRow = (
      (await query(convex, 'testing/workspaces:rawWorkspacesForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{
        _id: string
        servicingStatus?: string
        servicingStatusChangedAt?: number
      }>
    ).find(row => row._id === workspaceId)
    expect(bannedRow).toMatchObject({ servicingStatus: 'banned', servicingStatusChangedAt: 42 })

    const racing = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('lapse-race'),
      'Lapse Race',
    )
    const racingWorkspaceId = (await listMine(racing.client))[0]!.workspace._id
    await mutate(
      racing.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, now: startedAt },
    )
    const racingBilling = await persistedBilling(racing.user._id)
    const racingExpiry = racingBilling.monthlyCreditExpiresAt as number
    await Promise.all([
      preflight(racingWorkspaceId, dollarsToMicroUsd(0.01), racingExpiry),
      mutate(convex, 'domains/credits/internal:expireLapsedSubscriptions', {
        internalKey: INTERNAL_KEY,
        limit: 500,
        now: racingExpiry,
      }),
    ])
    const racingSubscription = racingBilling.subscription as { stripeSubscriptionId: string }
    const racingReference = `subscription_expiry:lapse:${racingSubscription.stripeSubscriptionId}:${racingBilling.monthlyCreditEpoch}`
    expect(
      (await listAccountTransactions(racing.user._id)).filter(
        row => row.reference === racingReference,
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'subscription_expiry',
        amountMicroUsd: -dollarsToMicroUsd(20),
      }),
    ])
  })

  test('reconcileServicingStatus refuses callers without the API internal key', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('reconcile-auth'),
      'Reconcile Auth',
    )
    await expect(
      mutate(convex, 'domains/credits/internal:reconcileServicingStatus', {
        internalKey: 'not-the-internal-key',
        userId: account.user._id,
      }),
    ).rejects.toThrow('Unauthorized API internal key')
  })

  test('SUBS-IMPL-07 sweep pauses a never-spent timed-out trial and is idempotent', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('trial-sweep'),
      'Trial Sweep',
    )
    await mutate(account.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: 0,
    })
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    const trialExpiresAt = (await persistedBilling(account.user._id)).trialExpiresAt as number

    await sweepLapses(trialExpiresAt)
    expect((await listMine(account.client))[0]!.workspace).toMatchObject({
      servicingStatus: 'paused',
    })
    expect(await wallet(workspaceId)).toMatchObject({
      paidCreditBalanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
      monthlyCreditBalanceMicroUsd: 0,
    })

    const before = await listAccountTransactions(account.user._id)
    await sweepLapses(trialExpiresAt + 1)
    expect(await listAccountTransactions(account.user._id)).toEqual(before)
  })

  test('usage drains monthly first, spills to paid, and sends overdraft excess only to paid', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('monthly-spend'),
      'Monthly Spend',
    )
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    await grantForAccount(workspaceId, dollarsToMicroUsd(2), 'grant:monthly-spend-paid')
    await resetMonthly(account.user._id, {
      invoiceId: 'in_spend_001',
      allotmentMicroUsd: dollarsToMicroUsd(5),
    })

    await charge(workspaceId, dollarsToMicroUsd(3), 'usage:monthly-only')
    expect(await wallet(workspaceId)).toEqual({
      balanceMicroUsd: dollarsToMicroUsd(9),
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(2),
      paidCreditBalanceMicroUsd: dollarsToMicroUsd(7),
    })
    await charge(workspaceId, dollarsToMicroUsd(5), 'usage:monthly-spill')
    expect(await wallet(workspaceId)).toEqual({
      balanceMicroUsd: dollarsToMicroUsd(4),
      monthlyCreditBalanceMicroUsd: 0,
      paidCreditBalanceMicroUsd: dollarsToMicroUsd(4),
    })
    await charge(workspaceId, dollarsToMicroUsd(10), 'usage:paid-overdraft')
    expect(await wallet(workspaceId)).toEqual({
      balanceMicroUsd: -dollarsToMicroUsd(6),
      monthlyCreditBalanceMicroUsd: 0,
      paidCreditBalanceMicroUsd: -dollarsToMicroUsd(6),
    })

    expect(
      (await listTransactions(workspaceId))
        .filter(
          row =>
            row.reference.startsWith('usage:monthly-') || row.reference === 'usage:paid-overdraft',
        )
        .map(row => [row.reference, row.monthlyAmountMicroUsd, row.paidAmountMicroUsd]),
    ).toEqual([
      ['usage:monthly-only', -dollarsToMicroUsd(3), 0],
      ['usage:monthly-spill', -dollarsToMicroUsd(2), -dollarsToMicroUsd(3)],
      ['usage:paid-overdraft', 0, -dollarsToMicroUsd(10)],
    ])
  })

  test('preflight floor uses combined spendable credit when paid reserve is zero', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('monthly-floor'),
      'Monthly Floor',
    )
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      amountMicroUsd: -DEFAULT_TRIAL_GRANT_MICRO_USD,
      type: 'adjustment',
      reference: 'adjustment:monthly-floor-zero-paid',
    })
    await mutate(
      account.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    await setBalance(workspaceId, dollarsToMicroUsd(5))

    expect(await preflight(workspaceId, dollarsToMicroUsd(0.01))).toMatchObject({
      proceed: true,
      balanceMicroUsd: dollarsToMicroUsd(5),
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(5),
      paidCreditBalanceMicroUsd: 0,
    })
  })

  test('SUBS-IMPL-06 gate fixture table is identical for post-response and reservation billing', async () => {
    for (const mode of ['post_response', 'reservation'] as const) {
      for (const scenario of [
        'trial',
        'exhausted_trial',
        'active',
        'monthly_spill',
        'empty_subscriber',
        'lapsed_with_paid',
      ] as const) {
        const account = await signInWithMagicLink<UserRow>(
          convex,
          uniqueEmail(`gate-${mode}-${scenario}`),
          `Gate ${mode} ${scenario}`,
        )
        const workspaceId = (await listMine(account.client))[0]!.workspace._id
        const now = Date.now()
        if (
          scenario === 'active' ||
          scenario === 'monthly_spill' ||
          scenario === 'empty_subscriber' ||
          scenario === 'lapsed_with_paid'
        ) {
          await mutate(
            account.client,
            'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
            { internalKey: INTERNAL_KEY, now },
          )
        }
        if (scenario === 'exhausted_trial') {
          await charge(workspaceId, DEFAULT_TRIAL_GRANT_MICRO_USD, `usage:gate:${mode}:${scenario}`)
        }
        if (scenario === 'monthly_spill' || scenario === 'lapsed_with_paid') {
          await charge(workspaceId, dollarsToMicroUsd(20), `usage:gate:${mode}:${scenario}`)
        }
        if (scenario === 'empty_subscriber') {
          await charge(
            workspaceId,
            dollarsToMicroUsd(20) + DEFAULT_TRIAL_GRANT_MICRO_USD,
            `usage:gate:${mode}:${scenario}`,
          )
        }
        if (scenario === 'lapsed_with_paid') {
          await mutate(
            account.client,
            'testing/workspaces:lapseCurrentUserSyntheticSubscriptionForTest',
            {
              internalKey: INTERNAL_KEY,
            },
          )
        }
        const decision = await billingModeDecision(mode, workspaceId, now + 1)
        const expectedReason =
          scenario === 'exhausted_trial' || scenario === 'lapsed_with_paid'
            ? 'subscription_required'
            : scenario === 'empty_subscriber'
              ? 'insufficient_credits'
              : undefined
        expect(decision, `${mode}: ${scenario}`).toMatchObject(
          expectedReason === undefined
            ? { proceed: true }
            : { proceed: false, reason: expectedReason },
        )
        if (scenario === 'monthly_spill') {
          expect(decision).toMatchObject({
            monthlyCreditBalanceMicroUsd: 0,
            paidCreditBalanceMicroUsd: expect.any(Number),
          })
          expect(decision.balanceMicroUsd).toBeGreaterThan(HARD_BLOCK_FLOOR_MICRO_USD)
        }
      }
    }
  }, 60_000)

  test('account ledger entries share reference idempotency and stay out of workspace ledgers', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('account-ledger'),
      'Account Ledger',
    )
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    const input = {
      internalKey: INTERNAL_KEY,
      userId: account.user._id,
      amountMicroUsd: dollarsToMicroUsd(1),
      reference: 'account-adjustment:001',
      now: Date.UTC(2026, 6, 1),
    }
    expect(
      await mutate(convex, 'testing/credits:applyAccountAdjustmentForTest', input),
    ).toMatchObject({ applied: true })
    expect(
      await mutate(convex, 'testing/credits:applyAccountAdjustmentForTest', input),
    ).toMatchObject({ applied: false })
    expect(
      (await listTransactions(workspaceId)).some(row => row.reference === input.reference),
    ).toBe(false)
    const history = (await query(convex, 'domains/credits/internal:getBillingHistory', {
      internalKey: INTERNAL_KEY,
      actorId: account.user._id,
      paginationOpts: { cursor: null, numItems: 100 },
    })) as {
      page: Array<{
        id: string
        scope: 'account' | 'workspace'
        workspaceId?: string
        workspaceName?: string
        amountMicroUsd: number
        type: string
        createdAt: number
      }>
    }
    expect(history.page.find(item => item.type === 'adjustment')).toEqual({
      id: expect.any(String),
      scope: 'account',
      amountMicroUsd: dollarsToMicroUsd(1),
      type: 'adjustment',
      createdAt: input.now,
    })
  })

  test('reservation reference replay returns the existing hold after balance moved', async () => {
    const workspaceId = await createWorkspace('reserve-replay')
    const startingBalance = await balance(workspaceId)
    await grant(workspaceId, dollarsToMicroUsd(3.05), 'grant:reserve-replay-seed')

    await reserve(workspaceId, dollarsToMicroUsd(2), 'reservation:replay')
    await reserve(workspaceId, dollarsToMicroUsd(2), 'reservation:replay')

    const transactions = await listTransactions(workspaceId)
    expect(transactions.filter(row => row.reference === 'reservation:replay')).toHaveLength(1)
    expect(await balance(workspaceId)).toBe(startingBalance + dollarsToMicroUsd(1.05))
  })

  test('reservation reference replay stays idempotent after the workspace payer changes', async () => {
    const nextPayer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('reserve-replay-next-payer'),
      'Reserve Replay Next Payer',
    )
    // Funding a second drive is capacity a Starter payer does not have.
    await mutate(
      nextPayer.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, plan: 'pro' },
    )
    const workspaceId = await createWorkspace('reserve-payer-scope')
    await grant(workspaceId, dollarsToMicroUsd(3), 'grant:reserve-replay-payer-change')
    await reserve(workspaceId, dollarsToMicroUsd(2), 'reservation:payer-change')

    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: nextPayer.user._id,
      role: 'owner',
    })
    await mutate(owner.client, 'domains/workspaces/mutations:setBillingUser', {
      workspaceId,
      newBillingUserId: nextPayer.user._id,
    })
    await reserve(workspaceId, dollarsToMicroUsd(2), 'reservation:payer-change')

    const holds = (await listTransactions(workspaceId)).filter(
      row => row.reference === 'reservation:payer-change',
    )
    expect(holds).toHaveLength(1)
    expect(holds[0]).toMatchObject({
      workspaceId,
      metadata: { status: 'held', estimateMicroUsd: dollarsToMicroUsd(2) },
    })
  })

  test('ledger caller metadata round trips through the explicit context bag', async () => {
    const workspaceId = await createWorkspace('credit-meta')
    await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      amountMicroUsd: dollarsToMicroUsd(1),
      type: 'grant',
      reference: 'grant:metadata-context',
      metadata: {
        generationId: 'generation_123',
        upstreamMetadata: { provider: 'fake', cached: true },
        note: 'operator note',
      },
    })

    expect(
      (await listTransactions(workspaceId)).find(row => row.reference === 'grant:metadata-context')
        ?.metadata,
    ).toEqual({
      context: {
        generationId: 'generation_123',
        upstreamMetadata: { provider: 'fake', cached: true },
        note: 'operator note',
      },
    })
  })

  test('ledger writes require privileged internal authorization', async () => {
    const workspaceId = await createWorkspace('writer-auth')
    await expect(
      mutate(owner.client, 'domains/credits/internal:applyLedgerEntry', {
        workspaceId,
        amountMicroUsd: dollarsToMicroUsd(1),
        type: 'grant',
        reference: 'grant:client-forbidden',
      }),
    ).rejects.toThrow('Unauthorized ledger writer')
  })

  test("designated payer's floor and account cap gate member activity", async () => {
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('credits-member'),
      'Credits Member',
    )
    const floorWorkspaceId = await createWorkspace('payer-floor')
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: floorWorkspaceId,
      userId: member.user._id,
      role: 'editor',
    })
    expect((await currentUser(member.client)).paidCreditBalanceMicroUsd).toBeGreaterThan(
      HARD_BLOCK_FLOOR_MICRO_USD,
    )
    await setBalance(floorWorkspaceId, HARD_BLOCK_FLOOR_MICRO_USD)
    expect(await preflight(floorWorkspaceId, 1, undefined, member.user._id)).toMatchObject({
      proceed: false,
      reason: 'insufficient_credits',
      tier: 'account',
      balanceMicroUsd: HARD_BLOCK_FLOOR_MICRO_USD,
    })

    const capWorkspaceId = await createWorkspace('payer-cap')
    await setBalance(capWorkspaceId, dollarsToMicroUsd(10))
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: capWorkspaceId,
      userId: member.user._id,
      role: 'editor',
    })
    await mutate(convex, 'domains/credits/internal:setTopupConfig', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: capWorkspaceId,
      maxMonthlySpendMicroUsd: 0,
    })
    expect(
      await preflight(capWorkspaceId, dollarsToMicroUsd(0.01), undefined, member.user._id),
    ).toMatchObject({ proceed: false, reason: 'monthly_cap', tier: 'account' })
    await mutate(convex, 'domains/credits/internal:setTopupConfig', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: capWorkspaceId,
      maxMonthlySpendMicroUsd: dollarsToMicroUsd(1_000_000),
    })
  })

  test('hold to settle and hold to release round trips keep exact micro-USD balances', async () => {
    const settlementPeriod = Date.UTC(2032, 4, 15)
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, now: settlementPeriod },
    )
    const settledWorkspaceId = await createWorkspace('settle')
    await grant(settledWorkspaceId, dollarsToMicroUsd(10), 'grant:settle-seed')
    const settledStart = await balance(settledWorkspaceId)
    await reserve(settledWorkspaceId, dollarsToMicroUsd(2), 'reservation:settle', settlementPeriod)
    expect(await balance(settledWorkspaceId)).toBe(settledStart - dollarsToMicroUsd(2))

    await mutate(convex, 'domains/credits/internal:settleReservation', {
      internalKey: INTERNAL_KEY,
      workspaceId: settledWorkspaceId,
      reservationId: 'reservation:settle',
      actualCostMicroUsd: dollarsToMicroUsd(0.37),
      now: settlementPeriod,
    })
    expect(await balance(settledWorkspaceId)).toBe(settledStart - dollarsToMicroUsd(0.37))
    expect(await preflight(settledWorkspaceId, undefined, settlementPeriod)).toMatchObject({
      accountMonthlySpendMicroUsd: dollarsToMicroUsd(0.37),
      workspaceMonthlySpendMicroUsd: dollarsToMicroUsd(0.37),
    })

    const releasedWorkspaceId = await createWorkspace('release')
    await grant(releasedWorkspaceId, dollarsToMicroUsd(10), 'grant:release-seed')
    const releasedStart = await balance(releasedWorkspaceId)
    await reserve(
      releasedWorkspaceId,
      dollarsToMicroUsd(2),
      'reservation:release',
      settlementPeriod,
    )
    await mutate(convex, 'domains/credits/internal:releaseReservation', {
      internalKey: INTERNAL_KEY,
      workspaceId: releasedWorkspaceId,
      reservationId: 'reservation:release',
      reason: 'upstream_failed',
      now: settlementPeriod,
    })
    expect(await balance(releasedWorkspaceId)).toBe(releasedStart)
    expect(await preflight(releasedWorkspaceId, undefined, settlementPeriod)).toMatchObject({
      workspaceMonthlySpendMicroUsd: 0,
    })
  })

  test('reservation settle and release retries are idempotent within the workspace', async () => {
    const settledWorkspaceId = await createWorkspace('settle-retry')
    await grant(settledWorkspaceId, dollarsToMicroUsd(3), 'grant:settle-retry')
    await reserve(settledWorkspaceId, dollarsToMicroUsd(2), 'reservation:settle-retry')
    const settleArgs = {
      internalKey: INTERNAL_KEY,
      workspaceId: settledWorkspaceId,
      reservationId: 'reservation:settle-retry',
      actualCostMicroUsd: dollarsToMicroUsd(0.5),
    }
    expect(
      await mutate(convex, 'domains/credits/internal:settleReservation', settleArgs),
    ).toMatchObject({ settled: true })
    expect(
      await mutate(convex, 'domains/credits/internal:settleReservation', settleArgs),
    ).toMatchObject({ settled: false })
    const settlementEvents = (await listTransactions(settledWorkspaceId)).filter(
      row => row.reference === 'reservation:settle-retry:settle',
    )
    expect(settlementEvents).toHaveLength(1)
    expect(settlementEvents[0]).toMatchObject({
      metadata: { event: 'settle', reservationId: 'reservation:settle-retry' },
    })

    const releasedWorkspaceId = await createWorkspace('release-retry')
    await grant(releasedWorkspaceId, dollarsToMicroUsd(3), 'grant:release-retry')
    await reserve(releasedWorkspaceId, dollarsToMicroUsd(2), 'reservation:release-retry')
    const releaseArgs = {
      internalKey: INTERNAL_KEY,
      workspaceId: releasedWorkspaceId,
      reservationId: 'reservation:release-retry',
      reason: 'upstream_failed',
    }
    expect(
      await mutate(convex, 'domains/credits/internal:releaseReservation', releaseArgs),
    ).toMatchObject({ released: true })
    expect(
      await mutate(convex, 'domains/credits/internal:releaseReservation', releaseArgs),
    ).toMatchObject({ released: false })
    const releaseEvents = (await listTransactions(releasedWorkspaceId)).filter(
      row => row.reference === 'reservation:release-retry:release',
    )
    expect(releaseEvents).toHaveLength(1)
    expect(releaseEvents[0]).toMatchObject({
      metadata: { event: 'release', reservationId: 'reservation:release-retry' },
    })
  })

  test('SUBS-IMPL-03 crossed-epoch release forfeits stale monthly credit', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('reservation-crossed-release'),
      'Reservation Crossed Release',
    )
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    await resetMonthlyEpoch(account.user._id, 'in_release_epoch_1', dollarsToMicroUsd(10), 1)
    await reserve(workspaceId, dollarsToMicroUsd(2), 'reservation:crossed-release')

    expect(
      (await listTransactions(workspaceId)).find(
        row => row.reference === 'reservation:crossed-release',
      ),
    ).toMatchObject({
      metadata: {
        walletAllocation: {
          monthlyDebitMicroUsd: dollarsToMicroUsd(2),
          paidDebitMicroUsd: 0,
          monthlyCreditEpoch: 'in_release_epoch_1',
        },
      },
    })

    await resetMonthlyEpoch(account.user._id, 'in_release_epoch_2', dollarsToMicroUsd(20), 2)
    await mutate(convex, 'domains/credits/internal:releaseReservation', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      reservationId: 'reservation:crossed-release',
      reason: 'upstream_failed',
    })

    expect(await wallet(workspaceId)).toEqual({
      balanceMicroUsd: dollarsToMicroUsd(25),
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(20),
      paidCreditBalanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
    })
    expect(
      (await listTransactions(workspaceId)).find(
        row => row.reference === 'reservation:crossed-release:release',
      ),
    ).toMatchObject({
      metadata: {
        event: 'release',
        reservationId: 'reservation:crossed-release',
        forfeitedMonthlyMicroUsd: dollarsToMicroUsd(2),
      },
    })
  })

  test('SUBS-IMPL-03 same-epoch settle and release restore exact bucket balances', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('reservation-same-epoch'),
      'Reservation Same Epoch',
    )
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    await resetMonthlyEpoch(account.user._id, 'in_same_epoch', dollarsToMicroUsd(1), 1)
    const startingWallet = await wallet(workspaceId)

    await reserve(workspaceId, dollarsToMicroUsd(3), 'reservation:same-epoch-settle')
    expect(
      (await listTransactions(workspaceId)).find(
        row => row.reference === 'reservation:same-epoch-settle',
      ),
    ).toMatchObject({
      metadata: {
        walletAllocation: {
          monthlyDebitMicroUsd: dollarsToMicroUsd(1),
          paidDebitMicroUsd: dollarsToMicroUsd(2),
          monthlyCreditEpoch: 'in_same_epoch',
        },
      },
    })
    await mutate(convex, 'domains/credits/internal:settleReservation', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      reservationId: 'reservation:same-epoch-settle',
      actualCostMicroUsd: dollarsToMicroUsd(0.5),
    })
    expect(await wallet(workspaceId)).toEqual({
      balanceMicroUsd: startingWallet.balanceMicroUsd - dollarsToMicroUsd(0.5),
      monthlyCreditBalanceMicroUsd:
        startingWallet.monthlyCreditBalanceMicroUsd - dollarsToMicroUsd(0.5),
      paidCreditBalanceMicroUsd: startingWallet.paidCreditBalanceMicroUsd,
    })

    const beforeRelease = await wallet(workspaceId)
    await reserve(workspaceId, dollarsToMicroUsd(3), 'reservation:same-epoch-release')
    await mutate(convex, 'domains/credits/internal:releaseReservation', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      reservationId: 'reservation:same-epoch-release',
      reason: 'upstream_failed',
    })
    expect(await wallet(workspaceId)).toEqual(beforeRelease)
  })

  test('SUBS-IMPL-03 crossed-epoch settle below estimate forfeits only stale monthly refund', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('reservation-crossed-below'),
      'Reservation Crossed Below',
    )
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    await resetMonthlyEpoch(account.user._id, 'in_below_epoch_1', dollarsToMicroUsd(10), 1)
    await reserve(workspaceId, dollarsToMicroUsd(2), 'reservation:crossed-below')
    await resetMonthlyEpoch(account.user._id, 'in_below_epoch_2', dollarsToMicroUsd(20), 2)

    await mutate(convex, 'domains/credits/internal:settleReservation', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      reservationId: 'reservation:crossed-below',
      actualCostMicroUsd: dollarsToMicroUsd(0.5),
    })

    expect(await wallet(workspaceId)).toEqual({
      balanceMicroUsd: dollarsToMicroUsd(25),
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(20),
      paidCreditBalanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
    })
    const transactions = await listTransactions(workspaceId)
    expect(transactions.find(row => row.reference === 'reservation:crossed-below')).toMatchObject({
      amountMicroUsd: -dollarsToMicroUsd(0.5),
      monthlyAmountMicroUsd: -dollarsToMicroUsd(0.5),
      paidAmountMicroUsd: 0,
    })
    expect(
      transactions.find(row => row.reference === 'reservation:crossed-below:settle'),
    ).toMatchObject({
      metadata: {
        balanceDeltaMicroUsd: 0,
        forfeitedMonthlyMicroUsd: dollarsToMicroUsd(1.5),
      },
    })
    expect(await preflight(workspaceId)).toMatchObject({
      accountMonthlySpendMicroUsd: dollarsToMicroUsd(0.5),
      workspaceMonthlySpendMicroUsd: dollarsToMicroUsd(0.5),
    })
  })

  test('SUBS-IMPL-03 crossed-epoch settle above estimate drains the current wallet monthly-first', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('reservation-crossed-above'),
      'Reservation Crossed Above',
    )
    const workspaceId = (await listMine(account.client))[0]!.workspace._id
    await resetMonthlyEpoch(account.user._id, 'in_above_epoch_1', dollarsToMicroUsd(10), 1)
    await reserve(workspaceId, dollarsToMicroUsd(2), 'reservation:crossed-above')
    await resetMonthlyEpoch(account.user._id, 'in_above_epoch_2', dollarsToMicroUsd(20), 2)

    await mutate(convex, 'domains/credits/internal:settleReservation', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      reservationId: 'reservation:crossed-above',
      actualCostMicroUsd: dollarsToMicroUsd(3),
    })

    expect(await wallet(workspaceId)).toEqual({
      balanceMicroUsd: dollarsToMicroUsd(24),
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(19),
      paidCreditBalanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
    })
    const transactions = await listTransactions(workspaceId)
    expect(transactions.find(row => row.reference === 'reservation:crossed-above')).toMatchObject({
      amountMicroUsd: -dollarsToMicroUsd(3),
      monthlyAmountMicroUsd: -dollarsToMicroUsd(3),
      paidAmountMicroUsd: 0,
    })
    expect(
      transactions.find(row => row.reference === 'reservation:crossed-above:settle'),
    ).toMatchObject({
      metadata: { balanceDeltaMicroUsd: -dollarsToMicroUsd(1), forfeitedMonthlyMicroUsd: 0 },
    })
    expect(await preflight(workspaceId)).toMatchObject({
      accountMonthlySpendMicroUsd: dollarsToMicroUsd(3),
      workspaceMonthlySpendMicroUsd: dollarsToMicroUsd(3),
    })
  })

  test('preflight applies the account floor before the workspace monthly cap', async () => {
    const workspaceId = await createWorkspace('preflight')
    await setBalance(workspaceId, HARD_BLOCK_FLOOR_MICRO_USD + 1)
    expect(await preflight(workspaceId, dollarsToMicroUsd(0.01))).toMatchObject({
      proceed: true,
      balanceMicroUsd: HARD_BLOCK_FLOOR_MICRO_USD + 1,
    })

    await charge(workspaceId, 1, 'usage:at-floor')
    expect(await preflight(workspaceId, dollarsToMicroUsd(0.01))).toMatchObject({
      proceed: false,
      reason: 'insufficient_credits',
      tier: 'account',
    })
    await charge(workspaceId, 1, 'usage:below-floor')
    expect(await balance(workspaceId)).toBeLessThan(HARD_BLOCK_FLOOR_MICRO_USD)

    const cappedWorkspaceId = await createWorkspace('monthly-cap')
    await setBalance(cappedWorkspaceId, DEFAULT_TRIAL_GRANT_MICRO_USD)
    await mutate(convex, 'domains/credits/internal:setMonthlyCap', {
      internalKey: INTERNAL_KEY,
      workspaceId: cappedWorkspaceId,
      maxMonthlySpendMicroUsd: dollarsToMicroUsd(1),
    })
    await charge(cappedWorkspaceId, dollarsToMicroUsd(0.75), 'usage:cap-seed')
    expect(await preflight(cappedWorkspaceId, dollarsToMicroUsd(0.26))).toMatchObject({
      proceed: false,
      reason: 'monthly_cap',
      tier: 'workspace',
      workspaceMonthlySpendMicroUsd: dollarsToMicroUsd(0.75),
      workspaceMonthlyCapMicroUsd: dollarsToMicroUsd(1),
    })
    await charge(cappedWorkspaceId, dollarsToMicroUsd(0.25), 'usage:cap-exact')
    expect(await preflight(cappedWorkspaceId)).toMatchObject({
      proceed: false,
      reason: 'monthly_cap',
      tier: 'workspace',
      workspaceMonthlySpendMicroUsd: dollarsToMicroUsd(1),
    })

    await charge(cappedWorkspaceId, dollarsToMicroUsd(20), 'usage:negative-ok')
    expect(await balance(cappedWorkspaceId)).toBeLessThan(0)
  })

  test('account monthly cap blocks every workspace while a workspace cap isolates one workspace', async () => {
    const account = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('two-tier-account'),
      'Two-tier Account',
    )
    const workspaceA = await createWorkspace('two-tier-a', account.client)
    const workspaceB = await createWorkspace('two-tier-b', account.client)
    const workspacePeriod = Date.UTC(2031, 0, 15)
    await mutate(
      account.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
        now: workspacePeriod,
      },
    )
    await setBalance(workspaceA, dollarsToMicroUsd(10))
    await mutate(convex, 'domains/credits/internal:setMonthlyCap', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspaceA,
      maxMonthlySpendMicroUsd: dollarsToMicroUsd(1),
    })
    await charge(workspaceA, dollarsToMicroUsd(1), 'usage:workspace-tier', workspacePeriod)

    expect(await preflight(workspaceA, undefined, workspacePeriod)).toMatchObject({
      proceed: false,
      reason: 'monthly_cap',
      tier: 'workspace',
    })
    expect(await preflight(workspaceB, undefined, workspacePeriod)).toMatchObject({
      proceed: true,
    })

    await mutate(convex, 'domains/credits/internal:setTopupConfig', {
      internalKey: INTERNAL_KEY,
      actorId: account.user._id,
      workspaceId: workspaceA,
      maxMonthlySpendMicroUsd: dollarsToMicroUsd(1),
    })
    expect(await preflight(workspaceA, undefined, workspacePeriod)).toMatchObject({
      proceed: false,
      reason: 'monthly_cap',
      tier: 'account',
    })
    expect(await preflight(workspaceB, undefined, workspacePeriod)).toMatchObject({
      proceed: false,
      reason: 'monthly_cap',
      tier: 'account',
    })
    await mutate(convex, 'domains/credits/internal:setTopupConfig', {
      internalKey: INTERNAL_KEY,
      actorId: account.user._id,
      workspaceId: workspaceA,
      maxMonthlySpendMicroUsd: dollarsToMicroUsd(1_000),
    })
  })

  test('account and workspace monthly counters roll periods independently', async () => {
    const workspaceA = await createWorkspace('reset-a')
    const workspaceB = await createWorkspace('reset-b')
    const january = Date.UTC(2033, 0, 15)
    const february = Date.UTC(2033, 1, 15)
    await setBalance(workspaceA, dollarsToMicroUsd(20))

    await charge(workspaceA, dollarsToMicroUsd(1), 'usage:reset:january', january)
    await charge(workspaceB, dollarsToMicroUsd(2), 'usage:reset:february-b', february)

    expect(await preflight(workspaceA, undefined, february)).toMatchObject({
      accountMonthlySpendMicroUsd: dollarsToMicroUsd(2),
      workspaceMonthlySpendMicroUsd: 0,
    })
    expect(await preflight(workspaceB, undefined, february)).toMatchObject({
      accountMonthlySpendMicroUsd: dollarsToMicroUsd(2),
      workspaceMonthlySpendMicroUsd: dollarsToMicroUsd(2),
    })

    await charge(workspaceA, dollarsToMicroUsd(0.5), 'usage:reset:february-a', february)
    expect(await preflight(workspaceA, undefined, february)).toMatchObject({
      accountMonthlySpendMicroUsd: dollarsToMicroUsd(2.5),
      workspaceMonthlySpendMicroUsd: dollarsToMicroUsd(0.5),
    })
  })

  test('trial grant lands once on the canonical-email account and every workspace sees it', async () => {
    const beforeGrant = Date.now()
    const email = uniqueEmail('canonical')
    const first = await signInWithMagicLink<UserRow>(convex, email.toUpperCase(), 'Canonical Owner')
    const firstWorkspaceId = (await listMine(first.client))[0]!.workspace._id
    expect(await balance(firstWorkspaceId)).toBe(DEFAULT_TRIAL_GRANT_MICRO_USD)

    await mutate(
      first.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const secondWorkspaceId = (await mutate(
      first.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('canonical-second'),
        name: 'Canonical Second',
      },
    )) as string
    await mutate(first.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: Date.now(),
    })
    expect(await balance(secondWorkspaceId)).toBe(DEFAULT_TRIAL_GRANT_MICRO_USD)

    const rows = await listMine(first.client)
    expect(
      rows.find(row => row.workspace._id === firstWorkspaceId)?.workspace.paidCreditBalanceMicroUsd,
    ).toBeUndefined()
    expect(
      rows.find(row => row.workspace._id === secondWorkspaceId)?.workspace
        .paidCreditBalanceMicroUsd,
    ).toBeUndefined()
    expect(
      rows.find(row => row.workspace._id === firstWorkspaceId)?.workspace
        .monthlyCreditBalanceMicroUsd,
    ).toBeUndefined()
    const account = (await query(first.client, 'domains/users/queries:current', {})) as UserRow
    expect(account.paidCreditBalanceMicroUsd).toBe(DEFAULT_TRIAL_GRANT_MICRO_USD)
    expect(account.monthlyCreditBalanceMicroUsd).toBe(0)
    expect(account.billing?.trialExpiresAt).toBeGreaterThanOrEqual(
      beforeGrant + 7 * 24 * 60 * 60 * 1000,
    )
    expect(account.billing?.trialExpiresAt).toBeLessThanOrEqual(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    )

    const grantRefs = (await listTransactions(firstWorkspaceId)).filter(row =>
      row.reference.startsWith('signup_grant:canonical:'),
    )
    expect(grantRefs.map(row => row.reference)).toEqual([`signup_grant:canonical:${email}`])
    expect(
      (await listTransactions(secondWorkspaceId)).filter(row => row.type === 'grant'),
    ).toHaveLength(0)
  })

  test('trial grant deduplicates non-gmail aliases through the real ledger', async () => {
    const mailbox = uniqueEmail('grant-alias')
    const [local, domain] = mailbox.split('@') as [string, string]
    const first = await signInWithMagicLink<UserRow>(
      convex,
      `${local}+first@${domain}`,
      'First Alias',
    )
    const second = await signInWithMagicLink<UserRow>(
      convex,
      `${local}+second@${domain}`,
      'Second Alias',
    )
    const firstWorkspaceId = (await listMine(first.client))[0]!.workspace._id
    const secondWorkspaceId = (await listMine(second.client))[0]!.workspace._id
    const reference = `signup_grant:canonical:${mailbox}`

    expect(
      (await listTransactions(firstWorkspaceId)).filter(row =>
        row.reference.startsWith('signup_grant:canonical:'),
      ),
    ).toMatchObject([{ amountMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD, reference }])
    expect((await listTransactions(secondWorkspaceId)).filter(row => row.type === 'grant')).toEqual(
      [],
    )
  })

  test('reservation terminal events append while the reservation row remains the projection', async () => {
    const workspaceId = await createWorkspace('append-projection')
    await setBalance(workspaceId, dollarsToMicroUsd(10))
    await reserve(workspaceId, dollarsToMicroUsd(2), 'reservation:projection')
    await mutate(convex, 'domains/credits/internal:settleReservation', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      reservationId: 'reservation:projection',
      actualCostMicroUsd: dollarsToMicroUsd(0.37),
    })

    const transactions = await listTransactions(workspaceId)
    const projection = transactions.find(row => row.reference === 'reservation:projection')!
    const terminal = transactions.find(row => row.reference === 'reservation:projection:settle')!
    expect(projection).toMatchObject({
      amountMicroUsd: -dollarsToMicroUsd(0.37),
      metadata: {
        status: 'settled',
        estimateMicroUsd: dollarsToMicroUsd(2),
        actualCostMicroUsd: dollarsToMicroUsd(0.37),
        walletAllocation: {
          monthlyDebitMicroUsd: 0,
          paidDebitMicroUsd: dollarsToMicroUsd(2),
        },
      },
    })
    expect(terminal).toMatchObject({
      amountMicroUsd: 0,
      metadata: {
        event: 'settle',
        reservationId: 'reservation:projection',
        balanceDeltaMicroUsd: dollarsToMicroUsd(1.63),
      },
    })
    expect(projection.amountMicroUsd + terminal.amountMicroUsd).toBe(-dollarsToMicroUsd(0.37))
  })
})

async function createWorkspace(
  prefix: string,
  client: ConvexHttpClient = owner.client,
): Promise<string> {
  await mutate(client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  return (await mutate(client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: uniqueSlug(prefix),
    name: `${prefix} workspace`,
  })) as string
}

async function grant(
  workspaceId: string,
  amountMicroUsd: number,
  reference: string,
): Promise<void> {
  await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    amountMicroUsd,
    type: 'grant',
    reference,
  })
}

async function grantForAccount(
  workspaceId: string,
  amountMicroUsd: number,
  reference: string,
): Promise<void> {
  await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    amountMicroUsd,
    type: 'grant',
    reference,
  })
}

async function resetMonthly(
  userId: string,
  overrides: { invoiceId: string; allotmentMicroUsd: number },
): Promise<void> {
  await mutate(convex, 'testing/credits:resetMonthlyCreditsForTest', {
    internalKey: INTERNAL_KEY,
    userId,
    invoiceId: overrides.invoiceId,
    plan: 'starter',
    allotmentMicroUsd: overrides.allotmentMicroUsd,
    periodStart: Date.UTC(2026, 6, 1),
    periodEnd: Date.UTC(2026, 7, 1),
    invoiceCreatedAt: Date.UTC(2026, 6, 1, 0, 1),
    now: Date.UTC(2026, 6, 1, 0, 2),
  })
}

const MONTHLY_EPOCH_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A monthly epoch that is still live on the clock the caller runs on.
 *
 * These tests reserve and settle across an epoch boundary; a wallet whose
 * period has already ended is a lapsed subscription, which is a different
 * story with its own owner. Fixed calendar months encoded "live" as a date and
 * so stopped being true the day the last of them passed — the epoch has to be
 * placed relative to now instead. Later epochs end later, because that
 * ordering is what makes one invoice supersede another.
 */
async function resetMonthlyEpoch(
  userId: string,
  invoiceId: string,
  allotmentMicroUsd: number,
  epoch: number,
): Promise<void> {
  const now = Date.now()
  // The offset by `epoch` keeps `invoiceCreatedAt` strictly ordered too, which
  // is the tie-break behind the period end.
  const periodStart = now - MONTHLY_EPOCH_MS + epoch
  await mutate(convex, 'testing/credits:resetMonthlyCreditsForTest', {
    internalKey: INTERNAL_KEY,
    userId,
    invoiceId,
    plan: 'starter',
    allotmentMicroUsd,
    periodStart,
    periodEnd: now + epoch * MONTHLY_EPOCH_MS,
    invoiceCreatedAt: periodStart + 1,
    now: periodStart + 2,
  })
}

async function charge(
  workspaceId: string,
  amountMicroUsd: number,
  reference: string,
  now?: number,
): Promise<void> {
  await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    amountMicroUsd: -amountMicroUsd,
    type: 'usage',
    reference,
    ...(now === undefined ? {} : { now }),
  })
}

async function setBalance(workspaceId: string, targetMicroUsd: number): Promise<void> {
  const current = await balance(workspaceId)
  await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    amountMicroUsd: targetMicroUsd - current,
    type: 'adjustment',
    reference: `adjustment:set-balance:${uniqueSlug('balance')}`,
  })
}

async function reserve(
  workspaceId: string,
  estimateMicroUsd: number,
  reference: string,
  now?: number,
): Promise<void> {
  await mutate(convex, 'domains/credits/internal:reserveCredits', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    estimateMicroUsd,
    reference,
    ...(now === undefined ? {} : { now }),
  })
}

async function balance(workspaceId: string): Promise<number> {
  return (await wallet(workspaceId)).balanceMicroUsd
}

async function wallet(workspaceId: string): Promise<WalletProbe> {
  return (await query(convex, 'testing/credits:walletForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as WalletProbe
}

async function preflight(
  workspaceId: string,
  estimatedCostMicroUsd?: number,
  now?: number,
  userId?: string,
): Promise<PreflightDecision> {
  const args: Record<string, unknown> = {
    internalKey: INTERNAL_KEY,
    workspaceId,
  }
  if (estimatedCostMicroUsd !== undefined) args.estimatedCostMicroUsd = estimatedCostMicroUsd
  if (now !== undefined) args.now = now
  if (userId !== undefined) args.userId = userId
  return (await mutate(convex, 'domains/credits/internal:runPreflight', args)) as PreflightDecision
}

async function billingModeDecision(
  mode: 'post_response' | 'reservation',
  workspaceId: string,
  now: number,
): Promise<PreflightDecision> {
  if (mode === 'post_response') {
    return await preflight(workspaceId, dollarsToMicroUsd(0.01), now)
  }
  return (await mutate(convex, 'domains/credits/internal:reserveCredits', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    estimateMicroUsd: dollarsToMicroUsd(0.01),
    reference: `reservation:gate:${workspaceId}`,
    now,
  })) as PreflightDecision
}

async function currentUser(client: ConvexHttpClient): Promise<UserRow> {
  return (await query(client, 'domains/users/queries:current', {})) as UserRow
}

async function persistedBilling(userId: string): Promise<Record<string, unknown>> {
  return (await query(convex, 'testing/credits:userBillingForTest', {
    internalKey: INTERNAL_KEY,
    userId,
  })) as Record<string, unknown>
}

async function sweepLapses(now: number): Promise<void> {
  let cursor: string | undefined
  for (let page = 0; page < 100; page += 1) {
    const result = (await mutate(convex, 'domains/credits/internal:expireLapsedSubscriptions', {
      internalKey: INTERNAL_KEY,
      limit: 500,
      now,
      ...(cursor === undefined ? {} : { cursor }),
    })) as { cursor?: string; done: boolean }
    if (result.done) return
    cursor = result.cursor
  }
  throw new Error('Lapse sweep did not finish')
}

async function listTransactions(workspaceId: string): Promise<LedgerRow[]> {
  return (await query(convex, 'testing/credits:listWorkspaceTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as LedgerRow[]
}

async function listAccountTransactions(userId: string): Promise<LedgerRow[]> {
  return (await query(convex, 'testing/credits:listAccountTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    userId,
  })) as LedgerRow[]
}

async function listMine(client: ConvexHttpClient): Promise<Array<{ workspace: WorkspaceRow }>> {
  return (await query(client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: WorkspaceRow
  }>
}

function uniqueSlug(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

interface UserRow {
  _id: string
  email: string
  paidCreditBalanceMicroUsd: number
  monthlyCreditBalanceMicroUsd: number
  billing?: {
    trialExpiresAt?: number
    monthlyCreditEpoch?: string
    monthlyCreditExpiresAt?: number
  }
}

interface WorkspaceRow {
  _id: string
  servicingStatus?: 'active' | 'paused' | 'banned'
  paidCreditBalanceMicroUsd?: number
  monthlyCreditBalanceMicroUsd?: number
}

interface PreflightDecision {
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
}

interface LedgerRow {
  amountMicroUsd: number
  monthlyAmountMicroUsd: number
  paidAmountMicroUsd: number
  workspaceId?: string
  type:
    | 'grant'
    | 'topup'
    | 'usage'
    | 'adjustment'
    | 'reservation'
    | 'subscription_grant'
    | 'subscription_expiry'
  reference: string
  metadata?: Record<string, unknown>
}

interface WalletProbe {
  balanceMicroUsd: number
  monthlyCreditBalanceMicroUsd: number
  paidCreditBalanceMicroUsd: number
}
