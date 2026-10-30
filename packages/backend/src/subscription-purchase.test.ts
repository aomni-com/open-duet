import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import type { GenericMutationCtx } from 'convex/server'

import { SUBSCRIPTION_PLANS, type AnalyticsEvent } from '@repo/contract'

import type { DataModel, Id } from '../convex/_generated/dataModel'
import type { CampaignDefinition } from '../convex/domains/campaigns/config'
import { convertOnSignupAndPurchase } from '../convex/domains/campaigns/conversionFunctions'
import { routeConversionEvent } from '../convex/domains/campaigns/conversionModel'
import { applyPaidSubscriptionInvoiceWithDb } from '../convex/domains/credits/subscriptions'
import schema from '../convex/schema'

const CUSTOMER_ID = 'cus_purchase'
const T0 = 1_900_000_000_000
const MONTH_MS = 30 * 24 * 60 * 60 * 1_000

test('the first paid invoice emits a purchase carrying what was actually charged', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  const events: AnalyticsEvent[] = []

  await t.run(async ctx => {
    const userId = await insertSubscriber(ctx)
    await applyPaidSubscriptionInvoiceWithDb(ctx, paidInvoice(), T0, collect(events))

    expect(events).toEqual([
      expect.objectContaining({
        id: 'subscription-purchase:in_1',
        name: 'subscription.started',
        userId,
        properties: {
          plan: 'pro',
          priceId: 'price_pro',
          invoiceId: 'in_1',
          subscriptionId: 'sub_1',
          billingReason: 'subscription_create',
          monthlyPriceMicroUsd: SUBSCRIPTION_PLANS.pro.monthlyPriceMicroUsd,
        },
      }),
    ])
  })
})

test('later invoices renew rather than repeat the purchase', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  const events: AnalyticsEvent[] = []

  await t.run(async ctx => {
    await insertSubscriber(ctx)
    await applyPaidSubscriptionInvoiceWithDb(ctx, paidInvoice(), T0, collect(events))
    await applyPaidSubscriptionInvoiceWithDb(
      ctx,
      paidInvoice({
        invoiceId: 'in_2',
        billingReason: 'subscription_cycle',
        periodStart: T0 + MONTH_MS,
        periodEnd: T0 + 2 * MONTH_MS,
        invoiceCreatedAt: T0 + MONTH_MS,
      }),
      T0 + MONTH_MS,
      collect(events),
    )

    expect(events.map(event => [event.name, event.id])).toEqual([
      ['subscription.started', 'subscription-purchase:in_1'],
      ['subscription.renewed', 'subscription-purchase:in_2'],
    ])
  })
})

test('a replayed invoice emits nothing the second time', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  const events: AnalyticsEvent[] = []

  await t.run(async ctx => {
    await insertSubscriber(ctx)
    await applyPaidSubscriptionInvoiceWithDb(ctx, paidInvoice(), T0, collect(events))
    await applyPaidSubscriptionInvoiceWithDb(ctx, paidInvoice(), T0 + 1_000, collect(events))

    expect(events.map(event => event.name)).toEqual(['subscription.started'])
  })
})

test('an invoice for an unknown customer emits nothing', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  const events: AnalyticsEvent[] = []

  await t.run(async ctx => {
    await applyPaidSubscriptionInvoiceWithDb(ctx, paidInvoice(), T0, collect(events))
    expect(events).toEqual([])
  })
})

test('a purchase reaches the campaign journey the user was acquired through', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

  await t.run(async ctx => {
    const userId = await insertSubscriber(ctx)
    const attributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug: 'fixture-purchase',
      action: 'signup',
      acquiredByUserId: userId,
      signals: {},
      createdAt: T0,
      expiresAt: T0 + MONTH_MS,
    })
    await ctx.db.patch(userId, { acquisitionAttributionId: attributionId })

    const campaign: CampaignDefinition = {
      enabled: true,
      attributionWindowMs: MONTH_MS,
      conversion: {
        on: ['user.signed_up', 'subscription.started'],
        run: convertOnSignupAndPurchase,
        config: {},
      },
    }
    const route = async (event: AnalyticsEvent) =>
      await routeConversionEvent(ctx, event, {
        now: T0,
        campaignBySlug: slug => (slug === 'fixture-purchase' ? campaign : undefined),
        startRun: async (_ctx, instanceId) => `run:${instanceId}`,
      })

    await route({
      id: `signup:${userId}`,
      name: 'user.signed_up',
      version: 1,
      at: T0,
      origin: 'product_backend',
      userId,
      properties: {},
    })
    await applyPaidSubscriptionInvoiceWithDb(ctx, paidInvoice(), T0, async (_ctx, event) => {
      await route(event)
    })

    const instances = await ctx.db.query('conversionInstances').collect()
    expect(instances.map(instance => instance.campaignSlug)).toEqual(['fixture-purchase'])
    expect((await ctx.db.query('conversionInputs').collect()).map(input => input.inputKey)).toEqual(
      [`event:signup:${userId}`, 'event:subscription-purchase:in_1'],
    )
  })
})

function collect(events: AnalyticsEvent[]) {
  return async (_ctx: GenericMutationCtx<DataModel>, event: AnalyticsEvent) => {
    events.push(event)
  }
}

function paidInvoice(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'invoice_paid' as const,
    eventId: 'evt_1',
    eventCreatedAt: T0,
    invoiceId: 'in_1',
    invoiceCreatedAt: T0,
    customerId: CUSTOMER_ID,
    subscriptionId: 'sub_1',
    priceId: 'price_pro',
    plan: 'pro' as const,
    periodStart: T0,
    periodEnd: T0 + MONTH_MS,
    billingReason: 'subscription_create' as const,
    ...overrides,
  }
}

async function insertSubscriber(ctx: GenericMutationCtx<DataModel>): Promise<Id<'users'>> {
  return await ctx.db.insert('users', {
    email: 'subscriber@example.com',
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    memberDirectoryRevision: 0,
    billing: { stripeCustomerId: CUSTOMER_ID },
    createdAt: T0,
    updatedAt: T0,
  })
}
