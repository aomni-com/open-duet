import {
  SubscriptionStatusSchema,
  type SubscriptionPlanId,
  type SubscriptionStatus,
} from '@repo/contract'

import { stripePlanForPriceId } from '../../config'

type Env = NodeJS.ProcessEnv

interface NormalizedBase {
  eventId: string
  eventCreatedAt: number
}

export type NormalizedSubscriptionEvent =
  | (NormalizedBase & {
      kind: 'invoice_paid'
      invoiceId: string
      invoiceCreatedAt: number
      customerId: string
      subscriptionId: string
      priceId: string
      plan: SubscriptionPlanId
      periodStart: number
      periodEnd: number
      billingReason: 'subscription_create' | 'subscription_cycle' | 'subscription_update'
    })
  | (NormalizedBase & {
      kind: 'invoice_payment_failed'
      invoiceId: string
      invoiceCreatedAt: number
      customerId: string
      subscriptionId: string
      priceId: string
      plan: SubscriptionPlanId
      periodEnd: number
    })
  | (NormalizedBase & {
      kind: 'subscription_lifecycle'
      customerId: string
      subscriptionId: string
      priceId: string
      plan: SubscriptionPlanId
      status: SubscriptionStatus
      currentPeriodStart: number
      currentPeriodEnd: number
      cancelAtPeriodEnd: boolean
      pendingPlan?: SubscriptionPlanId
    })
  | (NormalizedBase & {
      kind: 'subscription_deleted'
      customerId: string
      subscriptionId: string
      priceId: string
      plan: SubscriptionPlanId
      currentPeriodStart: number
      currentPeriodEnd: number
    })
  | (NormalizedBase & { kind: 'not_ours'; eventType: string })

export function normalizeSubscriptionEvent(
  input: unknown,
  env: Env = process.env,
  related: { subscriptionSchedule?: unknown } = {},
): NormalizedSubscriptionEvent {
  const event = record(input)
  const eventId = requiredString(event.id, 'event.id')
  const eventCreatedAt = stripeTimestampMs(event.created, 'event.created')
  const eventType = requiredString(event.type, 'event.type')
  const base = { eventId, eventCreatedAt }
  const object = record(record(event.data).object)

  if (eventType === 'invoice.paid') return normalizeInvoice(object, base, eventType, env)
  if (eventType === 'invoice.payment_failed') {
    return normalizeFailedInvoice(object, base, eventType, env)
  }
  if (
    eventType === 'customer.subscription.created' ||
    eventType === 'customer.subscription.updated'
  ) {
    return normalizeLifecycle(object, base, eventType, env, related)
  }
  if (eventType === 'customer.subscription.deleted') {
    return normalizeDeleted(object, base, eventType, env)
  }
  return { kind: 'not_ours', ...base, eventType }
}

function normalizeFailedInvoice(
  invoice: Record<string, unknown>,
  base: NormalizedBase,
  eventType: string,
  env: Env,
): NormalizedSubscriptionEvent {
  const parent = optionalRecord(invoice.parent)
  const details = optionalRecord(parent?.subscription_details)
  const metadata = optionalRecord(details?.metadata)
  if (!isDuetV2SubscriptionMetadata(metadata)) return { kind: 'not_ours', ...base, eventType }
  const subscriptionId = idOf(details?.subscription)
  if (subscriptionId === undefined) throw new Error('Duet invoice has no subscription id')
  const line = recognizedInvoiceLine(invoice, env)
  return {
    kind: 'invoice_payment_failed',
    ...base,
    invoiceId: requiredString(invoice.id, 'invoice.id'),
    invoiceCreatedAt: stripeTimestampMs(invoice.created, 'invoice.created'),
    customerId: requiredId(invoice.customer, 'invoice.customer'),
    subscriptionId,
    priceId: line.priceId,
    plan: line.plan,
    periodEnd: line.periodEnd,
  }
}

function normalizeInvoice(
  invoice: Record<string, unknown>,
  base: NormalizedBase,
  eventType: string,
  env: Env,
): NormalizedSubscriptionEvent {
  const parent = optionalRecord(invoice.parent)
  const details = optionalRecord(parent?.subscription_details)
  const metadata = optionalRecord(details?.metadata)
  if (!isDuetV2SubscriptionMetadata(metadata)) return { kind: 'not_ours', ...base, eventType }

  const billingReason = invoice.billing_reason
  if (
    billingReason !== 'subscription_create' &&
    billingReason !== 'subscription_cycle' &&
    billingReason !== 'subscription_update'
  ) {
    return { kind: 'not_ours', ...base, eventType }
  }
  const subscriptionId = idOf(details?.subscription)
  if (subscriptionId === undefined) throw new Error('Duet invoice has no subscription id')
  const line = recognizedInvoiceLine(invoice, env)

  return {
    kind: 'invoice_paid',
    ...base,
    invoiceId: requiredString(invoice.id, 'invoice.id'),
    invoiceCreatedAt: stripeTimestampMs(invoice.created, 'invoice.created'),
    customerId: requiredId(invoice.customer, 'invoice.customer'),
    subscriptionId,
    priceId: line.priceId,
    plan: line.plan,
    periodStart: line.periodStart,
    periodEnd: line.periodEnd,
    billingReason,
  }
}

function recognizedInvoiceLine(invoice: Record<string, unknown>, env: Env) {
  const candidates = array(record(invoice.lines).data)
    .map(line => invoiceLineCandidate(line, env))
    .filter(candidate => candidate !== undefined)
  if (candidates.length === 0)
    throw new Error('Duet invoice has no recognized recurring price line')
  const latestStart = Math.max(...candidates.map(candidate => candidate.periodStart))
  const latest = candidates.filter(candidate => candidate.periodStart === latestStart)
  if (latest.length !== 1) throw new Error('Duet invoice has ambiguous recurring price lines')
  return latest[0]!
}

function invoiceLineCandidate(
  input: unknown,
  env: Env,
):
  | {
      priceId: string
      plan: SubscriptionPlanId
      periodStart: number
      periodEnd: number
    }
  | undefined {
  const line = optionalRecord(input)
  if (line === undefined) return undefined
  const subscriptionItem = optionalRecord(optionalRecord(line.parent)?.subscription_item_details)
  const creditedItems = optionalRecord(subscriptionItem?.proration_details)?.credited_items
  if (creditedItems !== null && creditedItems !== undefined) return undefined
  const priceId = idOf(optionalRecord(optionalRecord(line.pricing)?.price_details)?.price)
  if (priceId === undefined) return undefined
  const plan = stripePlanForPriceId(priceId, env)
  if (plan === undefined) return undefined
  const period = record(line.period)
  return {
    priceId,
    plan,
    periodStart: stripeTimestampMs(period.start, 'invoice line period.start'),
    periodEnd: stripeTimestampMs(period.end, 'invoice line period.end'),
  }
}

function normalizeLifecycle(
  subscription: Record<string, unknown>,
  base: NormalizedBase,
  eventType: string,
  env: Env,
  related: { subscriptionSchedule?: unknown },
): NormalizedSubscriptionEvent {
  if (!isDuetV2SubscriptionMetadata(subscription.metadata)) {
    return { kind: 'not_ours', ...base, eventType }
  }
  const item = recognizedSubscriptionItem(subscription, env)
  const pendingPlan = pendingPlanFromSchedule(
    related.subscriptionSchedule,
    item.currentPeriodEnd,
    env,
  )
  return {
    kind: 'subscription_lifecycle',
    ...base,
    customerId: requiredId(subscription.customer, 'subscription.customer'),
    subscriptionId: requiredString(subscription.id, 'subscription.id'),
    priceId: item.priceId,
    plan: item.plan,
    status: requiredSubscriptionStatus(subscription.status),
    currentPeriodStart: item.currentPeriodStart,
    currentPeriodEnd: item.currentPeriodEnd,
    cancelAtPeriodEnd: requiredBoolean(
      subscription.cancel_at_period_end,
      'subscription.cancel_at_period_end',
    ),
    ...(pendingPlan === undefined ? {} : { pendingPlan }),
  }
}

function pendingPlanFromSchedule(
  input: unknown,
  currentPeriodEnd: number,
  env: Env,
): SubscriptionPlanId | undefined {
  if (input === undefined) return undefined
  const schedule = record(input)
  const futurePhases = array(schedule.phases)
    .map(optionalRecord)
    .filter(phase => phase !== undefined)
    .filter(
      phase => stripeTimestampMs(phase.start_date, 'schedule phase start_date') >= currentPeriodEnd,
    )
    .sort(
      (left, right) =>
        stripeTimestampMs(left.start_date, 'schedule phase start_date') -
        stripeTimestampMs(right.start_date, 'schedule phase start_date'),
    )
  const nextPhase = futurePhases[0]
  if (nextPhase === undefined) return undefined
  const plans = array(nextPhase.items)
    .map(item => idOf(optionalRecord(item)?.price))
    .filter(priceId => priceId !== undefined)
    .map(priceId => stripePlanForPriceId(priceId, env))
    .filter(plan => plan !== undefined)
  if (plans.length !== 1)
    throw new Error('Duet subscription schedule must have one recognized item')
  return plans[0]
}

function normalizeDeleted(
  subscription: Record<string, unknown>,
  base: NormalizedBase,
  eventType: string,
  env: Env,
): NormalizedSubscriptionEvent {
  if (!isDuetV2SubscriptionMetadata(subscription.metadata)) {
    return { kind: 'not_ours', ...base, eventType }
  }
  const item = recognizedSubscriptionItem(subscription, env)
  return {
    kind: 'subscription_deleted',
    ...base,
    customerId: requiredId(subscription.customer, 'subscription.customer'),
    subscriptionId: requiredString(subscription.id, 'subscription.id'),
    priceId: item.priceId,
    plan: item.plan,
    currentPeriodStart: item.currentPeriodStart,
    currentPeriodEnd: item.currentPeriodEnd,
  }
}

function recognizedSubscriptionItem(subscription: Record<string, unknown>, env: Env) {
  const recognized = array(record(subscription.items).data)
    .map(input => {
      const item = optionalRecord(input)
      if (item === undefined) return undefined
      const priceId = idOf(item.price)
      if (priceId === undefined) return undefined
      const plan = stripePlanForPriceId(priceId, env)
      if (plan === undefined) return undefined
      return {
        priceId,
        plan,
        currentPeriodStart: stripeTimestampMs(
          item.current_period_start,
          'subscription item current_period_start',
        ),
        currentPeriodEnd: stripeTimestampMs(
          item.current_period_end,
          'subscription item current_period_end',
        ),
      }
    })
    .filter(item => item !== undefined)
  if (recognized.length !== 1) throw new Error('Duet subscription must have one recognized item')
  return recognized[0]!
}

export function isDuetV2SubscriptionMetadata(input: unknown): boolean {
  const metadata = optionalRecord(input)
  return (
    metadata?.source === 'duet' &&
    typeof metadata.userId === 'string' &&
    metadata.userId.length > 0 &&
    (metadata.type === 'subscription' ||
      (typeof metadata.workspaceId === 'string' && metadata.workspaceId.length > 0))
  )
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  const object = optionalRecord(value)
  return typeof object?.id === 'string' && object.id.length > 0 ? object.id : undefined
}

function requiredId(value: unknown, field: string): string {
  const id = idOf(value)
  if (id === undefined) throw new Error(`${field} must be an id`)
  return id
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a string`)
  return value
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`)
  }
  return value
}

function stripeTimestampMs(value: unknown, field: string): number {
  return requiredNumber(value, field) * 1_000
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
  return value
}

function requiredSubscriptionStatus(value: unknown): SubscriptionStatus {
  const parsed = SubscriptionStatusSchema.safeParse(value)
  if (!parsed.success) throw new Error('subscription.status is not recognized')
  return parsed.data
}
