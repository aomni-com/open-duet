import { v } from 'convex/values'

import { internalMutation } from '../../_generated/server'
import { deliveryKindValidator } from '../../deliveryKinds'

const DELIVERY_LEASE_MS = 5 * 60 * 1000

export const claim = internalMutation({
  args: {
    kind: deliveryKindValidator,
    to: v.string(),
    subject: v.string(),
    idempotencyKey: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('emailDeliveries')
      .withIndex('by_idempotencyKey', q => q.eq('idempotencyKey', args.idempotencyKey))
      .unique()
    if (
      existing?.status === 'sent' ||
      (existing?.status === 'sending' && existing.updatedAt > args.now - DELIVERY_LEASE_MS)
    ) {
      return { send: false as const, deliveryId: existing._id }
    }
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        status: 'sending',
        attempts: existing.attempts + 1,
        updatedAt: args.now,
        error: undefined,
      })
      return { send: true as const, deliveryId: existing._id }
    }
    const deliveryId = await ctx.db.insert('emailDeliveries', {
      kind: args.kind,
      to: args.to,
      subject: args.subject,
      idempotencyKey: args.idempotencyKey,
      status: 'sending',
      attempts: 1,
      createdAt: args.now,
      updatedAt: args.now,
    })
    return { send: true as const, deliveryId }
  },
})

export const markSent = internalMutation({
  args: {
    deliveryId: v.id('emailDeliveries'),
    providerId: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: 'sent',
      providerId: args.providerId,
      updatedAt: args.now,
      error: undefined,
    })
  },
})

export const markFailed = internalMutation({
  args: { deliveryId: v.id('emailDeliveries'), error: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: 'failed',
      error: args.error.slice(0, 500),
      updatedAt: args.now,
    })
  },
})
