import { v } from 'convex/values'

import { AnalyticsEventSchema, type AnalyticsEvent, type FetchLike } from '@repo/contract'

import { internalAction } from '../../_generated/server'

interface PostHogCaptureOptions {
  apiKey: string
  host: string
  fetch: FetchLike
}

const POSTHOG_CAPTURE_CONCURRENCY = 10

export async function capturePostHogEvent(
  input: AnalyticsEvent,
  options: PostHogCaptureOptions,
): Promise<void> {
  const event = AnalyticsEventSchema.parse(input)
  const response = await options.fetch(new URL('capture/', ensureTrailingSlash(options.host)), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: options.apiKey,
      event: event.name,
      timestamp: new Date(event.at).toISOString(),
      properties: {
        ...event.properties,
        // Only ever the user: an event that cannot name one is not a product
        // fact a sink can attribute, and inventing an ID would mint a
        // throwaway person that merges with nothing.
        distinct_id: event.userId,
        $insert_id: event.id,
        event_version: event.version,
        origin: event.origin,
        ...(event.workspaceId === undefined ? {} : { workspace_id: event.workspaceId }),
        ...(event.attributionId === undefined ? {} : { attribution_id: event.attributionId }),
      },
    }),
  })
  if (!response.ok) {
    throw new Error(`PostHog capture failed with HTTP ${response.status}`)
  }
}

export const captureBatch = internalAction({
  args: { events: v.array(v.any()) },
  handler: async (_ctx, args) => {
    const apiKey = process.env.POSTHOG_API_KEY
    const host = process.env.POSTHOG_HOST
    if (!apiKey?.trim() || !host?.trim()) return null
    for (let offset = 0; offset < args.events.length; offset += POSTHOG_CAPTURE_CONCURRENCY) {
      await Promise.all(
        args.events.slice(offset, offset + POSTHOG_CAPTURE_CONCURRENCY).map(input =>
          capturePostHogEvent(AnalyticsEventSchema.parse(input), {
            apiKey,
            host,
            fetch,
          }),
        ),
      )
    }
    return null
  },
})

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}
