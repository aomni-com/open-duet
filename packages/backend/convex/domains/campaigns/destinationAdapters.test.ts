import { describe, expect, test } from 'bun:test'

import {
  deliverGoogle,
  deliverMeta,
  deliverOpenAi,
  deliverReddit,
  type DeliveryIdentity,
  type DeliveryView,
  type FetchLike,
} from './destinationAdapters'

const delivery: DeliveryView = {
  conversionId: 'conversion-123',
  occurredAt: 1_773_892_800_000,
  attributionCreatedAt: 1_773_806_400_000,
  campaignSlug: 'organic',
  attributionSignals: {
    fbclid: 'meta-click-123',
    gclid: 'google-click-123',
    gbraid: 'google-app-click-ignored',
    wbraid: 'google-web-click-ignored',
    rdt_cid: 'reddit-click-123',
    oppref: 'openai-click-123',
    ip: '203.0.113.10',
    userAgent: 'Duet Test Browser/1.0',
    sourceUrl: 'https://lander.example/signup?campaign=organic',
  },
  sourceUrl: 'https://lander.example/signup?campaign=organic',
  userId: 'user-123',
  eventName: 'registration',
  value: 12.34,
  currency: 'USD',
  properties: { fit: true },
}

const identity: DeliveryIdentity = {
  email: ' Person@Example.COM ',
  externalId: 'user-123',
  ipAddress: '203.0.113.10',
  userAgent: 'Duet Test Browser/1.0',
}

describe('provider destination request contracts', () => {
  test('Meta CAPI request matches the current server-event contract', async () => {
    const requests: CapturedRequest[] = []

    await deliverMeta(
      { ...delivery, eventName: 'CompleteRegistration' },
      identity,
      {
        enabled: true,
        apiVersion: 'v26.0',
        pixelId: 'meta-pixel-123',
        eventName: 'CompleteRegistration',
      },
      { accessToken: 'meta-secret' },
      captureFetch(requests),
    )

    expect(requests).toEqual([
      {
        url: 'https://graph.facebook.com/v26.0/meta-pixel-123/events',
        method: 'POST',
        headers: {
          authorization: 'Bearer meta-secret',
          'content-type': 'application/json',
        },
        body: {
          data: [
            {
              action_source: 'website',
              event_id: 'conversion-123',
              event_name: 'CompleteRegistration',
              event_source_url: 'https://lander.example/signup?campaign=organic',
              event_time: 1_773_892_800,
              user_data: {
                client_ip_address: '203.0.113.10',
                client_user_agent: 'Duet Test Browser/1.0',
                em: ['542d240129883c019e106e3b1b2d3f3cb3537c43c425364de8e951d5a3083345'],
                external_id: ['fcdec6df4d44dbc637c7c5b58efface52a7f8a88535423430255be0bb89bedd8'],
                fbc: 'fb.1.1773806400000.meta-click-123',
              },
              custom_data: { currency: 'USD', value: 12.34 },
            },
          ],
        },
      },
    ])
  })

  test('Google Data Manager refreshes OAuth and ingests an event with exactly one click ID', async () => {
    const requests: CapturedRequest[] = []

    await deliverGoogle(
      delivery,
      identity,
      {
        enabled: true,
        accountId: 'google-ads-123',
        loginAccountId: 'google-manager-456',
        conversionActionId: 'conversion-action-789',
      },
      {
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
        refreshToken: 'google-refresh-token',
      },
      captureFetch(requests, [
        Response.json({ access_token: 'google-access-token', expires_in: 3_600 }),
        Response.json({ requestId: 'request-123' }),
      ]),
    )

    expect(requests).toEqual([
      {
        url: 'https://oauth2.googleapis.com/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'client_id=google-client-id&client_secret=google-client-secret&refresh_token=google-refresh-token&grant_type=refresh_token',
      },
      {
        url: 'https://datamanager.googleapis.com/v1/events:ingest',
        method: 'POST',
        headers: {
          authorization: 'Bearer google-access-token',
          'content-type': 'application/json',
        },
        body: {
          destinations: [
            {
              loginAccount: { accountId: 'google-manager-456', accountType: 'GOOGLE_ADS' },
              operatingAccount: { accountId: 'google-ads-123', accountType: 'GOOGLE_ADS' },
              productDestinationId: 'conversion-action-789',
            },
          ],
          encoding: 'HEX',
          events: [
            {
              adIdentifiers: { gclid: 'google-click-123' },
              conversionValue: 12.34,
              currency: 'USD',
              eventSource: 'WEB',
              eventTimestamp: '2026-03-19T04:00:00.000Z',
              transactionId: 'conversion-123',
              userData: {
                userIdentifiers: [
                  {
                    emailAddress:
                      '542d240129883c019e106e3b1b2d3f3cb3537c43c425364de8e951d5a3083345',
                  },
                ],
              },
            },
          ],
          validateOnly: false,
        },
      },
    ])
  })

  test('Google click identity precedence is gclid, then gbraid, then wbraid', async () => {
    const choices = [
      {
        signals: { gclid: 'g', gbraid: 'gb', wbraid: 'wb' },
        expected: { gclid: 'g' },
      },
      { signals: { gbraid: 'gb', wbraid: 'wb' }, expected: { gbraid: 'gb' } },
      { signals: { wbraid: 'wb' }, expected: { wbraid: 'wb' } },
      { signals: {}, expected: undefined },
    ] as const

    for (const choice of choices) {
      const requests: CapturedRequest[] = []
      await deliverGoogle(
        { ...delivery, attributionSignals: choice.signals },
        identity,
        {
          enabled: true,
          accountId: 'google-ads-123',
          conversionActionId: 'conversion-action-789',
        },
        {
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
          refreshToken: 'google-refresh-token',
        },
        captureFetch(requests, [
          Response.json({ access_token: 'google-access-token' }),
          Response.json({ requestId: 'request-123' }),
        ]),
      )
      expect(
        (requests[1]!.body as { events: Array<{ adIdentifiers?: unknown }> }).events[0]
          ?.adIdentifiers,
      ).toEqual(choice.expected)
    }
  })

  test('Reddit v3 request canonicalizes and hashes identity in memory', async () => {
    const requests: CapturedRequest[] = []

    await deliverReddit(
      { ...delivery, eventName: 'SIGN_UP' },
      {
        ...identity,
        email: 'Al.ice+Apple@Example.Com',
        externalId: 'lead-123',
      },
      {
        enabled: true,
        pixelId: 'reddit-pixel-123',
        trackingType: 'SIGN_UP',
      },
      { accessToken: 'reddit-secret' },
      captureFetch(requests),
    )

    expect(requests).toEqual([
      {
        url: 'https://ads-api.reddit.com/api/v3/pixels/reddit-pixel-123/conversion_events',
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer reddit-secret',
          'content-type': 'application/json',
        },
        body: {
          data: {
            events: [
              {
                action_source: 'WEBSITE',
                click_id: 'reddit-click-123',
                event_at: 1_773_892_800_000,
                event_source_url: 'https://lander.example/signup?campaign=organic',
                metadata: {
                  conversion_id: 'conversion-123',
                  currency: 'USD',
                  value: 12.34,
                },
                type: { tracking_type: 'SIGN_UP' },
                user: {
                  email: 'ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976',
                  external_id: '2f6f3ee1e84eb0de6948acc7ce87a493b4db833b878cd0c72e09bf701220ed63',
                  ip_address: '203.0.113.10',
                  user_agent: 'Duet Test Browser/1.0',
                },
              },
            ],
          },
        },
      },
    ])
  })

  test('OpenAI request converts major units with the configured ISO exponent', async () => {
    const requests: CapturedRequest[] = []

    await deliverOpenAi(
      { ...delivery, eventName: 'registration_completed' },
      identity,
      {
        enabled: true,
        pixelId: 'openai-pixel-123',
        eventType: 'registration_completed',
        dataType: 'customer_action',
        currencyExponents: { USD: 2, JPY: 0 },
      },
      { apiKey: 'openai-secret' },
      captureFetch(requests),
    )

    expect(requests).toEqual([
      {
        url: 'https://bzr.openai.com/v1/events?pid=openai-pixel-123',
        method: 'POST',
        headers: {
          authorization: 'Bearer openai-secret',
          'content-type': 'application/json',
        },
        body: {
          events: [
            {
              action_source: 'web',
              data: {
                amount: 1_234,
                currency: 'USD',
                type: 'customer_action',
              },
              id: 'conversion-123',
              oppref: 'openai-click-123',
              source_url: 'https://lander.example/signup?campaign=organic',
              timestamp_ms: 1_773_892_800_000,
              type: 'registration_completed',
              user: {
                email_sha256: '542d240129883c019e106e3b1b2d3f3cb3537c43c425364de8e951d5a3083345',
                external_id_sha256:
                  'fcdec6df4d44dbc637c7c5b58efface52a7f8a88535423430255be0bb89bedd8',
                ip_address: '203.0.113.10',
                user_agent: 'Duet Test Browser/1.0',
              },
            },
          ],
          validate_only: false,
        },
      },
    ])
  })
})

describe('provider delivery failures', () => {
  for (const status of [400, 429, 500]) {
    test(`every provider throws for HTTP ${status}`, async () => {
      const response = new Response('', { status })
      await expect(
        deliverMeta(
          delivery,
          identity,
          {
            enabled: true,
            apiVersion: 'v26.0',
            pixelId: 'meta-pixel-123',
            eventName: 'CompleteRegistration',
          },
          { accessToken: 'meta-secret' },
          async () => response,
        ),
      ).rejects.toThrow(`Meta delivery failed with HTTP ${status}`)
      await expect(
        deliverReddit(
          delivery,
          identity,
          { enabled: true, pixelId: 'reddit-pixel-123', trackingType: 'SIGN_UP' },
          { accessToken: 'reddit-secret' },
          async () => response,
        ),
      ).rejects.toThrow(`Reddit delivery failed with HTTP ${status}`)
      await expect(
        deliverOpenAi(
          delivery,
          identity,
          {
            enabled: true,
            pixelId: 'openai-pixel-123',
            eventType: 'registration_completed',
            dataType: 'customer_action',
            currencyExponents: { USD: 2 },
          },
          { apiKey: 'openai-secret' },
          async () => response,
        ),
      ).rejects.toThrow(`OpenAI delivery failed with HTTP ${status}`)
    })
  }

  test('Google throws when OAuth or event ingestion is non-success', async () => {
    const config = {
      enabled: true as const,
      accountId: 'google-ads-123',
      conversionActionId: 'conversion-action-789',
    }
    const credentials = {
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
      refreshToken: 'google-refresh-token',
    }

    await expect(
      deliverGoogle(
        delivery,
        identity,
        config,
        credentials,
        async () => new Response('', { status: 429 }),
      ),
    ).rejects.toThrow('Google OAuth refresh failed with HTTP 429')

    let request = 0
    await expect(
      deliverGoogle(delivery, identity, config, credentials, async () => {
        request += 1
        return request === 1
          ? Response.json({ access_token: 'google-access-token' })
          : new Response('', { status: 500 })
      }),
    ).rejects.toThrow('Google delivery failed with HTTP 500')
  })

  test('network errors propagate for retrier ownership', async () => {
    const networkFailure: FetchLike = async () => {
      throw new Error('socket unavailable')
    }
    await expect(
      deliverMeta(
        delivery,
        identity,
        {
          enabled: true,
          apiVersion: 'v26.0',
          pixelId: 'meta-pixel-123',
          eventName: 'CompleteRegistration',
        },
        { accessToken: 'meta-secret' },
        networkFailure,
      ),
    ).rejects.toThrow('socket unavailable')
  })
})

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function captureFetch(
  requests: CapturedRequest[],
  responses: Response[] = [Response.json({ ok: true })],
): FetchLike {
  return async (input, init) => {
    const headers = Object.fromEntries(
      [...new Headers(init?.headers).entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    )
    const contentType = headers['content-type']
    const rawBody = typeof init?.body === 'string' ? init.body : ''
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: contentType === 'application/json' ? JSON.parse(rawBody) : rawBody,
    })
    return responses.shift() ?? Response.json({ ok: true })
  }
}
