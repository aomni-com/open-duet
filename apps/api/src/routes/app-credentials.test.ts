import { expect, test } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'
import { convexToJson, jsonToConvex, type Value } from 'convex/values'

import { hashApiKey, MAX_EXPORTED_APP_CREDENTIALS } from '@repo/contract'

import { createApiApp } from '../index'

const TOKEN = 'duet_sk_fixture-request-credential'
const KEY = 'duet_sk_fixture-exported-credential'
const BASE = '/v1/ws/example/apps/external/credentials'

function fixture(
  options: {
    createdAt?: number
    refusal?: Record<string, Value>
    gatewayUrl?: string
    role?: string
    scopes?: string[]
    kind?: string
  } = {},
) {
  const requests: Array<{ path: string; args: Record<string, Value> }> = []
  const client = new ConvexHttpClient('https://fixture.convex.cloud', {
    fetch: Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const args = jsonToConvex(body.args[0]) as Record<string, Value>
        requests.push({ path: body.path, args })
        let value: unknown
        if (body.path === 'domains/apiKeys/api:resolveCredential') {
          value = {
            ok: true,
            auth: {
              credentialKind: options.kind ?? 'system_vm',
              user: { id: 'attribution-user', email: 'fixture@example.test' },
              scopes: options.scopes ?? ['ws:example:apps'],
              versions: { api: 1 },
              workspaces: [
                {
                  id: 'workspace-id',
                  slug: 'example',
                  role: options.role ?? 'editor',
                  onboardedAt: 1,
                },
              ],
            },
          }
        } else if (body.path === 'domains/apiKeys/api:recordCredentialUse') {
          value = { ok: true }
        } else if (options.refusal) {
          return Response.json({
            status: 'error',
            errorMessage: `unsafe diagnostic ${KEY}`,
            errorData: convexToJson(options.refusal),
          })
        } else if (body.path === 'domains/apiKeys/appExports:exportCredential') {
          const expiration = args.expiration as 'never' | { seconds: number }
          value = {
            credentialId: 'credential-id',
            prefix: 'duet_sk_fixture',
            createdAt: options.createdAt ?? 1000,
            expiresAt: expiration === 'never' ? null : 1000 + expiration.seconds * 1000,
            key: KEY,
          }
        } else if (body.path === 'domains/apiKeys/appExports:listCredentials') {
          value = {
            items: [
              {
                credentialId: 'credential-id',
                prefix: 'duet_sk_fixture',
                createdAt: options.createdAt ?? 1000,
                expiresAt: null,
                key: KEY,
                hashedKey: 'fixture-hash',
              },
            ],
            nextCursor: null,
          }
        } else if (body.path === 'domains/apiKeys/appExports:revokeCredential') {
          value = { ok: true }
        } else throw new Error(`Unexpected backend request: ${body.path}`)
        return Response.json({ status: 'success', value: convexToJson(value as Value) })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  })
  const app = createApiApp({
    convexClient: client,
    convexUrl: 'https://fixture.convex.cloud',
    internalKey: 'fixture-internal',
    env: { DUET_API_URL: 'https://ctl-staging.example.test' },
    modelGatewayUrl: options.gatewayUrl ?? 'https://gateway-staging.example.test',
  })
  return { app, requests }
}

test('workspace agents export once through authenticated app management with deployment URLs', async () => {
  const { app, requests } = fixture()
  const response = await app.request(`${BASE}/export`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expiration: 'never' }),
  })
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toEqual({
    credentialId: 'credential-id',
    prefix: 'duet_sk_fixture',
    createdAt: 1000,
    expiresAt: null,
    key: KEY,
    apiUrl: 'https://ctl-staging.example.test',
    gatewayBaseUrl: 'https://gateway-staging.example.test',
  })
  const dispatched = requests.find(request => request.path.endsWith(':exportCredential'))!
  expect(dispatched.args).toEqual({
    internalKey: 'fixture-internal',
    workspaceId: 'workspace-id',
    appSlug: 'external',
    caller: {
      hashedKey: await hashApiKey(TOKEN),
      keyPrefix: requests.find(request => request.path.endsWith(':resolveCredential'))!.args
        .keyPrefix,
    },
    expiration: 'never',
  })
  expect(JSON.stringify(dispatched.args)).not.toContain(TOKEN)
})

test('durable authorization changes and unexpected failures never expose backend diagnostics', async () => {
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  for (const [code, status] of [
    ['unauthorized', 401],
    ['unrecognized_failure', 500],
  ] as const) {
    const { app } = fixture({ refusal: { code, status, key: KEY } })
    const response = await app.request(`${BASE}/export`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expiration: 'never' }),
    })
    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      error: status === 401 ? 'unauthorized' : 'internal_error',
    })
  }
})

test('ordinary apps authority admits human and workspace principals while viewers can inspect only', async () => {
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  const body = JSON.stringify({ expiration: 'never' })
  for (const kind of ['browser_session', 'impersonation', 'user', 'oauth', 'app', 'system_vm']) {
    const { app } = fixture({ kind, role: kind === 'browser_session' ? 'owner' : 'editor' })
    expect((await app.request(`${BASE}/export`, { method: 'POST', headers, body })).status).toBe(
      201,
    )
  }
  const viewer = fixture({ kind: 'user', role: 'viewer' })
  expect((await viewer.app.request(BASE, { headers })).status).toBe(200)
  for (const [path, method] of [
    [`${BASE}/export`, 'POST'],
    [`${BASE}/credential-id`, 'DELETE'],
  ]) {
    const response = await viewer.app.request(path!, {
      method,
      headers,
      body: method === 'POST' ? body : undefined,
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
  }
  expect(
    viewer.requests.filter(
      request =>
        request.path.endsWith(':exportCredential') || request.path.endsWith(':revokeCredential'),
    ),
  ).toEqual([])
  const denied = fixture({ scopes: ['ws:example:services'] })
  const missingScope = await denied.app.request(`${BASE}/export`, { method: 'POST', headers, body })
  expect(missingScope.status).toBe(403)
  expect(await missingScope.json()).toEqual({
    error: 'insufficient_scope',
    scope: 'ws:example:apps',
  })
})

test('missing or unusable gateway configuration refuses before exporting a credential', async () => {
  for (const gatewayUrl of ['', 'not-a-url', 'ftp://gateway.example.test']) {
    const { app, requests } = fixture({ gatewayUrl })
    const response = await app.request(`${BASE}/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expiration: 'never' }),
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: 'app_credentials_not_configured' })
    expect(requests.filter(request => request.path.endsWith(':exportCredential'))).toEqual([])
  }
})

test('expiration is explicit and bounded before issuance while finite seconds reach the backend unchanged', async () => {
  const { app, requests } = fixture()
  const request = (body: unknown) =>
    app.request(`${BASE}/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  for (const body of [
    {},
    { expiration: null },
    { expiration: { seconds: 0 } },
    { expiration: { seconds: -1 } },
    { expiration: { seconds: 1.5 } },
    { expiration: { seconds: Number.MAX_SAFE_INTEGER } },
    { expiration: { seconds: 10, extra: true } },
    { expiration: 'never', scopes: ['admin'] },
  ]) {
    const response = await request(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
  }
  expect(requests.filter(request => request.path.endsWith(':exportCredential'))).toEqual([])
  const finite = await request({ expiration: { seconds: 60 } })
  expect(finite.status).toBe(201)
  expect((await finite.json()).expiresAt).toBe(61_000)
  expect(
    requests.find(request => request.path.endsWith(':exportCredential'))!.args.expiration,
  ).toEqual({ seconds: 60 })
})

test('durable capacity refusal returns only the safe category and limit', async () => {
  const { app } = fixture({
    refusal: {
      code: 'app_credential_limit',
      status: 409,
      limit: MAX_EXPORTED_APP_CREDENTIALS,
      secret: KEY,
    },
  })
  const response = await app.request(`${BASE}/export`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expiration: 'never' }),
  })
  expect(response.status).toBe(409)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toEqual({
    error: 'app_credential_limit',
    limit: MAX_EXPORTED_APP_CREDENTIALS,
  })
})

test('credential responses stay private even when authentication fails before dispatch', async () => {
  const { app, requests } = fixture()
  for (const path of [BASE, `${BASE}/export`, `${BASE}/credential-id`]) {
    const response = await app.request(path, {
      method: path.endsWith('/export') ? 'POST' : path === BASE ? 'GET' : 'DELETE',
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  }
  expect(requests).toEqual([])
})

test('revoke binds the credential ID to the authenticated workspace and app', async () => {
  const { app, requests } = fixture()
  const response = await app.request(`${BASE}/credential-id`, {
    method: 'DELETE',
    headers: { 'x-api-key': TOKEN },
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ ok: true })
  expect(requests.find(request => request.path.endsWith(':revokeCredential'))!.args).toEqual({
    internalKey: 'fixture-internal',
    workspaceId: 'workspace-id',
    appSlug: 'external',
    caller: {
      hashedKey: await hashApiKey(TOKEN),
      keyPrefix: requests.find(request => request.path.endsWith(':resolveCredential'))!.args
        .keyPrefix,
    },
    credentialId: 'credential-id',
  })
})

test('inventory projects only live credential metadata and rejects paging inputs', async () => {
  const { app } = fixture()
  const headers = { authorization: `Bearer ${TOKEN}` }
  const response = await app.request(BASE, { headers })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toEqual({
    items: [
      {
        credentialId: 'credential-id',
        prefix: 'duet_sk_fixture',
        createdAt: 1000,
        expiresAt: null,
      },
    ],
    nextCursor: null,
  })
  const paged = await app.request(`${BASE}?limit=1`, { headers })
  expect(paged.status).toBe(400)
  expect(await paged.json()).toEqual({ error: 'invalid_request' })
})

test('fractional Convex creation timestamps remain recoverable through export and inventory', async () => {
  const { app } = fixture({ createdAt: 1000.5 })
  const exported = await app.request(`${BASE}/export`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expiration: 'never' }),
  })
  expect(exported.status).toBe(201)
  expect((await exported.json()).createdAt).toBe(1000.5)
  const inventory = await app.request(BASE, { headers: { authorization: `Bearer ${TOKEN}` } })
  expect(inventory.status).toBe(200)
  expect((await inventory.json()).items[0].createdAt).toBe(1000.5)
})
