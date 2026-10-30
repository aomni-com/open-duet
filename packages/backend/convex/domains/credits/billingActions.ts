'use node'

import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type Stripe from 'stripe'

import { SUBSCRIPTION_PLANS } from '@repo/contract'

import { action } from '../../_generated/server'
import {
  stripeBillingPortalConfigurationId,
  stripeSubscriptionPriceIds,
  useTestFakeStripe,
} from '../../config'
import {
  cancelPendingSubscriptionPlanChange,
  cancelSubscriptionAtPeriodEnd,
  changeSubscriptionPlan as changeStripeSubscriptionPlan,
  createBillingCheckout,
  createBillingPortal,
  createStripeClient,
  createOnboardingPaymentIntent as createStripeOnboardingPaymentIntent,
  createSubscriptionCheckout as createStripeSubscriptionCheckout,
  resumeSubscription,
  deterministicStripeIdSuffix,
  type StripeSubscriptionBillingClient,
  type StripeOnboardingPaymentClient,
} from '../../services/stripe'
import { requireApiInternalKey } from '../apiKeys/model'
import { isTerminalSubscriptionStatus } from './subscriptions'
import type { BillingSessionAccount } from './userBilling'

export const createCheckout = action({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    amountMicroUsd: v.optional(v.number()),
    returnUrl: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const secret = process.env.STRIPE_SECRET_KEY
    if (!secret) throw new Error('Stripe billing is not configured')
    const stripe = createStripeClient(secret)
    const account = (await ctx.runQuery(
      fnQuery('domains/credits/internal:getBillingSessionAccount'),
      {
        internalKey: args.internalKey,
        actorId: args.actorId,
        workspaceId: args.workspaceId,
      },
    )) as {
      userId: string
      email: string
      stripeCustomerId?: string
      paymentMethodReady: boolean
      workspaceId: string
    }
    let customerId = account.stripeCustomerId
    if (customerId === undefined) {
      const customer = await stripe.customers.create({
        email: account.email,
        metadata: { source: 'duet', userId: account.userId },
      })
      customerId = (await ctx.runMutation(
        fnMutation('domains/credits/internal:attachStripeCustomer'),
        {
          internalKey: args.internalKey,
          actorId: args.actorId,
          workspaceId: args.workspaceId,
          stripeCustomerId: customer.id,
          now: args.now,
        },
      )) as string
    }
    if (args.amountMicroUsd !== undefined && !account.paymentMethodReady) {
      throw new Error('Payment method required')
    }
    const session = await createBillingCheckout(stripe, {
      customerId,
      workspaceId: account.workspaceId,
      userId: account.userId,
      successUrl: `${args.returnUrl}?billing=success`,
      cancelUrl: `${args.returnUrl}?billing=cancelled`,
      amountMicroUsd: args.amountMicroUsd,
    })
    if (!session.url) throw new Error('Stripe Checkout did not return a URL')
    return { url: session.url }
  },
})

export const createPortal = action({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    returnUrl: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const secret = process.env.STRIPE_SECRET_KEY
    if (!secret) throw new Error('Stripe billing is not configured')
    const account = (await ctx.runQuery(
      fnQuery('domains/credits/internal:getBillingSessionAccount'),
      {
        internalKey: args.internalKey,
        actorId: args.actorId,
        workspaceId: args.workspaceId,
      },
    )) as { stripeCustomerId?: string; paymentMethodReady: boolean }
    if (account.stripeCustomerId === undefined || !account.paymentMethodReady) {
      throw new Error('Payment method required')
    }
    const session = await createBillingPortal(createStripeClient(secret), {
      customerId: account.stripeCustomerId,
      returnUrl: args.returnUrl,
      configurationId: stripeBillingPortalConfigurationId(),
    })
    return { url: session.url, sessionId: session.id }
  },
})

export const createSubscriptionCheckout = action({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    plan: v.union(v.literal('starter'), v.literal('pro'), v.literal('max')),
    returnUrl: v.string(),
    now: v.number(),
  },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const account = (await ctx.runQuery(
      fnQuery('domains/credits/internal:getBillingSessionAccount'),
      {
        internalKey: args.internalKey,
        actorId: args.actorId,
        workspaceId: args.workspaceId,
      },
    )) as BillingSessionAccount
    if (
      account.subscription !== undefined &&
      !isTerminalSubscriptionStatus(account.subscription.status)
    ) {
      throw new Error('Subscription already exists')
    }

    const checkoutGeneration = account.subscription?.latestLifecycleEventId ?? 'new'
    const returnUrlShape = deterministicStripeIdSuffix(args.returnUrl)
    const idempotencyKey = `subscription-checkout:${account.userId}:${checkoutGeneration}:${args.plan}:${returnUrlShape}`
    const secret = process.env.STRIPE_SECRET_KEY
    if (!secret && !useTestFakeStripe()) throw new Error('Stripe billing is not configured')
    const realStripe = secret ? createStripeClient(secret) : undefined
    const stripe: StripeSubscriptionBillingClient & {
      customers: { create(params: Stripe.CustomerCreateParams): Promise<Stripe.Customer> }
    } = realStripe ?? fakeSubscriptionStripe(idempotencyKey)
    let customerId = account.stripeCustomerId
    if (customerId === undefined) {
      const customer = realStripe
        ? await realStripe.customers.create({
            email: account.email,
            metadata: { source: 'duet', userId: account.userId },
          })
        : ({ id: `cus_fake_${deterministicStripeIdSuffix(idempotencyKey)}` } as Stripe.Customer)
      customerId = (await ctx.runMutation(
        fnMutation('domains/credits/internal:attachStripeCustomer'),
        {
          internalKey: args.internalKey,
          actorId: args.actorId,
          workspaceId: args.workspaceId,
          stripeCustomerId: customer.id,
          now: args.now,
        },
      )) as string
    }
    const session = await createStripeSubscriptionCheckout(stripe, {
      customerId,
      userId: account.userId,
      priceId: stripeSubscriptionPriceIds()[args.plan],
      successUrl: `${args.returnUrl}?billing=success`,
      cancelUrl: `${args.returnUrl}?billing=cancelled`,
      idempotencyKey,
    })
    if (!session.url) throw new Error('Stripe Checkout did not return a URL')
    return { url: session.url }
  },
})

export const createOnboardingPaymentIntent = action({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    attemptId: v.string(),
    now: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const account = (await ctx.runQuery(
      fnQuery('domains/credits/internal:getBillingSessionAccount'),
      {
        internalKey: args.internalKey,
        actorId: args.actorId,
        workspaceId: args.workspaceId,
      },
    )) as BillingSessionAccount
    if (account.paymentMethodReady && account.paymentMethodReadyAt !== undefined) {
      return { status: 'ready', paymentMethodReadyAt: account.paymentMethodReadyAt }
    }

    const secret = process.env.STRIPE_SECRET_KEY
    if (!secret && !useTestFakeStripe()) throw new Error('Stripe billing is not configured')
    const realStripe = secret ? createStripeClient(secret) : undefined
    const stripe = realStripe ?? fakeOnboardingStripe()
    let customerId = account.stripeCustomerId
    if (customerId === undefined) {
      const customer = await stripe.customers.create({
        email: account.email,
        metadata: { source: 'duet', userId: account.userId },
      })
      customerId = (await ctx.runMutation(
        fnMutation('domains/credits/internal:attachStripeCustomer'),
        {
          internalKey: args.internalKey,
          actorId: args.actorId,
          workspaceId: args.workspaceId,
          stripeCustomerId: customer.id,
          now: args.now,
        },
      )) as string
    }

    const existingIntentId = account.onboardingPaymentIntentId
    const existingAttemptId = account.onboardingPaymentAttemptId
    const existing =
      existingIntentId !== undefined &&
      existingAttemptId !== undefined &&
      account.onboardingPaymentStatus !== 'canceled' &&
      account.onboardingPaymentStatus !== 'failed'
        ? await stripe.paymentIntents.retrieve(existingIntentId).catch(() => null)
        : null
    const paymentIntent =
      existing ??
      (await createStripeOnboardingPaymentIntent(stripe, {
        customerId,
        workspaceId: account.workspaceId,
        userId: account.userId,
        attemptId: args.attemptId,
        idempotencyKey: `onboarding-payment:${account.userId}:${args.attemptId}`,
      }))
    const attemptId = existing === null ? args.attemptId : existingAttemptId!
    await ctx.runMutation(fnMutation('domains/credits/internal:recordOnboardingPaymentAttempt'), {
      internalKey: args.internalKey,
      actorId: args.actorId,
      workspaceId: args.workspaceId,
      attemptId,
      paymentIntentId: paymentIntent.id,
      status:
        paymentIntent.status === 'requires_action' ? 'requires_action' : 'requires_confirmation',
      now: args.now,
    })
    return {
      status: paymentIntent.status === 'requires_action' ? 'pending' : 'requires_confirmation',
      attemptId,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret ?? `pi_secret_${paymentIntent.id}`,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? 'pk_test_duet',
      amount: 1000,
      currency: 'usd',
    }
  },
})

export const completeOnboardingPayment = action({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    attemptId: v.string(),
    paymentIntentId: v.string(),
    billingDetails: v.object({
      name: v.string(),
      email: v.string(),
      address: v.object({
        line1: v.string(),
        line2: v.optional(v.string()),
        city: v.string(),
        state: v.optional(v.string()),
        postalCode: v.string(),
        country: v.string(),
      }),
    }),
    now: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const account = (await ctx.runQuery(
      fnQuery('domains/credits/internal:getBillingSessionAccount'),
      {
        internalKey: args.internalKey,
        actorId: args.actorId,
        workspaceId: args.workspaceId,
      },
    )) as BillingSessionAccount
    if (account.paymentMethodReady && account.paymentMethodReadyAt !== undefined) {
      return { ready: true, paymentMethodReadyAt: account.paymentMethodReadyAt, status: 'ready' }
    }
    if (
      account.onboardingPaymentIntentId !== undefined &&
      account.onboardingPaymentIntentId !== args.paymentIntentId
    ) {
      throw new Error('Payment attempt mismatch')
    }
    if (
      account.onboardingPaymentAttemptId !== undefined &&
      account.onboardingPaymentAttemptId !== args.attemptId
    ) {
      throw new Error('Payment attempt mismatch')
    }
    const secret = process.env.STRIPE_SECRET_KEY
    if (!secret && !useTestFakeStripe()) throw new Error('Stripe billing is not configured')
    const stripe = (
      secret ? createStripeClient(secret) : fakeOnboardingStripe()
    ) as StripeOnboardingPaymentClient
    const intent = await stripe.paymentIntents.retrieve(args.paymentIntentId)
    const metadata = intent.metadata ?? {}
    const hasValidMetadata =
      intent.amount === 1000 &&
      intent.currency === 'usd' &&
      metadata.userId === account.userId &&
      metadata.workspaceId === account.workspaceId &&
      typeof intent.payment_method === 'string' &&
      typeof intent.customer === 'string' &&
      account.stripeCustomerId !== undefined &&
      intent.customer === account.stripeCustomerId
    const canRecoverCanceled =
      intent.status === 'canceled' && account.onboardingPaymentStatus === 'canceling'
    const isFreshAuthorization =
      intent.status === 'requires_capture' && intent.amount_capturable === 1000
    if (!hasValidMetadata || (!isFreshAuthorization && !canRecoverCanceled)) {
      await ctx.runMutation(fnMutation('domains/credits/internal:recordOnboardingPaymentAttempt'), {
        internalKey: args.internalKey,
        actorId: args.actorId,
        workspaceId: args.workspaceId,
        attemptId: args.attemptId,
        paymentIntentId: args.paymentIntentId,
        status: 'failed',
        now: args.now,
      })
      throw new Error('Payment intent is not a valid onboarding authorization')
    }
    if (isFreshAuthorization) {
      await ctx.runMutation(fnMutation('domains/credits/internal:recordOnboardingPaymentAttempt'), {
        internalKey: args.internalKey,
        actorId: args.actorId,
        workspaceId: args.workspaceId,
        attemptId: args.attemptId,
        paymentIntentId: args.paymentIntentId,
        status: 'canceling',
        now: args.now,
      })
      const canceled = await stripe.paymentIntents.cancel(args.paymentIntentId, undefined, {
        idempotencyKey: `onboarding-payment-cancel:${args.paymentIntentId}`,
      })
      if (canceled.status !== 'canceled')
        throw new Error('Payment authorization could not be released')
    }
    if (account.stripeCustomerId === undefined || typeof intent.payment_method !== 'string') {
      throw new Error('Payment method was not attached to the billing customer')
    }
    await stripe.customers.update(account.stripeCustomerId, {
      name: args.billingDetails.name,
      email: args.billingDetails.email,
      address: {
        line1: args.billingDetails.address.line1,
        ...(args.billingDetails.address.line2 === undefined
          ? {}
          : { line2: args.billingDetails.address.line2 }),
        city: args.billingDetails.address.city,
        ...(args.billingDetails.address.state === undefined
          ? {}
          : { state: args.billingDetails.address.state }),
        postal_code: args.billingDetails.address.postalCode,
        country: args.billingDetails.address.country.toUpperCase(),
      },
      invoice_settings: { default_payment_method: intent.payment_method },
    })
    const readyAt = (await ctx.runMutation(
      fnMutation('domains/credits/internal:markOnboardingPaymentReady'),
      {
        internalKey: args.internalKey,
        actorId: args.actorId,
        workspaceId: args.workspaceId,
        attemptId: args.attemptId,
        paymentIntentId: args.paymentIntentId,
        now: args.now,
      },
    )) as number
    return { ready: true, paymentMethodReadyAt: readyAt, status: 'ready' }
  },
})

const onboardingFakeIntents = new Map<string, Stripe.PaymentIntent>()

function fakeOnboardingStripe(): StripeOnboardingPaymentClient {
  return {
    customers: {
      async create(params) {
        return {
          id: `cus_fake_onboarding_${deterministicStripeIdSuffix(params.email ?? 'duet')}`,
          object: 'customer',
          livemode: false,
          email: params.email ?? null,
          metadata: params.metadata ?? {},
        } as Stripe.Customer
      },
      async update(id) {
        return { id, object: 'customer', livemode: false } as Stripe.Customer
      },
    },
    paymentIntents: {
      async create(params) {
        const id = `pi_fake_onboarding_${deterministicStripeIdSuffix(
          `${String(params.metadata?.userId)}:${String(params.metadata?.workspaceId)}:${String(params.metadata?.attemptId)}`,
        )}`
        const intent = {
          id,
          object: 'payment_intent',
          amount: 1000,
          amount_capturable: 1000,
          amount_received: 0,
          currency: 'usd',
          customer: params.customer ?? null,
          payment_method: `pm_fake_onboarding_${deterministicStripeIdSuffix(String(params.metadata?.userId))}`,
          status: 'requires_capture',
          client_secret: `${id}_secret_duet`,
          metadata: params.metadata ?? {},
        } as Stripe.PaymentIntent
        onboardingFakeIntents.set(id, intent)
        return intent
      },
      async retrieve(id) {
        const intent = onboardingFakeIntents.get(id)
        if (intent === undefined) throw new Error('No such fake payment intent')
        return intent
      },
      async cancel(id) {
        const intent = onboardingFakeIntents.get(id)
        if (intent === undefined) throw new Error('No such fake payment intent')
        const canceled = {
          ...intent,
          status: 'canceled',
          amount_capturable: 0,
        } as Stripe.PaymentIntent
        onboardingFakeIntents.set(id, canceled)
        return canceled
      },
    },
  }
}

export const changeSubscriptionPlan = action({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    plan: v.optional(v.union(v.literal('starter'), v.literal('pro'), v.literal('max'))),
    cancel: v.optional(v.boolean()),
    resume: v.optional(v.boolean()),
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const account = (await ctx.runQuery(
      fnQuery('domains/credits/internal:getBillingSessionAccount'),
      {
        internalKey: args.internalKey,
        actorId: args.actorId,
        workspaceId: args.workspaceId,
      },
    )) as BillingSessionAccount
    const subscription = account.subscription
    if (subscription === undefined || isTerminalSubscriptionStatus(subscription.status)) {
      throw new Error('Nonterminal subscription required')
    }
    const transitionKey = `subscription-plan:${subscription.stripeSubscriptionId}:${subscription.latestLifecycleEventId}`
    const secret = process.env.STRIPE_SECRET_KEY
    if (!secret && !useTestFakeStripe()) throw new Error('Stripe billing is not configured')
    const realStripe = secret ? createStripeClient(secret) : undefined
    const stripe: StripeSubscriptionBillingClient =
      realStripe ?? fakeSubscriptionStripe(transitionKey)
    let liveSubscription: Stripe.Subscription | undefined
    const live = async () => {
      if (realStripe !== undefined && liveSubscription === undefined) {
        liveSubscription = await realStripe.subscriptions.retrieve(
          subscription.stripeSubscriptionId,
        )
      }
      return liveSubscription
    }
    const pendingScheduleId = async () => {
      if (subscription.pendingPlan === undefined) return undefined
      const current = await live()
      if (current === undefined) {
        return `sub_sched_fake_${deterministicStripeIdSuffix(subscription.stripeSubscriptionId)}`
      }
      return typeof current.schedule === 'string' ? current.schedule : current.schedule?.id
    }

    if (args.resume === true) {
      if (!subscription.cancelAtPeriodEnd) {
        throw new Error('Subscription is not scheduled to cancel')
      }
      await resumeSubscription(stripe, {
        subscriptionId: subscription.stripeSubscriptionId,
        idempotencyKey: `${transitionKey}:resume`,
      })
      return { ok: true as const }
    }

    if (args.cancel === true) {
      if (subscription.cancelAtPeriodEnd) return { ok: true as const }
      const scheduleId = await pendingScheduleId()
      if (scheduleId !== undefined) {
        await cancelPendingSubscriptionPlanChange(stripe, {
          scheduleId,
          idempotencyKey: `${transitionKey}:cancel:release`,
        })
      }
      await cancelSubscriptionAtPeriodEnd(stripe, {
        subscriptionId: subscription.stripeSubscriptionId,
        idempotencyKey: `${transitionKey}:cancel`,
      })
      return { ok: true as const }
    }
    if (args.plan === undefined) throw new Error('Subscription plan required')
    if (args.plan === subscription.pendingPlan) {
      return { ok: true as const }
    }
    if (args.plan === subscription.plan) {
      const scheduleId = await pendingScheduleId()
      if (scheduleId !== undefined) {
        await cancelPendingSubscriptionPlanChange(stripe, {
          scheduleId,
          idempotencyKey: `${transitionKey}:${args.plan}:release`,
        })
      }
      return { ok: true as const }
    }

    const direction =
      SUBSCRIPTION_PLANS[args.plan].monthlyPriceMicroUsd >
      SUBSCRIPTION_PLANS[subscription.plan].monthlyPriceMicroUsd
        ? 'upgrade'
        : 'downgrade'
    let itemId = `si_fake_${deterministicStripeIdSuffix(subscription.stripeSubscriptionId)}`
    if (realStripe) {
      const current = (await live())!
      const item = current.items.data.find(candidate => {
        const priceId = typeof candidate.price === 'string' ? candidate.price : candidate.price.id
        return priceId === subscription.stripePriceId
      })
      if (item === undefined) throw new Error('Stripe subscription item not found')
      itemId = item.id
    }
    await changeStripeSubscriptionPlan(stripe, {
      subscriptionId: subscription.stripeSubscriptionId,
      itemId,
      newPriceId: stripeSubscriptionPriceIds()[args.plan],
      direction,
      idempotencyKey: `${transitionKey}:${args.plan}`,
      scheduleId: await pendingScheduleId(),
    })
    return { ok: true as const }
  },
})

function fakeSubscriptionStripe(idempotencyKey: string): StripeSubscriptionBillingClient & {
  customers: { create(params: Stripe.CustomerCreateParams): Promise<Stripe.Customer> }
} {
  const suffix = deterministicStripeIdSuffix(idempotencyKey)
  return {
    customers: {
      create: async () => ({ id: `cus_fake_${suffix}` }) as Stripe.Customer,
    },
    checkout: {
      sessions: {
        create: async () =>
          ({
            id: `cs_fake_${suffix}`,
            url: `https://checkout.stripe.test/cs_fake_${suffix}`,
          }) as Stripe.Checkout.Session,
      },
    },
    subscriptions: {
      update: async id => ({ id }) as Stripe.Subscription,
    },
    subscriptionSchedules: {
      create: async params =>
        ({
          id: `sub_sched_fake_${suffix}`,
          current_phase: { start_date: 1, end_date: 2 },
          phases: [
            {
              start_date: 1,
              end_date: 2,
              items: [{ price: `price_fake_${params.from_subscription}`, quantity: 1 }],
            },
          ],
        }) as unknown as Stripe.SubscriptionSchedule,
      update: async id => ({ id }) as Stripe.SubscriptionSchedule,
      retrieve: async id =>
        ({
          id,
          current_phase: { start_date: 1, end_date: 2 },
          phases: [
            {
              start_date: 1,
              end_date: 2,
              items: [{ price: 'price_fake_current', quantity: 1 }],
            },
          ],
        }) as unknown as Stripe.SubscriptionSchedule,
      release: async id => ({ id }) as Stripe.SubscriptionSchedule,
    },
  }
}

function fnQuery(name: string): FunctionReference<'query'> {
  return makeFunctionReference(name) as FunctionReference<'query'>
}

function fnMutation(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}
