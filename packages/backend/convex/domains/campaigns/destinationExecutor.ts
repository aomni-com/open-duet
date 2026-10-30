import { onCompleteValidator } from '@convex-dev/action-retrier'
import type { RegisteredMutation, RegisteredQuery } from 'convex/server'
import { v, type Infer } from 'convex/values'

import { normalizeAttributionSignals } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import { internalMutation, internalQuery } from '../../_generated/server'
import type { DeliveryIdentity } from './destinationAdapters'
import { failDeliveryRun, settleDeliveryRun } from './destinationDelivery'

type DeliveryRunArgs = {
  deliveryId: Id<'conversionDeliveries'>
}

export interface LoadedDelivery {
  delivery: Doc<'conversionDeliveries'>
  attribution: Doc<'campaignAttributions'>
}

const deliveryRunArgs = { deliveryId: v.id('conversionDeliveries') }

export const loadDelivery: RegisteredQuery<'internal', DeliveryRunArgs, LoadedDelivery> =
  internalQuery({
    args: deliveryRunArgs,
    handler: async (ctx, args) => {
      const delivery = await ctx.db.get(args.deliveryId)
      if (
        delivery === null ||
        delivery.sentAt !== undefined ||
        delivery.skippedAt !== undefined ||
        delivery.activeRunId === undefined
      ) {
        throw new Error('Delivery run no longer owns its row')
      }
      const attribution = await ctx.db.get(delivery.attributionId)
      if (attribution === null) throw new Error('Delivery attribution not found')
      return { delivery, attribution }
    },
  })

export const loadIdentity: RegisteredQuery<'internal', DeliveryRunArgs, DeliveryIdentity> =
  internalQuery({
    args: deliveryRunArgs,
    handler: async (ctx, args) => {
      const delivery = await ctx.db.get(args.deliveryId)
      if (delivery === null) throw new Error('Delivery row not found')
      const [user, attribution] = await Promise.all([
        delivery.userId === undefined ? null : ctx.db.get(delivery.userId),
        ctx.db.get(delivery.attributionId),
      ])
      if (attribution === null) throw new Error('Delivery attribution not found')
      const signals = normalizeAttributionSignals(attribution.signals)
      return {
        ...(user === null ? {} : { email: user.email }),
        ...(delivery.userId === undefined ? {} : { externalId: delivery.userId }),
        ...(signals.ip === undefined ? {} : { ipAddress: signals.ip }),
        ...(signals.userAgent === undefined ? {} : { userAgent: signals.userAgent }),
      }
    },
  })

export const onComplete: RegisteredMutation<
  'internal',
  Infer<typeof onCompleteValidator>,
  null
> = internalMutation({
  args: onCompleteValidator,
  handler: async (ctx, args) => {
    if (args.result.type === 'success') {
      await settleDeliveryRun(ctx, args.runId, args.result.returnValue)
    } else {
      await failDeliveryRun(
        ctx,
        args.runId,
        args.result.type === 'failed' ? args.result.error : 'Delivery run canceled',
      )
    }
    // Completed retrier runs are vacuumed by the component's own daily cron.
    return null
  },
})
