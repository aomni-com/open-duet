import Stripe from 'stripe'

export const STRIPE_API_VERSION = '2026-02-25.clover'

const WEBHOOK_VERIFICATION_KEY = 'sk_test_duet_webhook_verification'

export function deterministicStripeIdSuffix(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export interface StripeTopupInvoicesClient {
  invoices: {
    create(
      params: Stripe.InvoiceCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Invoice>
    finalizeInvoice(
      id: string,
      params?: Stripe.InvoiceFinalizeInvoiceParams,
    ): Promise<Stripe.Invoice>
    pay(id: string, params?: Stripe.InvoicePayParams): Promise<Stripe.Invoice>
    voidInvoice(id: string): Promise<Stripe.Invoice>
    retrieve(id: string): Promise<Stripe.Invoice>
  }
  invoiceItems: {
    create(
      params: Stripe.InvoiceItemCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.InvoiceItem>
  }
  paymentMethods: {
    list(params: Stripe.PaymentMethodListParams): Promise<Stripe.ApiList<Stripe.PaymentMethod>>
  }
  customers: {
    retrieve(
      id: string,
      params?: Stripe.CustomerRetrieveParams,
    ): Promise<Stripe.Customer | Stripe.DeletedCustomer>
  }
}

export const NO_PAYMENT_METHOD_FAILURE_CODE = 'no_payment_method'

export interface StripeHostedBillingClient {
  customers: {
    create(params: Stripe.CustomerCreateParams): Promise<Stripe.Customer>
  }
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ): Promise<Stripe.Checkout.Session>
    }
  }
  billingPortal: {
    sessions: {
      create(
        params: Stripe.BillingPortal.SessionCreateParams,
      ): Promise<Stripe.BillingPortal.Session>
    }
  }
}

export interface StripeOnboardingPaymentClient {
  paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.PaymentIntent>
    retrieve(id: string): Promise<Stripe.PaymentIntent>
    cancel(
      id: string,
      params?: Stripe.PaymentIntentCancelParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.PaymentIntent>
  }
  customers: {
    create(params: Stripe.CustomerCreateParams): Promise<Stripe.Customer>
    update(
      id: string,
      params: Stripe.CustomerUpdateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Customer>
  }
}

export interface StripeSubscriptionBillingClient {
  checkout: StripeHostedBillingClient['checkout']
  subscriptions: {
    update(
      id: string,
      params: Stripe.SubscriptionUpdateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Subscription>
  }
  subscriptionSchedules: {
    create(
      params: Stripe.SubscriptionScheduleCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.SubscriptionSchedule>
    update(
      id: string,
      params: Stripe.SubscriptionScheduleUpdateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.SubscriptionSchedule>
    retrieve(id: string): Promise<Stripe.SubscriptionSchedule>
    release(
      id: string,
      params?: Stripe.SubscriptionScheduleReleaseParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.SubscriptionSchedule>
  }
}

export function createStripeClient(apiKey: string = WEBHOOK_VERIFICATION_KEY): Stripe {
  return new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION,
  })
}

export async function constructStripeWebhookEvent(args: {
  rawBody: string
  signature: string
  webhookSecret: string
}): Promise<Stripe.Event> {
  return await createStripeClient().webhooks.constructEventAsync(
    args.rawBody,
    args.signature,
    args.webhookSecret,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  )
}

export async function createTopupInvoice(
  stripe: StripeTopupInvoicesClient,
  args: {
    workspaceId: string
    userId: string
    stripeCustomerId: string
    amountMicroUsd: number
    idempotencyKey: string
  },
): Promise<{
  status: 'paid' | 'failed'
  invoiceId: string
  failureCode?: string
  failureMessage?: string
  // Whether Stripe was asked to pay. Only then does a failure surface as an
  // `invoice.payment_failed` webhook; earlier failures must be counted locally.
  paymentAttempted: boolean
}> {
  const metadata = {
    source: 'duet',
    type: 'credit_topup',
    workspaceId: args.workspaceId,
    userId: args.userId,
  }
  const invoice = await stripe.invoices.create(
    {
      customer: args.stripeCustomerId,
      auto_advance: false,
      collection_method: 'charge_automatically',
      metadata,
    },
    { idempotencyKey: args.idempotencyKey },
  )
  if (!invoice.id) throw new Error('Stripe did not return an invoice id')

  await stripe.invoiceItems.create(
    {
      customer: args.stripeCustomerId,
      invoice: invoice.id,
      amount: Math.round(args.amountMicroUsd / 10_000),
      currency: 'usd',
      description: 'Duet credits',
      metadata,
    },
    { idempotencyKey: `${args.idempotencyKey}-item` },
  )

  const finalized =
    invoice.status === 'draft'
      ? await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false })
      : invoice
  if (finalized.status === 'paid') {
    return { status: 'paid', invoiceId: invoice.id, paymentAttempted: false }
  }

  if (finalized.status !== 'open') {
    return await voidFailedTopupInvoice(
      stripe,
      invoice.id,
      `invoice_${finalized.status ?? 'unknown'}`,
      false,
    )
  }

  // From here on the invoice is open, so every failure — including a lookup
  // that throws — must void it: the idempotency bucket never retries.
  let payRequested = false
  try {
    // Name the card explicitly. A standalone invoice only falls back to the
    // customer's `invoice_settings.default_payment_method`, and neither
    // subscription Checkout (card lives on the subscription) nor a one-time
    // payment with `setup_future_usage` (card is merely attached) ever sets
    // that, so an off-session pay with no `payment_method` fails for every
    // subscriber who never opened the Stripe portal. A default the user did
    // choose (in the portal) wins, then the subscription's card — so a
    // one-time top-up paid with another card never silently becomes the
    // auto top-up card — and only then the newest card on file.
    const paymentMethod =
      (await preferredPaymentMethod(stripe, args.stripeCustomerId)) ??
      (await stripe.paymentMethods.list({ customer: args.stripeCustomerId, limit: 1 })).data[0]?.id
    if (paymentMethod === undefined) {
      await stripe.invoices.voidInvoice(invoice.id)
      return {
        status: 'failed',
        invoiceId: invoice.id,
        failureCode: NO_PAYMENT_METHOD_FAILURE_CODE,
        failureMessage: 'No payment method is attached to this Stripe customer.',
        paymentAttempted: false,
      }
    }
    payRequested = true
    const paid = await stripe.invoices.pay(invoice.id, {
      off_session: true,
      payment_method: paymentMethod,
    })
    if (paid.status === 'paid') {
      return { status: 'paid', invoiceId: invoice.id, paymentAttempted: true }
    }
    return await voidFailedTopupInvoice(
      stripe,
      invoice.id,
      `invoice_${paid.status ?? 'unknown'}`,
      true,
    )
  } catch (error) {
    const failure = {
      failureCode:
        error instanceof Stripe.errors.StripeError
          ? (error.code ?? 'stripe_error')
          : 'stripe_error',
      failureMessage: error instanceof Error ? error.message : 'Stripe invoice payment failed',
    }
    // A card error is a payment attempt Stripe ran and will report through
    // `invoice.payment_failed`. Any other error from the pay call is
    // ambiguous — the request may have reached Stripe with its response lost
    // — so the invoice itself decides whether a payment ran, and whether it
    // went through. Errors before the pay call never produced an attempt.
    if (payRequested && !(error instanceof Stripe.errors.StripeCardError)) {
      const current = await stripe.invoices.retrieve(invoice.id)
      if (current.status === 'paid') {
        return { status: 'paid', invoiceId: invoice.id, paymentAttempted: true }
      }
      await stripe.invoices.voidInvoice(invoice.id)
      return {
        status: 'failed',
        invoiceId: invoice.id,
        ...failure,
        paymentAttempted: current.attempted,
      }
    }
    await stripe.invoices.voidInvoice(invoice.id)
    return { status: 'failed', invoiceId: invoice.id, ...failure, paymentAttempted: payRequested }
  }
}

async function preferredPaymentMethod(
  stripe: StripeTopupInvoicesClient,
  customerId: string,
): Promise<string | undefined> {
  const customer = await stripe.customers.retrieve(customerId, { expand: ['subscriptions'] })
  if (customer.deleted) return undefined
  return (
    paymentMethodId(customer.invoice_settings.default_payment_method) ??
    customer.subscriptions?.data
      .map(subscription => paymentMethodId(subscription.default_payment_method))
      .find(id => id !== undefined)
  )
}

function paymentMethodId(
  paymentMethod: string | Stripe.PaymentMethod | null | undefined,
): string | undefined {
  return typeof paymentMethod === 'string' ? paymentMethod : (paymentMethod?.id ?? undefined)
}

async function voidFailedTopupInvoice(
  stripe: StripeTopupInvoicesClient,
  invoiceId: string,
  failureCode: string,
  paymentAttempted: boolean,
): Promise<{
  status: 'failed'
  invoiceId: string
  failureCode: string
  paymentAttempted: boolean
}> {
  await stripe.invoices.voidInvoice(invoiceId)
  return { status: 'failed', invoiceId, failureCode, paymentAttempted }
}

export async function createBillingCheckout(
  stripe: StripeHostedBillingClient,
  args: {
    customerId: string
    workspaceId: string
    userId: string
    successUrl: string
    cancelUrl: string
    amountMicroUsd?: number
  },
): Promise<Stripe.Checkout.Session> {
  if (args.amountMicroUsd === undefined) {
    return await stripe.checkout.sessions.create({
      mode: 'setup',
      currency: 'usd',
      customer: args.customerId,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      setup_intent_data: {
        metadata: {
          source: 'duet',
          type: 'payment_method_setup',
          workspaceId: args.workspaceId,
          userId: args.userId,
        },
      },
    })
  }
  return await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: args.customerId,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(args.amountMicroUsd / 10_000),
          product_data: { name: 'Duet credits' },
        },
      },
    ],
    payment_intent_data: {
      setup_future_usage: 'off_session',
      metadata: {
        source: 'duet',
        type: 'credit_topup',
        workspaceId: args.workspaceId,
        userId: args.userId,
      },
    },
    invoice_creation: {
      enabled: true,
      invoice_data: {
        metadata: {
          source: 'duet',
          type: 'credit_topup_manual',
          workspaceId: args.workspaceId,
          userId: args.userId,
        },
      },
    },
  })
}

export async function createBillingPortal(
  stripe: StripeHostedBillingClient,
  args: { customerId: string; returnUrl: string; configurationId: string },
): Promise<Stripe.BillingPortal.Session> {
  return await stripe.billingPortal.sessions.create({
    customer: args.customerId,
    return_url: args.returnUrl,
    configuration: args.configurationId,
  })
}

export async function createSubscriptionCheckout(
  stripe: Pick<StripeSubscriptionBillingClient, 'checkout'>,
  args: {
    customerId: string
    userId: string
    priceId: string
    successUrl: string
    cancelUrl: string
    idempotencyKey: string
  },
): Promise<Stripe.Checkout.Session> {
  return await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      customer: args.customerId,
      payment_method_collection: 'if_required',
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      line_items: [{ price: args.priceId, quantity: 1 }],
      subscription_data: {
        metadata: { source: 'duet', type: 'subscription', userId: args.userId },
      },
    },
    { idempotencyKey: args.idempotencyKey },
  )
}

export async function createOnboardingPaymentIntent(
  stripe: {
    paymentIntents: Pick<StripeOnboardingPaymentClient['paymentIntents'], 'create'>
  },
  args: {
    customerId: string
    workspaceId: string
    userId: string
    attemptId?: string
    idempotencyKey: string
  },
): Promise<Stripe.PaymentIntent> {
  return await stripe.paymentIntents.create(
    {
      amount: 1000,
      currency: 'usd',
      customer: args.customerId,
      payment_method_types: ['card'],
      capture_method: 'manual',
      setup_future_usage: 'off_session',
      metadata: {
        source: 'duet',
        type: 'onboarding_payment_method_authorization',
        workspaceId: args.workspaceId,
        userId: args.userId,
        ...(args.attemptId === undefined ? {} : { attemptId: args.attemptId }),
      },
    },
    { idempotencyKey: args.idempotencyKey },
  )
}

export async function changeSubscriptionPlan(
  stripe: Pick<StripeSubscriptionBillingClient, 'subscriptions' | 'subscriptionSchedules'>,
  args: {
    subscriptionId: string
    itemId: string
    newPriceId: string
    direction: 'upgrade' | 'downgrade'
    idempotencyKey: string
    scheduleId?: string
  },
): Promise<void> {
  if (args.direction === 'upgrade') {
    if (args.scheduleId !== undefined) {
      await stripe.subscriptionSchedules.release(
        args.scheduleId,
        {},
        { idempotencyKey: `${args.idempotencyKey}:release` },
      )
    }
    await stripe.subscriptions.update(
      args.subscriptionId,
      {
        items: [{ id: args.itemId, price: args.newPriceId }],
        proration_behavior: 'always_invoice',
      },
      { idempotencyKey: args.idempotencyKey },
    )
    return
  }

  const schedule =
    args.scheduleId === undefined
      ? await stripe.subscriptionSchedules.create(
          { from_subscription: args.subscriptionId },
          { idempotencyKey: `${args.idempotencyKey}:schedule` },
        )
      : await stripe.subscriptionSchedules.retrieve(args.scheduleId)
  const current = schedule.current_phase
  if (current === null) throw new Error('Stripe subscription schedule has no current phase')
  const currentPhase = schedule.phases.find(
    phase => phase.start_date === current.start_date && phase.end_date === current.end_date,
  )
  if (currentPhase === undefined) throw new Error('Stripe subscription schedule phase is missing')
  const currentItems = currentPhase.items.map(item => ({
    price: typeof item.price === 'string' ? item.price : item.price.id,
    quantity: item.quantity ?? 1,
  }))
  await stripe.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: 'release',
      phases: [
        {
          start_date: current.start_date,
          end_date: current.end_date,
          items: currentItems,
        },
        {
          start_date: current.end_date,
          items: [{ price: args.newPriceId, quantity: 1 }],
        },
      ],
    },
    { idempotencyKey: `${args.idempotencyKey}:update` },
  )
}

export async function cancelPendingSubscriptionPlanChange(
  stripe: Pick<StripeSubscriptionBillingClient, 'subscriptionSchedules'>,
  args: { scheduleId: string; idempotencyKey: string },
): Promise<void> {
  await stripe.subscriptionSchedules.release(
    args.scheduleId,
    {},
    { idempotencyKey: args.idempotencyKey },
  )
}

export async function cancelSubscriptionAtPeriodEnd(
  stripe: Pick<StripeSubscriptionBillingClient, 'subscriptions'>,
  args: { subscriptionId: string; idempotencyKey: string },
): Promise<void> {
  await stripe.subscriptions.update(
    args.subscriptionId,
    { cancel_at_period_end: true },
    { idempotencyKey: args.idempotencyKey },
  )
}

export async function resumeSubscription(
  stripe: Pick<StripeSubscriptionBillingClient, 'subscriptions'>,
  args: { subscriptionId: string; idempotencyKey: string },
): Promise<void> {
  await stripe.subscriptions.update(
    args.subscriptionId,
    { cancel_at_period_end: false },
    { idempotencyKey: args.idempotencyKey },
  )
}
