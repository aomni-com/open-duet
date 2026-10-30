import { expect, test } from 'bun:test'

import { Hono } from 'hono'

import { createApiApp } from '../index'
import type { ApiRouteRuntime, ApiVariables, ComposioMcpProvider } from '../shared'
import { registerSessionDeletionInternalRoutes } from './session-deletions'

test('the API composition root bypasses public API-key auth only for the private callback', async () => {
  const app = createApiApp({
    convexUrl: 'https://example.convex.cloud',
    internalKey: 'expected-internal-key',
  })

  const response = await app.request('/v1/internal/session-deletions/work-1/dispose', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-internal-key' },
  })

  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: 'unauthorized' })
})

test('session disposal rejects the wrong internal bearer before reading or performing effects', async () => {
  let reads = 0
  let gatewayCalls = 0
  let providerCalls = 0
  const app = new Hono<{ Variables: ApiVariables }>()
  registerSessionDeletionInternalRoutes(
    app,
    {
      apiInternalKey: 'expected-internal-key',
      convex: {
        query: async () => {
          reads += 1
          return null
        },
      },
      internalKey: 'expected-internal-key',
    } as unknown as ApiRouteRuntime,
    {
      async discardAgentSession() {
        gatewayCalls += 1
        return { ok: true as const, discarded: true }
      },
    },
    {
      async deleteToolRouterSession() {
        providerCalls += 1
      },
    } as unknown as ComposioMcpProvider,
  )

  const response = await app.request('/v1/internal/session-deletions/work-1/dispose', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-internal-key' },
  })

  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: 'unauthorized' })
  expect({ reads, gatewayCalls, providerCalls }).toEqual({
    reads: 0,
    gatewayCalls: 0,
    providerCalls: 0,
  })
})

test('session disposal treats missing or stale work as a harmless no-op', async () => {
  let reads = 0
  let gatewayCalls = 0
  const app = new Hono<{ Variables: ApiVariables }>()
  registerSessionDeletionInternalRoutes(
    app,
    {
      apiInternalKey: 'expected-internal-key',
      convex: {
        query: async () => {
          reads += 1
          return null
        },
      },
      internalKey: 'expected-internal-key',
    } as unknown as ApiRouteRuntime,
    {
      async discardAgentSession() {
        gatewayCalls += 1
        return { ok: true as const, discarded: false }
      },
    },
  )

  const response = await app.request('/v1/internal/session-deletions/not-a-convex-id/dispose', {
    method: 'POST',
    headers: { authorization: 'Bearer expected-internal-key' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'noop' })
  expect({ reads, gatewayCalls }).toEqual({ reads: 1, gatewayCalls: 0 })
})

test('session disposal rejects a malformed Convex plan before performing effects', async () => {
  let gatewayCalls = 0
  const app = new Hono<{ Variables: ApiVariables }>()
  registerSessionDeletionInternalRoutes(
    app,
    {
      apiInternalKey: 'expected-internal-key',
      convex: {
        query: async () => ({ sessionId: 'session-1' }),
      },
      internalKey: 'expected-internal-key',
    } as unknown as ApiRouteRuntime,
    {
      async discardAgentSession() {
        gatewayCalls += 1
        return { ok: true as const, discarded: true }
      },
    },
  )

  const originalError = console.error
  console.error = () => undefined
  try {
    const response = await app.request('/v1/internal/session-deletions/work-1/dispose', {
      method: 'POST',
      headers: { authorization: 'Bearer expected-internal-key' },
    })
    expect(response.status).toBe(500)
  } finally {
    console.error = originalError
  }
  expect(gatewayCalls).toBe(0)
})

test('session disposal discards the gateway session before best-effort provider cleanup', async () => {
  const effects: string[] = []
  const app = new Hono<{ Variables: ApiVariables }>()
  registerSessionDeletionInternalRoutes(
    app,
    {
      apiInternalKey: 'expected-internal-key',
      convex: {
        query: async () => ({
          workspaceSlug: 'acme',
          sessionId: 'session-1',
          providerSessionId: 'provider-1',
        }),
      },
      internalKey: 'expected-internal-key',
    } as unknown as ApiRouteRuntime,
    {
      async discardAgentSession(workspaceSlug, sessionId) {
        effects.push(`gateway:${workspaceSlug}:${sessionId}`)
        return { ok: true as const, discarded: true }
      },
    },
    {
      async deleteToolRouterSession({ providerSessionId }: { providerSessionId: string }) {
        effects.push(`provider:${providerSessionId}`)
      },
    } as unknown as ComposioMcpProvider,
  )

  const response = await app.request('/v1/internal/session-deletions/work-1/dispose', {
    method: 'POST',
    headers: { authorization: 'Bearer expected-internal-key' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    status: 'disposed',
    runner: 'absent',
    providerAttempted: true,
  })
  expect(effects).toEqual(['gateway:acme:session-1', 'provider:provider-1'])
})

test('session disposal leaves provider cleanup untouched when gateway discard is retryable', async () => {
  let providerCalls = 0
  const app = new Hono<{ Variables: ApiVariables }>()
  registerSessionDeletionInternalRoutes(
    app,
    {
      apiInternalKey: 'expected-internal-key',
      convex: {
        query: async () => ({
          workspaceSlug: 'acme',
          sessionId: 'session-1',
          providerSessionId: 'provider-1',
        }),
      },
      internalKey: 'expected-internal-key',
    } as unknown as ApiRouteRuntime,
    {
      async discardAgentSession() {
        return { ok: false as const, error: 'gateway_failed' as const }
      },
    },
    {
      async deleteToolRouterSession() {
        providerCalls += 1
      },
    } as unknown as ComposioMcpProvider,
  )

  const response = await app.request('/v1/internal/session-deletions/work-1/dispose', {
    method: 'POST',
    headers: { authorization: 'Bearer expected-internal-key' },
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    error: 'session_disposal_retryable',
    code: 'gateway_failed',
  })
  expect(providerCalls).toBe(0)
})

test('session disposal reports success when provider cleanup fails after gateway discard', async () => {
  const app = new Hono<{ Variables: ApiVariables }>()
  registerSessionDeletionInternalRoutes(
    app,
    {
      apiInternalKey: 'expected-internal-key',
      convex: {
        query: async () => ({
          workspaceSlug: 'acme',
          sessionId: 'session-1',
          providerSessionId: 'provider-1',
        }),
      },
      internalKey: 'expected-internal-key',
    } as unknown as ApiRouteRuntime,
    {
      async discardAgentSession() {
        return { ok: true as const, discarded: false }
      },
    },
    {
      async deleteToolRouterSession() {
        throw new Error('provider unavailable')
      },
    } as unknown as ComposioMcpProvider,
  )

  const originalError = console.error
  console.error = () => undefined
  try {
    const response = await app.request('/v1/internal/session-deletions/work-1/dispose', {
      method: 'POST',
      headers: { authorization: 'Bearer expected-internal-key' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'disposed',
      runner: 'absent',
      providerAttempted: true,
    })
  } finally {
    console.error = originalError
  }
})
