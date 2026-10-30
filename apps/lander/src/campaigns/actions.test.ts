import { describe, expect, test } from 'bun:test'

import { handleCampaignAction, type CampaignActionDependencies } from './actions'

const APP_URL = 'https://app.test'

function dependencies(
  overrides: Partial<CampaignActionDependencies> & {
    mutations?: Array<{ name: string; args: Record<string, unknown> }>
  } = {},
): CampaignActionDependencies {
  const mutations = overrides.mutations ?? []
  return {
    appUrl: overrides.appUrl ?? APP_URL,
    now: () => 1_000,
    convexMutation:
      overrides.convexMutation ??
      (async (name, args) => {
        mutations.push({ name, args })
        return { ok: true, attributionId: 'journey-signup', expiresAt: 31_000, leadId: 'lead-1' }
      }),
  }
}

describe('lander campaign actions', () => {
  test('signup mints in Convex and redirects the opaque handoff with a journey cookie', async () => {
    const mutations: Array<{ name: string; args: Record<string, unknown> }> = []
    const response = await handleCampaignAction(
      new Request('https://lander.test/api/campaigns/main/actions/signup?ignored=1', {
        headers: {
          cookie: 'utm_source=first-touch; duet_campaign_journey=journey-current',
          'x-forwarded-for': '203.0.113.9, 10.0.0.1',
          'user-agent': 'TestBrowser/1.0',
        },
      }),
      { campaignSlug: 'main', action: 'signup' },
      dependencies({ mutations }),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://app.test/api/campaigns/handoff?token=journey-signup',
    )
    expect(response.headers.get('set-cookie')).toContain('duet_campaign_journey=journey-signup')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(mutations).toEqual([
      {
        name: 'domains/campaigns/api:mintAttribution',
        args: expect.objectContaining({
          campaignSlug: 'main',
          action: 'signup',
          currentJourneyToken: 'journey-current',
          signals: expect.objectContaining({
            utm_source: 'first-touch',
            ip: '203.0.113.9',
            userAgent: 'TestBrowser/1.0',
          }),
          now: 1_000,
        }),
      },
    ])
  })

  test('a lead submission inserts one contact row and starts no campaign journey', async () => {
    const mutations: Array<{ name: string; args: Record<string, unknown> }> = []
    const response = await handleCampaignAction(
      new Request('https://lander.test/api/campaigns/main/actions/lead', {
        method: 'POST',
        headers: { cookie: 'fbclid=stale-click' },
        body: JSON.stringify({
          data: { email: 'owner@example.com', source: 'blog' },
        }),
      }),
      { campaignSlug: 'main', action: 'lead' },
      dependencies({ mutations }),
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ leadId: 'lead-1' })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(mutations[0]?.name).toBe('domains/campaigns/api:captureLead')
    expect(mutations[0]?.args).toEqual({
      campaignSlug: 'main',
      data: { email: 'owner@example.com', source: 'blog' },
      now: 1_000,
    })
  })

  test('a disabled or unknown campaign reports not found without side effects', async () => {
    const response = await handleCampaignAction(
      new Request('https://lander.test/api/campaigns/gone/actions/signup'),
      { campaignSlug: 'gone', action: 'signup' },
      dependencies({
        convexMutation: async () => ({ ok: false, error: 'campaign_disabled' }),
      }),
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('a Convex outage answers the stable 502 shape, not an error page', async () => {
    const response = await handleCampaignAction(
      new Request('https://lander.test/api/campaigns/main/actions/lead', {
        method: 'POST',
        body: JSON.stringify({ data: { email: 'owner@example.com' } }),
      }),
      { campaignSlug: 'main', action: 'lead' },
      dependencies({
        convexMutation: async () => {
          throw new Error('convex down')
        },
      }),
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'upstream_unreachable' })
  })

  test('an invalid signup target answers the stable 502 shape without minting attribution', async () => {
    const mutations: Array<{ name: string; args: Record<string, unknown> }> = []
    const response = await handleCampaignAction(
      new Request('https://lander.test/api/campaigns/main/actions/signup'),
      { campaignSlug: 'main', action: 'signup' },
      dependencies({ appUrl: 'not-a-url', mutations }),
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'upstream_unreachable' })
    expect(mutations).toEqual([])
  })

  test('a malformed lead body is rejected before Convex is consulted', async () => {
    const mutations: Array<{ name: string; args: Record<string, unknown> }> = []
    const response = await handleCampaignAction(
      new Request('https://lander.test/api/campaigns/main/actions/lead', {
        method: 'POST',
        body: 'not-json',
      }),
      { campaignSlug: 'main', action: 'lead' },
      dependencies({ mutations }),
    )
    expect(response.status).toBe(400)
    expect(mutations).toEqual([])
  })
})
