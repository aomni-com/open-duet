'use node'

import { makeFunctionReference } from 'convex/server'
import { type Infer, v } from 'convex/values'

import { prepareTransactionalEmail } from '@repo/email'
import { TRANSACTIONAL_EMAIL_KINDS, type TransactionalEmailInput } from '@repo/email/contracts'
import { renderPreparedTransactionalEmail } from '@repo/email/render'

import { internalAction } from '../_generated/server'
import { testAuthEmailEnabled } from '../config'
import { sendResendMessage } from './resendTransport'

const claimDelivery = makeFunctionReference<'mutation'>('domains/emailDeliveries/model:claim')
const markDeliverySent = makeFunctionReference<'mutation'>('domains/emailDeliveries/model:markSent')
const markDeliveryFailed = makeFunctionReference<'mutation'>(
  'domains/emailDeliveries/model:markFailed',
)

export const transactionalEmailInputValidator = v.union(
  v.object({
    kind: v.literal(TRANSACTIONAL_EMAIL_KINDS[0]),
    actionUrl: v.string(),
    code: v.optional(v.string()),
    clientName: v.optional(v.string()),
    expiresInMinutes: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal(TRANSACTIONAL_EMAIL_KINDS[1]),
    actionUrl: v.string(),
    role: v.union(v.literal('editor'), v.literal('viewer')),
  }),
  v.object({
    kind: v.literal(TRANSACTIONAL_EMAIL_KINDS[2]),
    actionUrl: v.string(),
    sharerName: v.string(),
    folderName: v.string(),
  }),
  v.object({
    kind: v.literal(TRANSACTIONAL_EMAIL_KINDS[3]),
    actionUrl: v.string(),
    jobId: v.string(),
    recipientName: v.optional(v.string()),
  }),
)

type Assert<T extends true> = T
export type ValidatorAcceptsEveryTransactionalEmail = Assert<
  TransactionalEmailInput extends Infer<typeof transactionalEmailInputValidator> ? true : false
>
export type TransactionalEmailAcceptsEveryValidatedInput = Assert<
  Infer<typeof transactionalEmailInputValidator> extends TransactionalEmailInput ? true : false
>

export const sendTransactional = internalAction({
  args: {
    to: v.string(),
    idempotencyKey: v.string(),
    email: transactionalEmailInputValidator,
  },
  handler: async (ctx, args) => {
    const prepared = prepareTransactionalEmail(args.email)
    const now = Date.now()
    const claim = (await ctx.runMutation(claimDelivery, {
      kind: args.email.kind,
      to: args.to,
      subject: prepared.subject,
      idempotencyKey: args.idempotencyKey,
      now,
    })) as { send: boolean; deliveryId: string }
    if (!claim.send) return { sent: false as const, duplicate: true as const }

    try {
      const html = await renderPreparedTransactionalEmail(prepared).catch(() => {
        throw new Error('Email rendering failed')
      })
      if (testAuthEmailEnabled()) {
        await ctx.runMutation(markDeliverySent, {
          deliveryId: claim.deliveryId,
          providerId: 'test-capture',
          now: Date.now(),
        })
        return { sent: true as const, duplicate: false as const }
      }

      const payload = await sendResendMessage({
        from: process.env.DUET_EMAIL_FROM ?? 'Duet <team@mail.duet.so>',
        to: args.to,
        subject: prepared.subject,
        html,
        idempotencyKey: args.idempotencyKey,
      })
      await ctx.runMutation(markDeliverySent, {
        deliveryId: claim.deliveryId,
        ...(payload.id === undefined ? {} : { providerId: payload.id }),
        now: Date.now(),
      })
      return { sent: true as const, duplicate: false as const }
    } catch (error) {
      await ctx.runMutation(markDeliveryFailed, {
        deliveryId: claim.deliveryId,
        error: error instanceof Error ? error.message : 'Email delivery failed',
        now: Date.now(),
      })
      throw error
    }
  },
})
