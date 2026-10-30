import { v } from 'convex/values'

import { mutation } from '../../_generated/server'
import { gatewayBlockValidator } from '../../validators'
import { requireApiInternalKey } from '../apiKeys/model'
import { runPreflightWithDb } from '../credits/ledger'
import { enqueueSettlement } from '../credits/settlementQueue'
import { serviceChargeMetadataValidator } from '../credits/settlementTypes'
import { isSubscriber } from '../credits/subscriptions'
import { blocked, paymentBlock, preflightBlock, rateLimitBlock } from '../modelGateway/blocks'
import { consumeServiceRateLimitWithDb } from './rateLimit'

const proxyAuthValidator = v.object({ userId: v.id('users') })

export const proxyPreflight = mutation({
  args: {
    internalKey: v.string(),
    auth: proxyAuthValidator,
    workspaceId: v.id('workspaces'),
    service: v.string(),
    metered: v.boolean(),
    now: v.optional(v.number()),
  },
  returns: v.union(
    v.object({
      proceed: v.literal(true),
      workspaceId: v.id('workspaces'),
      userId: v.id('users'),
    }),
    v.object({ proceed: v.literal(false), block: gatewayBlockValidator }),
  ),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')

    const servicingStatus = workspace.servicingStatus ?? 'active'
    if (servicingStatus === 'paused') return blocked(paymentBlock('subscription_inactive'))
    if (servicingStatus === 'banned') return blocked(paymentBlock('payment_required'))

    const billingUser = await ctx.db.get(workspace.billingUserId)
    if (billingUser === null) throw new Error('Billing user not found')
    const now = args.now ?? Date.now()
    const preflight = args.metered
      ? await runPreflightWithDb(ctx, {
          workspaceId: workspace._id,
          userId: args.auth.userId,
          now,
        })
      : undefined
    if (preflight?.reason === 'subscription_required') {
      return blocked(preflightBlock(preflight.reason, preflight.tier, preflight.balanceMicroUsd))
    }

    const rateLimit = await consumeServiceRateLimitWithDb(ctx, {
      workspaceId: workspace._id,
      paid: isSubscriber(billingUser),
      now,
    })
    if (!rateLimit.ok) return blocked(rateLimitBlock(rateLimit.retryAfterSeconds))

    if (preflight !== undefined && !preflight.proceed) {
      return blocked(preflightBlock(preflight.reason, preflight.tier, preflight.balanceMicroUsd))
    }

    return {
      proceed: true as const,
      workspaceId: workspace._id,
      userId: args.auth.userId,
    }
  },
})

export const chargeServiceCall = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    amountMicroUsd: v.number(),
    reference: v.string(),
    metadata: serviceChargeMetadataValidator,
    now: v.optional(v.number()),
  },
  returns: v.object({ accepted: v.literal(true), settlementId: v.id('billingSettlements') }),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await enqueueSettlement(ctx, {
      kind: 'service',
      workspaceId: args.workspaceId,
      userId: args.userId,
      amountMicroUsd: args.amountMicroUsd,
      reference: args.reference,
      metadata: args.metadata,
      occurredAt: args.now ?? Date.now(),
    })
  },
})
