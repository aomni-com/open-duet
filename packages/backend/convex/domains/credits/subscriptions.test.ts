import { describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import { HARD_BLOCK_FLOOR_MICRO_USD } from '@repo/contract'

import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import schema from '../../schema'
import {
  applySubscriptionLifecycleWithDb,
  AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD,
  desiredServicingStatus,
  ensureCurrentEntitlementWithDb,
  expireLapsedSubscriptionsWithDb,
  isSubscriber,
  servicingStatusFor,
} from './subscriptions'
import { authorizeSpend } from './creditsShared'

test('an active renewal keeps the workspace running while the previous credit epoch expires', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'renewal@example.com',
      createdAt: 1,
      updatedAt: 1,
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 5_000_000,
      monthlyCreditBalanceMicroUsd: 10_000_000,
      billing: {
        stripeCustomerId: 'cus_renewal',
        subscriptionEverActivatedAt: 1,
        monthlyCreditEpoch: 'in_previous',
        monthlyCreditExpiresAt: 100,
        subscription: subscription('active', 100),
      },
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      name: 'Renewal',
      slug: 'renewal',
      billingUserId: userId,
      status: 'active',
      servicingStatus: 'active',
      createdAt: 1,
    })
    await applySubscriptionLifecycleWithDb(
      ctx,
      {
        kind: 'subscription_lifecycle',
        eventId: 'evt_renewal',
        eventCreatedAt: 100,
        customerId: 'cus_renewal',
        subscriptionId: 'sub_matrix',
        priceId: 'price_matrix',
        plan: 'starter',
        status: 'active',
        currentPeriodStart: 100,
        currentPeriodEnd: 200,
        cancelAtPeriodEnd: false,
      },
      101,
    )
    expect((await ctx.db.get(workspaceId))?.servicingStatus).toBe('active')
    const account = (await ctx.db.get(userId))!
    const refreshed = await ensureCurrentEntitlementWithDb(ctx, account, 101)
    expect(refreshed.monthlyCreditBalanceMicroUsd).toBe(0)
    expect(refreshed.paidCreditBalanceMicroUsd).toBe(5_000_000)
    expect((await ctx.db.get(workspaceId))?.servicingStatus).toBe('active')
    await expireLapsedSubscriptionsWithDb(ctx, { limit: 10, now: 102 })
    expect((await ctx.db.get(workspaceId))?.servicingStatus).toBe('active')

    // Only a subsequent Stripe status change pauses access; recovery does not
    // depend on another credit grant arriving first.
    for (const [status, at, expected] of [
      ['past_due', 103, 'paused'],
      ['active', 104, 'active'],
      ['canceled', 105, 'paused'],
    ] as const) {
      await applySubscriptionLifecycleWithDb(
        ctx,
        {
          kind: 'subscription_lifecycle',
          eventId: `evt_${status}`,
          eventCreatedAt: at,
          customerId: 'cus_renewal',
          subscriptionId: 'sub_matrix',
          priceId: 'price_matrix',
          plan: 'starter',
          status,
          currentPeriodStart: 100,
          currentPeriodEnd: 200,
          cancelAtPeriodEnd: false,
        },
        at,
      )
      expect((await ctx.db.get(workspaceId))?.servicingStatus).toBe(expected)
    }
  })
})

describe('subscription entitlement predicate', () => {
  test('Stripe status controls access independently of credit expiry or scheduled cancellation', () => {
    for (const status of [
      'active',
      'trialing',
      'past_due',
      'canceled',
      'unpaid',
      'paused',
      'incomplete',
      'incomplete_expired',
    ] as const) {
      for (const expiresAt of [undefined, 1, 100, 200]) {
        for (const cancelAtPeriodEnd of [false, true]) {
          const account = userWithSubscription(status, cancelAtPeriodEnd, expiresAt)
          expect(isSubscriber(account)).toBe(status === 'active' || status === 'trialing')
        }
      }
    }
    expect(isSubscriber(user({ paid: 5_000_000 }))).toBe(false)
  })
})

describe('servicing reconciliation policy', () => {
  test('keeps an unexpired trial with spendable credit active', () => {
    expect(
      desiredServicingStatus(
        {
          paidCreditBalanceMicroUsd: HARD_BLOCK_FLOOR_MICRO_USD + 1,
          monthlyCreditBalanceMicroUsd: 0,
          billing: { trialExpiresAt: 100 },
        } as Doc<'users'>,
        99,
      ),
    ).toBe('active')
  })

  test('SUBS-IMPL-07 covers the binding reconciler matrix', () => {
    const now = 100
    const trial = user({ paid: HARD_BLOCK_FLOOR_MICRO_USD + 1, trialExpiresAt: now + 1 })
    const subscriber = user({
      paid: 2_000_000,
      monthly: 20_000_000,
      monthlyCreditExpiresAt: now + 1,
      subscription: subscription('active', now + 1),
      subscriptionEverActivatedAt: 1,
    })
    const cases: Array<[string, Doc<'users'>, 'active' | 'paused']> = [
      ['trial-with-credit-and-time', trial, 'active'],
      [
        'trial-exhausted',
        user({ paid: HARD_BLOCK_FLOOR_MICRO_USD, trialExpiresAt: now + 1 }),
        'paused',
      ],
      [
        'trial-timed-out',
        user({ paid: HARD_BLOCK_FLOOR_MICRO_USD + 1, trialExpiresAt: now }),
        'paused',
      ],
      ['subscriber', subscriber, 'active'],
      [
        'subscriber+topup-backoff',
        user({
          ...inputOf(subscriber),
          consecutiveTopupFailures: AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD,
        }),
        'paused',
      ],
      ['disputed', user({ ...inputOf(subscriber), disputeFlaggedAt: now }), 'paused'],
      [
        'canceled-despite-paid-balance',
        user({
          ...inputOf(subscriber),
          subscription: { ...subscription('active', now + 1), status: 'canceled' },
        }),
        'paused',
      ],
      ['renewal-after-lapse', subscriber, 'active'],
      [
        'topup-success-after-lapse',
        user({ paid: 20_000_000, subscriptionEverActivatedAt: 1 }),
        'paused',
      ],
    ]
    for (const [name, account, expected] of cases) {
      expect(desiredServicingStatus(account, now), name).toBe(expected)
    }
    expect(servicingStatusFor({ servicingStatus: 'banned' }, subscriber, now)).toBe('banned')
    expect(
      servicingStatusFor(
        { servicingStatus: 'paused', servicingExemptAt: now - 1 },
        user({ paid: HARD_BLOCK_FLOOR_MICRO_USD }),
        now,
      ),
    ).toBe('active')
  })
})

test('a servicing-exempt workspace can spend its billing user credits without a subscription', () => {
  const workspace = {
    servicingStatus: 'active',
    servicingExemptAt: 1,
    billing: undefined,
  } as unknown as Doc<'workspaces'>
  const decision = authorizeSpend(workspace, user({ paid: 5_000_000 }), {
    workspaceMonthlySpendMicroUsd: 0,
    estimatedCostMicroUsd: 1_000,
    now: 100,
  })

  expect(decision.proceed).toBe(true)
})

interface UserInput {
  paid: number
  monthly?: number
  trialExpiresAt?: number
  monthlyCreditExpiresAt?: number
  subscriptionEverActivatedAt?: number
  consecutiveTopupFailures?: number
  disputeFlaggedAt?: number
  subscription?: NonNullable<NonNullable<Doc<'users'>['billing']>['subscription']>
}

function user(input: UserInput): Doc<'users'> {
  return {
    paidCreditBalanceMicroUsd: input.paid,
    monthlyCreditBalanceMicroUsd: input.monthly ?? 0,
    billing: {
      ...(input.trialExpiresAt === undefined ? {} : { trialExpiresAt: input.trialExpiresAt }),
      ...(input.monthlyCreditExpiresAt === undefined
        ? {}
        : { monthlyCreditExpiresAt: input.monthlyCreditExpiresAt }),
      ...(input.subscriptionEverActivatedAt === undefined
        ? {}
        : { subscriptionEverActivatedAt: input.subscriptionEverActivatedAt }),
      ...(input.consecutiveTopupFailures === undefined
        ? {}
        : { consecutiveTopupFailures: input.consecutiveTopupFailures }),
      ...(input.disputeFlaggedAt === undefined ? {} : { disputeFlaggedAt: input.disputeFlaggedAt }),
      ...(input.subscription === undefined ? {} : { subscription: input.subscription }),
    },
  } as Doc<'users'>
}

function inputOf(account: Doc<'users'>): UserInput {
  return {
    paid: account.paidCreditBalanceMicroUsd,
    monthly: account.monthlyCreditBalanceMicroUsd,
    ...account.billing,
  }
}

function subscription(
  status: 'active',
  currentPeriodEnd: number,
): NonNullable<NonNullable<Doc<'users'>['billing']>['subscription']> {
  return {
    stripeSubscriptionId: 'sub_matrix',
    stripePriceId: 'price_matrix',
    plan: 'starter',
    status,
    currentPeriodStart: 1,
    currentPeriodEnd,
    cancelAtPeriodEnd: false,
    latestLifecycleEventCreatedAt: 1,
    latestLifecycleEventId: 'evt_matrix',
  }
}

function userWithSubscription(
  status: NonNullable<NonNullable<Doc<'users'>['billing']>['subscription']>['status'],
  cancelAtPeriodEnd: boolean,
  monthlyCreditExpiresAt: number | undefined,
): Doc<'users'> {
  return {
    billing: {
      monthlyCreditExpiresAt,
      subscription: {
        stripeSubscriptionId: 'sub_test',
        stripePriceId: 'price_test',
        plan: 'starter',
        status,
        currentPeriodStart: 1,
        currentPeriodEnd: 100,
        cancelAtPeriodEnd,
        latestLifecycleEventCreatedAt: 1,
        latestLifecycleEventId: 'evt_test',
      },
    },
  } as Doc<'users'>
}

describe('lapse sweep pass window', () => {
  // A Convex pagination cursor belongs to the exact query that produced it, and
  // this scan's upper bound is the clock. Carrying a cursor from one cron tick
  // to the next therefore has to keep the bound the pass started with; the
  // observable consequence is that an account which lapses mid-pass waits for
  // the next pass rather than widening the one in flight.
  test('pins the scan boundary for the whole pass and clears it when done', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    // Even wall-clock minutes select the monthly phase, so both ticks of one
    // pass are two minutes apart.
    const firstTick = 4 * 60_000
    const secondTick = 6 * 60_000

    await t.run(async ctx => {
      await lapsedUser(ctx, 'early@example.com', firstTick - 2_000)
      await lapsedUser(ctx, 'late@example.com', firstTick - 1_000)
      // Lapses between the two ticks: inside the second tick's clock, outside
      // the boundary this pass pinned.
      await lapsedUser(ctx, 'midpass@example.com', firstTick + 1_000)
    })

    const first = await t.run(
      async ctx =>
        await expireLapsedSubscriptionsWithDb(ctx, {
          limit: 1,
          now: firstTick,
          useStoredCursor: true,
        }),
    )
    expect(first).toMatchObject({ done: false, processed: 1 })
    const afterFirst = await t.run(
      async ctx => await ctx.db.query('subscriptionLapseSweepState').unique(),
    )
    expect(afterFirst?.boundary).toBe(firstTick)

    const second = await t.run(
      async ctx =>
        await expireLapsedSubscriptionsWithDb(ctx, {
          limit: 1,
          now: secondTick,
          useStoredCursor: true,
        }),
    )
    expect(second).toMatchObject({ done: true, processed: 1 })
    const afterSecond = await t.run(
      async ctx => await ctx.db.query('subscriptionLapseSweepState').unique(),
    )
    expect(afterSecond?.cursor).toBeUndefined()
    expect(afterSecond?.boundary).toBeUndefined()
    const nextPass = await t.run(ctx =>
      expireLapsedSubscriptionsWithDb(ctx, {
        limit: 10,
        now: secondTick + 2 * 60_000,
        useStoredCursor: true,
      }),
    )
    expect(nextPass).toMatchObject({ done: true, processed: 3 })
  })

  test('carries the pass window inside the cursor it hands back to a caller', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const opened = 4 * 60_000
    await t.run(async ctx => {
      await lapsedUser(ctx, 'early@example.com', opened - 2_000)
      await lapsedUser(ctx, 'late@example.com', opened - 1_000)
      await lapsedUser(ctx, 'midpass@example.com', opened + 1_000)
    })

    const first = await expireLapsed(t, { limit: 1, now: opened })
    expect(first).toMatchObject({ done: false, processed: 1 })
    // Handed a cursor and a clock that has moved on, the sweep still reads the
    // window that cursor was taken under — three lapsed accounts exist, only the
    // two inside the opening window belong to this pass.
    const second = await expireLapsed(t, {
      limit: 10,
      now: opened + 5_000,
      cursor: first.cursor,
    })
    expect(second.processed).toBe(1)
  })

  test('abandons a cursor that has no window, or whose window went stale', async () => {
    for (const poison of ['no boundary', 'stale'] as const) {
      const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
      const firstTick = 4 * 60_000
      await t.run(async ctx => {
        await lapsedUser(ctx, 'first@example.com', firstTick - 2_000)
        await lapsedUser(ctx, 'second@example.com', firstTick - 1_000)
      })
      await t.run(
        async ctx =>
          await expireLapsedSubscriptionsWithDb(ctx, {
            limit: 1,
            now: firstTick,
            useStoredCursor: true,
          }),
      )

      // Either the row a pre-boundary deployment left behind, or a pass whose
      // every tick has been dying before it could stamp itself.
      // A distant valid monthly-phase clock makes this a stale-pass scenario
      // without copying the tunable abandonment interval.
      const distantMonthlyTick = Math.floor(Number.MAX_SAFE_INTEGER / 120_000) * 120_000
      const nextTick = poison === 'stale' ? distantMonthlyTick : firstTick + 2 * 60_000
      await t.run(async ctx => {
        const state = await ctx.db.query('subscriptionLapseSweepState').unique()
        if (state === null) throw new Error('sweep state missing')
        if (poison === 'no boundary') await ctx.db.patch(state._id, { boundary: undefined })
      })

      const resumed = await t.run(
        async ctx =>
          await expireLapsedSubscriptionsWithDb(ctx, {
            limit: 1,
            now: nextTick,
            useStoredCursor: true,
          }),
      )
      // A fresh pass: the boundary is this tick's clock, not the dead one's.
      expect(resumed.processed).toBe(1)
      const state = await t.run(
        async ctx => await ctx.db.query('subscriptionLapseSweepState').unique(),
      )
      expect(state?.boundary).toBe(nextTick)
    }
  })
})

async function expireLapsed(
  t: ReturnType<typeof convexTest>,
  args: { limit: number; now: number; cursor?: string },
): Promise<{ cursor?: string; done: boolean; processed: number }> {
  return await t.run(
    async ctx =>
      await expireLapsedSubscriptionsWithDb(ctx, {
        limit: args.limit,
        now: args.now,
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      }),
  )
}

async function lapsedUser(
  ctx: MutationCtx,
  email: string,
  monthlyCreditExpiresAt: number,
): Promise<void> {
  await ctx.db.insert('users', {
    email,
    createdAt: 1,
    updatedAt: 1,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    memberDirectoryRevision: 0,
    billing: { monthlyCreditExpiresAt },
  })
}
