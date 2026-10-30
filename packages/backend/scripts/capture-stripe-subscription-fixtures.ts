import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import Stripe from 'stripe'

import { normalizeSubscriptionEvent } from '../convex/domains/credits/subscriptionEvents'
import { STRIPE_API_VERSION } from '../convex/services/stripe'
import { requireProvisioningKey } from './provision-stripe-subscriptions'

const FIXTURE_DIR = resolve(import.meta.dir, '../test-fixtures/stripe-subscriptions')
const STARTER_PRICE_ID = requiredEnv('STRIPE_STARTER_RECURRING_PRICE_ID')
const PRO_PRICE_ID = requiredEnv('STRIPE_PRO_RECURRING_PRICE_ID')

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

async function waitForClock(stripe: Stripe, clockId: string): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId)
    if (clock.status === 'ready') return
    if (clock.status === 'internal_failure') throw new Error(`Test clock ${clockId} failed`)
    await Bun.sleep(500)
  }
  throw new Error(`Timed out waiting for test clock ${clockId}`)
}

function objectOf(event: Stripe.Event): Record<string, unknown> {
  return event.data.object as unknown as Record<string, unknown>
}

function stringId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  ) {
    return (value as { id: string }).id
  }
  return undefined
}

function relatedEvent(event: Stripe.Event, customerId: string, subscriptionId: string): boolean {
  const object = objectOf(event)
  if (stringId(object.customer) === customerId || object.id === subscriptionId) return true
  const parent = object.parent as
    | { subscription_details?: { subscription?: string | { id: string } } }
    | undefined
  return stringId(parent?.subscription_details?.subscription) === subscriptionId
}

function subscriptionPriceId(object: Record<string, unknown>): string | undefined {
  const items = object.items as { data?: Array<{ price?: unknown }> } | undefined
  return stringId(items?.data?.[0]?.price)
}

async function listRelatedEvents(
  stripe: Stripe,
  createdAfter: number,
  customerId: string,
  subscriptionId: string,
): Promise<Stripe.Event[]> {
  const events = await stripe.events
    .list({
      created: { gte: createdAfter },
      types: [
        'invoice.paid',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
      ],
      limit: 100,
    })
    .autoPagingToArray({ limit: 100 })
  return events
    .filter(event => relatedEvent(event, customerId, subscriptionId))
    .sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
}

async function waitForRelatedEvents(
  stripe: Stripe,
  createdAfter: number,
  customerId: string,
  subscriptionId: string,
): Promise<Stripe.Event[]> {
  const deadline = Date.now() + 30_000
  let related: Stripe.Event[] = []
  while (Date.now() < deadline) {
    related = await listRelatedEvents(stripe, createdAfter, customerId, subscriptionId)
    if (
      related.some(event => {
        const metadata = objectOf(event).metadata as Record<string, unknown> | undefined
        return metadata?.organizationId === 'fixture_chat_organization'
      })
    ) {
      return related
    }
    await Bun.sleep(500)
  }
  return related
}

async function writeFixture(name: string, event: Stripe.Event | Record<string, unknown>) {
  await writeFile(resolve(FIXTURE_DIR, name), `${JSON.stringify(event, null, 2)}\n`)
  return name
}

async function main(): Promise<void> {
  const key = requireProvisioningKey(process.env.STRIPE_SECRET_KEY, false)
  if (!key.startsWith('sk_test_')) throw new Error('Fixture capture requires an sk_test_ key')
  const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION })
  await mkdir(FIXTURE_DIR, { recursive: true })

  const captureStartedAt = Math.floor(Date.now() / 1000) - 5
  const initialTime = Math.floor(Date.now() / 1000)
  let clockId: string | undefined
  let customerId: string | undefined
  let subscriptionId: string | undefined
  let scheduleId: string | undefined

  try {
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: initialTime,
      name: 'Duet slice 04 fixture capture',
    })
    clockId = clock.id
    const customer = await stripe.customers.create({
      test_clock: clock.id,
      name: 'Duet slice 04 fixture customer',
      metadata: { owner: 'duet-monthly-subscriptions-fixture' },
      payment_method: 'pm_card_visa',
      invoice_settings: { default_payment_method: 'pm_card_visa' },
    })
    customerId = customer.id
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: STARTER_PRICE_ID }],
      metadata: {
        source: 'duet',
        workspaceId: 'fixture_workspace_v2',
        userId: 'fixture_user_v2',
      },
      payment_behavior: 'error_if_incomplete',
    })
    subscriptionId = subscription.id

    const initialItem = subscription.items.data[0]
    if (initialItem === undefined) throw new Error('Created subscription has no item')
    await stripe.testHelpers.testClocks.advance(clock.id, {
      frozen_time: initialItem.current_period_end + 60,
    })
    await waitForClock(stripe, clock.id)

    let current = await stripe.subscriptions.retrieve(subscription.id)
    const currentItem = current.items.data[0]
    if (currentItem === undefined) throw new Error('Renewed subscription has no item')
    await stripe.subscriptions.update(subscription.id, {
      items: [{ id: currentItem.id, price: PRO_PRICE_ID }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
    })

    current = await stripe.subscriptions.retrieve(subscription.id)
    const upgradedItem = current.items.data[0]
    if (upgradedItem === undefined) throw new Error('Upgraded subscription has no item')
    const schedule = await stripe.subscriptionSchedules.create({
      from_subscription: subscription.id,
    })
    scheduleId = schedule.id
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: 'release',
      phases: [
        {
          start_date: schedule.current_phase?.start_date ?? 'now',
          end_date: upgradedItem.current_period_end,
          items: [{ price: PRO_PRICE_ID, quantity: 1 }],
          proration_behavior: 'none',
        },
        {
          start_date: upgradedItem.current_period_end,
          end_date: upgradedItem.current_period_end + 31 * 24 * 60 * 60,
          items: [{ price: STARTER_PRICE_ID, quantity: 1 }],
          proration_behavior: 'none',
        },
      ],
    })

    await stripe.subscriptionSchedules.release(schedule.id)
    scheduleId = undefined
    current = await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true })
    const cancelItem = current.items.data[0]
    if (cancelItem === undefined) throw new Error('Canceling subscription has no item')
    await stripe.testHelpers.testClocks.advance(clock.id, {
      frozen_time: cancelItem.current_period_end + 60,
    })
    await waitForClock(stripe, clock.id)

    const chatInvoice = await stripe.invoices.create({
      customer: customer.id,
      auto_advance: false,
      collection_method: 'charge_automatically',
      metadata: {
        source: 'duet',
        type: 'credit_topup',
        organizationId: 'fixture_chat_organization',
      },
    })
    await stripe.invoiceItems.create({
      customer: customer.id,
      invoice: chatInvoice.id,
      amount: 100,
      currency: 'usd',
      description: 'Chat-app-shaped credit topup fixture',
      metadata: chatInvoice.metadata,
    })
    const finalizedChatInvoice = await stripe.invoices.finalizeInvoice(chatInvoice.id, {
      auto_advance: true,
    })
    if (finalizedChatInvoice.status === 'open') {
      await stripe.invoices.pay(chatInvoice.id, { off_session: true })
    }

    const related = await waitForRelatedEvents(
      stripe,
      captureStartedAt,
      customer.id,
      subscription.id,
    )

    const invoice = (reason: string) =>
      related.find(
        event => event.type === 'invoice.paid' && objectOf(event).billing_reason === reason,
      )
    const lifecycle = (predicate: (object: Record<string, unknown>) => boolean) =>
      related.find(
        event => event.type === 'customer.subscription.updated' && predicate(objectOf(event)),
      )
    const selected = [
      ['01-invoice-create.json', invoice('subscription_create')],
      [
        '02-subscription-created.json',
        related.find(event => event.type === 'customer.subscription.created'),
      ],
      ['03-invoice-renewal.json', invoice('subscription_cycle')],
      ['04-invoice-upgrade.json', invoice('subscription_update')],
      [
        '05-subscription-upgraded.json',
        lifecycle(
          object => subscriptionPriceId(object) === PRO_PRICE_ID && object.schedule === null,
        ),
      ],
      [
        '06-subscription-downgrade-scheduled.json',
        lifecycle(
          object => subscriptionPriceId(object) === PRO_PRICE_ID && object.schedule !== null,
        ),
      ],
      [
        '07-subscription-cancel-scheduled.json',
        lifecycle(object => object.cancel_at_period_end === true),
      ],
      [
        '08-subscription-deleted.json',
        related.find(event => event.type === 'customer.subscription.deleted'),
      ],
    ] as const
    for (const [name, event] of selected) {
      if (event === undefined) throw new Error(`Did not capture ${name}`)
    }

    const names: string[] = []
    for (const [name, event] of selected) names.push(await writeFixture(name, event!))
    const chatEvent = related.find(event => {
      const metadata = objectOf(event).metadata as Record<string, unknown> | undefined
      return (
        event.type === 'invoice.paid' && metadata?.organizationId === 'fixture_chat_organization'
      )
    })
    if (chatEvent === undefined) throw new Error('Did not capture chat-app topup invoice')
    names.push(await writeFixture('09-chat-app-topup-invoice-paid.json', chatEvent))
    console.table(
      await Promise.all(
        names.map(async name => {
          const event = JSON.parse(await readFile(resolve(FIXTURE_DIR, name), 'utf8'))
          const meaning = normalizeSubscriptionEvent(event)
          return {
            fixture: name,
            meaning:
              meaning.kind === 'invoice_paid'
                ? `${meaning.kind}:${meaning.billingReason}:${meaning.plan}`
                : meaning.kind === 'subscription_lifecycle'
                  ? `${meaning.kind}:${meaning.plan}:${meaning.status}`
                  : meaning.kind,
          }
        }),
      ),
    )
  } finally {
    if (scheduleId !== undefined) {
      const id = scheduleId
      await ignoreMissing(() => stripe.subscriptionSchedules.cancel(id))
    }
    if (subscriptionId !== undefined) {
      const id = subscriptionId
      await ignoreMissing(() => stripe.subscriptions.cancel(id))
    }
    if (customerId !== undefined) {
      const id = customerId
      await ignoreMissing(() => stripe.customers.del(id))
    }
    if (clockId !== undefined) {
      const id = clockId
      await ignoreMissing(() => stripe.testHelpers.testClocks.del(id))
    }
  }
}

async function ignoreMissing(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === 'resource_missing'
    ) {
      return
    }
    throw error
  }
}

if (import.meta.main) await main()
