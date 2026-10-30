import { expect, test } from 'bun:test'

import { Hono } from 'hono'

import { WORKSPACE_PURPOSE_MAX_LENGTH } from '@repo/contract'

import type { ApiRouteRuntime, ApiVariables } from '../shared'
import { registerOnboardingRoutes } from './onboarding'

const FOUR_RECOMMENDATIONS = [
  { agentName: 'scribe', reason: 'You want content faster — Scribe drafts it for you.' },
  { agentName: 'seo-scout', reason: 'You mentioned SEO; this agent finds the keywords.' },
  { agentName: 'inbox-zero', reason: 'Less busywork: it answers routine email for you.' },
  { agentName: 'bookkeeper', reason: 'Keeps your invoices reconciled while you grow.' },
]

function onboardingApp(options: {
  role?: 'owner' | 'editor' | 'viewer'
  onboardedAt?: number
  action?: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>
  query?: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>
}) {
  const calls: Array<Record<string, unknown>> = []
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('*', async (context, next) => {
    context.set('auth', {
      credentialKind: 'browser_session',
      user: { id: 'user-1', email: 'owner@example.test' },
      workspaces: [
        {
          id: 'workspace-1',
          slug: 'acme',
          name: 'Acme',
          status: 'active',
          servicingStatus: 'active',
          role: options.role ?? 'owner',
          billingUserId: 'user-1',
          funding: { plan: null, active: true },
          creditRecovery: null,
          defaultTier: { effective: 'balanced' },
          ...(options.onboardedAt === undefined ? {} : { onboardedAt: options.onboardedAt }),
        },
      ],
      scopes: ['ws:acme:agents'],
      versions: { api: 1 },
    })
    await next()
  })
  const runtime = {
    convex: {
      action: async (reference: unknown, args: Record<string, unknown>) => {
        calls.push(args)
        if (options.action !== undefined) return await options.action(reference, args)
        return { recommendations: FOUR_RECOMMENDATIONS }
      },
      query: async (reference: unknown, args: Record<string, unknown>) => {
        calls.push(args)
        if (options.query !== undefined) return await options.query(reference, args)
        return { ready: false }
      },
    },
    internalKey: 'internal',
    now: () => 1_700_000_000_000,
  } as unknown as ApiRouteRuntime
  registerOnboardingRoutes(app, runtime)
  return { app, calls }
}

function recommendationsRequest(body: unknown) {
  return new Request('http://localhost/v1/ws/acme/onboarding/recommendations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function paymentIntentRequest(body: unknown) {
  return new Request('http://localhost/v1/ws/acme/onboarding/payment-method/intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function paymentStatusRequest() {
  return new Request('http://localhost/v1/ws/acme/onboarding/payment-method', { method: 'GET' })
}

function paymentCompleteRequest(body: unknown) {
  return new Request('http://localhost/v1/ws/acme/onboarding/payment-method/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('payment intent proxies the owner request and preserves the typed $10 response', async () => {
  const { app, calls } = onboardingApp({
    action: async () => ({
      status: 'requires_confirmation',
      attemptId: 'attempt-12345678',
      paymentIntentId: 'pi_test',
      clientSecret: 'pi_test_secret',
      publishableKey: 'pk_test',
      amount: 1000,
      currency: 'usd',
    }),
  })

  const response = await app.request(paymentIntentRequest({ attemptId: 'attempt-12345678' }))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    status: 'requires_confirmation',
    attemptId: 'attempt-12345678',
    paymentIntentId: 'pi_test',
    clientSecret: 'pi_test_secret',
    publishableKey: 'pk_test',
    amount: 1000,
    currency: 'usd',
  })
  expect(calls).toContainEqual({
    internalKey: 'internal',
    actorId: 'user-1',
    workspaceId: 'workspace-1',
    attemptId: 'attempt-12345678',
    now: expect.any(Number),
  })
})

test('payment status is server-derived and does not expose provider details', async () => {
  const { app, calls } = onboardingApp({
    query: async () => ({
      ready: false,
      attemptId: 'attempt-12345678',
      paymentIntentId: 'pi_test',
      status: 'requires_capture',
    }),
  })

  const response = await app.request(paymentStatusRequest())

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ready: false,
    attemptId: 'attempt-12345678',
    paymentIntentId: 'pi_test',
    status: 'requires_capture',
  })
  expect(calls).toEqual([
    { internalKey: 'internal', actorId: 'user-1', workspaceId: 'workspace-1' },
  ])
})

test('payment completion forwards billing details and returns readiness', async () => {
  const { app, calls } = onboardingApp({
    action: async () => ({ ready: true, status: 'ready', paymentMethodReadyAt: 1_700_000_000_000 }),
  })

  const response = await app.request(
    paymentCompleteRequest({
      attemptId: 'attempt-12345678',
      paymentIntentId: 'pi_test',
      billingDetails: {
        name: 'Billing Owner',
        email: 'owner@example.test',
        address: {
          line1: '1 Test Street',
          city: 'San Francisco',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
      },
    }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ready: true, status: 'ready' })
  expect(calls).toContainEqual({
    internalKey: 'internal',
    actorId: 'user-1',
    workspaceId: 'workspace-1',
    attemptId: 'attempt-12345678',
    paymentIntentId: 'pi_test',
    billingDetails: {
      name: 'Billing Owner',
      email: 'owner@example.test',
      address: {
        line1: '1 Test Street',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94105',
        country: 'US',
      },
    },
    now: 1_700_000_000_000,
  })
})

test('recommendations proxy the purpose to the Convex action and answer 200 with four picks', async () => {
  const { app, calls } = onboardingApp({})

  const response = await app.request(
    recommendationsRequest({ purpose: 'Grow my bakery.', tagHints: ['marketing'] }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ recommendations: FOUR_RECOMMENDATIONS })
  expect(calls).toEqual([
    { internalKey: 'internal', purpose: 'Grow my bakery.', tagHints: ['marketing'] },
  ])
})

test('an invalid body is a 400 before any Convex call', async () => {
  const { app, calls } = onboardingApp({})

  for (const body of [
    {},
    { purpose: '' },
    { purpose: 'x'.repeat(WORKSPACE_PURPOSE_MAX_LENGTH + 1) },
  ]) {
    const response = await app.request(recommendationsRequest(body))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
  }
  expect(calls).toEqual([])
})

test('non-owners are refused with 403', async () => {
  const { app, calls } = onboardingApp({ role: 'editor' })

  const response = await app.request(recommendationsRequest({ purpose: 'Grow my bakery.' }))

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'forbidden' })
  expect(calls).toEqual([])
})

test('an already-onboarded workspace is refused with 409', async () => {
  const { app, calls } = onboardingApp({ onboardedAt: 1_700_000_000_000 })

  const response = await app.request(recommendationsRequest({ purpose: 'Grow my bakery.' }))

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'already_onboarded' })
  expect(calls).toEqual([])
})

test('an action failure still answers 200 with empty recommendations', async () => {
  const { app } = onboardingApp({
    action: async () => {
      throw new Error('convex unavailable')
    },
  })

  const response = await app.request(recommendationsRequest({ purpose: 'Grow my bakery.' }))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ recommendations: [] })
})

test('a malformed action reply (partial list) degrades to empty, never a partial 200', async () => {
  const { app } = onboardingApp({
    action: async () => ({ recommendations: FOUR_RECOMMENDATIONS.slice(0, 2) }),
  })

  const response = await app.request(recommendationsRequest({ purpose: 'Grow my bakery.' }))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ recommendations: [] })
})
