import { describe, expect, test } from 'bun:test'

import { createFakeOAuthIssuer } from '@repo/fake-oauth-issuer'

import { createApiApp } from './index'

const BASE_URL = 'https://api.example/v1/test-only/oauth-issuer'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

describe('test-only fake OAuth issuer routes', () => {
  test('are absent unless explicitly enabled', async () => {
    for (const env of [{}, { DUET_ENABLE_FAKE_OAUTH_ISSUER: 'true' }]) {
      const app = createApiApp({
        convexUrl: 'https://example.convex.cloud',
        internalKey: 'test-api-internal-key',
        env,
      })

      const response = await post(app, '/device/code', {
        client_id: 'duet-agent:openai-codex',
        scope: 'openid profile email',
      })

      expect(response.status).toBe(404)
    }
  })

  test('complete a device-code round trip when enabled', async () => {
    let now = 1_000
    const issuer = createFakeOAuthIssuer({ approvalDelayMs: 100, now: () => now })
    const app = createApiApp({
      convexUrl: 'https://example.convex.cloud',
      internalKey: 'test-api-internal-key',
      env: { DUET_ENABLE_FAKE_OAUTH_ISSUER: '1' },
      fakeOAuthIssuer: issuer,
    })

    const deviceResponse = await post(app, '/device/code', {
      client_id: 'duet-agent:openai-codex',
      scope: 'openid profile email',
    })
    expect(deviceResponse.status).toBe(200)
    const device = (await deviceResponse.json()) as Record<string, unknown>

    const pending = await post(app, '/token', {
      device_code: device.device_code,
      grant_type: DEVICE_GRANT,
    })
    expect(await pending.json()).toEqual({ status: 'pending' })

    now += 100

    const token = await post(app, '/token', {
      device_code: device.device_code,
      grant_type: DEVICE_GRANT,
    })
    expect(token.status).toBe(200)
    expect(await token.json()).toEqual({
      access_token: expect.stringMatching(/^fake-oauth-access-/),
      refresh_token: expect.stringMatching(/^fake-oauth-refresh-/),
      expires_in: 3_600,
      account_id: expect.stringMatching(/^fake-account-openai-codex-/),
    })
  })

  test('preserve grants across separate API issuer instances', async () => {
    let now = 1_000
    const enabledOptions = {
      convexUrl: 'https://example.convex.cloud',
      internalKey: 'test-api-internal-key',
      env: { DUET_ENABLE_FAKE_OAUTH_ISSUER: '1' },
    } as const
    const issuingApp = createApiApp({
      ...enabledOptions,
      fakeOAuthIssuer: createFakeOAuthIssuer({ approvalDelayMs: 100, now: () => now }),
    })
    const device = (await (
      await post(issuingApp, '/device/code', {
        client_id: 'duet-agent:github-copilot',
        scope: 'read:user',
      })
    ).json()) as Record<string, unknown>

    const consumingApp = createApiApp({
      ...enabledOptions,
      fakeOAuthIssuer: createFakeOAuthIssuer({ approvalDelayMs: 100, now: () => now }),
    })
    const pending = await post(consumingApp, '/token', {
      device_code: device.device_code,
      grant_type: DEVICE_GRANT,
    })
    expect(await pending.json()).toEqual({ status: 'pending' })

    now += 100
    const token = await post(consumingApp, '/token', {
      device_code: device.device_code,
      grant_type: DEVICE_GRANT,
    })
    expect(token.status).toBe(200)
    expect(await token.json()).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      expires_in: 3_600,
      account_id: expect.stringMatching(/^fake-account-github-copilot-/),
    })
  })
})

function post(
  app: ReturnType<typeof createApiApp>,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return Promise.resolve(
    app.request(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}
