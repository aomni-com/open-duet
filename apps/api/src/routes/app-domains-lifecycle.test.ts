import { afterEach, expect, test } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { ConvexError, convexToJson, jsonToConvex, type Value } from 'convex/values'
import { Hono } from 'hono'

import { AppDomainListResponseSchema, AppDomainResponseSchema } from '@repo/contract'

import {
  cleanupCustomDomainFixtures,
  createCustomDomainFixture,
  settleDomainWork,
} from '../../../../packages/backend/src/custom-domains-fixture'
import type { ApiRouteRuntime, ApiVariables, AuthPayload } from '../shared'
import { registerAppDomainRoutes } from './app-domains'

afterEach(cleanupCustomDomainFixtures)

test('REST reservations, DNS checks, source continuation, and removal share one durable lifecycle', async () => {
  const { t, args, provider, assignments } = await createCustomDomainFixture()
  const client = new ConvexHttpClient('https://fixture.convex.cloud', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          path: string
          args: Parameters<typeof jsonToConvex>[0][]
        }
        const values = jsonToConvex(body.args[0]!) as Record<string, Value>
        try {
          const value =
            new URL(String(input)).pathname === '/api/query'
              ? await t.query(makeFunctionReference<'query'>(body.path), values)
              : await t.mutation(makeFunctionReference<'mutation'>(body.path), values)
          return Response.json({ status: 'success', value: convexToJson(value) })
        } catch (error) {
          if (!(error instanceof ConvexError)) throw error
          return Response.json({
            status: 'error',
            errorMessage: error.message,
            errorData: convexToJson(error.data),
          })
        }
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  })
  const auth: AuthPayload = {
    credentialKind: 'user',
    user: { id: args.identity.actorId, email: 'domain-owner@example.test' },
    scopes: ['ws:domains:apps'],
    versions: { api: 1 },
    workspaces: [
      {
        id: args.workspaceId,
        slug: 'domains',
        name: 'Domains',
        status: 'active',
        servicingStatus: 'active',
        onboardedAt: 1,
        role: 'owner',
        billingUserId: args.identity.actorId,
        funding: { plan: null, active: true },
        creditRecovery: null,
        defaultTier: { effective: 'balanced' },
      },
    ],
  }
  const app = new Hono<{ Variables: ApiVariables }>()
  // Authentication has its own real-deployment suite; this trace starts with
  // its accepted identity and controls only Convex/Vercel HTTP transports.
  app.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  const runtime: ApiRouteRuntime = {
    convex: client,
    internalKey: args.internalKey,
    apiInternalKey: args.internalKey,
    fetchImpl: globalThis.fetch,
    now: Date.now,
    appUrl: 'https://app.example',
    officialHubOwnerEmail: 'fixture@example.test',
    officialHubBaseUrl: 'https://hub.example',
  }
  registerAppDomainRoutes(app, runtime)
  const path = '/v1/ws/domains/apps/one/domain'
  const attach = (route: string, hostname: string) =>
    app.request(route, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname }),
    })
  provider.ownershipVerified = false
  provider.misconfigured = true
  const initial = await attach(path, ' HTTPS://ONE.Example.COM/ ')
  expect(initial.status).toBe(200)
  const first = AppDomainResponseSchema.parse(await initial.json()).domain!
  expect(first).toMatchObject({ hostname: 'one.example.com', status: 'pending' })
  const replay = await attach(path, 'one.example.com')
  expect(AppDomainResponseSchema.parse(await replay.json()).domain).toMatchObject({
    id: first.id,
    hostname: first.hostname,
  })
  const conflict = await attach('/v1/ws/domains/apps/two/domain', first.hostname)
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ error: 'hostname_in_use' })
  await attach('/v1/ws/domains/apps/two/domain', 'two.example.com')
  await settleDomainWork(t)
  const waiting = AppDomainResponseSchema.parse(await (await app.request(path)).json()).domain!
  expect(waiting).toMatchObject({
    status: 'verifying',
    records: [
      expect.objectContaining({ type: 'TXT', value: 'ownership-proof' }),
      expect.objectContaining({ type: 'A', value: '76.76.21.21' }),
    ],
  })
  const firstPage = AppDomainListResponseSchema.parse(
    await (await app.request('/v1/ws/domains/app-domains?limit=1')).json(),
  )
  expect(firstPage.items[0]).toMatchObject({
    domain: { id: first.id },
    app: { slug: 'one', controls: { manageDomain: true } },
  })
  expect(firstPage.nextCursor).not.toBeNull()
  const nextPage = AppDomainListResponseSchema.parse(
    await (
      await app.request(
        `/v1/ws/domains/app-domains?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      )
    ).json(),
  )
  expect(nextPage.items[0]).toMatchObject({
    domain: { hostname: 'two.example.com' },
    app: { slug: 'two' },
  })
  expect(nextPage.nextCursor).toBeNull()
  provider.ownershipVerified = true
  provider.misconfigured = false
  expect((await app.request(`${path}/recheck`, { method: 'POST' })).status).toBe(200)
  await settleDomainWork(t)
  expect(
    AppDomainResponseSchema.parse(await (await app.request(path)).json()).domain,
  ).toMatchObject({ id: first.id, status: 'active', records: [], conflicts: [] })
  const remove = await app.request(path, { method: 'DELETE' })
  expect(AppDomainResponseSchema.parse(await remove.json()).domain).toMatchObject({
    id: first.id,
    status: 'removing',
  })
  await settleDomainWork(t)
  expect(assignments.has(first.hostname)).toBe(false)
  expect(await (await app.request(path)).json()).toEqual({ domain: null })
})
