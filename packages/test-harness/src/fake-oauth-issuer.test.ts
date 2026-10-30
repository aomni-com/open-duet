import { describe, expect, test } from 'bun:test'

import {
  assertFakeIssuerEnvironment,
  createFakeOAuthIssuer,
  type FakeOAuthIssuerFetch,
} from './fake-oauth-issuer.ts'

const BASE_URL = 'https://issuer.test'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
type JsonObject = Record<string, unknown>

describe('fake OAuth issuer RFC-8628 conformance', () => {
  test('the published client logs in and refreshes against the actual issuer', async () => {
    const runtime = await publishedFakeClient()
    const originalFetch = globalThis.fetch
    let now = 1_000
    const issuer = createFakeOAuthIssuer({ approvalDelayMs: 100, now: () => now })
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await issuer.fetch(String(input), init)
        if (String(input).endsWith('/device/code')) {
          const grant = await response.json()
          // Control the external polling hint; client compatibility must not
          // depend on the issuer fixture's default polling cadence.
          return Response.json({ ...grant, interval: 0 }, { status: response.status })
        }
        if (
          String(input).endsWith('/token') &&
          (await response.clone().json()).status === 'pending'
        )
          now += 100
        return response
      },
      { preconnect() {} },
    )
    try {
      runtime.installFakeIssuerIfConfigured({ DUET_CONNECT_FAKE_ISSUER_URL: BASE_URL })
      const oauth = runtime.fakeConnectedProvider('openai-codex')!.auth.oauth!
      const notices: unknown[] = []
      const credential = await oauth.login({
        signal: new AbortController().signal,
        prompt: async () => {
          throw new Error('Device login must not prompt for secrets')
        },
        notify: event => notices.push(event),
      })
      expect(notices).toContainEqual(
        expect.objectContaining({
          type: 'device_code',
          verificationUri: `${BASE_URL}/device`,
          userCode: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
        }),
      )
      expect(credential.access).toMatch(/^fake-oauth-access-/)
      expect(credential.refresh).toMatch(/^fake-oauth-refresh-/)
      expect(await completion(issuer.fetch, credential.access)).toMatchObject({ status: 200 })
      const rotated = await oauth.refresh(credential, new AbortController().signal)
      expect(rotated.refresh).not.toBe(credential.refresh)
      expect(rotated.accountId).toBe(credential.accountId)
      expect(await completion(issuer.fetch, rotated.access)).toMatchObject({ status: 200 })
      const preserved = await oauth.refresh(rotated, new AbortController().signal)
      expect(preserved.refresh).toBe(rotated.refresh)
      expect(await completion(issuer.fetch, preserved.access)).toMatchObject({ status: 200 })
      expect(issuer.requests[0]).toMatchObject({
        method: 'POST',
        path: '/device/code',
        body: {
          client_id: 'duet-agent:openai-codex',
          scope: 'openid profile email',
        },
      })
    } finally {
      globalThis.fetch = originalFetch
      runtime.resetFakeIssuer()
    }
  })

  test('keeps approval time-based and expires the self-contained device grant', async () => {
    let now = 1_000
    const issuer = createFakeOAuthIssuer({ approvalDelayMs: 100, now: () => now })
    const device = await issueDevice(issuer.fetch)
    expect(await poll(issuer.fetch, device)).toEqual({ status: 'pending' })
    now += Number(device.expires_in) * 1_000
    expect(await poll(issuer.fetch, device)).toEqual({ status: 'expired' })
  })

  test('returns plan ineligibility and deterministic quota exhaustion from the model seam', async () => {
    const ineligible = createFakeOAuthIssuer({ approvalDelayMs: 0, plan: 'ineligible' })
    const ineligibleTokens = await approve(ineligible.fetch)
    expect(
      await completion(ineligible.fetch, textField(ineligibleTokens, 'access_token')),
    ).toMatchObject({ status: 402, body: { error: { message: 'plan not eligible' } } })

    let now = 1_000
    const quota = createFakeOAuthIssuer({ approvalDelayMs: 0, quotaAfterMs: 100, now: () => now })
    const quotaTokens = await approve(quota.fetch)
    expect(await completion(quota.fetch, textField(quotaTokens, 'access_token'))).toMatchObject({
      status: 200,
      body: expect.stringContaining('data: [DONE]'),
    })
    now += 100
    expect(await completion(quota.fetch, textField(quotaTokens, 'access_token'))).toMatchObject({
      status: 429,
      body: { error: { message: 'usage_limit_reached' } },
    })
  })

  test('refuses real-provider-shaped bearer tokens and production environments', async () => {
    const issuer = createFakeOAuthIssuer({ approvalDelayMs: 0 })
    for (const token of ['sk-real-provider-token', 'eyJhbGciOiJIUzI1NiJ9.payload.signature']) {
      expect(await completion(issuer.fetch, token)).toMatchObject({ status: 401 })
    }
    for (const host of ['ctl.duet.so', 'app.duet.so', 'api.duet.so']) {
      for (const variable of ['DUET_API_URL', 'DUET_APP_URL']) {
        expect(() =>
          assertFakeIssuerEnvironment({
            NODE_ENV: 'test',
            [variable]: `https://${host}`,
          }),
        ).toThrow('never run against production')
      }
    }
    expect(() =>
      assertFakeIssuerEnvironment({
        NODE_ENV: 'production',
        DUET_API_URL: 'https://api-staging.duet.so',
      }),
    ).not.toThrow()
  })
})

async function issueDevice(fetchImpl: FakeOAuthIssuerFetch): Promise<JsonObject> {
  return await post(fetchImpl, BASE_URL, '/device/code', {
    client_id: 'duet-agent:openai-codex',
    scope: 'openid profile email',
  })
}

async function poll(fetchImpl: FakeOAuthIssuerFetch, device: JsonObject): Promise<JsonObject> {
  return await post(fetchImpl, BASE_URL, '/token', {
    device_code: textField(device, 'device_code'),
    grant_type: DEVICE_GRANT,
  })
}

async function approve(fetchImpl: FakeOAuthIssuerFetch): Promise<JsonObject> {
  return await poll(fetchImpl, await issueDevice(fetchImpl))
}

async function completion(
  fetchImpl: FakeOAuthIssuerFetch,
  accessToken: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture-model', stream: true }),
  })
  const contentType = response.headers.get('content-type') ?? ''
  return {
    status: response.status,
    body: contentType.includes('application/json') ? await response.json() : await response.text(),
  }
}

async function post(
  fetchImpl: FakeOAuthIssuerFetch,
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<JsonObject> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as JsonObject
}

function textField(value: JsonObject, field: string): string {
  const item = value[field]
  if (typeof item !== 'string') throw new Error(`Expected ${field} to be a string`)
  return item
}

async function publishedFakeClient(): Promise<
  typeof import('../../agent/dist/src/connected-providers/fake-issuer')
> {
  const packageJson = import.meta.resolve('@repo/agent/package.json')
  return await import(new URL('./dist/src/connected-providers/fake-issuer.js', packageJson).href)
}
