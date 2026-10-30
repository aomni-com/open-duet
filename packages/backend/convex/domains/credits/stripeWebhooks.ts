import type { Infer } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { asRecord } from './creditsShared'
import type { processStripeWebhookEventArgs } from './internal'
import { applyLedgerEntryWithDb } from './ledger'
import { resetTopupFailureBilling } from './paymentRecovery'
import { normalizeSubscriptionEvent } from './subscriptionEvents'
import {
  applyPaidSubscriptionInvoiceWithDb,
  applySubscriptionLifecycleWithDb,
  flagSubscriptionDisputeWithDb,
  recordSubscriptionPaymentFailureWithDb,
  reconcileServicingStatus,
} from './subscriptions'
import {
  clearTopupErrorWithDb,
  markPaymentMethodReadyWithDb,
  recordInvoicePaymentFailureWithDb,
} from './topups'

export async function processStripeWebhookEventImpl(
  ctx: MutationCtx,
  args: Infer<typeof processStripeWebhookEventArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const existing = await ctx.db
    .query('stripeWebhookEvents')
    .withIndex('by_eventId', q => q.eq('eventId', args.eventId))
    .first()
  if (existing !== null) return { ok: true, replay: true }
  const now = args.now ?? Date.now()
  const object = asRecord(args.object) ?? {}
  const normalized = normalizeSubscriptionEvent(
    {
      id: args.eventId,
      created: args.eventCreatedAt,
      type: args.type,
      data: { object },
    },
    process.env,
    { subscriptionSchedule: args.subscriptionSchedule },
  )
  if (args.type === 'customer.updated') {
    const previous = asRecord(asRecord(args.previousAttributes)?.invoice_settings)
    const method = asRecord(object.invoice_settings)?.default_payment_method
    if (
      previous &&
      Object.hasOwn(previous, 'default_payment_method') &&
      typeof method === 'string' &&
      method.length > 0 &&
      method !== previous.default_payment_method &&
      typeof object.id === 'string'
    ) {
      const payer = await ctx.db
        .query('users')
        .withIndex('by_stripe_customer', q => q.eq('billing.stripeCustomerId', object.id as string))
        .unique()
      if (payer !== null) {
        await ctx.db.patch(payer._id, {
          billing: {
            ...resetTopupFailureBilling(payer.billing, args.eventCreatedAt * 1000),
            paymentMethodReadyAt: payer.billing?.paymentMethodReadyAt ?? args.eventCreatedAt * 1000,
          },
        })
        await reconcileServicingStatus(ctx, payer._id, now)
      }
    }
  } else if (
    normalized.kind === 'subscription_lifecycle' ||
    normalized.kind === 'subscription_deleted'
  ) {
    await applySubscriptionLifecycleWithDb(ctx, normalized, now)
  } else if (args.type === 'setup_intent.succeeded') {
    const metadata = asRecord(object.metadata) ?? {}
    const workspaceId = metadata.workspaceId
    const userId = metadata.userId
    if (
      metadata.source === 'duet' &&
      metadata.type === 'payment_method_setup' &&
      typeof workspaceId === 'string' &&
      typeof userId === 'string'
    ) {
      await markPaymentMethodReadyWithDb(
        ctx,
        workspaceId as Id<'workspaces'>,
        userId as Id<'users'>,
        now,
        args.eventCreatedAt * 1000,
      )
    }
  } else if (args.type === 'invoice.paid') {
    if (normalized.kind === 'invoice_paid') {
      await applyPaidSubscriptionInvoiceWithDb(ctx, normalized, now)
      await markWebhookProcessed(ctx, args, now)
      return { ok: true }
    }
    const metadata = asRecord(object.metadata) ?? {}
    const workspaceId = metadata.workspaceId
    const userId = metadata.userId
    if (
      metadata.source !== 'duet' ||
      typeof workspaceId !== 'string' ||
      typeof userId !== 'string'
    ) {
      await markWebhookProcessed(ctx, args, now)
      return { ok: true, ignored: true }
    }
    if (!isTopupKind(metadata.type)) {
      await markWebhookProcessed(ctx, args, now)
      return { ok: true, ignored: true }
    }
    const invoiceId = stringField(object.id)
    const totalCents = numberField(object.total) ?? 0
    if (invoiceId !== undefined && totalCents > 0) {
      await applyLedgerEntryWithDb(ctx, {
        workspaceId: workspaceId as Id<'workspaces'>,
        userId: userId as Id<'users'>,
        amountMicroUsd: totalCents * 10_000,
        type: 'topup',
        reference: invoiceId,
        metadata: { source: 'stripe_webhook', eventId: args.eventId, totalCents },
        now,
      })
    }
    await markPaymentMethodReadyWithDb(
      ctx,
      workspaceId as Id<'workspaces'>,
      userId as Id<'users'>,
      now,
      args.eventCreatedAt * 1000,
    )
    await clearTopupErrorWithDb(
      ctx,
      workspaceId as Id<'workspaces'>,
      userId as Id<'users'>,
      now,
      args.eventCreatedAt * 1000,
    )
  } else if (args.type === 'invoice.payment_failed') {
    if (normalized.kind === 'invoice_payment_failed') {
      await recordSubscriptionPaymentFailureWithDb(ctx, normalized, now)
      await markWebhookProcessed(ctx, args, now)
      return { ok: true }
    }
    const metadata = asRecord(object.metadata) ?? {}
    const workspaceId = metadata.workspaceId
    const userId = metadata.userId
    if (
      metadata.source === 'duet' &&
      isTopupKind(metadata.type) &&
      typeof workspaceId === 'string' &&
      typeof userId === 'string'
    ) {
      const message =
        'Your payment method was declined. Please update your card or try another payment method.'
      await recordInvoicePaymentFailureWithDb(
        ctx,
        workspaceId as Id<'workspaces'>,
        userId as Id<'users'>,
        {
          code: 'invoice_payment_failed',
          message,
          at: args.eventCreatedAt * 1000,
        },
        now,
      )
    }
  } else if (args.type === 'charge.dispute.created') {
    const customerId = args.disputeCustomerId
    if (customerId === undefined || !(await flagSubscriptionDisputeWithDb(ctx, customerId, now))) {
      await markWebhookProcessed(ctx, args, now)
      return { ok: true, ignored: true }
    }
  }
  await markWebhookProcessed(ctx, args, now)
  return { ok: true }
}

async function markWebhookProcessed(
  ctx: MutationCtx,
  args: { eventId: string; type: string },
  now: number,
): Promise<void> {
  await ctx.db.insert('stripeWebhookEvents', {
    eventId: args.eventId,
    type: args.type,
    processedAt: now,
  })
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isTopupKind(value: unknown): boolean {
  return value === 'credit_topup' || value === 'credit_topup_manual'
}
