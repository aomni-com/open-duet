import { describe, expect, test } from 'bun:test'

import type { ConvexHttpClient } from 'convex/browser'
import { getFunctionName } from 'convex/server'

import {
  API_VERSION,
  DESKTOP_GRANT_TTL_MS,
  DESKTOP_SCREEN,
  tunnelTokenDigest,
  type FetchLike,
} from '@repo/contract'

import { GatewayClient } from './gateway/client'
import { createApiApp } from './index'
import type { AuthPayload } from './shared'

function browserAuth(overrides: Partial<AuthPayload> = {}): AuthPayload {
  return {
    credentialKind: 'browser_session',
    user: { id: 'usr_1', email: 'owner@example.com' },
    workspaces: [
      {
        id: 'ws_1',
        slug: 'acme',
        name: 'Acme',
        status: 'active',
        servicingStatus: 'active',
        onboardedAt: 1,
        role: 'owner',
        billingUserId: 'usr_1',
        funding: { plan: null, active: true },
        creditRecovery: null,
        defaultTier: { effective: 'balanced' },
      },
    ],
    scopes: ['ws:acme:sessions'],
    versions: API_VERSION,
    ...overrides,
  }
}

describe('GatewayClient desktop transport', () => {
  test('registers only the grant digest and returns the direct exe.dev viewer credential', async () => {
    let registration:
      | {
          url: string
          authorization: string | null
          body: { grantId: string; tokenDigest: string; expiresAt: number; embedOrigin: string }
        }
      | undefined
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          workspaceSlug: 'acme',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.exe.xyz',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          grantId: string
          tokenDigest: string
          expiresAt: number
          embedOrigin: string
        }
        registration = {
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
          body,
        }
        return Response.json({
          entryPath: `/v1/desktop/${body.grantId}/`,
          phase: 'ready',
        })
      },
      now: () => 1_000,
    })

    const result = await client.mintDesktopGrant('acme', 'https://customer.example')
    if ('error' in result) throw new Error(`unexpected desktop error: ${result.error}`)

    expect(registration).toEqual({
      url: 'https://duet-acme.exe.xyz/v1/desktop/grants',
      authorization: 'Bearer vm-token',
      body: {
        grantId: expect.stringMatching(/^desktop-/),
        tokenDigest: expect.any(String),
        expiresAt: 1_000 + DESKTOP_GRANT_TTL_MS,
        embedOrigin: 'https://customer.example',
      },
    })
    expect(result).toMatchObject({
      expiresAt: 1_000 + DESKTOP_GRANT_TTL_MS,
      phase: 'ready',
      screen: DESKTOP_SCREEN,
    })

    const entry = new URL(result.entryUrl)
    const token = entry.pathname.match(/\.([A-Za-z0-9_-]+)\/$/)?.[1]
    expect(token).toBeDefined()
    expect(registration?.body.tokenDigest).toBe(await tunnelTokenDigest(token!))
    expect(JSON.stringify(registration?.body)).not.toContain(token!)
    expect(entry.origin).toBe('https://duet-acme.exe.xyz')
    expect(entry.pathname).toBe(
      `/v1/desktop/${encodeURIComponent(registration!.body.grantId)}.${token}/`,
    )
    expect(entry.searchParams.get('path')).toBe(
      `v1/desktop/${encodeURIComponent(registration!.body.grantId)}.${token}/websockify`,
    )
  })

  test('reads live desktop status through the VM bearer boundary', async () => {
    let request: { url: string; method: string; authorization: string | null } | undefined
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          workspaceSlug: 'acme',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.exe.xyz',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async (input, init) => {
        request = {
          url: String(input),
          method: init?.method ?? 'GET',
          authorization: new Headers(init?.headers).get('authorization'),
        }
        return Response.json({
          phase: 'ready',
          viewers: 2,
          owners: [
            {
              owner: { kind: 'agent', agentId: 'agent-a' },
              agentSlug: 'researcher',
              phase: 'active',
              focused: true,
              liveBatchCount: 1,
              batchTabCount: 1,
              discardedBatchTabCount: 0,
              lastActiveAt: 900,
            },
          ],
        })
      },
      now: () => 1_000,
    })

    expect(await client.readDesktopStatus('acme')).toEqual({
      phase: 'ready',
      viewers: 2,
      owners: [
        {
          owner: { kind: 'agent', agentId: 'agent-a' },
          agentSlug: 'researcher',
          phase: 'active',
          focused: true,
          liveBatchCount: 1,
          batchTabCount: 1,
          discardedBatchTabCount: 0,
          lastActiveAt: 900,
        },
      ],
    })
    expect(request).toEqual({
      url: 'https://duet-acme.exe.xyz/v1/desktop/status',
      method: 'GET',
      authorization: 'Bearer vm-token',
    })
  })

  test('collapses unreachable or malformed VM responses to the desktop gateway failure', async () => {
    let attempts = 0
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          workspaceSlug: 'acme',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.exe.xyz',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('connect ECONNREFUSED')
        return Response.json({ phase: 'unknown', viewers: -1, owners: [] })
      },
      now: () => 1_000,
    })

    expect(await client.mintDesktopGrant('acme', 'https://customer.example')).toEqual({
      error: 'gateway_failed',
    })
    expect(await client.readDesktopStatus('acme')).toEqual({ error: 'gateway_failed' })
  })

  test('preserves a full live desktop grant registry as typed unavailability', async () => {
    const client = new GatewayClient({
      convex: {
        query: async () => ({
          workspaceId: 'workspace_1',
          workspaceSlug: 'acme',
          vmName: 'duet-acme',
          httpsUrl: 'https://duet-acme.exe.xyz',
          vmToken: 'vm-token',
        }),
      } as unknown as ConvexHttpClient,
      internalKey: 'internal-key',
      fetchImpl: async () => Response.json({ error: 'desktop_unavailable' }, { status: 503 }),
      now: () => 1_000,
    })

    expect(await client.mintDesktopGrant('acme', 'https://customer.example')).toEqual({
      error: 'desktop_unavailable',
    })
  })
})

const LIVE_GATEWAY = {
  workspaceId: 'ws_1',
  workspaceSlug: 'acme',
  vmName: 'duet-acme',
  httpsUrl: 'https://duet-acme.exe.xyz',
  vmToken: 'vm-token',
}
const REQUEST_AUTH = { authorization: 'Bearer duet_sk_desktop-fixture' }
const LIVE_STATUS = {
  phase: 'starting',
  viewers: 1,
  owners: [
    {
      owner: { kind: 'agent', agentId: 'agent-a' },
      agentSlug: 'stale-researcher',
      phase: 'active',
      focused: true,
      liveBatchCount: 1,
      batchTabCount: 1,
      discardedBatchTabCount: 0,
      lastActiveAt: 120_000,
    },
  ],
}

// Convex and the workspace VM are remote edges. Route registration, auth
// middleware, gateway transport and response serialization all stay real.
function desktopApi(
  input: {
    auth?: AuthPayload
    gateway?: unknown
    fetch?: FetchLike
  } = {},
) {
  const requests: Array<{
    url: URL
    method: string
    body: Record<string, unknown> | null
    authorization: string | null
  }> = []
  const api = createApiApp({
    convexUrl: 'https://example.convex.cloud',
    internalKey: 'test-internal-key',
    now: () => 1_000,
    convexClient: {
      query: async (
        reference: Parameters<ConvexHttpClient['query']>[0],
        args: Record<string, unknown>,
      ) => {
        switch (getFunctionName(reference)) {
          case 'domains/apiKeys/api:resolveCredential':
            return { ok: true, auth: input.auth ?? browserAuth() }
          case 'domains/workspaces/provisioning:gatewayConnectionBySlug':
            return input.gateway ?? LIVE_GATEWAY
          case 'domains/agents/model:getBySlug':
            return args.workspaceId === 'ws_1' && args.slug === 'researcher'
              ? { id: 'agent-a' }
              : null
          case 'domains/agents/model:listByWorkspace':
            return [{ id: 'agent-a', slug: 'renamed-researcher', name: 'Research Lead' }]
          default:
            throw new Error(`unexpected backend query ${getFunctionName(reference)}`)
        }
      },
      mutation: async (reference: Parameters<ConvexHttpClient['mutation']>[0]) => {
        if (getFunctionName(reference) !== 'domains/apiKeys/api:recordCredentialUse')
          throw new Error('unexpected backend mutation')
        return { ok: true }
      },
    } as unknown as ConvexHttpClient,
    fetch: async (url, init) => {
      const parsed = new URL(String(url))
      const body = init?.body ? JSON.parse(String(init.body)) : null
      requests.push({
        url: parsed,
        method: init?.method ?? 'GET',
        body,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      if (input.fetch) return input.fetch(url, init)
      if (parsed.pathname === '/v1/desktop/grants')
        return Response.json({
          entryPath: `/v1/desktop/${body.grantId}/`,
          phase: 'ready',
          token: 'must-not-cross-api',
        })
      if (parsed.pathname === '/v1/desktop/status') return Response.json(LIVE_STATUS)
      if (parsed.pathname === '/v1/desktop/browser/windows/focus')
        return Response.json({ focused: true })
      throw new Error(`unexpected gateway path ${parsed.pathname}`)
    },
  })
  return { api, requests }
}

function postJson(body: unknown) {
  return {
    method: 'POST',
    headers: { ...REQUEST_AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}
function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
}

describe('desktop product routes', () => {
  test('mints a browser viewer through the mounted API and actual gateway transport', async () => {
    const { api, requests } = desktopApi()
    const response = await api.request(
      '/v1/ws/acme/desktop/session',
      postJson({ embedOrigin: 'https://customer.example' }),
    )
    expect(response.status).toBe(200)
    const session = (await response.json()) as {
      entryUrl: string
      expiresAt: number
      phase: string
    }
    expect(session).toMatchObject({ phase: 'ready', expiresAt: 1_000 + DESKTOP_GRANT_TTL_MS })
    expectPrivate(response)
    const entry = new URL(session.entryUrl)
    expect(entry.origin).toBe(LIVE_GATEWAY.httpsUrl)
    const token = entry.pathname.match(/\.([A-Za-z0-9_-]+)\/$/)?.[1]
    expect(token).toBeDefined()
    expect(
      requests.map(request => ({
        method: request.method,
        path: request.url.pathname,
        authorization: request.authorization,
        body: request.body,
      })),
    ).toEqual([
      {
        method: 'POST',
        path: '/v1/desktop/grants',
        authorization: 'Bearer vm-token',
        body: {
          grantId: expect.any(String),
          tokenDigest: await tunnelTokenDigest(token!),
          expiresAt: session.expiresAt,
          embedOrigin: 'https://customer.example',
        },
      },
    ])
    expect(JSON.stringify(session)).not.toContain('must-not-cross-api')
    expect(JSON.stringify(requests[0]!.body)).not.toContain(token!)
  })

  test('rejects a non-canonical embed origin without issuing a VM credential', async () => {
    const { api, requests } = desktopApi()
    const response = await api.request(
      '/v1/ws/acme/desktop/session',
      postJson({ embedOrigin: 'https://CUSTOMER.example/' }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
    expect(requests).toEqual([])
  })

  test('status enriches live VM owners with current backend names without issuing a grant', async () => {
    const { api, requests } = desktopApi()
    const response = await api.request('/v1/ws/acme/desktop/status', { headers: REQUEST_AUTH })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ...LIVE_STATUS,
      owners: [
        { ...LIVE_STATUS.owners[0], agentSlug: 'renamed-researcher', agentName: 'Research Lead' },
      ],
    })
    expect(
      requests.map(request => ({
        path: request.url.pathname,
        method: request.method,
        authorization: request.authorization,
      })),
    ).toEqual([{ path: '/v1/desktop/status', method: 'GET', authorization: 'Bearer vm-token' }])
    expectPrivate(response)
  })

  test('focus resolves the current agent slug and root to actual VM command payloads', async () => {
    const { api, requests } = desktopApi()
    for (const slug of ['researcher', 'root']) {
      const response = await api.request(
        `/v1/ws/acme/agents/${slug}/desktop/focus`,
        postJson({ requestId: `request-${slug}` }),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ focused: true })
    }
    expect(
      requests.map(request => ({
        path: request.url.pathname,
        method: request.method,
        body: request.body,
      })),
    ).toEqual([
      {
        path: '/v1/desktop/browser/windows/focus',
        method: 'POST',
        body: { owner: { kind: 'agent', agentId: 'agent-a' }, requestId: 'request-researcher' },
      },
      {
        path: '/v1/desktop/browser/windows/focus',
        method: 'POST',
        body: { owner: { kind: 'root' }, requestId: 'request-root' },
      },
    ])
  })

  test('the mounted desktop routes require credentials, membership and sessions scope', async () => {
    const { api, requests } = desktopApi()
    for (const [path, method] of [
      ['/v1/ws/acme/desktop/session', 'POST'],
      ['/v1/ws/acme/desktop/status', 'GET'],
      ['/v1/ws/acme/agents/root/desktop/focus', 'POST'],
    ]) {
      expect((await api.request(path!, { method })).status).toBe(401)
    }
    expect(requests).toEqual([])
    const insufficient = desktopApi({
      auth: browserAuth({ credentialKind: 'user', scopes: ['ws:acme:files:read'] }),
    })
    const refused = await insufficient.api.request('/v1/ws/acme/desktop/status', {
      headers: REQUEST_AUTH,
    })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'insufficient_scope', scope: 'ws:acme:sessions' })
    expectPrivate(refused)
    expect(insufficient.requests).toEqual([])
    const absent = await api.request('/v1/ws/other/desktop/status', { headers: REQUEST_AUTH })
    expect(absent.status).toBe(404)
    expect(await absent.json()).toEqual({ error: 'not_found' })
    expectPrivate(absent)
    expect(requests).toEqual([])
  })

  test.each(['browser_session', 'impersonation', 'user', 'oauth', 'app'] as const)(
    'admits an ordinary sessions-scoped %s credential',
    async credentialKind => {
      const { api } = desktopApi({ auth: browserAuth({ credentialKind }) })
      const response = await api.request('/v1/ws/acme/desktop/status', { headers: REQUEST_AUTH })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { viewers: number }).viewers).toBe(LIVE_STATUS.viewers)
    },
  )

  test.each([
    ['paused', 402],
    ['provisioning', 409],
    ['unhealthy', 503],
    ['archived', 410],
  ] as const)('preserves backend %s refusal on mint and status', async (refusal, status) => {
    const { api, requests } = desktopApi({ gateway: { refusal } })
    for (const [path, init] of [
      ['/v1/ws/acme/desktop/session', postJson({ embedOrigin: 'https://customer.example' })],
      ['/v1/ws/acme/desktop/status', { headers: REQUEST_AUTH }],
    ] as const) {
      const response = await api.request(path, init)
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: `workspace_${refusal}` })
      expectPrivate(response)
    }
    expect(requests).toEqual([])
  })

  test('maps an actual VM transport rejection to a gateway failure', async () => {
    const { api } = desktopApi({
      fetch: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })
    const response = await api.request(
      '/v1/ws/acme/desktop/session',
      postJson({ embedOrigin: 'https://customer.example' }),
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'desktop_gateway_failed' })
  })

  test('returns retryable service refusal from the VM grant registry', async () => {
    const { api } = desktopApi({
      fetch: async () => Response.json({ error: 'desktop_unavailable' }, { status: 503 }),
    })
    const response = await api.request(
      '/v1/ws/acme/desktop/session',
      postJson({ embedOrigin: 'https://customer.example' }),
    )
    expect(response.status).toBe(503)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await response.json()).toEqual({ error: 'desktop_unavailable' })
  })
})
