import type { GenericMutationCtx } from 'convex/server'

import type { DataModel, Id } from '../../_generated/dataModel'
import { campaignBySlug, type CampaignDefinition, type CampaignDestinations } from './config'
import {
  deliverGoogle,
  deliverMeta,
  deliverOpenAi,
  deliverReddit,
  type DeliveryIdentity,
  type DeliveryView,
  type FetchLike,
} from './destinationAdapters'

export type DestinationName = keyof CampaignDestinations
export type DeliveryOutcome = 'sent' | 'skipped'

type DeliveryMutationCtx = GenericMutationCtx<DataModel>

export interface DeliveryRuntimeDependencies {
  campaignBySlug?: (slug: string) => CampaignDefinition | undefined
  resolveIdentity: () => Promise<DeliveryIdentity>
  env: Readonly<Record<string, string | undefined>>
  fetch: FetchLike
}

export async function runConfiguredDelivery(
  destination: DestinationName,
  delivery: DeliveryView,
  dependencies: DeliveryRuntimeDependencies,
): Promise<DeliveryOutcome> {
  const campaign = (dependencies.campaignBySlug ?? campaignBySlug)(delivery.campaignSlug)
  switch (destination) {
    case 'meta': {
      const config = campaign?.destinations?.meta
      if (config === undefined || !config.enabled) return 'skipped'
      const identity = await dependencies.resolveIdentity()
      await deliverMeta(
        { ...delivery, eventName: config.eventName },
        identity,
        config,
        { accessToken: requiredEnv(dependencies.env, 'META_CONVERSIONS_ACCESS_TOKEN') },
        dependencies.fetch,
      )
      break
    }
    case 'google': {
      const config = campaign?.destinations?.google
      if (config === undefined || !config.enabled) return 'skipped'
      const identity = await dependencies.resolveIdentity()
      await deliverGoogle(
        { ...delivery, eventName: config.conversionActionId },
        identity,
        config,
        {
          clientId: requiredEnv(dependencies.env, 'GOOGLE_DATA_MANAGER_CLIENT_ID'),
          clientSecret: requiredEnv(dependencies.env, 'GOOGLE_DATA_MANAGER_CLIENT_SECRET'),
          refreshToken: requiredEnv(dependencies.env, 'GOOGLE_DATA_MANAGER_REFRESH_TOKEN'),
        },
        dependencies.fetch,
      )
      break
    }
    case 'reddit': {
      const config = campaign?.destinations?.reddit
      if (config === undefined || !config.enabled) return 'skipped'
      const identity = await dependencies.resolveIdentity()
      await deliverReddit(
        { ...delivery, eventName: config.trackingType },
        identity,
        config,
        { accessToken: requiredEnv(dependencies.env, 'REDDIT_CONVERSIONS_ACCESS_TOKEN') },
        dependencies.fetch,
      )
      break
    }
    case 'openai': {
      const config = campaign?.destinations?.openai
      if (config === undefined || !config.enabled) return 'skipped'
      const identity = await dependencies.resolveIdentity()
      await deliverOpenAi(
        { ...delivery, eventName: config.eventType },
        identity,
        config,
        { apiKey: requiredEnv(dependencies.env, 'OPENAI_CONVERSIONS_API_KEY') },
        dependencies.fetch,
      )
      break
    }
  }
  return 'sent'
}

export async function completeDeliveryRun(
  ctx: DeliveryMutationCtx,
  runId: string,
  outcome: DeliveryOutcome,
  now = Date.now(),
): Promise<Id<'conversionDeliveries'> | null> {
  const delivery = await ctx.db
    .query('conversionDeliveries')
    .withIndex('by_active_run', q => q.eq('activeRunId', runId))
    .unique()
  if (delivery === null) return null
  await ctx.db.patch(delivery._id, {
    activeRunId: undefined,
    ...(outcome === 'sent' ? { sentAt: now } : { skippedAt: now }),
    lastError: undefined,
    updatedAt: now,
  })
  return delivery._id
}

export async function settleDeliveryRun(
  ctx: DeliveryMutationCtx,
  runId: string,
  returnValue: unknown,
  now = Date.now(),
): Promise<Id<'conversionDeliveries'> | null> {
  try {
    return await completeDeliveryRun(ctx, runId, parseDeliveryOutcome(returnValue), now)
  } catch (error) {
    // The retrier swallows a completion-callback throw and still marks the
    // run completed, so an unhandled error would strand activeRunId forever.
    const message = error instanceof Error ? error.message : String(error)
    return await failDeliveryRun(ctx, runId, `Delivery completion failed: ${message}`, now)
  }
}

function parseDeliveryOutcome(value: unknown): DeliveryOutcome {
  if (value === 'sent' || value === 'skipped') return value
  throw new Error('Delivery action returned an invalid result')
}

export async function failDeliveryRun(
  ctx: DeliveryMutationCtx,
  runId: string,
  error: string,
  now = Date.now(),
): Promise<Id<'conversionDeliveries'> | null> {
  const delivery = await ctx.db
    .query('conversionDeliveries')
    .withIndex('by_active_run', q => q.eq('activeRunId', runId))
    .unique()
  if (delivery === null) return null
  await ctx.db.patch(delivery._id, {
    activeRunId: undefined,
    lastError: boundedError(error),
    updatedAt: now,
  })
  return delivery._id
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function boundedError(error: string): string {
  return error.length <= 4_096 ? error : `${error.slice(0, 4_093)}...`
}
