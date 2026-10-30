import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import schema from '../../schema'
import { processStripeWebhookEventImpl } from './stripeWebhooks'
import {
  applyPaidSubscriptionInvoiceWithDb,
  AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD,
} from './subscriptions'

test('a portal card replacement clears topup failures and resumes eligible workspaces', async () => {
  const previous = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'recovery-test'
  try {
    const t = convexTest(schema, { '../../_generated/api.ts': async () => ({}) })
    const { userId, workspaceId } = await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'payer@example.test',
        createdAt: 1,
        updatedAt: 1,
        paidCreditBalanceMicroUsd: 20_000_000,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
        billing: {
          stripeCustomerId: 'cus_recovery',
          consecutiveTopupFailures: AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD,
          lastTopupError: { code: 'card_declined', message: 'Declined', at: 1000 },
          monthlyCreditExpiresAt: 100_000,
          subscription: {
            stripeSubscriptionId: 'sub_recovery',
            stripePriceId: 'price_recovery',
            plan: 'max',
            status: 'active',
            currentPeriodStart: 1,
            currentPeriodEnd: 100_000,
            cancelAtPeriodEnd: false,
            latestLifecycleEventCreatedAt: 1,
            latestLifecycleEventId: 'evt_initial',
          },
        },
      })
      const workspaceId = await ctx.db.insert('workspaces', {
        slug: 'recovery',
        name: 'Recovery',
        billingUserId: userId,
        status: 'active',
        servicingStatus: 'paused',
        createdAt: 1,
      })
      await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
      return { userId, workspaceId }
    })
    await t.run(ctx =>
      processStripeWebhookEventImpl(ctx, {
        internalKey: 'recovery-test',
        eventId: 'evt_card',
        type: 'customer.updated',
        eventCreatedAt: 2,
        now: 3000,
        object: { id: 'cus_recovery', invoice_settings: { default_payment_method: 'pm_new' } },
        previousAttributes: { invoice_settings: { default_payment_method: 'pm_old' } },
      }),
    )
    expect(await t.run(ctx => ctx.db.get(workspaceId))).toMatchObject({ servicingStatus: 'active' })
    const payer = await t.run(ctx => ctx.db.get(userId))
    expect(payer?.billing?.consecutiveTopupFailures).toBe(0)
    expect(payer?.billing?.lastTopupError).toBeUndefined()
    expect(payer?.paidCreditBalanceMicroUsd).toBe(20_000_000)
    const failure = (id: string, created: number) =>
      t.run(ctx =>
        processStripeWebhookEventImpl(ctx, {
          internalKey: 'recovery-test',
          eventId: id,
          type: 'invoice.payment_failed',
          eventCreatedAt: created,
          now: 5000,
          object: { metadata: { source: 'duet', type: 'credit_topup', workspaceId, userId } },
        }),
      )
    await failure('evt_delayed_failure', 1)
    expect((await t.run(ctx => ctx.db.get(userId)))?.billing?.consecutiveTopupFailures).toBe(0)
    await failure('evt_new_failure', 4)
    expect((await t.run(ctx => ctx.db.get(userId)))?.billing?.consecutiveTopupFailures).toBe(1)
    // A replay and an unrelated customer edit must not forgive a newer failure.
    for (const [id, previousAttributes, method] of [
      ['evt_card', { invoice_settings: { default_payment_method: 'pm_old' } }, 'pm_new'],
      ['evt_address', { address: null }, 'pm_new'],
      ['evt_removal', { invoice_settings: { default_payment_method: 'pm_new' } }, null],
      ['evt_delayed_card', { invoice_settings: { default_payment_method: 'pm_old' } }, 'pm_new'],
    ] as const) {
      await t.run(ctx =>
        processStripeWebhookEventImpl(ctx, {
          internalKey: 'recovery-test',
          eventId: id,
          type: 'customer.updated',
          eventCreatedAt: 2,
          now: 6000,
          object: { id: 'cus_recovery', invoice_settings: { default_payment_method: method } },
          previousAttributes,
        }),
      )
      expect((await t.run(ctx => ctx.db.get(userId)))?.billing?.consecutiveTopupFailures).toBe(1)
    }
    // Recovery does not remove an independent dispute block.
    await t.run(async ctx => {
      const u = (await ctx.db.get(userId))!
      await ctx.db.patch(userId, { billing: { ...u.billing, disputeFlaggedAt: 7000 } })
    })
    await t.run(ctx =>
      processStripeWebhookEventImpl(ctx, {
        internalKey: 'recovery-test',
        eventId: 'evt_new_card',
        type: 'customer.updated',
        eventCreatedAt: 8,
        now: 9000,
        object: { id: 'cus_recovery', invoice_settings: { default_payment_method: 'pm_newer' } },
        previousAttributes: { invoice_settings: { default_payment_method: 'pm_new' } },
      }),
    )
    expect((await t.run(ctx => ctx.db.get(userId)))?.billing).toMatchObject({
      consecutiveTopupFailures: 0,
      disputeFlaggedAt: 7000,
    })
    expect(await t.run(ctx => ctx.db.get(workspaceId))).toMatchObject({ servicingStatus: 'paused' })
    await t.run(async ctx => {
      const u = (await ctx.db.get(userId))!
      await ctx.db.patch(userId, {
        billing: {
          ...u.billing,
          disputeFlaggedAt: undefined,
          consecutiveTopupFailures: AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD,
          lastTopupError: { code: 'declined', message: 'Declined', at: 10000 },
        },
      })
    })
    await t.run(ctx =>
      applyPaidSubscriptionInvoiceWithDb(
        ctx,
        {
          kind: 'invoice_paid',
          eventId: 'evt_paid_upgrade',
          eventCreatedAt: 12000,
          invoiceId: 'in_upgrade',
          invoiceCreatedAt: 11000,
          customerId: 'cus_recovery',
          subscriptionId: 'sub_recovery',
          priceId: 'price_recovery',
          plan: 'max',
          periodStart: 1,
          periodEnd: 100000,
          billingReason: 'subscription_update',
        },
        13000,
        async () => {},
      ),
    )
    expect((await t.run(ctx => ctx.db.get(userId)))?.billing?.consecutiveTopupFailures).toBe(0)
    expect(await t.run(ctx => ctx.db.get(workspaceId))).toMatchObject({ servicingStatus: 'active' })
    for (let attempt = 0; attempt < AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD; attempt++) {
      const created = 14 + attempt
      await t.run(ctx =>
        processStripeWebhookEventImpl(ctx, {
          internalKey: 'recovery-test',
          eventId: `evt_later_${created}`,
          type: 'invoice.payment_failed',
          eventCreatedAt: created,
          now: 90000,
          object: { metadata: { source: 'duet', type: 'credit_topup', workspaceId, userId } },
        }),
      )
    }
    expect(await t.run(ctx => ctx.db.get(workspaceId))).toMatchObject({
      servicingStatus: 'paused',
      servicingStatusChangedAt: 90000,
    })
    await t.run(async ctx => {
      for (const task of await ctx.db.system.query('_scheduled_functions').collect())
        await ctx.scheduler.cancel(task._id)
    })
  } finally {
    if (previous === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previous
  }
})

test('a delayed recovery retains a newer failure while advancing the recovery boundary', async () => {
  const { resetTopupFailureBilling } = await import('./paymentRecovery')
  expect(
    resetTopupFailureBilling(
      {
        consecutiveTopupFailures: 1,
        lastTopupError: { code: 'declined', message: 'New failure', at: 30000 },
      },
      20000,
    ),
  ).toEqual({
    paymentRecoveredAt: 20000,
    topupFailureAts: [30000],
    consecutiveTopupFailures: 1,
    lastTopupError: { code: 'declined', message: 'New failure', at: 30000 },
  })
})

test('a recovery removes only failures preceding it and wins a same-second tie', async () => {
  const { resetTopupFailureBilling } = await import('./paymentRecovery')
  const billing = {
    consecutiveTopupFailures: 3,
    topupFailureAts: [30000, 11000, 10000],
    lastTopupError: { code: 'declined', message: 'New failure', at: 30000 },
  }
  expect(resetTopupFailureBilling(billing, 20000)).toMatchObject({
    consecutiveTopupFailures: 1,
    topupFailureAts: [30000],
  })
  expect(
    resetTopupFailureBilling(
      {
        ...billing,
        lastTopupError: { ...billing.lastTopupError, at: 20500 },
        topupFailureAts: [20500, 11000, 10000],
      },
      20000,
    ),
  ).toMatchObject({ consecutiveTopupFailures: 0, topupFailureAts: [], lastTopupError: undefined })
})

test('legacy counters and newer diagnostics survive an older recovery', async () => {
  const { resetTopupFailureBilling } = await import('./paymentRecovery')
  const lastTopupError = { code: 'declined', message: 'New failure', at: 30000 }
  expect(
    resetTopupFailureBilling(
      { consecutiveTopupFailures: AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD + 1, lastTopupError },
      20000,
    ),
  ).toMatchObject({
    consecutiveTopupFailures: AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD,
    topupFailureAts: Array.from({ length: AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD }, () => 30000),
    lastTopupError,
  })
  expect(
    resetTopupFailureBilling(
      { consecutiveTopupFailures: 0, topupFailureAts: [], lastTopupError },
      20000,
    ),
  ).toMatchObject({ consecutiveTopupFailures: 0, lastTopupError })
})
