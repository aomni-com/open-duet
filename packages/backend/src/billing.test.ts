import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'
import Stripe from 'stripe'

import {
  currentWeekKey,
  type UsageReportGroup,
  type UsageReportPeriod,
  dollarsToMicroUsd,
  HARD_BLOCK_FLOOR_MICRO_USD,
  type UserBillingOverview,
  VM_IMAGE_HEADROOM_GB,
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

import {
  cancelSubscriptionAtPeriodEnd,
  cancelPendingSubscriptionPlanChange,
  changeSubscriptionPlan,
  resumeSubscription,
  createBillingCheckout,
  createBillingPortal,
  createSubscriptionCheckout,
  createStripeClient,
  createTopupInvoice,
} from '../convex/services/stripe'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-billing-internal-key'
const STRIPE_WEBHOOK_SECRET = 'whsec_billing_test'

let convex: ConvexDevFixture
let owner: SignedInUser
let sequence = 0

describe('billing topups and usage reports', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_FAKE_EXE: '1',
        DUET_TEST_FAKE_STRIPE: '1',
        DUET_USAGE_ROLLUP_MAX_JITTER_MS: '0',
        DUET_APP_URL: 'http://localhost:3000',
        STRIPE_WEBHOOK_SECRET,
        STRIPE_STARTER_RECURRING_PRICE_ID: 'price_1TuClpKD7CmTYhpWZ0BCQ6jy',
        STRIPE_PRO_RECURRING_PRICE_ID: 'price_1TuClpKD7CmTYhpWxqz7Rmlr',
        STRIPE_MAX_RECURRING_PRICE_ID: 'price_test_max',
      },
      reset: true,
    })
    owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('billing-owner'),
      'Billing Owner',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('onboarding payment authorization releases the hold and is idempotent', async () => {
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: uniqueSlug('onboarding-payment'),
      name: 'Onboarding payment workspace',
      requiresOnboarding: true,
    })) as string
    const attemptId = `onboarding-attempt-${Date.now()}`
    const created = (await action('domains/credits/billingActions:createOnboardingPaymentIntent', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      attemptId,
      now: Date.now(),
    })) as Record<string, unknown>

    expect(created).toMatchObject({
      status: 'requires_confirmation',
      attemptId,
      amount: 1000,
      currency: 'usd',
    })
    expect(created.paymentIntentId).toEqual(expect.any(String))

    await expect(
      action('domains/credits/billingActions:completeOnboardingPayment', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        workspaceId,
        attemptId: `${attemptId}-other`,
        paymentIntentId: created.paymentIntentId,
        billingDetails: {
          name: 'Billing Owner',
          email: owner.user.email,
          address: {
            line1: '1 Test Street',
            city: 'San Francisco',
            postalCode: '94105',
            country: 'US',
          },
        },
        now: Date.now(),
      }),
    ).rejects.toThrow('Payment attempt mismatch')

    const completed = (await action('domains/credits/billingActions:completeOnboardingPayment', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      attemptId,
      paymentIntentId: created.paymentIntentId,
      billingDetails: {
        name: 'Billing Owner',
        email: owner.user.email,
        address: {
          line1: '1 Test Street',
          city: 'San Francisco',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
      },
      now: Date.now(),
    })) as Record<string, unknown>

    expect(completed).toMatchObject({ ready: true, status: 'ready' })
    expect(completed.paymentMethodReadyAt).toEqual(expect.any(Number))
    expect(
      await query(convex, 'domains/credits/internal:getOnboardingPaymentStatus', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        workspaceId,
      }),
    ).toMatchObject({ ready: true, status: 'ready', attemptId })

    const replay = (await action('domains/credits/billingActions:completeOnboardingPayment', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      attemptId,
      paymentIntentId: created.paymentIntentId,
      billingDetails: {
        name: 'Billing Owner',
        email: owner.user.email,
        address: {
          line1: '1 Test Street',
          city: 'San Francisco',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
      },
      now: Date.now() + 1,
    })) as Record<string, unknown>
    expect(replay).toEqual(completed)
  })

  test('free-credit cohort excludes lapsed subscribers by activation history', async () => {
    const admin = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('free-credit-admin').replace(/@[^@]+$/, '@aomni.com'),
      'Free Credit Admin',
    )
    // Read-only by contract: a query cannot lose a write conflict to the fleet
    // heartbeat, which a report reading every live workspace otherwise does.
    const summaryBefore = (await query(convex, 'domains/internalAdmin/model:freeCredits', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
    })) as { unpaidUserCount: number; totalFreeCreditsMicroUsd: number }
    // A refusal travels as ConvexError data: production Convex redacts plain
    // error messages, so a code is the only thing the API can map to a status.
    await expect(
      query(convex, 'domains/internalAdmin/model:freeCredits', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
      }),
    ).rejects.toMatchObject({ data: { error: 'internal_admin_required' } })
    const churned = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('free-credit-churned'),
      'Free Credit Churned',
    )
    await mutate(
      churned.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    await mutate(
      churned.client,
      'testing/workspaces:lapseCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    await mutate(churned.client, 'testing/workspaces:clearCurrentUserPaidForTest', {
      internalKey: INTERNAL_KEY,
    })

    const summaryAfter = (await query(convex, 'domains/internalAdmin/model:freeCredits', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
    })) as { unpaidUserCount: number; totalFreeCreditsMicroUsd: number }
    expect(summaryAfter.unpaidUserCount).toBe(summaryBefore.unpaidUserCount)
    expect(summaryAfter.totalFreeCreditsMicroUsd).toBe(summaryBefore.totalFreeCreditsMicroUsd)
  })

  test('auto-topup uses active-subscription combined spendable balance', async () => {
    const fullMonthly = await createTopupPolicyFixture('topup-full-monthly', true)
    const fullWallet = (await wallet(fullMonthly.workspaceId)) as {
      paidCreditBalanceMicroUsd: number
    }
    await mutate(convex, 'testing/credits:applyAccountAdjustmentForTest', {
      internalKey: INTERNAL_KEY,
      userId: fullMonthly.user.user._id,
      amountMicroUsd: -fullWallet.paidCreditBalanceMicroUsd,
      reference: `adjustment:${fullMonthly.workspaceId}:paid-low`,
      now: fullMonthly.now,
    })
    const beforeFull = await scheduledTopupCount()
    expect(await preflight(fullMonthly.workspaceId, fullMonthly.now + 1)).toMatchObject({
      proceed: true,
    })
    expect(await scheduledTopupCount()).toBe(beforeFull)

    const lowCombined = await createTopupPolicyFixture('topup-low-combined', true)
    await mutate(convex, 'testing/credits:setAutoTopupThresholdRawForTest', {
      internalKey: INTERNAL_KEY,
      userId: lowCombined.user.user._id,
      thresholdMicroUsd: dollarsToMicroUsd(4),
    })
    expect(await userBillingOverview(lowCombined.user.user._id)).toMatchObject({
      autoTopupThresholdMicroUsd: dollarsToMicroUsd(5),
    })
    const lowWallet = (await wallet(lowCombined.workspaceId)) as { balanceMicroUsd: number }
    await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
      internalKey: INTERNAL_KEY,
      workspaceId: lowCombined.workspaceId,
      amountMicroUsd: -(lowWallet.balanceMicroUsd - dollarsToMicroUsd(4)),
      type: 'usage',
      reference: `usage:${lowCombined.workspaceId}:below-topup-threshold`,
      now: lowCombined.now,
    })
    const beforeLow = await scheduledTopupCount()
    expect(await preflight(lowCombined.workspaceId, lowCombined.now + 1)).toMatchObject({
      proceed: true,
      balanceMicroUsd: dollarsToMicroUsd(4),
    })
    expect(await scheduledTopupCount()).toBe(beforeLow + 1)

    const noSubscription = await createTopupPolicyFixture('topup-no-subscription', false)
    await mutate(noSubscription.user.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: 0,
    })
    const beforeNoSubscription = await scheduledTopupCount()
    expect(await preflight(noSubscription.workspaceId, 7 * 24 * 60 * 60 * 1_000)).toMatchObject({
      proceed: false,
      reason: 'subscription_required',
    })
    expect(await scheduledTopupCount()).toBe(beforeNoSubscription)
  })

  test('auto-topup idempotency collapses one bucket and three failures pause until a successful topup', async () => {
    const workspaceId = await createWorkspace('topup-idempotent')
    await configureBilling(workspaceId, { stripeCustomerId: 'cus_fake_ok', autoTopupEnabled: true })

    const first = (await action('domains/credits/actions:attemptTopup', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: `topup:${workspaceId}:bucket`,
    })) as { ok: boolean; invoiceId?: string }
    const siblingWorkspaceId = await createWorkspace('topup-idempotent-sibling')
    const second = (await action('domains/credits/actions:attemptTopup', {
      internalKey: INTERNAL_KEY,
      workspaceId: siblingWorkspaceId,
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: `topup:${workspaceId}:bucket`,
    })) as { ok: boolean; invoiceId?: string }

    expect(first).toMatchObject({ ok: true })
    expect(second.invoiceId).toBe(first.invoiceId)
    const successfulTopups = await topups(workspaceId)
    expect(successfulTopups).toEqual([
      expect.objectContaining({
        status: 'paid',
        stripeInvoiceId: first.invoiceId,
      }),
    ])
    expect(successfulTopups[0]).not.toHaveProperty('stripePaymentIntentId')
    expect(await topups(siblingWorkspaceId)).toHaveLength(0)
    expect((await listTransactions(workspaceId)).filter(row => row.type === 'topup')).toHaveLength(
      0,
    )

    const failingWorkspaceId = await createWorkspace('topup-fail')
    await configureBilling(failingWorkspaceId, {
      stripeCustomerId: 'fail_fake_card',
      autoTopupEnabled: true,
    })
    for (let index = 0; index < 3; index += 1) {
      await action('domains/credits/actions:attemptTopup', {
        internalKey: INTERNAL_KEY,
        workspaceId: failingWorkspaceId,
        amountMicroUsd: dollarsToMicroUsd(20),
        idempotencyKey: `topup:${failingWorkspaceId}:fail-${index}`,
      })
    }
    const config = await topupConfig(failingWorkspaceId)
    expect(config).toMatchObject({
      consecutiveTopupFailures: 3,
      lastTopupError: { code: 'card_declined' },
    })
    expect(await workspaceById(failingWorkspaceId)).toMatchObject({ servicingStatus: 'paused' })
    expect(await topups(failingWorkspaceId)).toEqual([
      expect.objectContaining({ status: 'failed', stripeInvoiceId: expect.any(String) }),
      expect.objectContaining({ status: 'failed', stripeInvoiceId: expect.any(String) }),
      expect.objectContaining({ status: 'failed', stripeInvoiceId: expect.any(String) }),
    ])

    await configureBilling(failingWorkspaceId, { stripeCustomerId: 'cus_fake_recovered' })
    const recovered = (await action('domains/credits/actions:attemptTopup', {
      internalKey: INTERNAL_KEY,
      workspaceId: failingWorkspaceId,
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: `topup:${failingWorkspaceId}:recovered`,
    })) as { ok: boolean }

    expect(recovered).toMatchObject({ ok: true })
    const recoveredConfig = await topupConfig(failingWorkspaceId)
    expect(recoveredConfig).toMatchObject({ consecutiveTopupFailures: 0 })
    expect(recoveredConfig.lastTopupError).toBeUndefined()
    expect(await workspaceById(failingWorkspaceId)).toMatchObject({ servicingStatus: 'active' })
  })

  test('a failed auto-topup remains idempotent inside its five-minute bucket', async () => {
    const workspaceId = await createWorkspace('topup-failed-idempotent')
    await configureBilling(workspaceId, {
      stripeCustomerId: 'fail_fake_card',
      autoTopupEnabled: true,
    })
    const idempotencyKey = `topup:${workspaceId}:same-bucket`

    const first = (await action('domains/credits/actions:attemptTopup', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey,
    })) as { ok: boolean; invoiceId?: string }
    const replay = (await action('domains/credits/actions:attemptTopup', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey,
    })) as { ok: boolean; invoiceId?: string }

    expect(first).toMatchObject({ ok: false, invoiceId: expect.any(String) })
    expect(replay).toEqual(first)
    expect(await topups(workspaceId)).toEqual([
      expect.objectContaining({ status: 'failed', stripeInvoiceId: first.invoiceId }),
    ])
    expect(await topupConfig(workspaceId)).toMatchObject({ consecutiveTopupFailures: 1 })
  })

  test('signed portal card updates recover a payer paused by topup failures', async () => {
    const workspaceId = await createWorkspace('portal-recovery')
    await configureBilling(workspaceId, {
      stripeCustomerId: 'fail_portal_recovery',
      autoTopupEnabled: true,
    })
    for (let i = 0; i < 3; i++)
      await action('domains/credits/actions:attemptTopup', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        amountMicroUsd: dollarsToMicroUsd(20),
        idempotencyKey: `portal-recovery-${i}`,
      })
    expect(await workspaceById(workspaceId)).toMatchObject({ servicingStatus: 'paused' })
    const initialBalance = await balance(workspaceId)
    const event = {
      id: 'evt_portal_recovery',
      created: Math.floor(Date.now() / 1000),
      type: 'customer.updated',
      data: {
        object: {
          id: 'fail_portal_recovery',
          invoice_settings: { default_payment_method: 'pm_replacement' },
        },
        previous_attributes: { invoice_settings: { default_payment_method: null } },
      },
    }
    expect(await postSignedWebhook(event)).toEqual({ ok: true })
    expect(await workspaceById(workspaceId)).toMatchObject({ servicingStatus: 'active' })
    expect(await topupConfig(workspaceId)).toMatchObject({ consecutiveTopupFailures: 0 })
    expect(await balance(workspaceId)).toBe(initialBalance)
    expect(await postSignedWebhook(event)).toEqual({ ok: true, replay: true })
  })

  test('Stripe webhook recovery activates paused workspaces but not banned workspaces', async () => {
    const internalAdmin = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('billing-admin').replace(/@[^@]+$/, '@aomni.com'),
      'Billing Admin',
    )
    const pausedWorkspaceId = await createWorkspace('webhook-paused-recovery')
    await configureBilling(pausedWorkspaceId, {
      stripeCustomerId: 'fail_fake_card',
      autoTopupEnabled: true,
    })
    for (let index = 0; index < 3; index += 1) {
      await action('domains/credits/actions:attemptTopup', {
        internalKey: INTERNAL_KEY,
        workspaceId: pausedWorkspaceId,
        amountMicroUsd: dollarsToMicroUsd(20),
        idempotencyKey: `topup:${pausedWorkspaceId}:pause-${index}`,
      })
    }
    expect(await workspaceById(pausedWorkspaceId)).toMatchObject({ servicingStatus: 'paused' })

    await processWebhook(
      invoicePaidEvent('evt_paused_recovery', pausedWorkspaceId, 'in_paused_recovery', 2_000),
    )
    expect(await workspaceById(pausedWorkspaceId)).toMatchObject({ servicingStatus: 'active' })
    expect(await topupConfig(pausedWorkspaceId)).toMatchObject({ consecutiveTopupFailures: 0 })

    const bannedWorkspaceId = await createWorkspace('webhook-banned-recovery')
    await mutate(convex, 'domains/internalAdmin/model:mutateWorkspace', {
      internalKey: INTERNAL_KEY,
      workspaceId: bannedWorkspaceId,
      actorId: internalAdmin.user._id,
      requestId: crypto.randomUUID(),
      reason: 'billing review',
      now: Date.now(),
      operation: 'ban',
    })
    await processWebhook(
      invoicePaidEvent('evt_banned_recovery', bannedWorkspaceId, 'in_banned_recovery', 2_000),
    )
    expect(await workspaceById(bannedWorkspaceId)).toMatchObject({ servicingStatus: 'banned' })

    await expect(
      mutate(convex, 'domains/internalAdmin/model:mutateWorkspace', {
        internalKey: INTERNAL_KEY,
        workspaceId: bannedWorkspaceId,
        actorId: internalAdmin.user._id,
        requestId: crypto.randomUUID(),
        reason: 'manual activation is forbidden',
        now: Date.now(),
        operation: 'servicing',
        servicingStatus: 'active',
      }),
    ).rejects.toThrow()
    expect(await workspaceById(bannedWorkspaceId)).toMatchObject({ servicingStatus: 'banned' })
  })

  test('Stripe webhook grants an invoice topup once across event and invoice replays', async () => {
    const workspaceId = await createWorkspace('webhook-replay')
    const startingBalance = await balance(workspaceId)
    const event = invoicePaidEvent('evt_replay_once', workspaceId, 'in_replay_once', 2_000, 0)

    await processWebhook(event)
    await processWebhook(event)
    await processWebhook(
      invoicePaidEvent('evt_replay_new_event', workspaceId, 'in_replay_once', 2_000),
    )

    const topupRows = (await listTransactions(workspaceId)).filter(row => row.type === 'topup')
    expect(topupRows).toHaveLength(1)
    expect(topupRows[0]).toMatchObject({
      amountMicroUsd: dollarsToMicroUsd(20),
      reference: 'in_replay_once',
      metadata: {
        context: { source: 'stripe_webhook', eventId: 'evt_replay_once' },
      },
    })
    expect(await balance(workspaceId)).toBe(startingBalance + dollarsToMicroUsd(20))
  })

  test('subscription and topup PaymentIntents credit nothing', async () => {
    const workspaceId = await createWorkspace('payment-intents-ignored')
    const startingBalance = await balance(workspaceId)
    const subscriptionEvent = paymentIntentSucceededEvent(
      'evt_subscription_pi_ignored',
      workspaceId,
      'pi_subscription_ignored',
      2_000,
      'subscription',
    )
    const topupEvent = paymentIntentSucceededEvent(
      'evt_topup_pi_ignored',
      workspaceId,
      'pi_topup_ignored',
      2_000,
    )

    await processWebhook(subscriptionEvent)
    await processWebhook(topupEvent)

    expect((await listTransactions(workspaceId)).filter(row => row.type === 'topup')).toEqual([])
    expect(await balance(workspaceId)).toBe(startingBalance)
  })

  test('a captured chat-app topup invoice is not a Duet-v2 topup', async () => {
    const workspaceId = await createWorkspace('chat-invoice')
    const startingBalance = await balance(workspaceId)
    const fixture = (await Bun.file(
      join(BACKEND_DIR, 'test-fixtures/stripe-subscriptions/09-chat-app-topup-invoice-paid.json'),
    ).json()) as Record<string, unknown>

    await processWebhook(fixture)

    expect((await listTransactions(workspaceId)).filter(row => row.type === 'topup')).toEqual([])
    expect(await balance(workspaceId)).toBe(startingBalance)
  })

  test('a captured subscription invoice grants the catalog allotment through the signed HTTP seam', async () => {
    const workspaceId = await createWorkspace('sub-invoice-grant')
    await mutate(owner.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: Date.now(),
    })
    await configureBilling(workspaceId, { stripeCustomerId: 'cus_Uu10GVGuICzRj3' })
    expect((await accountBilling(owner.user._id)).stripeCustomerId).toBe('cus_Uu10GVGuICzRj3')
    const fixture = await stripeFixture('01-invoice-create.json')

    expect(await postSignedWebhook(fixture)).toEqual({ ok: true })

    expect(await wallet(workspaceId)).toMatchObject({
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(20),
    })
    expect(await accountBilling(owner.user._id)).toMatchObject({
      firstPaidAt: expect.any(Number),
      paymentMethodReadyAt: expect.any(Number),
      subscriptionEverActivatedAt: expect.any(Number),
      monthlyCreditEpoch: 'in_1TuCyrKD7CmTYhpWoAKcbcNe',
      subscription: {
        stripeSubscriptionId: 'sub_1TuCyrKD7CmTYhpW8njVLwJj',
        stripePriceId: 'price_1TuClpKD7CmTYhpWZ0BCQ6jy',
        plan: 'starter',
      },
    })
    const sessionUser = (await query(owner.client, 'domains/users/queries:current', {})) as {
      billing: Record<string, unknown>
    }
    expect(sessionUser.billing).not.toHaveProperty('subscription')
    expect(sessionUser.billing).not.toHaveProperty('disputeFlaggedAt')
    expect(JSON.stringify(sessionUser)).not.toContain('stripeSubscriptionId')
    expect(JSON.stringify(sessionUser)).not.toContain('latestLifecycleEventId')
  })

  test('direct billing updates reject an automatic top-up threshold below five dollars', async () => {
    const account = await createSubscriptionAccount('topup-threshold-floor', 'cus_threshold_floor')

    await expect(
      mutate(convex, 'domains/credits/internal:updateUserBilling', {
        internalKey: INTERNAL_KEY,
        actorId: account.user.user._id,
        workspaceId: account.workspaceId,
        autoTopupThresholdMicroUsd: dollarsToMicroUsd(5) - 1,
        now: Date.now(),
      }),
    ).rejects.toThrow('Automatic top-up threshold must be at least $5')
  })

  test('SUBS-IMPL-05 captured subscription fixtures converge in captured, reversed, and shuffled order', async () => {
    const fixtureNames = [
      '01-invoice-create.json',
      '02-subscription-created.json',
      '03-invoice-renewal.json',
      '04-invoice-upgrade.json',
      '05-subscription-upgraded.json',
      '06-subscription-downgrade-scheduled.json',
      '07-subscription-cancel-scheduled.json',
      '08-subscription-deleted.json',
      '09-chat-app-topup-invoice-paid.json',
    ]
    const fixtures = await Promise.all(fixtureNames.map(stripeFixture))
    const orders = [
      fixtures,
      [...fixtures].reverse(),
      [
        fixtures[4]!,
        fixtures[0]!,
        fixtures[8]!,
        fixtures[2]!,
        fixtures[7]!,
        fixtures[1]!,
        fixtures[6]!,
        fixtures[3]!,
        fixtures[5]!,
      ],
    ]
    const states: SubscriptionHarnessState[] = []

    for (const [index, order] of orders.entries()) {
      const account = await createSubscriptionAccount(`perm-${index}`, `cus_perm_${index}`)
      for (const original of order) {
        const event = structuredClone(original)
        event.id = `${String(event.id)}:perm-${index}`
        const object = (event.data as { object: Record<string, unknown> }).object
        object.customer = account.customerId
        if (event.type === 'customer.subscription.updated' && typeof object.schedule === 'string') {
          object.schedule = subscriptionScheduleFixture(object)
        }
        await postSignedWebhook(event)
      }
      states.push(await subscriptionHarnessState(account.user.user._id, account.workspaceId))
    }

    expect(states[1]).toEqual(states[0])
    expect(states[2]).toEqual(states[0])
    expect(states[0]).toMatchObject({
      subscription: { plan: 'pro', status: 'canceled', cancelAtPeriodEnd: false },
      monthlyCreditBalanceMicroUsd: 0,
      paidCreditBalanceMicroUsd: dollarsToMicroUsd(5),
      monthlyCreditEpoch: 'in_1TuCz0KD7CmTYhpWCKPDiSpG',
    })
  }, 60_000)

  test('SUBS-IMPL-FIX2 checkout accepts a projected unpaid subscription', async () => {
    const account = await createSubscriptionAccount('unpaid-checkout', 'cus_unpaid_checkout')
    const event = await fixtureForCustomer('02-subscription-created.json', account.customerId)
    event.id = 'evt_unpaid_checkout'
    ;(event.data as { object: Record<string, unknown> }).object.status = 'unpaid'
    await postSignedWebhook(event)

    expect(await accountBilling(account.user.user._id)).toMatchObject({
      subscription: { status: 'unpaid' },
    })

    const checkout = (await action('domains/credits/billingActions:createSubscriptionCheckout', {
      internalKey: INTERNAL_KEY,
      actorId: account.user.user._id,
      workspaceId: account.workspaceId,
      plan: 'pro',
      returnUrl: 'http://localhost:3000/settings/billing',
      now: Date.now(),
    })) as { url: string }
    expect(checkout.url).toStartWith('https://checkout.stripe.test/')
  })

  test('SUBS-IMPL-FIX2 reports a trial at the hard-block floor as exhausted', async () => {
    const trialUser = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('trial-hard-block-floor'),
      'Trial Hard Block Floor',
    )
    const now = Date.now()
    await mutate(trialUser.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now,
    })
    const before = (await userBillingOverview(trialUser.user._id)) as {
      balanceMicroUsd: number
    }
    await mutate(convex, 'testing/credits:applyAccountAdjustmentForTest', {
      internalKey: INTERNAL_KEY,
      userId: trialUser.user._id,
      amountMicroUsd: HARD_BLOCK_FLOOR_MICRO_USD - before.balanceMicroUsd,
      reference: `adjustment:trial-hard-block-floor:${trialUser.user._id}`,
      now,
    })

    expect(await userBillingOverview(trialUser.user._id)).toMatchObject({
      balanceMicroUsd: HARD_BLOCK_FLOOR_MICRO_USD,
      trial: { status: 'exhausted' },
    })
  })

  test('billing overview reports trial storage as unmeasured Starter capacity', async () => {
    const trialUser = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('trial-storage-overview'),
      'Trial Storage Overview',
    )
    await mutate(trialUser.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: Date.now(),
    })

    const overview = (await userBillingOverview(trialUser.user._id)) as UserBillingOverview
    expect(overview.workspaces[0]?.storage).toEqual({
      usableGb: 20,
      plan: 'starter',
      nextPlan: 'pro',
      nextUsableGb: 50,
    })
  })

  test('billing overview keeps a downgraded workspace denominator physically honest', async () => {
    const payer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('downgraded-storage-overview'),
      'Downgraded Storage Overview',
    )
    const now = Date.now()
    await mutate(
      payer.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, now, plan: 'pro' },
    )
    const rows = (await query(payer.client, 'domains/workspaces/queries:listMine', {})) as Array<{
      workspace: { _id: string }
    }>
    const workspaceId = rows[0]!.workspace._id
    await markDiskWorkspaceLive(workspaceId, 58)
    await mutate(
      payer.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, now: now + 1, plan: 'starter' },
    )
    await mutate(convex, 'testing/vmTelemetry:seedTelemetrySamplesForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      samples: [
        { at: now + 2, fsUsedGb: VM_IMAGE_HEADROOM_GB + 0.012 },
        { at: now + 3, fsUsedGb: VM_IMAGE_HEADROOM_GB + 0.008 },
      ],
    })

    const overview = (await userBillingOverview(payer.user._id)) as UserBillingOverview
    // The retained 58GB disk already covers pro's 50GB, so no upgrade step
    // is advertised (whole-spec review fix).
    // `usedBytes` is asserted apart from the rest because the projection
    // subtracts the image headroom from a float GB reading, which lands a hair
    // off the round number. The rest stays an exact match so a new field in the
    // projection still fails here rather than passing unnoticed.
    const { usedBytes, ...storage } = overview.workspaces.find(
      workspace => workspace.id === workspaceId,
    )!.storage
    expect(storage).toEqual({ usableGb: 50, sampledAt: now + 3, plan: 'starter' })
    expect(usedBytes).toBeCloseTo(8_000_000, 0)
  })

  test('billing overview reports independent newest measurements for Max workspaces', async () => {
    const payer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('max-storage-overview'),
      'Max Storage Overview',
    )
    const now = Date.now()
    await mutate(
      payer.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, now, plan: 'max' },
    )
    const rows = (await query(payer.client, 'domains/workspaces/queries:listMine', {})) as Array<{
      workspace: { _id: string }
    }>
    const firstWorkspaceId = rows[0]!.workspace._id
    await markDiskWorkspaceLive(firstWorkspaceId, 108)
    const secondWorkspaceId = await createDiskWorkspace(payer.client, 'max-ovw-second', 108)
    await mutate(convex, 'testing/vmTelemetry:seedTelemetrySamplesForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: firstWorkspaceId,
      samples: [
        { at: now + 1, fsUsedGb: VM_IMAGE_HEADROOM_GB + 0.004 },
        { at: now + 3, fsUsedGb: VM_IMAGE_HEADROOM_GB + 0.0125 },
      ],
    })
    await mutate(convex, 'testing/vmTelemetry:seedTelemetrySamplesForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: secondWorkspaceId,
      samples: [{ at: now + 2, fsUsedGb: VM_IMAGE_HEADROOM_GB }],
    })

    const overview = (await userBillingOverview(payer.user._id)) as UserBillingOverview
    const { usedBytes: firstUsedBytes, ...firstStorage } = overview.workspaces.find(
      workspace => workspace.id === firstWorkspaceId,
    )!.storage
    expect(firstStorage).toEqual({ usableGb: 100, sampledAt: now + 3, plan: 'max' })
    expect(firstUsedBytes).toBeCloseTo(12_500_000, 0)
    expect(
      overview.workspaces.find(workspace => workspace.id === secondWorkspaceId)?.storage,
    ).toEqual({
      usableGb: 100,
      usedBytes: 0,
      sampledAt: now + 2,
      plan: 'max',
    })
  })

  test('subscription payment failure records only subscription error state', async () => {
    const account = await createSubscriptionAccount('sub-failure', 'cus_sub_failure')
    const topupFailure = invoicePaymentFailedEvent(
      'evt_topup_failure_control',
      account.workspaceId,
      'in_topup_failure_control',
    )
    topupFailure.created = 100
    ;((topupFailure.data as Record<string, unknown>).object as Record<string, unknown>).metadata = {
      source: 'duet',
      type: 'credit_topup',
      workspaceId: account.workspaceId,
      userId: account.user.user._id,
    }
    await postSignedWebhook(topupFailure)
    const beforeTopup = await topupConfig(account.workspaceId)
    const beforeTopupRows = await topups(account.workspaceId)

    const subscriptionFailure = await stripeFixture('03-invoice-renewal.json')
    subscriptionFailure.id = 'evt_subscription_payment_failed'
    subscriptionFailure.created = 101
    subscriptionFailure.type = 'invoice.payment_failed'
    ;(
      (subscriptionFailure.data as Record<string, unknown>).object as Record<string, unknown>
    ).customer = account.customerId
    await postSignedWebhook(subscriptionFailure)

    expect(await accountBilling(account.user.user._id)).toMatchObject({
      subscriptionPaymentError: { code: 'invoice_payment_failed', at: expect.any(Number) },
    })
    expect(await topupConfig(account.workspaceId)).toMatchObject({
      consecutiveTopupFailures: beforeTopup.consecutiveTopupFailures,
      lastTopupError: beforeTopup.lastTopupError,
    })
    expect(await topups(account.workspaceId)).toEqual(beforeTopupRows)
    expect((await workspaceByIdFor(account.user.client, account.workspaceId)).servicingStatus).toBe(
      'active',
    )
  })

  test('subscription payment error follows invoice order across stale paid and failed deliveries', async () => {
    const account = await createSubscriptionAccount('payment-order', 'cus_payment_order')
    const upgradePaid = await fixtureForCustomer('04-invoice-upgrade.json', account.customerId)
    await postSignedWebhook(upgradePaid)

    const staleFailure = await fixtureForCustomer('03-invoice-renewal.json', account.customerId)
    staleFailure.type = 'invoice.payment_failed'
    staleFailure.id = 'evt_stale_renewal_failure'
    staleFailure.created = Number(upgradePaid.created) + 10
    await postSignedWebhook(staleFailure)
    expect(await accountBilling(account.user.user._id)).not.toHaveProperty(
      'subscriptionPaymentError',
    )

    const currentFailure = structuredClone(upgradePaid)
    currentFailure.type = 'invoice.payment_failed'
    currentFailure.id = 'evt_current_upgrade_failure'
    currentFailure.created = Number(upgradePaid.created) + 20
    await postSignedWebhook(currentFailure)
    expect(await accountBilling(account.user.user._id)).toMatchObject({
      subscriptionPaymentError: { code: 'invoice_payment_failed' },
    })

    const stalePaid = await fixtureForCustomer('03-invoice-renewal.json', account.customerId)
    stalePaid.id = 'evt_stale_renewal_paid_after_failure'
    stalePaid.created = Number(upgradePaid.created) + 30
    await postSignedWebhook(stalePaid)
    expect(await accountBilling(account.user.user._id)).toMatchObject({
      subscriptionPaymentError: { code: 'invoice_payment_failed' },
    })

    const recoveredPaid = structuredClone(upgradePaid)
    recoveredPaid.id = 'evt_current_upgrade_paid_recovery'
    recoveredPaid.created = Number(upgradePaid.created) + 40
    await postSignedWebhook(recoveredPaid)
    expect(await accountBilling(account.user.user._id)).not.toHaveProperty(
      'subscriptionPaymentError',
    )
  })

  test('a paid first subscription clears older topup failures and stamps paid history', async () => {
    const account = await createSubscriptionAccount('activation', 'cus_activation')
    const topupFailure = invoicePaymentFailedEvent(
      'evt_activation_topup_failure',
      account.workspaceId,
      'in_activation_topup_failure',
    )
    topupFailure.created = 110
    ;((topupFailure.data as Record<string, unknown>).object as Record<string, unknown>).metadata = {
      source: 'duet',
      type: 'credit_topup',
      workspaceId: account.workspaceId,
      userId: account.user.user._id,
    }
    await postSignedWebhook(topupFailure)
    expect(await topupConfig(account.workspaceId)).toMatchObject({ consecutiveTopupFailures: 1 })

    await postSignedWebhook(await fixtureForCustomer('01-invoice-create.json', account.customerId))

    expect(await accountBilling(account.user.user._id)).toMatchObject({
      firstPaidAt: expect.any(Number),
      subscriptionEverActivatedAt: expect.any(Number),
      consecutiveTopupFailures: 0,
    })
    expect(await accountBilling(account.user.user._id)).not.toHaveProperty('lastTopupError')
  })

  test('a foreign-charge dispute flags a mapped customer for internal admin and ignores an unmapped customer', async () => {
    const account = await createSubscriptionAccount('dispute', 'cus_foreign_dispute')
    const mapped = {
      id: 'evt_foreign_dispute_mapped',
      created: 200,
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_foreign_charge',
          charge: {
            id: 'ch_owned_by_another_app',
            customer: account.customerId,
          },
        },
      },
    }
    expect(await postSignedWebhook(mapped)).toEqual({ ok: true })
    expect(await accountBilling(account.user.user._id)).toMatchObject({
      disputeFlaggedAt: expect.any(Number),
    })
    expect((await workspaceByIdFor(account.user.client, account.workspaceId)).servicingStatus).toBe(
      'paused',
    )

    const admin = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('dispute-admin').replace(/@[^@]+$/, '@aomni.com'),
      'Dispute Admin',
    )
    const adminResult = (await query(convex, 'domains/internalAdmin/model:search', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      identifier: account.customerId,
    })) as { workspaces: Array<Record<string, unknown>> }
    expect(adminResult.workspaces).toContainEqual(
      expect.objectContaining({
        id: account.workspaceId,
        disputeFlaggedAt: expect.any(Number),
      }),
    )
    await mutate(convex, 'domains/internalAdmin/model:mutateWorkspace', {
      internalKey: INTERNAL_KEY,
      workspaceId: account.workspaceId,
      actorId: admin.user._id,
      requestId: 'dispute-clear-01',
      reason: 'chargeback evidence reviewed',
      now: Date.now(),
      operation: 'dispute_clear',
    })
    expect(await accountBilling(account.user.user._id)).not.toHaveProperty('disputeFlaggedAt')
    expect((await workspaceByIdFor(account.user.client, account.workspaceId)).servicingStatus).toBe(
      'active',
    )

    const unmapped = structuredClone(mapped)
    unmapped.id = 'evt_foreign_dispute_unmapped'
    unmapped.data.object.charge.customer = 'cus_not_mapped'
    expect(await postSignedWebhook(unmapped)).toEqual({ ok: true, ignored: true })
  })

  test('foreign subscription lifecycle and organization invoice are ignored and marked', async () => {
    const account = await createSubscriptionAccount('foreign-events', 'cus_foreign_events')
    const lifecycle = await fixtureForCustomer('02-subscription-created.json', account.customerId)
    const lifecycleObject = (lifecycle.data as { object: Record<string, unknown> }).object
    lifecycleObject.metadata = {
      source: 'duet',
      organizationId: 'foreign_organization',
    }
    const organizationInvoice = await fixtureForCustomer(
      '09-chat-app-topup-invoice-paid.json',
      account.customerId,
    )

    expect(await postSignedWebhook(lifecycle)).toEqual({ ok: true })
    expect(await postSignedWebhook(organizationInvoice)).toEqual({ ok: true, ignored: true })
    expect(await accountBilling(account.user.user._id)).not.toHaveProperty('subscription')
    expect(await wallet(account.workspaceId)).toMatchObject({
      paidCreditBalanceMicroUsd: dollarsToMicroUsd(5),
      monthlyCreditBalanceMicroUsd: 0,
    })
  })

  test('a second nonterminal subscription fails loudly and is not marked processed', async () => {
    const account = await createSubscriptionAccount('second-sub', 'cus_second_sub')
    const first = await stripeFixture('02-subscription-created.json')
    ;((first.data as Record<string, unknown>).object as Record<string, unknown>).customer =
      account.customerId
    await postSignedWebhook(first)

    const second = structuredClone(first)
    second.id = 'evt_second_nonterminal_subscription'
    second.created = Number(first.created) + 1
    ;((second.data as Record<string, unknown>).object as Record<string, unknown>).id =
      'sub_second_nonterminal'
    const response = await signedWebhookResponse(second)
    expect(response.status).toBe(500)
    expect((await signedWebhookResponse(second)).status).toBe(500)
    expect(await accountBilling(account.user.user._id)).toMatchObject({
      subscription: { stripeSubscriptionId: 'sub_1TuCyrKD7CmTYhpW8njVLwJj' },
    })
  })

  test('upgrade grants the full new plan allotment; stale renewal and scheduled downgrade grant nothing', async () => {
    const account = await createSubscriptionAccount('plan-change', 'cus_plan_change')
    const createInvoice = await fixtureForCustomer('01-invoice-create.json', account.customerId)
    const upgradeInvoice = await fixtureForCustomer('04-invoice-upgrade.json', account.customerId)
    const downgradeLifecycle = await fixtureForCustomer(
      '06-subscription-downgrade-scheduled.json',
      account.customerId,
    )

    await postSignedWebhook(createInvoice)
    await postSignedWebhook(upgradeInvoice)
    expect(await wallet(account.workspaceId)).toMatchObject({
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(60),
    })
    expect(await accountBilling(account.user.user._id)).toMatchObject({
      subscription: { plan: 'pro' },
      monthlyCreditEpoch: 'in_1TuCz0KD7CmTYhpWCKPDiSpG',
    })
    await postSignedWebhook(await fixtureForCustomer('03-invoice-renewal.json', account.customerId))
    expect(await wallet(account.workspaceId)).toMatchObject({
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(60),
    })
    expect(await accountBilling(account.user.user._id)).toMatchObject({
      monthlyCreditEpoch: 'in_1TuCz0KD7CmTYhpWCKPDiSpG',
    })
    const beforeDowngrade = await subscriptionLedgerReferences(account.user.user._id)

    await postSignedWebhook(downgradeLifecycle)

    expect(await wallet(account.workspaceId)).toMatchObject({
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(60),
    })
    expect(await accountBilling(account.user.user._id)).toMatchObject({
      subscription: { plan: 'pro', pendingPlan: 'starter' },
    })
    expect(await subscriptionLedgerReferences(account.user.user._id)).toEqual(beforeDowngrade)
  })

  test('a Starter to Pro paid invoice schedules one disk grow for each payer workspace', async () => {
    const account = await createSubscriptionAccount('disk-grow', 'cus_disk_grow')
    // The initial paid invoice makes the payer paid — the production gate for
    // owning more than one workspace.
    await postSignedWebhook(await fixtureForCustomer('01-invoice-create.json', account.customerId))
    const workspaceIds = [account.workspaceId]
    for (let index = 1; index < 3; index += 1) {
      workspaceIds.push(await createDiskWorkspace(account.user.client, `disk-grow-${index}`, 28))
    }
    await markDiskWorkspaceLive(account.workspaceId, 28)

    await postSignedWebhook(await fixtureForCustomer('04-invoice-upgrade.json', account.customerId))

    expect(
      await Promise.all(
        workspaceIds.map(workspaceId => resizeScheduleEventCount(account.user.client, workspaceId)),
      ),
    ).toEqual([1, 1, 1])
  }, 60_000)

  test('a pending downgrade lifecycle schedules no disk resize', async () => {
    const account = await createSubscriptionAccount('disk-downgrade', 'cus_disk_downgrade')
    await markDiskWorkspaceLive(account.workspaceId, 58)
    await postSignedWebhook(await fixtureForCustomer('04-invoice-upgrade.json', account.customerId))
    const before = await resizeScheduleEventCount(account.user.client, account.workspaceId)

    await postSignedWebhook(
      await fixtureForCustomer('06-subscription-downgrade-scheduled.json', account.customerId),
    )

    expect(await resizeScheduleEventCount(account.user.client, account.workspaceId)).toBe(before)
  })

  test('a replayed paid invoice schedules no additional disk resize', async () => {
    const account = await createSubscriptionAccount('disk-replay', 'cus_disk_replay')
    await markDiskWorkspaceLive(account.workspaceId, 28)
    const invoice = await fixtureForCustomer('04-invoice-upgrade.json', account.customerId)
    await postSignedWebhook(invoice)
    const before = await resizeScheduleEventCount(account.user.client, account.workspaceId)

    expect(await postSignedWebhook(invoice)).toEqual({ ok: true, replay: true })

    expect(await resizeScheduleEventCount(account.user.client, account.workspaceId)).toBe(before)
  })

  test('a same-size multi-workspace paid-invoice fan-out schedules zero actions', async () => {
    const account = await createSubscriptionAccount('disk-fanout', 'cus_disk_fanout')
    await postSignedWebhook(await fixtureForCustomer('01-invoice-create.json', account.customerId))
    const workspaceIds = [account.workspaceId]
    await markDiskWorkspaceLive(account.workspaceId, 58)
    for (let index = 1; index < 3; index += 1) {
      workspaceIds.push(await createDiskWorkspace(account.user.client, `disk-fanout-${index}`, 58))
    }

    await postSignedWebhook(await fixtureForCustomer('04-invoice-upgrade.json', account.customerId))

    expect(
      (
        await Promise.all(
          workspaceIds.map(workspaceId =>
            resizeScheduleEventCount(account.user.client, workspaceId),
          ),
        )
      ).reduce((sum, count) => sum + count, 0),
    ).toBe(0)
  }, 120_000)

  test('cancel-at-period-end retains credits; deletion expires monthly once and stale active cannot resurrect it', async () => {
    const account = await createSubscriptionAccount('cancel-delete', 'cus_cancel_delete')
    await postSignedWebhook(await fixtureForCustomer('04-invoice-upgrade.json', account.customerId))
    await postSignedWebhook(
      await fixtureForCustomer('07-subscription-cancel-scheduled.json', account.customerId),
    )
    expect(await wallet(account.workspaceId)).toMatchObject({
      paidCreditBalanceMicroUsd: dollarsToMicroUsd(5),
      monthlyCreditBalanceMicroUsd: dollarsToMicroUsd(60),
    })

    const deletion = await fixtureForCustomer('08-subscription-deleted.json', account.customerId)
    await postSignedWebhook(deletion)
    expect(await postSignedWebhook(deletion)).toEqual({ ok: true, replay: true })
    const staleActive = await fixtureForCustomer(
      '05-subscription-upgraded.json',
      account.customerId,
    )
    staleActive.id = 'evt_stale_active_after_delete'
    await postSignedWebhook(staleActive)

    expect(await wallet(account.workspaceId)).toMatchObject({
      paidCreditBalanceMicroUsd: dollarsToMicroUsd(5),
      monthlyCreditBalanceMicroUsd: 0,
    })
    expect(await accountBilling(account.user.user._id)).toMatchObject({
      subscription: { status: 'canceled' },
    })
    expect((await workspaceByIdFor(account.user.client, account.workspaceId)).servicingStatus).toBe(
      'paused',
    )
    expect(
      (await subscriptionLedgerReferences(account.user.user._id)).filter(reference =>
        reference.startsWith('subscription_expiry:lapse:'),
      ),
    ).toEqual([
      'subscription_expiry:lapse:sub_1TuCyrKD7CmTYhpW8njVLwJj:in_1TuCz0KD7CmTYhpWCKPDiSpG',
    ])
  })

  test('SUBS-IMPL-FIX39 same-second lifecycle events apply in delivery order, not id order', async () => {
    const account = await createSubscriptionAccount('tie', 'cus_tie')
    await postSignedWebhook(await fixtureForCustomer('01-invoice-create.json', account.customerId))
    await postSignedWebhook(
      await fixtureForCustomer('02-subscription-created.json', account.customerId),
    )

    // Stripe created both events in the same second (observed live: schedule
    // release then cancel). Event ids are not monotonic — here the later,
    // true state carries the LOWER id and must still win.
    const release = await fixtureForCustomer(
      '07-subscription-cancel-scheduled.json',
      account.customerId,
    )
    release.id = `evt_zz_release:${account.customerId}`
    ;((release.data as Record<string, unknown>).object as Record<string, unknown>)[
      'cancel_at_period_end'
    ] = false
    await postSignedWebhook(release)

    const cancel = await fixtureForCustomer(
      '07-subscription-cancel-scheduled.json',
      account.customerId,
    )
    cancel.id = `evt_aa_cancel:${account.customerId}`
    await postSignedWebhook(cancel)

    const after = await subscriptionHarnessState(account.user.user._id, account.workspaceId)
    expect(after.subscription).toMatchObject({ cancelAtPeriodEnd: true })
  })

  test('SUBS-IMPL-FIX39 an equal-second lifecycle event never revives a terminal record', async () => {
    const account = await createSubscriptionAccount('tie-term', 'cus_tie_term')
    await postSignedWebhook(await fixtureForCustomer('01-invoice-create.json', account.customerId))
    const deleted = await fixtureForCustomer('08-subscription-deleted.json', account.customerId)
    await postSignedWebhook(deleted)

    const staleActive = await fixtureForCustomer(
      '07-subscription-cancel-scheduled.json',
      account.customerId,
    )
    staleActive.id = `evt_zz_stale_active:${account.customerId}`
    staleActive.created = deleted.created
    ;((staleActive.data as Record<string, unknown>).object as Record<string, unknown>)[
      'cancel_at_period_end'
    ] = false
    await postSignedWebhook(staleActive)

    const after = await subscriptionHarnessState(account.user.user._id, account.workspaceId)
    expect(after.subscription).toMatchObject({ status: 'canceled' })
  })

  test('SUBS-IMPL-FIX30 resubscribe after terminal lapse rebinds the new subscription', async () => {
    const account = await createSubscriptionAccount('rebind', 'cus_rebind')
    await postSignedWebhook(await fixtureForCustomer('01-invoice-create.json', account.customerId))
    await postSignedWebhook(
      await fixtureForCustomer('02-subscription-created.json', account.customerId),
    )
    await postSignedWebhook(
      await fixtureForCustomer('08-subscription-deleted.json', account.customerId),
    )
    const lapsed = await subscriptionHarnessState(account.user.user._id, account.workspaceId)
    expect(lapsed.subscription).toMatchObject({ status: 'canceled' })
    expect(lapsed.monthlyCreditBalanceMicroUsd).toBe(0)

    // A resubscribe mints a NEW Stripe subscription; staging delivers its first
    // invoice.paid before customer.subscription.created (320ms apart).
    const offsetSeconds = 35 * 24 * 60 * 60
    const resumeInvoice = await fixtureForCustomer('01-invoice-create.json', account.customerId)
    resumeInvoice.id = `evt_resume_invoice:${account.customerId}`
    resumeInvoice.created = Number(resumeInvoice.created) + offsetSeconds
    const invoiceObject = (resumeInvoice.data as { object: Record<string, unknown> }).object
    invoiceObject.id = 'in_resume_rebind'
    invoiceObject.created = Number(invoiceObject.created) + offsetSeconds
    const parent = invoiceObject.parent as {
      subscription_details: { subscription: string }
    }
    parent.subscription_details.subscription = 'sub_resume_rebind'
    for (const line of (invoiceObject.lines as { data: Array<Record<string, unknown>> }).data) {
      const period = line.period as { start: number; end: number }
      period.start += offsetSeconds
      period.end += offsetSeconds
    }
    await postSignedWebhook(resumeInvoice)

    const resumeCreated = await fixtureForCustomer(
      '02-subscription-created.json',
      account.customerId,
    )
    resumeCreated.id = `evt_resume_created:${account.customerId}`
    resumeCreated.created = Number(resumeCreated.created) + offsetSeconds
    const subscriptionObject = (resumeCreated.data as { object: Record<string, unknown> }).object
    subscriptionObject.id = 'sub_resume_rebind'
    for (const item of (subscriptionObject.items as { data: Array<Record<string, unknown>> })
      .data) {
      item.current_period_start = Number(item.current_period_start) + offsetSeconds
      item.current_period_end = Number(item.current_period_end) + offsetSeconds
    }
    await postSignedWebhook(resumeCreated)

    const resumed = await subscriptionHarnessState(account.user.user._id, account.workspaceId)
    expect(resumed.subscription).toMatchObject({
      stripeSubscriptionId: 'sub_resume_rebind',
      status: 'active',
    })
    expect(resumed.monthlyCreditBalanceMicroUsd).toBe(20_000_000)
    const billing = await accountBilling(account.user.user._id)
    expect(billing.monthlyCreditEpoch).toBe('in_resume_rebind')
  })

  test('SUBS-IMPL-FIX1 resumed lifecycle clears cancellation without a grant or reset', async () => {
    const account = await createSubscriptionAccount('resume', 'cus_resume')
    await postSignedWebhook(await fixtureForCustomer('04-invoice-upgrade.json', account.customerId))
    const canceling = await fixtureForCustomer(
      '07-subscription-cancel-scheduled.json',
      account.customerId,
    )
    await postSignedWebhook(canceling)
    const before = await subscriptionHarnessState(account.user.user._id, account.workspaceId)
    expect(before.subscription).toMatchObject({ cancelAtPeriodEnd: true })

    const resumed = structuredClone(canceling)
    resumed.id = 'evt_subscription_resumed'
    resumed.created = Number(canceling.created) + 1
    ;((resumed.data as Record<string, unknown>).object as Record<string, unknown>)[
      'cancel_at_period_end'
    ] = false
    await postSignedWebhook(resumed)

    const after = await subscriptionHarnessState(account.user.user._id, account.workspaceId)
    expect(after.subscription).toMatchObject({ cancelAtPeriodEnd: false })
    expect(after.monthlyCreditBalanceMicroUsd).toBe(before.monthlyCreditBalanceMicroUsd)
    expect(after.monthlyCreditEpoch).toBe(before.monthlyCreditEpoch)
    expect(after.ledgerReferences).toEqual(before.ledgerReferences)
  })

  test('invoice event replay and a second event id still grant one subscription reset', async () => {
    const account = await createSubscriptionAccount('sub-replay', 'cus_sub_replay')
    const invoice = await fixtureForCustomer('01-invoice-create.json', account.customerId)
    await postSignedWebhook(invoice)
    expect(await postSignedWebhook(invoice)).toEqual({ ok: true, replay: true })
    const wrappedAgain = structuredClone(invoice)
    wrappedAgain.id = 'evt_same_subscription_invoice_again'
    await postSignedWebhook(wrappedAgain)

    expect(
      (await subscriptionLedgerReferences(account.user.user._id)).filter(reference =>
        reference.endsWith('in_1TuCyrKD7CmTYhpWoAKcbcNe'),
      ),
    ).toEqual([
      'subscription_expiry:invoice:in_1TuCyrKD7CmTYhpWoAKcbcNe',
      'subscription_grant:invoice:in_1TuCyrKD7CmTYhpWoAKcbcNe',
    ])
  })

  test('invoice.payment_failed counts only Duet-v2 topup invoices', async () => {
    const workspaceId = await createWorkspace('invoice-payment-failed')
    const topupFailure = invoicePaymentFailedEvent(
      'evt_topup_invoice_failed',
      workspaceId,
      'in_topup_failed',
    )
    const subscriptionFailure = invoicePaymentFailedEvent(
      'evt_subscription_invoice_failed',
      workspaceId,
      'in_subscription_failed',
      'subscription',
    )

    await processWebhook(topupFailure)
    await processWebhook(subscriptionFailure)

    expect(await topupConfig(workspaceId)).toMatchObject({
      consecutiveTopupFailures: 1,
      lastTopupError: { code: 'invoice_payment_failed' },
    })
  })

  test('Stripe webhook credits only the invoice when invoice and payment events both arrive', async () => {
    const workspaceId = await createWorkspace('webhook-shared-payment')
    const startingBalance = await balance(workspaceId)
    const invoice = invoicePaidEvent('evt_invoice_shared', workspaceId, 'in_shared', 2_500)
    const paymentIntent = paymentIntentSucceededEvent(
      'evt_pi_shared',
      workspaceId,
      'pi_shared',
      2_500,
    )

    await processWebhook(invoice)
    await processWebhook(paymentIntent)

    const topupRows = (await listTransactions(workspaceId)).filter(row => row.type === 'topup')
    expect(topupRows).toHaveLength(1)
    expect(topupRows[0]).toMatchObject({
      amountMicroUsd: dollarsToMicroUsd(25),
      reference: 'in_shared',
    })
    expect(await balance(workspaceId)).toBe(startingBalance + dollarsToMicroUsd(25))
  })
  test('Stripe webhook HTTP route verifies the raw signed body and is replay safe', async () => {
    const workspaceId = await createWorkspace('webhook-http-replay')
    const payload = JSON.stringify(
      invoicePaidEvent('evt_http_replay_once', workspaceId, 'in_http_replay_once', 1_200),
    )

    const missingSignature = await fetch(`${convex.siteUrl}/v1/stripe/webhook`, {
      method: 'POST',
      body: payload,
    })
    expect(missingSignature.status).toBe(400)
    expect(await missingSignature.json()).toEqual({ error: 'missing_signature' })

    const invalidSignature = await fetch(`${convex.siteUrl}/v1/stripe/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': 't=123456,v1=bad' },
      body: payload,
    })
    expect(invalidSignature.status).toBe(400)
    expect(await invalidSignature.json()).toEqual({ error: 'invalid_signature' })

    const signature = await createStripeClient().webhooks.generateTestHeaderStringAsync({
      payload,
      secret: STRIPE_WEBHOOK_SECRET,
    })
    const first = await fetch(`${convex.siteUrl}/v1/stripe/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body: payload,
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true })

    const replay = await fetch(`${convex.siteUrl}/v1/stripe/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body: payload,
    })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ ok: true, replay: true })

    const topupRows = (await listTransactions(workspaceId)).filter(row => row.type === 'topup')
    expect(topupRows).toHaveLength(1)
    expect(topupRows[0]).toMatchObject({
      amountMicroUsd: dollarsToMicroUsd(12),
      reference: 'in_http_replay_once',
      metadata: {
        context: { source: 'stripe_webhook', eventId: 'evt_http_replay_once' },
      },
    })
  })

  test('auto-topup invoice uses the pinned Stripe SDK parameters and idempotency options', async () => {
    const calls: Array<{ operation: string; params: unknown; options?: Stripe.RequestOptions }> = []
    const fakeStripe = {
      invoices: {
        create: async (params: Stripe.InvoiceCreateParams, options?: Stripe.RequestOptions) => {
          calls.push({ operation: 'invoice.create', params, options })
          return { id: 'in_fake_sdk', status: 'draft' } as Stripe.Invoice
        },
        finalizeInvoice: async (id: string, params?: Stripe.InvoiceFinalizeInvoiceParams) => {
          calls.push({ operation: 'invoice.finalize', params: { id, ...params } })
          return { id, status: 'open' } as Stripe.Invoice
        },
        pay: async (id: string, params?: Stripe.InvoicePayParams) => {
          calls.push({ operation: 'invoice.pay', params: { id, ...params } })
          return { id, status: 'paid' } as Stripe.Invoice
        },
        voidInvoice: async (id: string) => {
          calls.push({ operation: 'invoice.void', params: { id } })
          return { id, status: 'void' } as Stripe.Invoice
        },
        retrieve: async (id: string) =>
          ({ id, status: 'open', attempted: false }) as Stripe.Invoice,
      },
      invoiceItems: {
        create: async (params: Stripe.InvoiceItemCreateParams, options?: Stripe.RequestOptions) => {
          calls.push({ operation: 'invoiceItem.create', params, options })
          return { id: 'ii_fake_sdk' } as Stripe.InvoiceItem
        },
      },
      paymentMethods: {
        list: async (params: Stripe.PaymentMethodListParams) => {
          calls.push({ operation: 'paymentMethod.list', params })
          return { data: [{ id: 'pm_on_file' }] } as Stripe.ApiList<Stripe.PaymentMethod>
        },
      },
      customers: {
        retrieve: async (id: string, params?: Stripe.CustomerRetrieveParams) => {
          calls.push({ operation: 'customer.retrieve', params: { id, ...params } })
          return { id, invoice_settings: { default_payment_method: null } } as Stripe.Customer
        },
      },
    }

    const result = await createTopupInvoice(fakeStripe, {
      workspaceId: 'workspace_123',
      userId: 'user_123',
      stripeCustomerId: 'cus_fake_sdk',
      amountMicroUsd: dollarsToMicroUsd(12),
      idempotencyKey: 'topup:workspace_123:bucket',
    })

    expect(result).toEqual({
      status: 'paid',
      invoiceId: 'in_fake_sdk',
      paymentAttempted: true,
    })
    expect(calls).toEqual([
      {
        operation: 'invoice.create',
        params: {
          customer: 'cus_fake_sdk',
          auto_advance: false,
          collection_method: 'charge_automatically',
          metadata: {
            source: 'duet',
            type: 'credit_topup',
            workspaceId: 'workspace_123',
            userId: 'user_123',
          },
        },
        options: { idempotencyKey: 'topup:workspace_123:bucket' },
      },
      {
        operation: 'invoiceItem.create',
        params: {
          customer: 'cus_fake_sdk',
          invoice: 'in_fake_sdk',
          amount: 1_200,
          currency: 'usd',
          description: 'Duet credits',
          metadata: {
            source: 'duet',
            type: 'credit_topup',
            workspaceId: 'workspace_123',
            userId: 'user_123',
          },
        },
        options: { idempotencyKey: 'topup:workspace_123:bucket-item' },
      },
      {
        operation: 'invoice.finalize',
        params: { id: 'in_fake_sdk', auto_advance: false },
      },
      // The card is named explicitly: a customer whose card arrived through
      // subscription Checkout has no invoice default for Stripe to fall back on.
      { operation: 'customer.retrieve', params: { id: 'cus_fake_sdk', expand: ['subscriptions'] } },
      { operation: 'paymentMethod.list', params: { customer: 'cus_fake_sdk', limit: 1 } },
      {
        operation: 'invoice.pay',
        params: { id: 'in_fake_sdk', off_session: true, payment_method: 'pm_on_file' },
      },
    ])
  })

  test('an auto-topup charges the card the customer chose as default over a newer one', async () => {
    let paidWith: string | undefined
    const fakeStripe = {
      invoices: {
        create: async () => ({ id: 'in_default', status: 'draft' }) as Stripe.Invoice,
        finalizeInvoice: async () => ({ id: 'in_default', status: 'open' }) as Stripe.Invoice,
        pay: async (id: string, params?: Stripe.InvoicePayParams) => {
          paidWith = params?.payment_method
          return { id, status: 'paid' } as Stripe.Invoice
        },
        voidInvoice: async () => ({ id: 'in_default', status: 'void' }) as Stripe.Invoice,
        retrieve: async (id: string) =>
          ({ id, status: 'open', attempted: false }) as Stripe.Invoice,
      },
      invoiceItems: {
        create: async () => ({ id: 'ii_default' }) as Stripe.InvoiceItem,
      },
      paymentMethods: {
        list: async () =>
          ({ data: [{ id: 'pm_newer' }] }) as unknown as Stripe.ApiList<Stripe.PaymentMethod>,
      },
      customers: {
        retrieve: async () =>
          ({
            id: 'cus_default',
            invoice_settings: { default_payment_method: 'pm_chosen' },
          }) as Stripe.Customer,
      },
    }

    const result = await createTopupInvoice(fakeStripe, {
      workspaceId: 'workspace_123',
      userId: 'user_123',
      stripeCustomerId: 'cus_default',
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: 'topup:workspace_123:default',
    })

    expect(result).toEqual({ status: 'paid', invoiceId: 'in_default', paymentAttempted: true })
    expect(paidWith).toBe('pm_chosen')
  })

  test('a failed payment-method lookup voids the finalized invoice instead of orphaning it', async () => {
    const calls: string[] = []
    const fakeStripe = {
      invoices: {
        create: async () => {
          calls.push('create')
          return { id: 'in_lookup', status: 'draft' } as Stripe.Invoice
        },
        finalizeInvoice: async () => {
          calls.push('finalize')
          return { id: 'in_lookup', status: 'open' } as Stripe.Invoice
        },
        pay: async () => {
          calls.push('pay')
          return { id: 'in_lookup', status: 'paid' } as Stripe.Invoice
        },
        voidInvoice: async () => {
          calls.push('void')
          return { id: 'in_lookup', status: 'void' } as Stripe.Invoice
        },
        retrieve: async (id: string) =>
          ({ id, status: 'open', attempted: false }) as Stripe.Invoice,
      },
      invoiceItems: {
        create: async () => ({ id: 'ii_lookup' }) as Stripe.InvoiceItem,
      },
      paymentMethods: {
        list: async () =>
          ({ data: [{ id: 'pm_on_file' }] }) as unknown as Stripe.ApiList<Stripe.PaymentMethod>,
      },
      customers: {
        retrieve: async () => {
          throw new Stripe.errors.StripeConnectionError({
            type: 'api_error',
            message: 'Fake Stripe network failure',
          })
        },
      },
    }

    const result = await createTopupInvoice(fakeStripe, {
      workspaceId: 'workspace_123',
      userId: 'user_123',
      stripeCustomerId: 'cus_lookup',
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: 'topup:workspace_123:lookup',
    })

    // Stripe was never asked to pay, so no `invoice.payment_failed` webhook will
    // count this failure; the caller has to count it locally or backoff never trips.
    expect(result).toEqual({
      status: 'failed',
      invoiceId: 'in_lookup',
      failureCode: 'stripe_error',
      failureMessage: 'Fake Stripe network failure',
      paymentAttempted: false,
    })
    // The open invoice must not survive: its idempotency bucket never retries.
    expect(calls).toEqual(['create', 'finalize', 'void'])
  })

  test('an auto-topup charges the subscription card over a card attached by a later one-time top-up', async () => {
    let paidWith: string | undefined
    const fakeStripe = {
      invoices: {
        create: async () => ({ id: 'in_sub', status: 'draft' }) as Stripe.Invoice,
        finalizeInvoice: async () => ({ id: 'in_sub', status: 'open' }) as Stripe.Invoice,
        pay: async (id: string, params?: Stripe.InvoicePayParams) => {
          paidWith = params?.payment_method
          return { id, status: 'paid' } as Stripe.Invoice
        },
        voidInvoice: async () => ({ id: 'in_sub', status: 'void' }) as Stripe.Invoice,
        retrieve: async (id: string) =>
          ({ id, status: 'open', attempted: false }) as Stripe.Invoice,
      },
      invoiceItems: {
        create: async () => ({ id: 'ii_sub' }) as Stripe.InvoiceItem,
      },
      paymentMethods: {
        list: async () =>
          ({ data: [{ id: 'pm_one_time' }] }) as unknown as Stripe.ApiList<Stripe.PaymentMethod>,
      },
      customers: {
        retrieve: async () =>
          ({
            id: 'cus_sub',
            invoice_settings: { default_payment_method: null },
            subscriptions: { data: [{ default_payment_method: 'pm_subscription' }] },
          }) as unknown as Stripe.Customer,
      },
    }

    const result = await createTopupInvoice(fakeStripe, {
      workspaceId: 'workspace_123',
      userId: 'user_123',
      stripeCustomerId: 'cus_sub',
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: 'topup:workspace_123:sub',
    })

    expect(result).toEqual({ status: 'paid', invoiceId: 'in_sub', paymentAttempted: true })
    expect(paidWith).toBe('pm_subscription')
  })

  test('a pay call that never reaches Stripe is not counted by the webhook', async () => {
    const calls: string[] = []
    const fakeStripe = {
      invoices: {
        create: async () => {
          calls.push('create')
          return { id: 'in_transport', status: 'draft' } as Stripe.Invoice
        },
        finalizeInvoice: async () => {
          calls.push('finalize')
          return { id: 'in_transport', status: 'open' } as Stripe.Invoice
        },
        pay: async () => {
          calls.push('pay')
          throw new Stripe.errors.StripeConnectionError({
            type: 'api_error',
            message: 'Fake Stripe socket hang up',
          })
        },
        voidInvoice: async () => {
          calls.push('void')
          return { id: 'in_transport', status: 'void' } as Stripe.Invoice
        },
        retrieve: async () => {
          calls.push('retrieve')
          return { id: 'in_transport', status: 'open', attempted: false } as Stripe.Invoice
        },
      },
      invoiceItems: {
        create: async () => ({ id: 'ii_transport' }) as Stripe.InvoiceItem,
      },
      paymentMethods: {
        list: async () =>
          ({ data: [{ id: 'pm_on_file' }] }) as unknown as Stripe.ApiList<Stripe.PaymentMethod>,
      },
      customers: {
        retrieve: async () =>
          ({
            id: 'cus_transport',
            invoice_settings: { default_payment_method: null },
          }) as Stripe.Customer,
      },
    }

    const result = await createTopupInvoice(fakeStripe, {
      workspaceId: 'workspace_123',
      userId: 'user_123',
      stripeCustomerId: 'cus_transport',
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: 'topup:workspace_123:transport',
    })

    // Stripe ran no payment attempt, so no `invoice.payment_failed` follows.
    expect(result).toEqual({
      status: 'failed',
      invoiceId: 'in_transport',
      failureCode: 'stripe_error',
      failureMessage: 'Fake Stripe socket hang up',
      paymentAttempted: false,
    })
    expect(calls).toEqual(['create', 'finalize', 'pay', 'retrieve', 'void'])
  })

  test('an ambiguous pay error defers to the invoice: an attempt Stripe ran is webhook-counted', async () => {
    const calls: string[] = []
    const fakeStripe = {
      invoices: {
        create: async () => ({ id: 'in_lost', status: 'draft' }) as Stripe.Invoice,
        finalizeInvoice: async () => ({ id: 'in_lost', status: 'open' }) as Stripe.Invoice,
        pay: async () => {
          calls.push('pay')
          throw new Stripe.errors.StripeConnectionError({
            type: 'api_error',
            message: 'Fake Stripe response lost',
          })
        },
        voidInvoice: async () => {
          calls.push('void')
          return { id: 'in_lost', status: 'void' } as Stripe.Invoice
        },
        retrieve: async () => {
          calls.push('retrieve')
          return { id: 'in_lost', status: 'open', attempted: true } as Stripe.Invoice
        },
      },
      invoiceItems: {
        create: async () => ({ id: 'ii_lost' }) as Stripe.InvoiceItem,
      },
      paymentMethods: {
        list: async () =>
          ({ data: [{ id: 'pm_on_file' }] }) as unknown as Stripe.ApiList<Stripe.PaymentMethod>,
      },
      customers: {
        retrieve: async () =>
          ({
            id: 'cus_lost',
            invoice_settings: { default_payment_method: null },
          }) as Stripe.Customer,
      },
    }

    const result = await createTopupInvoice(fakeStripe, {
      workspaceId: 'workspace_123',
      userId: 'user_123',
      stripeCustomerId: 'cus_lost',
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: 'topup:workspace_123:lost',
    })

    expect(result).toEqual({
      status: 'failed',
      invoiceId: 'in_lost',
      failureCode: 'stripe_error',
      failureMessage: 'Fake Stripe response lost',
      paymentAttempted: true,
    })
    expect(calls).toEqual(['pay', 'retrieve', 'void'])
  })

  test('an ambiguous pay error defers to the invoice: a payment that went through is paid', async () => {
    const calls: string[] = []
    const fakeStripe = {
      invoices: {
        create: async () => ({ id: 'in_landed', status: 'draft' }) as Stripe.Invoice,
        finalizeInvoice: async () => ({ id: 'in_landed', status: 'open' }) as Stripe.Invoice,
        pay: async () => {
          calls.push('pay')
          throw new Stripe.errors.StripeConnectionError({
            type: 'api_error',
            message: 'Fake Stripe response lost',
          })
        },
        voidInvoice: async () => {
          calls.push('void')
          throw new Error('void must not be called on a paid invoice')
        },
        retrieve: async () => {
          calls.push('retrieve')
          return { id: 'in_landed', status: 'paid', attempted: true } as Stripe.Invoice
        },
      },
      invoiceItems: {
        create: async () => ({ id: 'ii_landed' }) as Stripe.InvoiceItem,
      },
      paymentMethods: {
        list: async () =>
          ({ data: [{ id: 'pm_on_file' }] }) as unknown as Stripe.ApiList<Stripe.PaymentMethod>,
      },
      customers: {
        retrieve: async () =>
          ({
            id: 'cus_landed',
            invoice_settings: { default_payment_method: null },
          }) as Stripe.Customer,
      },
    }

    const result = await createTopupInvoice(fakeStripe, {
      workspaceId: 'workspace_123',
      userId: 'user_123',
      stripeCustomerId: 'cus_landed',
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: 'topup:workspace_123:landed',
    })

    expect(result).toEqual({ status: 'paid', invoiceId: 'in_landed', paymentAttempted: true })
    expect(calls).toEqual(['pay', 'retrieve'])
  })

  test('an auto-topup with no card on file voids the invoice instead of charging', async () => {
    const calls: string[] = []
    const fakeStripe = {
      invoices: {
        create: async () => {
          calls.push('create')
          return { id: 'in_no_card', status: 'draft' } as Stripe.Invoice
        },
        finalizeInvoice: async () => {
          calls.push('finalize')
          return { id: 'in_no_card', status: 'open' } as Stripe.Invoice
        },
        pay: async () => {
          calls.push('pay')
          return { id: 'in_no_card', status: 'paid' } as Stripe.Invoice
        },
        voidInvoice: async () => {
          calls.push('void')
          return { id: 'in_no_card', status: 'void' } as Stripe.Invoice
        },
        retrieve: async (id: string) =>
          ({ id, status: 'open', attempted: false }) as Stripe.Invoice,
      },
      invoiceItems: {
        create: async () => ({ id: 'ii_no_card' }) as Stripe.InvoiceItem,
      },
      paymentMethods: {
        list: async () => ({ data: [] }) as unknown as Stripe.ApiList<Stripe.PaymentMethod>,
      },
      customers: {
        retrieve: async () =>
          ({
            id: 'cus_no_card',
            invoice_settings: { default_payment_method: null },
          }) as Stripe.Customer,
      },
    }

    const result = await createTopupInvoice(fakeStripe, {
      workspaceId: 'workspace_123',
      userId: 'user_123',
      stripeCustomerId: 'cus_no_card',
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: 'topup:workspace_123:no-card',
    })

    expect(result).toEqual({
      status: 'failed',
      invoiceId: 'in_no_card',
      failureCode: 'no_payment_method',
      failureMessage: 'No payment method is attached to this Stripe customer.',
      paymentAttempted: false,
    })
    expect(calls).toEqual(['create', 'finalize', 'void'])
  })

  test('a failed auto-topup invoice is voided once and a new key creates a new invoice', async () => {
    const calls: string[] = []
    let sequence = 0
    const fakeStripe = {
      invoices: {
        create: async () => {
          sequence += 1
          const id = `in_failed_${sequence}`
          calls.push(`create:${id}`)
          return { id, status: 'draft' } as Stripe.Invoice
        },
        finalizeInvoice: async (id: string) => {
          calls.push(`finalize:${id}`)
          return { id, status: 'open' } as Stripe.Invoice
        },
        pay: async (id: string) => {
          calls.push(`pay:${id}`)
          throw new Stripe.errors.StripeCardError({
            type: 'card_error',
            code: 'card_declined',
            message: 'Card declined',
          })
        },
        voidInvoice: async (id: string) => {
          calls.push(`void:${id}`)
          return { id, status: 'void' } as Stripe.Invoice
        },
        retrieve: async (id: string) =>
          ({ id, status: 'open', attempted: false }) as Stripe.Invoice,
      },
      invoiceItems: {
        create: async (params: Stripe.InvoiceItemCreateParams) => {
          calls.push(`item:${params.invoice}`)
          return { id: `ii_${params.invoice}` } as Stripe.InvoiceItem
        },
      },
      paymentMethods: {
        list: async () =>
          ({ data: [{ id: 'pm_on_file' }] }) as unknown as Stripe.ApiList<Stripe.PaymentMethod>,
      },
      customers: {
        retrieve: async () =>
          ({
            id: 'cus_failed',
            invoice_settings: { default_payment_method: null },
          }) as Stripe.Customer,
      },
    }

    const first = await createTopupInvoice(fakeStripe, {
      workspaceId: 'workspace_123',
      userId: 'user_123',
      stripeCustomerId: 'cus_declined',
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: 'topup:user_123:100',
    })
    const nextWindow = await createTopupInvoice(fakeStripe, {
      workspaceId: 'workspace_123',
      userId: 'user_123',
      stripeCustomerId: 'cus_declined',
      amountMicroUsd: dollarsToMicroUsd(20),
      idempotencyKey: 'topup:user_123:101',
    })

    expect(first).toMatchObject({
      status: 'failed',
      invoiceId: 'in_failed_1',
      failureCode: 'card_declined',
      // A card decline is a payment attempt Stripe ran and will report.
      paymentAttempted: true,
    })
    expect(nextWindow).toMatchObject({
      status: 'failed',
      invoiceId: 'in_failed_2',
      failureCode: 'card_declined',
    })
    expect(calls).toEqual([
      'create:in_failed_1',
      'item:in_failed_1',
      'finalize:in_failed_1',
      'pay:in_failed_1',
      'void:in_failed_1',
      'create:in_failed_2',
      'item:in_failed_2',
      'finalize:in_failed_2',
      'pay:in_failed_2',
      'void:in_failed_2',
    ])
  })

  test('hosted Stripe sessions keep setup, top-up metadata, and portal return ownership explicit', async () => {
    const checkoutCalls: Array<{
      params: Stripe.Checkout.SessionCreateParams
      options?: Stripe.RequestOptions
    }> = []
    const portalCalls: Stripe.BillingPortal.SessionCreateParams[] = []
    const fakeStripe = {
      customers: { create: async () => ({ id: 'cus_unused' }) as Stripe.Customer },
      checkout: {
        sessions: {
          create: async (
            params: Stripe.Checkout.SessionCreateParams,
            options?: Stripe.RequestOptions,
          ) => {
            checkoutCalls.push({ params, options })
            return {
              id: 'cs_test',
              url: 'https://checkout.stripe.com/test',
            } as Stripe.Checkout.Session
          },
        },
      },
      billingPortal: {
        sessions: {
          create: async (params: Stripe.BillingPortal.SessionCreateParams) => {
            portalCalls.push(params)
            return {
              id: 'bps_test',
              url: 'https://billing.stripe.com/test',
            } as Stripe.BillingPortal.Session
          },
        },
      },
    }

    await createBillingCheckout(fakeStripe, {
      customerId: 'cus_payer',
      workspaceId: 'workspace_123',
      userId: 'user_payer',
      successUrl: 'https://app.duet.so/settings/billing?billing=success',
      cancelUrl: 'https://app.duet.so/settings/billing?billing=cancelled',
    })
    await createBillingCheckout(fakeStripe, {
      customerId: 'cus_payer',
      workspaceId: 'workspace_123',
      userId: 'user_payer',
      successUrl: 'https://app.duet.so/settings/billing?billing=success',
      cancelUrl: 'https://app.duet.so/settings/billing?billing=cancelled',
      amountMicroUsd: dollarsToMicroUsd(25),
    })
    await createBillingPortal(fakeStripe, {
      customerId: 'cus_payer',
      returnUrl: 'https://app.duet.so/settings/billing',
      configurationId: 'bpc_duet',
    })

    expect(checkoutCalls[0]?.params).toMatchObject({
      mode: 'setup',
      currency: 'usd',
      customer: 'cus_payer',
      setup_intent_data: {
        metadata: {
          source: 'duet',
          type: 'payment_method_setup',
          workspaceId: 'workspace_123',
          userId: 'user_payer',
        },
      },
    })
    expect(checkoutCalls[1]?.params).toMatchObject({
      mode: 'payment',
      customer: 'cus_payer',
      line_items: [{ price_data: { unit_amount: 2500 } }],
      payment_intent_data: {
        setup_future_usage: 'off_session',
        metadata: {
          source: 'duet',
          type: 'credit_topup',
          workspaceId: 'workspace_123',
          userId: 'user_payer',
        },
      },
      invoice_creation: {
        enabled: true,
        invoice_data: {
          metadata: {
            source: 'duet',
            type: 'credit_topup_manual',
            workspaceId: 'workspace_123',
            userId: 'user_payer',
          },
        },
      },
    })
    expect(portalCalls).toEqual([
      {
        customer: 'cus_payer',
        return_url: 'https://app.duet.so/settings/billing',
        configuration: 'bpc_duet',
      },
    ])
  })

  test('subscription Stripe calls pin checkout metadata, immediate invoice upgrades, scheduled downgrades, and period-end cancel', async () => {
    const checkoutCalls: Array<{
      params: Stripe.Checkout.SessionCreateParams
      options?: Stripe.RequestOptions
    }> = []
    const subscriptionUpdates: Array<{
      id: string
      params: Stripe.SubscriptionUpdateParams
      options?: Stripe.RequestOptions
    }> = []
    const scheduleCreates: Array<{
      params: Stripe.SubscriptionScheduleCreateParams
      options?: Stripe.RequestOptions
    }> = []
    const scheduleUpdates: Array<{
      id: string
      params: Stripe.SubscriptionScheduleUpdateParams
      options?: Stripe.RequestOptions
    }> = []
    const scheduleReleases: Array<{
      id: string
      params?: Stripe.SubscriptionScheduleReleaseParams
      options?: Stripe.RequestOptions
    }> = []
    const fakeStripe = {
      checkout: {
        sessions: {
          create: async (
            params: Stripe.Checkout.SessionCreateParams,
            options?: Stripe.RequestOptions,
          ) => {
            checkoutCalls.push({ params, options })
            return {
              id: 'cs_subscription',
              url: 'https://checkout.stripe.test/sub',
            } as Stripe.Checkout.Session
          },
        },
      },
      subscriptions: {
        update: async (
          id: string,
          params: Stripe.SubscriptionUpdateParams,
          options?: Stripe.RequestOptions,
        ) => {
          subscriptionUpdates.push({ id, params, options })
          return { id } as Stripe.Subscription
        },
      },
      subscriptionSchedules: {
        create: async (
          params: Stripe.SubscriptionScheduleCreateParams,
          options?: Stripe.RequestOptions,
        ) => {
          scheduleCreates.push({ params, options })
          return {
            id: 'sub_sched_1',
            current_phase: { start_date: 100, end_date: 200 },
            phases: [
              {
                start_date: 100,
                end_date: 200,
                items: [{ price: 'price_pro', quantity: 1 }],
              },
            ],
          } as unknown as Stripe.SubscriptionSchedule
        },
        update: async (
          id: string,
          params: Stripe.SubscriptionScheduleUpdateParams,
          options?: Stripe.RequestOptions,
        ) => {
          scheduleUpdates.push({ id, params, options })
          return { id } as Stripe.SubscriptionSchedule
        },
        retrieve: async (id: string) => ({ id }) as Stripe.SubscriptionSchedule,
        release: async (
          id: string,
          params?: Stripe.SubscriptionScheduleReleaseParams,
          options?: Stripe.RequestOptions,
        ) => {
          scheduleReleases.push({ id, params, options })
          return { id } as Stripe.SubscriptionSchedule
        },
      },
    }

    for (const [plan, priceId] of [
      ['starter', 'price_starter'],
      ['pro', 'price_pro'],
      ['max', 'price_max'],
    ] as const) {
      await createSubscriptionCheckout(fakeStripe, {
        customerId: 'cus_payer',
        userId: 'user_payer',
        priceId,
        successUrl: `https://app.duet.so/settings/billing?plan=${plan}&billing=success`,
        cancelUrl: 'https://app.duet.so/settings/billing?billing=cancelled',
        idempotencyKey: `subscription-checkout:user_payer:${plan}`,
      })
    }
    await changeSubscriptionPlan(fakeStripe, {
      subscriptionId: 'sub_1',
      itemId: 'si_1',
      newPriceId: 'price_pro',
      direction: 'upgrade',
      idempotencyKey: 'subscription-plan:sub_1:pro',
    })
    await changeSubscriptionPlan(fakeStripe, {
      subscriptionId: 'sub_1',
      itemId: 'si_1',
      newPriceId: 'price_starter',
      direction: 'downgrade',
      idempotencyKey: 'subscription-plan:sub_1:starter',
    })
    await cancelSubscriptionAtPeriodEnd(fakeStripe, {
      subscriptionId: 'sub_1',
      idempotencyKey: 'subscription-plan:sub_1:cancel',
    })
    await resumeSubscription(fakeStripe, {
      subscriptionId: 'sub_1',
      idempotencyKey: 'subscription-plan:sub_1:resume',
    })
    await cancelPendingSubscriptionPlanChange(fakeStripe, {
      scheduleId: 'sub_sched_pending',
      idempotencyKey: 'subscription-plan:sub_1:evt_2:pro:release',
    })

    expect(checkoutCalls).toEqual(
      ['starter', 'pro', 'max'].map(plan => ({
        params: {
          mode: 'subscription',
          customer: 'cus_payer',
          payment_method_collection: 'if_required',
          success_url: expect.stringContaining('billing=success'),
          cancel_url: 'https://app.duet.so/settings/billing?billing=cancelled',
          line_items: [{ price: `price_${plan}`, quantity: 1 }],
          subscription_data: {
            metadata: { source: 'duet', type: 'subscription', userId: 'user_payer' },
          },
        },
        options: { idempotencyKey: `subscription-checkout:user_payer:${plan}` },
      })),
    )
    expect(subscriptionUpdates).toEqual([
      {
        id: 'sub_1',
        params: {
          items: [{ id: 'si_1', price: 'price_pro' }],
          proration_behavior: 'always_invoice',
        },
        options: { idempotencyKey: 'subscription-plan:sub_1:pro' },
      },
      {
        id: 'sub_1',
        params: { cancel_at_period_end: true },
        options: { idempotencyKey: 'subscription-plan:sub_1:cancel' },
      },
      {
        id: 'sub_1',
        params: { cancel_at_period_end: false },
        options: { idempotencyKey: 'subscription-plan:sub_1:resume' },
      },
    ])
    expect(scheduleCreates).toEqual([
      {
        params: { from_subscription: 'sub_1' },
        options: { idempotencyKey: 'subscription-plan:sub_1:starter:schedule' },
      },
    ])
    expect(scheduleUpdates).toEqual([
      {
        id: 'sub_sched_1',
        params: {
          end_behavior: 'release',
          phases: [
            {
              start_date: 100,
              end_date: 200,
              items: [{ price: 'price_pro', quantity: 1 }],
            },
            { start_date: 200, items: [{ price: 'price_starter', quantity: 1 }] },
          ],
        },
        options: { idempotencyKey: 'subscription-plan:sub_1:starter:update' },
      },
    ])
    expect(scheduleReleases).toEqual([
      {
        id: 'sub_sched_pending',
        params: {},
        options: { idempotencyKey: 'subscription-plan:sub_1:evt_2:pro:release' },
      },
    ])
  })

  test('a customer created for canceled Checkout is not a ready payment method until a verified success webhook', async () => {
    const checkoutPayer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('checkout-readiness'),
      'Checkout Readiness',
    )
    await mutate(
      checkoutPayer.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const workspaceId = (await mutate(
      checkoutPayer.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('checkout-readiness'),
        name: 'Checkout readiness workspace',
      },
    )) as string
    await mutate(convex, 'domains/credits/internal:setTopupConfig', {
      internalKey: INTERNAL_KEY,
      actorId: checkoutPayer.user._id,
      workspaceId,
      stripeCustomerId: 'cus_checkout_readiness',
    })

    expect(await userBillingOverview(checkoutPayer.user._id)).toMatchObject({
      hasPaymentMethod: false,
    })
    expect(await billingSessionAccount(checkoutPayer.user._id, workspaceId)).toMatchObject({
      paymentMethodReady: false,
    })

    await processWebhook({
      id: 'evt_setup_intent_ready',
      type: 'setup_intent.succeeded',
      data: {
        object: {
          id: 'seti_ready',
          customer: 'cus_checkout_readiness',
          metadata: {
            source: 'duet',
            type: 'payment_method_setup',
            workspaceId,
            userId: checkoutPayer.user._id,
          },
        },
      },
    })

    expect(await userBillingOverview(checkoutPayer.user._id)).toMatchObject({
      hasPaymentMethod: true,
    })
    expect(await billingSessionAccount(checkoutPayer.user._id, workspaceId)).toMatchObject({
      paymentMethodReady: true,
    })
  })

  test('daily rollups survive concurrent ledger usage writes and monthly reports match the cap counter', async () => {
    const workspaceId = await createWorkspace('rollup-concurrent')
    await grant(workspaceId, dollarsToMicroUsd(10), 'grant:rollup')
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        charge(workspaceId, dollarsToMicroUsd(0.25), `usage:rollup:${index}`, {
          inputTokens: 10,
          outputTokens: 4,
        }),
      ),
    )

    await waitForReport(workspaceId, 'daily', 'workspace', dollarsToMicroUsd(2))
    const monthly = await waitForReport(workspaceId, 'monthly', 'workspace', dollarsToMicroUsd(2))
    const decision = await preflight(workspaceId)
    expect(decision.accountMonthlySpendMicroUsd).toBe(dollarsToMicroUsd(2))
    expect(decision.workspaceMonthlySpendMicroUsd).toBe(dollarsToMicroUsd(2))
    expect(monthly[0]).toMatchObject({
      spendMicroUsd: dollarsToMicroUsd(2),
      inputTokens: 80,
      outputTokens: 32,
    })
  })

  test('one charge folds into daily, weekly, and monthly rows keyed by the same instant', async () => {
    const workspaceId = await createWorkspace('rollup-weekly')
    await grant(workspaceId, dollarsToMicroUsd(10), 'grant:rollup-weekly')
    // Monday 2024-12-30 is ISO week 2025-W01: the weekly key rolls into the next
    // year while the daily and monthly keys stay in 2024. Pinning the instant
    // keeps the three keys exact instead of racing the wall clock past midnight.
    const chargedAt = Date.UTC(2024, 11, 30, 12)
    await charge(
      workspaceId,
      dollarsToMicroUsd(0.5),
      'usage:rollup-weekly',
      { inputTokens: 30, outputTokens: 12 },
      chargedAt,
    )

    const weekly = await waitForReport(workspaceId, 'weekly', 'workspace', dollarsToMicroUsd(0.5))
    expect(weekly).toEqual([
      expect.objectContaining({
        period: '2025-W01',
        spendMicroUsd: dollarsToMicroUsd(0.5),
        inputTokens: 30,
        outputTokens: 12,
      }),
    ])
    expect(currentWeekKey(chargedAt)).toBe('2025-W01')
    // Every granularity sees the same charge once: the fold adds a period, not a
    // reattribution, so all three totals equal the single charge.
    const daily = await waitForReport(workspaceId, 'daily', 'workspace', dollarsToMicroUsd(0.5))
    const monthly = await waitForReport(workspaceId, 'monthly', 'workspace', dollarsToMicroUsd(0.5))
    expect([daily[0]?.period, monthly[0]?.period]).toEqual(['2024-12-30', '2024-12'])
  })

  test('one usage settlement schedules one rollup job for all granularities', async () => {
    const workspaceId = await createWorkspace('rollup-scheduled-job')
    const scheduledCount = await mutate(convex, 'testing/credits:scheduleUsageRollupForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      spendMicroUsd: dollarsToMicroUsd(0.5),
      createdAt: Date.UTC(2024, 11, 30, 12),
      userId: owner.user._id,
      dimensions: { inputTokens: 30, outputTokens: 12 },
    })

    expect(scheduledCount).toBe(1)
  })

  test('usage reports attribute spend by API-key user and by app', async () => {
    const workspaceId = await createWorkspace('report-attribution')
    await grant(workspaceId, dollarsToMicroUsd(10), 'grant:attribution')
    await charge(workspaceId, dollarsToMicroUsd(0.75), 'usage:attribution', {
      appSlug: 'field-tools',
    })

    const userRows = await waitForReport(workspaceId, 'monthly', 'user', dollarsToMicroUsd(0.75))
    expect(userRows).toContainEqual(
      expect.objectContaining({ userId: owner.user._id, spendMicroUsd: dollarsToMicroUsd(0.75) }),
    )
    const appRows = await waitForReport(workspaceId, 'monthly', 'app', dollarsToMicroUsd(0.75))
    expect(appRows).toContainEqual(
      expect.objectContaining({ appSlug: 'field-tools', spendMicroUsd: dollarsToMicroUsd(0.75) }),
    )
  })

  test('usage reports apply group filtering before the read cap', async () => {
    const workspaceId = await createWorkspace('report-group-cap')
    // Bulk seam: the fixture is a thousand distinct periods, not a thousand
    // individually committed round trips (~40ms each — this loop alone was
    // most of the file's wall time).
    for (let start = 0; start < 1000; start += 250) {
      await mutate(convex, 'testing/credits:applyUsageRollupRunForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        count: 250,
        startIndex: start,
      })
    }
    await mutate(convex, 'domains/credits/internal:applyUsageRollupBatch', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      periodKeys: { daily: '2027-9999', weekly: '2027-W01', monthly: '2027-01' },
      spendMicroUsd: 7,
      appSlug: 'late-app',
    })

    expect(await usageReport(workspaceId, 'daily', 'app')).toEqual([
      expect.objectContaining({ period: '2027-9999', appSlug: 'late-app', spendMicroUsd: 7 }),
    ])
  }, 120_000)

  test('workspace spend cap blocks at the limit using the same counter the ledger preflight reads', async () => {
    const workspaceId = await createWorkspace('cap-limit')
    await grant(workspaceId, dollarsToMicroUsd(10), 'grant:cap-limit')
    await mutate(convex, 'domains/credits/internal:setMonthlyCap', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      maxMonthlySpendMicroUsd: dollarsToMicroUsd(1),
    })
    await charge(workspaceId, dollarsToMicroUsd(1), 'usage:cap-limit')

    await waitForReport(workspaceId, 'monthly', 'workspace', dollarsToMicroUsd(1))
    expect(await preflight(workspaceId)).toMatchObject({
      proceed: false,
      reason: 'monthly_cap',
      tier: 'workspace',
      workspaceMonthlySpendMicroUsd: dollarsToMicroUsd(1),
      workspaceMonthlyCapMicroUsd: dollarsToMicroUsd(1),
    })
  })

  test('retention prunes daily rows older than 13 months and keeps coarser rows forever', async () => {
    const workspaceId = await createWorkspace('retention')
    // Same instant in 2024, written at all three granularities.
    await mutate(convex, 'domains/credits/internal:applyUsageRollupBatch', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      periodKeys: { daily: '2024-01-01', weekly: '2024-W01', monthly: '2024-01' },
      spendMicroUsd: dollarsToMicroUsd(1),
      now: Date.UTC(2024, 0, 1),
    })
    await mutate(convex, 'domains/credits/internal:pruneDailyUsage', {
      internalKey: INTERNAL_KEY,
      now: Date.UTC(2025, 3, 15),
    })

    expect(await usageReport(workspaceId, 'daily', 'workspace')).toEqual([])
    expect(await usageReport(workspaceId, 'weekly', 'workspace')).toEqual([
      expect.objectContaining({ period: '2024-W01', spendMicroUsd: dollarsToMicroUsd(1) }),
    ])
    expect(await usageReport(workspaceId, 'monthly', 'workspace')).toEqual([
      expect.objectContaining({ period: '2024-01', spendMicroUsd: dollarsToMicroUsd(1) }),
    ])
  })
})

async function createWorkspace(prefix: string): Promise<string> {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  return (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: uniqueSlug(prefix),
    name: `${prefix} workspace`,
  })) as string
}

async function createTopupPolicyFixture(prefix: string, subscribed: boolean) {
  const user = await signInWithMagicLink<UserRow>(convex, uniqueEmail(prefix), prefix)
  const now = Date.now()
  if (subscribed) {
    await mutate(
      user.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, now },
    )
  }
  const rows = (await query(user.client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: { _id: string }
  }>
  const workspaceId = rows[0]!.workspace._id
  await mutate(convex, 'domains/credits/internal:setTopupConfig', {
    internalKey: INTERNAL_KEY,
    actorId: user.user._id,
    workspaceId,
    stripeCustomerId: `cus_${prefix}`,
    autoTopupEnabled: true,
  })
  return { user, workspaceId, now }
}

async function scheduledTopupCount(): Promise<number> {
  const rows = (await query(convex, 'testing/credits:listScheduledCreditFunctionsForTest', {
    internalKey: INTERNAL_KEY,
  })) as Array<{ name: string }>
  return rows.filter(row => row.name === 'domains/credits/actions.js:attemptTopup').length
}

async function configureBilling(
  workspaceId: string,
  config: Record<string, unknown>,
): Promise<void> {
  await mutate(convex, 'domains/credits/internal:setTopupConfig', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    workspaceId,
    ...config,
  })
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

async function charge(
  workspaceId: string,
  amountMicroUsd: number,
  reference: string,
  metadata?: Record<string, unknown>,
  now?: number,
): Promise<void> {
  await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    userId: owner.user._id,
    amountMicroUsd: -amountMicroUsd,
    type: 'usage',
    reference,
    metadata,
    usageRollup: metadata,
    now,
  })
}

async function processWebhook(event: Record<string, unknown>): Promise<void> {
  await mutate(convex, 'domains/credits/internal:processStripeWebhookEvent', {
    internalKey: INTERNAL_KEY,
    eventId: event.id,
    eventCreatedAt: event.created ?? 0,
    type: event.type,
    object: (event.data as Record<string, unknown>).object,
  })
}

async function postSignedWebhook(event: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await signedWebhookResponse(event)
  if (response.status !== 200) {
    throw new Error(`Webhook failed (${response.status}): ${await response.text()}`)
  }
  return (await response.json()) as Record<string, unknown>
}

async function signedWebhookResponse(event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event)
  const signature = await createStripeClient().webhooks.generateTestHeaderStringAsync({
    payload,
    secret: STRIPE_WEBHOOK_SECRET,
  })
  return await fetch(`${convex.siteUrl}/v1/stripe/webhook`, {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: payload,
  })
}

async function stripeFixture(name: string): Promise<Record<string, unknown>> {
  return (await Bun.file(
    join(BACKEND_DIR, 'test-fixtures/stripe-subscriptions', name),
  ).json()) as Record<string, unknown>
}

async function fixtureForCustomer(
  name: string,
  customerId: string,
): Promise<Record<string, unknown>> {
  const event = await stripeFixture(name)
  event.id = `${String(event.id)}:${customerId}`
  const object = (event.data as { object: Record<string, unknown> }).object
  object.customer = customerId
  if (name === '06-subscription-downgrade-scheduled.json') {
    object.schedule = subscriptionScheduleFixture(object)
  }
  return event
}

function subscriptionScheduleFixture(subscription: Record<string, unknown>) {
  const items = (subscription.items as { data: Array<{ current_period_end: number }> }).data
  return {
    phases: [
      {
        start_date: items[0]!.current_period_end,
        items: [{ price: 'price_1TuClpKD7CmTYhpWZ0BCQ6jy' }],
      },
    ],
  }
}

async function createSubscriptionAccount(prefix: string, customerId: string) {
  const user = await signInWithMagicLink<UserRow>(
    convex,
    uniqueEmail(`billing-${prefix}`),
    `Billing ${prefix}`,
  )
  const rows = (await query(user.client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: { _id: string }
  }>
  const workspaceId = rows[0]!.workspace._id
  await mutate(convex, 'domains/credits/internal:setTopupConfig', {
    internalKey: INTERNAL_KEY,
    actorId: user.user._id,
    workspaceId,
    stripeCustomerId: customerId,
  })
  return { user, workspaceId, customerId }
}

async function createDiskWorkspace(
  client: ConvexHttpClient,
  prefix: string,
  vmDiskGb: number,
): Promise<string> {
  const workspaceId = (await mutate(client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: uniqueSlug(prefix),
    name: `${prefix} workspace`,
  })) as string
  await markDiskWorkspaceLive(workspaceId, vmDiskGb)
  return workspaceId
}

async function markDiskWorkspaceLive(workspaceId: string, vmDiskGb: number): Promise<void> {
  await mutate(convex, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    vmDiskGb,
    now: Date.now(),
  })
}

async function resizeScheduleEventCount(
  client: ConvexHttpClient,
  workspaceId: string,
): Promise<number> {
  const events = (await query(client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as Array<{ event: string }>
  return events.filter(event => event.event === 'workspace.vm_disk_resize_scheduled').length
}

async function accountBilling(userId: string): Promise<Record<string, unknown>> {
  return (await query(convex, 'testing/credits:userBillingForTest', {
    internalKey: INTERNAL_KEY,
    userId,
  })) as Record<string, unknown>
}

async function subscriptionHarnessState(
  userId: string,
  workspaceId: string,
): Promise<SubscriptionHarnessState> {
  const billing = await accountBilling(userId)
  const balances = await wallet(workspaceId)
  const transactions = (await query(convex, 'testing/credits:listAccountTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    userId,
  })) as LedgerRow[]
  const subscription = structuredClone(billing.subscription ?? {}) as Record<string, unknown>
  if (typeof subscription.latestLifecycleEventId === 'string') {
    subscription.latestLifecycleEventId = subscription.latestLifecycleEventId.replace(
      /:perm-\d+$/,
      '',
    )
  }
  return {
    subscription,
    paidCreditBalanceMicroUsd: balances.paidCreditBalanceMicroUsd as number,
    monthlyCreditBalanceMicroUsd: balances.monthlyCreditBalanceMicroUsd as number,
    monthlyCreditEpoch: billing.monthlyCreditEpoch as string,
    ledgerReferences: transactions
      .filter(row => row.reference.startsWith('subscription_'))
      .map(row => row.reference)
      .sort(),
  }
}

async function subscriptionLedgerReferences(userId: string): Promise<string[]> {
  const rows = (await query(convex, 'testing/credits:listAccountTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    userId,
  })) as LedgerRow[]
  return rows
    .map(row => row.reference)
    .filter(reference => reference.startsWith('subscription_'))
    .sort()
}

async function waitForReport(
  workspaceId: string,
  period: UsageReportPeriod,
  group: UsageReportGroup,
  expectedSpendMicroUsd: number,
): Promise<UsageRow[]> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const rows = await usageReport(workspaceId, period, group)
    const total = rows.reduce((sum, row) => sum + row.spendMicroUsd, 0)
    if (total === expectedSpendMicroUsd) return rows
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return usageReport(workspaceId, period, group)
}

async function usageReport(
  workspaceId: string,
  period: UsageReportPeriod,
  group: UsageReportGroup,
): Promise<UsageRow[]> {
  return (await query(convex, 'domains/credits/internal:listUsageReport', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    period,
    group,
  })) as UsageRow[]
}

async function topupConfig(workspaceId: string): Promise<Record<string, unknown>> {
  return (await query(convex, 'domains/credits/internal:getTopupConfig', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Record<string, unknown>
}

async function userBillingOverview(
  actorId: string,
  now?: number,
): Promise<Record<string, unknown>> {
  return (await query(convex, 'domains/credits/internal:getUserBillingOverview', {
    internalKey: INTERNAL_KEY,
    actorId,
    ...(now === undefined ? {} : { now }),
  })) as Record<string, unknown>
}

async function billingSessionAccount(
  actorId: string,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  return (await query(convex, 'domains/credits/internal:getBillingSessionAccount', {
    internalKey: INTERNAL_KEY,
    actorId,
    workspaceId,
  })) as Record<string, unknown>
}

async function topups(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'testing/credits:listTopupsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
}

async function listTransactions(workspaceId: string): Promise<LedgerRow[]> {
  return (await query(convex, 'testing/credits:listWorkspaceTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as LedgerRow[]
}

async function balance(workspaceId: string): Promise<number> {
  return ((await wallet(workspaceId)) as { balanceMicroUsd: number }).balanceMicroUsd
}

async function wallet(workspaceId: string): Promise<Record<string, unknown>> {
  return (await query(convex, 'testing/credits:walletForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Record<string, unknown>
}

async function workspaceById(workspaceId: string): Promise<Record<string, unknown>> {
  const rows = (await query(owner.client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: Record<string, unknown>
  }>
  const workspace = rows.find(row => row.workspace._id === workspaceId)?.workspace
  if (workspace === undefined) throw new Error(`Workspace not found in test list: ${workspaceId}`)
  return workspace
}

async function workspaceByIdFor(
  client: ConvexHttpClient,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const rows = (await query(client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: Record<string, unknown>
  }>
  const workspace = rows.find(row => row.workspace._id === workspaceId)?.workspace
  if (workspace === undefined) throw new Error(`Workspace not found in test list: ${workspaceId}`)
  return workspace
}

async function preflight(workspaceId: string, now?: number): Promise<PreflightDecision> {
  return (await mutate(convex, 'domains/credits/internal:runPreflight', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    ...(now === undefined ? {} : { now }),
  })) as PreflightDecision
}

function invoicePaidEvent(
  eventId: string,
  workspaceId: string,
  invoiceId: string,
  totalCents: number,
  amountPaidCents = totalCents,
): Record<string, unknown> {
  return {
    id: eventId,
    created: Math.floor(Date.now() / 1000),
    type: 'invoice.paid',
    data: {
      object: {
        id: invoiceId,
        total: totalCents,
        amount_paid: amountPaidCents,
        metadata: { source: 'duet', type: 'credit_topup', workspaceId, userId: owner.user._id },
      },
    },
  }
}

function invoicePaymentFailedEvent(
  eventId: string,
  workspaceId: string,
  invoiceId: string,
  metadataType = 'credit_topup',
): Record<string, unknown> {
  return {
    id: eventId,
    created: Math.floor(Date.now() / 1000),
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: invoiceId,
        metadata: {
          source: 'duet',
          type: metadataType,
          workspaceId,
          userId: owner.user._id,
        },
      },
    },
  }
}

function paymentIntentSucceededEvent(
  eventId: string,
  workspaceId: string,
  paymentIntentId: string,
  totalCents: number,
  metadataType = 'credit_topup',
): Record<string, unknown> {
  return {
    id: eventId,
    created: Math.floor(Date.now() / 1000),
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: paymentIntentId,
        amount: totalCents,
        amount_received: totalCents,
        metadata: { source: 'duet', type: metadataType, workspaceId, userId: owner.user._id },
      },
    },
  }
}

function action(name: string, args: Record<string, unknown>): Promise<unknown> {
  return convex.action(name, args)
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
}

interface PreflightDecision {
  proceed: boolean
  reason?: 'insufficient_credits' | 'monthly_cap'
  tier?: 'account' | 'workspace'
  balanceMicroUsd: number
  accountMonthlySpendMicroUsd: number
  accountMonthlyCapMicroUsd?: number
  workspaceMonthlySpendMicroUsd: number
  workspaceMonthlyCapMicroUsd?: number
}

interface UsageRow {
  period: string
  spendMicroUsd: number
  userId?: string
  appSlug?: string
  inputTokens?: number
  outputTokens?: number
}

interface LedgerRow {
  amountMicroUsd: number
  type: string
  reference: string
  metadata?: Record<string, unknown>
}

interface SubscriptionHarnessState {
  subscription: Record<string, unknown>
  paidCreditBalanceMicroUsd: number
  monthlyCreditBalanceMicroUsd: number
  monthlyCreditEpoch: string
  ledgerReferences: string[]
}
