import Stripe from 'stripe'

import { SUBSCRIPTION_PLANS, type SubscriptionPlanId } from '@repo/contract'

import { STRIPE_API_VERSION } from '../convex/services/stripe'

const OWNER = 'duet-monthly-subscriptions-v1'
const PORTAL_OWNER = 'duet-monthly-subscriptions-portal-narrow-v2'
const PRODUCT_NAME = 'Duet monthly subscription'
const PORTAL_NAME = 'Duet billing portal'
const PLAN_IDS = ['starter', 'pro', 'max'] as const satisfies readonly SubscriptionPlanId[]

export const STRIPE_SUBSCRIPTION_WEBHOOK_EVENTS = [
  'setup_intent.succeeded',
  'customer.updated',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.dispute.created',
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[]

export function requireProvisioningKey(key: string | undefined, confirmLive: boolean): string {
  if (key?.startsWith('sk_test_')) return key
  if (key?.startsWith('sk_live_')) {
    if (!confirmLive) throw new Error('Refusing sk_live_ key without --confirm-live')
    return key
  }
  throw new Error('STRIPE_SECRET_KEY must be an sk_test_ or sk_live_ secret key')
}

export function parseWebhookUrl(args: string[]): string | undefined {
  const indexes = args.flatMap((argument, index) => (argument === '--with-webhook' ? [index] : []))
  if (indexes.length === 0) return undefined
  if (indexes.length > 1) throw new Error('--with-webhook may be passed only once')
  const value = args[indexes[0]! + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--with-webhook requires a URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('--with-webhook must be an absolute HTTPS URL')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('--with-webhook must be an absolute HTTPS URL')
  }
  return value
}

export async function provisionWebhook(
  stripe: Stripe,
  exactUrl: string,
): Promise<Stripe.WebhookEndpoint> {
  const matches = (
    await stripe.webhookEndpoints.list({ limit: 100 }).autoPagingToArray({ limit: 10_000 })
  ).filter(endpoint => endpoint.url === exactUrl)
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} webhook endpoints at exact URL ${exactUrl}`)
  }
  const existing = matches[0]
  const endpoint = await stripe.webhookEndpoints.create({
    url: exactUrl,
    enabled_events: [...STRIPE_SUBSCRIPTION_WEBHOOK_EVENTS],
  })
  if (endpoint.secret === undefined) {
    throw new Error('Stripe webhook creation response did not include a signing secret')
  }
  // Create first so a Stripe creation error cannot remove the working endpoint.
  if (existing !== undefined) await stripe.webhookEndpoints.del(existing.id)
  return endpoint
}

function priceLookupKey(plan: SubscriptionPlanId): string {
  return `duet_monthly_${plan}_v1`
}

function owned(metadata: Stripe.Metadata | null | undefined): boolean {
  return metadata?.owner === OWNER
}

async function provisionProduct(stripe: Stripe): Promise<Stripe.Product> {
  const matches = (
    await stripe.products.list({ limit: 100 }).autoPagingToArray({ limit: 10_000 })
  ).filter(product => owned(product.metadata))
  if (matches.length > 1) throw new Error(`Found ${matches.length} products owned by ${OWNER}`)
  const existing = matches[0]
  if (existing !== undefined) {
    if (!existing.active || existing.name !== PRODUCT_NAME) {
      throw new Error(`Owned product ${existing.id} has drifted`)
    }
    return existing
  }
  return await stripe.products.create({
    name: PRODUCT_NAME,
    metadata: { owner: OWNER },
  })
}

async function provisionPrice(
  stripe: Stripe,
  productId: string,
  plan: SubscriptionPlanId,
): Promise<Stripe.Price> {
  const lookupKey = priceLookupKey(plan)
  const matches = (await stripe.prices.list({ lookup_keys: [lookupKey], limit: 100 })).data
  if (matches.length > 1) throw new Error(`Lookup key ${lookupKey} is not unique`)
  const existing = matches[0]
  const expectedCents = SUBSCRIPTION_PLANS[plan].monthlyPriceMicroUsd / 10_000
  if (existing !== undefined) {
    const existingProduct =
      typeof existing.product === 'string' ? existing.product : existing.product.id
    if (
      !owned(existing.metadata) ||
      !existing.active ||
      existingProduct !== productId ||
      existing.currency !== 'usd' ||
      existing.unit_amount !== expectedCents ||
      existing.recurring?.interval !== 'month' ||
      existing.recurring.interval_count !== 1
    ) {
      throw new Error(`Price ${existing.id} at ${lookupKey} is not the expected Duet price`)
    }
    return existing
  }
  return await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: expectedCents,
    recurring: { interval: 'month', interval_count: 1 },
    lookup_key: lookupKey,
    nickname: `Duet ${plan}`,
    metadata: { owner: OWNER, plan },
  })
}

function portalCreateParams(): Stripe.BillingPortal.ConfigurationCreateParams {
  return {
    name: PORTAL_NAME,
    metadata: { owner: PORTAL_OWNER },
    business_profile: {
      terms_of_service_url: 'https://duet.so/terms',
      privacy_policy_url: 'https://duet.so/privacy-policy',
    },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
    },
  }
}

function verifyPortal(portal: Stripe.BillingPortal.Configuration): void {
  const update = portal.features.subscription_update
  const cancel = portal.features.subscription_cancel
  if (
    portal.metadata?.owner !== PORTAL_OWNER ||
    !portal.active ||
    portal.name !== PORTAL_NAME ||
    portal.business_profile.terms_of_service_url !== 'https://duet.so/terms' ||
    portal.business_profile.privacy_policy_url !== 'https://duet.so/privacy-policy' ||
    !portal.features.invoice_history.enabled ||
    !portal.features.payment_method_update.enabled ||
    portal.features.customer_update.enabled ||
    update.enabled ||
    (update.products?.length ?? 0) !== 0 ||
    cancel.enabled
  ) {
    throw new Error(`Portal configuration ${portal.id} has drifted from the Duet contract`)
  }
}

export async function provisionPortal(
  stripe: Stripe,
  configuredId: string | undefined,
): Promise<Stripe.BillingPortal.Configuration> {
  if (configuredId !== undefined) {
    const configured = await stripe.billingPortal.configurations.retrieve(configuredId)
    const configuredOwner = configured.metadata?.owner
    if (
      typeof configuredOwner !== 'string' ||
      !configuredOwner.startsWith('duet-monthly-subscriptions')
    ) {
      // Truly foreign config: never touched, strict verify fails closed.
      verifyPortal(configured)
      return configured
    }
    if (configuredOwner === PORTAL_OWNER) {
      // Ours: reconcile drift in place (e.g. a canonical-host change).
      return await reconcilePortal(stripe, configured.id)
    }
    // Older Duet-family config (legacy broad, or an old narrow tag) falls
    // through: the current narrow owner is reused/reconciled/minted below and
    // the older object is left alone.
  }
  const ownedConfigurations = (
    await stripe.billingPortal.configurations
      .list({ limit: 100 })
      .autoPagingToArray({ limit: 10_000 })
  ).filter(configuration => configuration.metadata?.owner === PORTAL_OWNER)
  if (ownedConfigurations.length > 1) {
    throw new Error(
      `Found ${ownedConfigurations.length} portal configurations owned by ${PORTAL_OWNER}`,
    )
  }
  const existing = ownedConfigurations[0]
  if (existing !== undefined) {
    return await reconcilePortal(stripe, existing.id)
  }
  return await stripe.billingPortal.configurations.create(portalCreateParams())
}

// Duet-owned configs reconcile drift in place; foreign configs are never
// updated — the strict verify on the configured-id path fails closed instead.
async function reconcilePortal(
  stripe: Stripe,
  id: string,
): Promise<Stripe.BillingPortal.Configuration> {
  const params = portalCreateParams()
  const reconciled = await stripe.billingPortal.configurations.update(id, {
    name: params.name,
    metadata: params.metadata,
    business_profile: params.business_profile,
    active: true,
    features: {
      ...params.features,
      customer_update: { enabled: false },
      subscription_update: { enabled: false, products: [] },
      subscription_cancel: { enabled: false },
    },
  })
  verifyPortal(reconciled)
  return reconciled
}

async function main(): Promise<void> {
  const key = requireProvisioningKey(
    process.env.STRIPE_SECRET_KEY,
    process.argv.includes('--confirm-live'),
  )
  const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION })
  const product = await provisionProduct(stripe)
  const priceEntries = await Promise.all(
    PLAN_IDS.map(
      async plan => [plan, (await provisionPrice(stripe, product.id, plan)).id] as const,
    ),
  )
  const priceIds = Object.fromEntries(priceEntries) as Record<SubscriptionPlanId, string>
  console.log(`STRIPE_STARTER_RECURRING_PRICE_ID=${priceIds.starter}`)
  console.log(`STRIPE_PRO_RECURRING_PRICE_ID=${priceIds.pro}`)
  console.log(`STRIPE_MAX_RECURRING_PRICE_ID=${priceIds.max}`)
  const portal = await provisionPortal(stripe, process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID)
  verifyPortal(portal)
  console.log(`STRIPE_BILLING_PORTAL_CONFIGURATION_ID=${portal.id}`)
  console.log('PORTAL_D1=first-party-plan-changes;portal=payment-method+invoice-history')
  const webhookUrl = parseWebhookUrl(process.argv.slice(2))
  if (webhookUrl !== undefined) {
    const webhook = await provisionWebhook(stripe, webhookUrl)
    console.log(`STRIPE_WEBHOOK_SECRET=${webhook.secret}`)
  }
}

if (import.meta.main) await main()
