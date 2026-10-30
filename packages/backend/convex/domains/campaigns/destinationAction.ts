'use node'

import type { RegisteredAction } from 'convex/server'
import { v } from 'convex/values'

import { JsonObjectSchema, normalizeAttributionSignals } from '@repo/contract'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import { internalAction } from '../../_generated/server'
import type { DeliveryView } from './destinationAdapters'
import { runConfiguredDelivery, type DeliveryOutcome } from './destinationDelivery'
import type { LoadedDelivery } from './destinationExecutor'

type DeliveryRunArgs = {
  deliveryId: Id<'conversionDeliveries'>
}

export const runDelivery: RegisteredAction<'internal', DeliveryRunArgs, DeliveryOutcome> =
  internalAction({
    args: { deliveryId: v.id('conversionDeliveries') },
    handler: async (ctx, args) => {
      const loaded = await ctx.runQuery(
        internal.domains.campaigns.destinationExecutor.loadDelivery,
        args,
      )
      return await runConfiguredDelivery(loaded.delivery.destination, deliveryView(loaded), {
        resolveIdentity: async () =>
          await ctx.runQuery(internal.domains.campaigns.destinationExecutor.loadIdentity, args),
        env: process.env,
        fetch: async (input, init) => await fetch(input, init),
      })
    },
  })

function deliveryView(loaded: LoadedDelivery): DeliveryView {
  const result = JsonObjectSchema.parse(loaded.delivery.result)
  const properties = JsonObjectSchema.parse(result.properties ?? {})
  const signals = normalizeAttributionSignals(loaded.attribution.signals)
  const value = result.value
  const currency = result.currency
  return {
    conversionId: loaded.delivery.conversionId,
    occurredAt: loaded.delivery.occurredAt,
    attributionCreatedAt: loaded.attribution.createdAt,
    campaignSlug: loaded.delivery.campaignSlug,
    attributionSignals: signals,
    ...(signals.sourceUrl === undefined ? {} : { sourceUrl: signals.sourceUrl }),
    ...(loaded.delivery.userId === undefined ? {} : { userId: loaded.delivery.userId }),
    eventName: loaded.delivery.destination,
    ...(typeof value === 'number' ? { value } : {}),
    ...(typeof currency === 'string' ? { currency } : {}),
    properties,
  }
}
