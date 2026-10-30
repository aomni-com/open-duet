import { type GenericMutationCtx } from 'convex/server'

import { AnalyticsEventSchema, type AnalyticsEvent } from '@repo/contract'

import { internal } from '../../_generated/api'
import type { DataModel } from '../../_generated/dataModel'
import { retrier } from '../../utils'
import { routeConversionEvent, startConversionRun } from '../campaigns/conversionModel'

type AnalyticsMutationCtx = GenericMutationCtx<DataModel>

export const PRODUCT_BACKEND_ANALYTICS_ORIGIN = 'product_backend'

// Conversion routing is transactional with the product write; the PostHog
// sink is best-effort and deliberately not gated on routing (nor routing on
// sink configuration).
export async function emitAnalyticsEvents(
  ctx: AnalyticsMutationCtx,
  inputs: readonly AnalyticsEvent[],
): Promise<void> {
  const events = inputs.map(input => AnalyticsEventSchema.parse(input))
  if (events.length === 0) return
  for (const event of events) {
    await routeConversionEvent(ctx, event, { startRun: startConversionRun })
  }
  if (isPostHogConfigured()) {
    await retrier.run(ctx, internal.domains.analytics.posthog.captureBatch, { events })
  }
}

export async function emitAnalyticsEvent(
  ctx: AnalyticsMutationCtx,
  event: AnalyticsEvent,
): Promise<void> {
  await emitAnalyticsEvents(ctx, [event])
}

function isPostHogConfigured(): boolean {
  return Boolean(process.env.POSTHOG_API_KEY?.trim() && process.env.POSTHOG_HOST?.trim())
}
