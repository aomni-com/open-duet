import { expect, test } from 'bun:test'

import { Hono, type Next } from 'hono'

import { MAX_ANALYTICS_JSON_BYTES } from '@repo/contract'

import { createApiApp } from '../index'
import type { ApiContext, ApiVariables, AuthPayload } from '../shared'
import { registerAnalyticsRoutes, type AnalyticsRouteRuntime } from './analytics'

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthPayload
  }
}

test('analytics ingress requires an authenticated API credential', async () => {
  const app = createApiApp({
    convexUrl: 'https://example.convex.cloud',
    internalKey: 'internal',
  })

  const response = await app.request('/v1/analytics/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validRequest()),
  })

  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: 'unauthorized' })
})

test('analytics ingress rejects non-browser credentials', async () => {
  const app = analyticsApp({
    credentialKind: 'user',
    workspaces: [],
  })

  const response = await app.request('/v1/analytics/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validRequest()),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'browser_session_required' })
})

test('analytics ingress derives identity and timing before scheduling', async () => {
  const scheduled: unknown[] = []
  const app = analyticsApp(
    {
      credentialKind: 'browser_session',
      workspaces: [{ id: 'workspace-1', slug: 'acme' }],
    },
    event => scheduled.push(event),
  )

  const response = await app.request('/v1/analytics/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validRequest(),
      workspaceId: 'workspace-1',
      properties: { step: 'welcome' },
    }),
  })

  expect(response.status).toBe(202)
  expect(scheduled).toEqual([
    {
      id: validRequest().id,
      name: 'onboarding.started',
      workspaceId: 'workspace-1',
      properties: { step: 'welcome' },
      version: 1,
      at: 123,
      origin: 'product_browser',
      userId: 'user-1',
    },
  ])
})

test('analytics ingress rejects a workspace outside the live browser-session list', async () => {
  const scheduled: unknown[] = []
  const app = analyticsApp(
    {
      credentialKind: 'browser_session',
      workspaces: [{ id: 'workspace-1', slug: 'acme' }],
    },
    event => scheduled.push(event),
  )

  const response = await app.request('/v1/analytics/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...validRequest(), workspaceId: 'workspace-2' }),
  })

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: 'not_found' })
  expect(scheduled).toEqual([])
})

test('analytics ingress rejects invalid names while stripping server-owned event fields', async () => {
  const scheduled: unknown[] = []
  const app = analyticsApp(
    {
      credentialKind: 'browser_session',
      workspaces: [],
    },
    event => scheduled.push(event),
  )

  const invalidName = await app.request('/v1/analytics/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...validRequest(), name: 'made.up' }),
  })
  expect(invalidName.status).toBe(400)
  expect(await invalidName.json()).toEqual({ error: 'invalid_request' })

  for (const request of [
    { ...validRequest(), userId: 'spoofed-user' },
    { ...validRequest(), attributionId: 'spoofed-attribution' },
    { ...validRequest(), at: 999 },
  ]) {
    const response = await app.request('/v1/analytics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    expect(response.status).toBe(202)
  }
  expect(scheduled).toHaveLength(3)
  for (const event of scheduled) {
    expect(event).toMatchObject({ at: 123, userId: 'user-1' })
    expect(event).not.toHaveProperty('attributionId')
  }
})

test('analytics ingress rejects properties over its configured byte limit', async () => {
  const app = analyticsApp({
    credentialKind: 'browser_session',
    workspaces: [],
  })

  const response = await app.request('/v1/analytics/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validRequest(),
      properties: { value: 'x'.repeat(MAX_ANALYTICS_JSON_BYTES) },
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid_request' })
})

function analyticsApp(
  auth: {
    credentialKind: 'user' | 'browser_session'
    workspaces: Array<{ id: string; slug: string }>
  },
  onMutation: (event: unknown) => void = () => {},
) {
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use(async (context: ApiContext, next: Next) => {
    context.set('auth', {
      credentialKind: auth.credentialKind,
      user: { id: 'user-1', email: 'owner@example.test' },
      workspaces: auth.workspaces.map(workspace => ({
        ...workspace,
        name: workspace.slug,
        status: 'active',
        servicingStatus: 'active',
        onboardedAt: 1,
        role: 'owner',
        billingUserId: 'user-1',
        funding: { plan: null, active: true },
        creditRecovery: null,
        defaultTier: { effective: 'balanced' },
      })),
      scopes: [],
      versions: { api: 1 },
    })
    await next()
  })
  const runtime: AnalyticsRouteRuntime = {
    convex: {
      mutation: async (_reference, args) => {
        onMutation(args.event)
        return null
      },
    },
    internalKey: 'internal',
    now: () => 123,
  }
  registerAnalyticsRoutes(app, runtime)
  return app
}

function validRequest() {
  return {
    id: '8678a1e9-8217-4cb7-88a6-f1f264605e2c',
    name: 'onboarding.started',
    properties: {},
  }
}
