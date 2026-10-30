import { expect, test } from 'bun:test'

import type { AnalyticsEvent } from '@repo/contract'

import { capturePostHogEvent } from './posthog'

test('PostHog receives the stable event identity and original analytics context', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const event: AnalyticsEvent = {
    id: 'event-1',
    name: 'onboarding.started',
    version: 1,
    at: 1_723_000_000_000,
    origin: 'product_browser',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    properties: { step: 'welcome', nested: { ready: true } },
  }

  await capturePostHogEvent(event, {
    apiKey: 'phc_test',
    host: 'https://posthog.example.test/base/',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response(null, { status: 200 })
    },
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]!.url).toBe('https://posthog.example.test/base/capture/')
  expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
    api_key: 'phc_test',
    event: 'onboarding.started',
    timestamp: '2024-08-07T03:06:40.000Z',
    properties: {
      distinct_id: 'user-1',
      $insert_id: 'event-1',
      event_version: 1,
      origin: 'product_browser',
      workspace_id: 'workspace-1',
      step: 'welcome',
      nested: { ready: true },
    },
  })
})

test('PostHog non-success responses fail so the action retrier can retry them', async () => {
  await expect(
    capturePostHogEvent(
      {
        id: 'event-2',
        name: 'onboarding.started',
        version: 1,
        at: 1,
        origin: 'product_browser',
        userId: 'user-1',
        properties: {},
      },
      {
        apiKey: 'phc_test',
        host: 'https://posthog.example.test',
        fetch: async () => new Response(null, { status: 503 }),
      },
    ),
  ).rejects.toThrow('PostHog capture failed with HTTP 503')
})
