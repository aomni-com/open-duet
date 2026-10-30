'use node'

import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'
import Stripe from 'stripe'

import { action, type ActionCtx } from '../../_generated/server'
import { useTestFakeStripe } from '../../config'
import {
  NO_PAYMENT_METHOD_FAILURE_CODE,
  createStripeClient,
  createTopupInvoice,
  deterministicStripeIdSuffix,
  type StripeTopupInvoicesClient,
} from '../../services/stripe'
import { requireApiInternalKey } from '../apiKeys/model'

const GENERIC_TOPUP_FAILURE_MESSAGE =
  'We could not add credits with your saved payment method. Please update your card or try again.'

export const attemptTopup = action({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    userId: v.optional(v.id('users')),
    amountMicroUsd: v.number(),
    idempotencyKey: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.object({
    ok: v.boolean(),
    reason: v.optional(v.string()),
    invoiceId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (args.amountMicroUsd <= 0) return { ok: false, reason: 'invalid_amount' }

    const attempt = (await ctx.runMutation(
      fnMutation('domains/credits/internal:createTopupAttempt'),
      {
        internalKey: args.internalKey,
        workspaceId: args.workspaceId,
        userId: args.userId,
        amountMicroUsd: args.amountMicroUsd,
        idempotencyKey: args.idempotencyKey,
        now: args.now,
      },
    )) as {
      created: boolean
      attempt: {
        stripeInvoiceId?: string
        status: string
        failureCode?: string
      } | null
      account: { id: string; stripeCustomerId?: string }
    }
    if (!attempt.created) {
      return {
        ok: attempt.attempt?.status !== 'failed',
        reason:
          attempt.attempt?.status === 'failed'
            ? (attempt.attempt.failureCode ?? 'stripe_status_failed')
            : undefined,
        invoiceId: attempt.attempt?.stripeInvoiceId,
      }
    }
    if (attempt.account.stripeCustomerId === undefined) {
      await recordTopupError(
        ctx,
        args,
        attempt.account.id,
        'no_stripe_customer',
        'Add a payment method before topping up credits.',
      )
      return { ok: false, reason: 'no_stripe_customer' }
    }

    try {
      const charged = await chargeStripeOrFake({
        workspaceId: args.workspaceId,
        userId: attempt.account.id,
        stripeCustomerId: attempt.account.stripeCustomerId,
        amountMicroUsd: args.amountMicroUsd,
        idempotencyKey: args.idempotencyKey,
      })
      await ctx.runMutation(fnMutation('domains/credits/internal:markTopupAttempt'), {
        internalKey: args.internalKey,
        workspaceId: args.workspaceId,
        userId: attempt.account.id,
        idempotencyKey: args.idempotencyKey,
        status: charged.status === 'paid' ? 'paid' : 'failed',
        stripeInvoiceId: charged.invoiceId,
        failureCode: charged.failureCode,
        failureMessage: charged.failureMessage,
        now: args.now,
      })
      if (charged.status !== 'paid') {
        const code = charged.failureCode ?? `stripe_status_${charged.status}`
        const message = topupFailureMessage(code)
        // Live Stripe also emits invoice.payment_failed, which is the sole counter owner
        // there. The keyless fake has no webhook delivery, so the action simulates it.
        if (charged.failureCountedByWebhook) {
          await recordTopupError(ctx, args, attempt.account.id, code, message)
        } else {
          await recordTopupFailure(ctx, args, attempt.account.id, code, message)
        }
        return {
          ok: false,
          reason: code,
          invoiceId: charged.invoiceId,
        }
      }
      await ctx.runMutation(fnMutation('domains/credits/internal:clearTopupError'), {
        internalKey: args.internalKey,
        workspaceId: args.workspaceId,
        userId: attempt.account.id,
        now: args.now,
      })
      return { ok: true, invoiceId: charged.invoiceId }
    } catch (error) {
      const code = errorCode(error)
      await ctx.runMutation(fnMutation('domains/credits/internal:markTopupAttempt'), {
        internalKey: args.internalKey,
        workspaceId: args.workspaceId,
        userId: attempt.account.id,
        idempotencyKey: args.idempotencyKey,
        status: 'failed',
        failureCode: code,
        failureMessage: error instanceof Error ? error.message : GENERIC_TOPUP_FAILURE_MESSAGE,
        now: args.now,
      })
      await recordTopupFailure(ctx, args, attempt.account.id, code, topupFailureMessage(code))
      return { ok: false, reason: code }
    }
  },
})

async function chargeStripeOrFake(args: {
  workspaceId: string
  userId: string
  stripeCustomerId: string
  amountMicroUsd: number
  idempotencyKey: string
}): Promise<{
  status: 'paid' | 'failed'
  invoiceId?: string
  failureCode?: string
  failureMessage?: string
  failureCountedByWebhook: boolean
}> {
  const apiKey = process.env.STRIPE_SECRET_KEY
  if (apiKey) {
    const result = await createTopupInvoice(createStripeClient(apiKey), args)
    // Live Stripe emits `invoice.payment_failed` only for a payment it was
    // asked to make; a failure before that point has to be counted here.
    return { ...result, failureCountedByWebhook: result.paymentAttempted }
  }
  if (!useTestFakeStripe()) throw new Error('Stripe billing is not configured')
  const result = await createTopupInvoice(fakeTopupInvoicesClient(args), args)
  return { ...result, failureCountedByWebhook: false }
}

function fakeTopupInvoicesClient(args: {
  stripeCustomerId: string
  idempotencyKey: string
}): StripeTopupInvoicesClient {
  const invoiceId = `in_fake_${deterministicStripeIdSuffix(args.idempotencyKey)}`
  return {
    invoices: {
      create: async () => ({ id: invoiceId, status: 'draft' }) as Stripe.Invoice,
      finalizeInvoice: async () => ({ id: invoiceId, status: 'open' }) as Stripe.Invoice,
      pay: async () => {
        if (args.stripeCustomerId.startsWith('fail_')) {
          throw new Stripe.errors.StripeCardError({
            type: 'card_error',
            code: 'card_declined',
            message: 'Fake Stripe card declined',
          })
        }
        return { id: invoiceId, status: 'paid' } as Stripe.Invoice
      },
      voidInvoice: async () => ({ id: invoiceId, status: 'void' }) as Stripe.Invoice,
      retrieve: async () => ({ id: invoiceId, status: 'open', attempted: false }) as Stripe.Invoice,
    },
    invoiceItems: {
      create: async () =>
        ({
          id: `ii_fake_${deterministicStripeIdSuffix(args.idempotencyKey)}`,
        }) as Stripe.InvoiceItem,
    },
    paymentMethods: {
      list: async () =>
        ({
          data: [{ id: `pm_fake_${deterministicStripeIdSuffix(args.stripeCustomerId)}` }],
        }) as unknown as Stripe.ApiList<Stripe.PaymentMethod>,
    },
    customers: {
      retrieve: async () =>
        ({
          id: args.stripeCustomerId,
          invoice_settings: { default_payment_method: null },
        }) as Stripe.Customer,
    },
  }
}

async function recordTopupError(
  ctx: ActionCtx,
  args: { internalKey: string; workspaceId: string; now?: number },
  userId: string,
  code: string,
  message: string,
): Promise<void> {
  await ctx.runMutation(fnMutation('domains/credits/internal:recordTopupError'), {
    internalKey: args.internalKey,
    workspaceId: args.workspaceId,
    userId,
    error: { code, message, at: args.now ?? Date.now() },
  })
}

async function recordTopupFailure(
  ctx: ActionCtx,
  args: { internalKey: string; workspaceId: string; now?: number },
  userId: string,
  code: string,
  message: string,
): Promise<void> {
  await ctx.runMutation(fnMutation('domains/credits/internal:recordInvoicePaymentFailure'), {
    internalKey: args.internalKey,
    workspaceId: args.workspaceId,
    userId,
    error: { code, message, at: args.now ?? Date.now() },
  })
}

function topupFailureMessage(code: string): string {
  if (
    code === 'card_declined' ||
    code === 'authentication_required' ||
    code === 'invoice_payment_failed'
  ) {
    return 'Your payment method was declined. Please update your card or try another payment method.'
  }
  if (code === 'no_stripe_customer' || code === NO_PAYMENT_METHOD_FAILURE_CODE)
    return 'Add a payment method before topping up credits.'
  return GENERIC_TOPUP_FAILURE_MESSAGE
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code
  return 'stripe_error'
}

function fnMutation(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}
