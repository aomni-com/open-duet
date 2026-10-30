import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { normalizeSubscriptionEvent } from './subscriptionEvents'

const fixtureDirectory = resolve(import.meta.dir, '../../../test-fixtures/stripe-subscriptions')
const env = {
  STRIPE_STARTER_RECURRING_PRICE_ID: 'price_1TuClpKD7CmTYhpWZ0BCQ6jy',
  STRIPE_PRO_RECURRING_PRICE_ID: 'price_1TuClpKD7CmTYhpWxqz7Rmlr',
  STRIPE_MAX_RECURRING_PRICE_ID: 'price_1TuClpKD7CmTYhpWyAsfztS2',
}

describe('Stripe subscription event normalization', () => {
  test('normalizes a paid creation invoice from its subscription snapshot and recurring line', async () => {
    const event = await fixture('01-invoice-create.json')

    expect(normalizeSubscriptionEvent(event, env)).toEqual({
      kind: 'invoice_paid',
      eventId: event.id,
      eventCreatedAt: event.created * 1_000,
      invoiceId: event.data.object.id,
      invoiceCreatedAt: event.data.object.created * 1_000,
      customerId: event.data.object.customer,
      subscriptionId: event.data.object.parent.subscription_details.subscription,
      priceId: env.STRIPE_STARTER_RECURRING_PRICE_ID,
      plan: 'starter',
      periodStart: event.data.object.lines.data[0]!.period.start * 1_000,
      periodEnd: event.data.object.lines.data[0]!.period.end * 1_000,
      billingReason: 'subscription_create',
    })
  })

  test('maps every captured fixture to its expected meaning', async () => {
    const cases = [
      [
        '01-invoice-create.json',
        { kind: 'invoice_paid', billingReason: 'subscription_create', plan: 'starter' },
      ],
      [
        '02-subscription-created.json',
        {
          kind: 'subscription_lifecycle',
          plan: 'starter',
          status: 'active',
          cancelAtPeriodEnd: false,
        },
      ],
      [
        '03-invoice-renewal.json',
        { kind: 'invoice_paid', billingReason: 'subscription_cycle', plan: 'starter' },
      ],
      [
        '04-invoice-upgrade.json',
        { kind: 'invoice_paid', billingReason: 'subscription_update', plan: 'pro' },
      ],
      [
        '05-subscription-upgraded.json',
        { kind: 'subscription_lifecycle', plan: 'pro', status: 'active', cancelAtPeriodEnd: false },
      ],
      [
        '06-subscription-downgrade-scheduled.json',
        { kind: 'subscription_lifecycle', plan: 'pro', status: 'active', cancelAtPeriodEnd: false },
      ],
      [
        '07-subscription-cancel-scheduled.json',
        { kind: 'subscription_lifecycle', plan: 'pro', status: 'active', cancelAtPeriodEnd: true },
      ],
      ['08-subscription-deleted.json', { kind: 'subscription_deleted', plan: 'pro' }],
      ['09-chat-app-topup-invoice-paid.json', { kind: 'not_ours', eventType: 'invoice.paid' }],
    ] as const

    for (const [name, expected] of cases) {
      expect(normalizeSubscriptionEvent(await fixture(name), env), name).toMatchObject(expected)
    }
  })

  test('is independent of fixture delivery order', async () => {
    const names = (await readdir(fixtureDirectory)).filter(name => name.endsWith('.json')).sort()
    const fixtures = await Promise.all(names.map(fixture))
    const meanings = fixtures.map(event => normalizeSubscriptionEvent(event, env))
    const permutation = fixtures.map((_, index) => index).reverse()
    const shuffledMeanings = permutation.map(index =>
      normalizeSubscriptionEvent(fixtures[index]!, env),
    )

    expect(Object.fromEntries(meanings.map(meaning => [meaning.eventId, meaning]))).toEqual(
      Object.fromEntries(shuffledMeanings.map(meaning => [meaning.eventId, meaning])),
    )
  })

  test('accepts one authoritative schedule lookup for a pending downgrade', async () => {
    const event = await fixture('06-subscription-downgrade-scheduled.json')

    expect(
      normalizeSubscriptionEvent(event, env, {
        subscriptionSchedule: {
          phases: [
            {
              start_date: event.data.object.items.data[0]!.current_period_end,
              items: [{ price: env.STRIPE_STARTER_RECURRING_PRICE_ID }],
            },
          ],
        },
      }),
    ).toMatchObject({ kind: 'subscription_lifecycle', plan: 'pro', pendingPlan: 'starter' })
  })

  test('provenance rests on our own ids; foreign metadata without them is not ours', async () => {
    const event = await fixture('01-invoice-create.json')
    // Missing our userId — not ours, regardless of any other fields present.
    event.data.object.parent.subscription_details.metadata = {
      source: 'duet',
      organizationId: 'fixture_chat_organization',
    }
    expect(normalizeSubscriptionEvent(event, env)).toMatchObject({ kind: 'not_ours' })

    event.data.object.parent.subscription_details.metadata = {}
    expect(normalizeSubscriptionEvent(event, env)).toMatchObject({ kind: 'not_ours' })

    // A valid first-party event stays ours even if it carries an
    // organizationId — provenance no longer excludes on that field.
    event.data.object.parent.subscription_details.metadata = {
      source: 'duet',
      type: 'subscription',
      userId: 'user_first_party',
      organizationId: 'fixture_chat_organization',
    }
    expect(normalizeSubscriptionEvent(event, env)).toMatchObject({
      kind: 'invoice_paid',
    })
  })

  test('recognizes the first-party subscription Checkout metadata contract', async () => {
    const event = await fixture('02-subscription-created.json')
    event.data.object.metadata = {
      source: 'duet',
      type: 'subscription',
      userId: 'user_checkout',
    }
    expect(normalizeSubscriptionEvent(event, env)).toMatchObject({
      kind: 'subscription_lifecycle',
      plan: 'starter',
    })

    delete event.data.object.metadata.type
    expect(normalizeSubscriptionEvent(event, env)).toMatchObject({ kind: 'not_ours' })
  })

  test('fails closed when a Duet upgrade invoice has ambiguous current price lines', async () => {
    const event = await fixture('04-invoice-upgrade.json')
    event.data.object.lines.data[0]!.parent.subscription_item_details.proration_details.credited_items =
      null

    expect(() => normalizeSubscriptionEvent(event, env)).toThrow(
      'Duet invoice has ambiguous recurring price lines',
    )
  })
})

interface FixtureEvent {
  id: string
  created: number
  type: string
  data: {
    object: {
      id: string
      created: number
      customer: string
      metadata: Record<string, unknown>
      parent: {
        subscription_details: {
          subscription: string
          metadata: Record<string, unknown>
        }
      }
      lines: {
        data: Array<{
          period: { start: number; end: number }
          parent: {
            subscription_item_details: {
              proration_details: { credited_items: unknown }
            }
          }
        }>
      }
      items: { data: Array<{ current_period_end: number }> }
    }
  }
}

async function fixture(name: string): Promise<FixtureEvent> {
  return JSON.parse(await readFile(resolve(fixtureDirectory, name), 'utf8')) as FixtureEvent
}
