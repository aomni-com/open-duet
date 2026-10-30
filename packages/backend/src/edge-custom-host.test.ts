import { afterEach, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import { DUET_APP_ACCESS_COOKIE, DUET_APP_ACCESS_QUERY, mintAppAccessGrant } from '@repo/contract'

import { createEdgeApp } from '../../../apps/edge/src/index'
import schema from '../convex/schema'

const originalEnv = { ...process.env }
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})
async function fixture() {
  process.env.DUET_API_INTERNAL_KEY = 'edge-api-key'
  process.env.DUET_EDGE_INTERNAL_KEY = 'edge-key'
  const t = convexTest(schema, {
    '../convex/_generated/api.ts': async () => ({}),
    '../convex/domains/edge/model.ts': () => import('../convex/domains/edge/model'),
    '../convex/http.ts': () => import('../convex/http'),
    '../convex/domains/apps/model.ts': () => import('../convex/domains/apps/model'),
    '../convex/domains/customDomains/model.ts': () =>
      import('../convex/domains/customDomains/model'),
  })
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'edge@example.test',
      createdAt: 1,
      updatedAt: 1,
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'acme',
      name: 'Acme',
      status: 'active',
      servicingStatus: 'active',
      createdByUserId: userId,
      billingUserId: userId,
      createdAt: 1,
      vmName: 'vm',
      httpsUrl: 'https://vm.example.test',
      vmTokenNonce: 'nonce',
    })
    const anchorId = await ctx.db.insert('anchors', {
      workspaceId,
      path: 'apps/todo',
      markerNonce: 'marker',
      kind: 'app',
      state: 'active',
      settings: {},
      createdAt: 1,
      updatedAt: 1,
    })
    const appId = await ctx.db.insert('apps', {
      workspaceId,
      anchorId,
      slug: 'todo',
      command: 'start',
      apiScopes: [],
      port: 4001,
      visibility: 'public',
      runtimeStatus: 'reconciled',
      createdByUserId: userId,
      createdAt: 1,
      updatedAt: 1,
    })
    const diagnosticsId = await ctx.db.insert('customDomainDiagnostics', {
      records: [],
      conflicts: [],
    })
    const domainId = await ctx.db.insert('customDomains', {
      workspaceId,
      appId,
      hostname: 'aomni.co',
      status: 'active',
      target: { teamId: 'team', projectId: 'project', gitBranch: 'staging' },
      revision: 1,
      providerAssigned: true,
      workRunning: false,
      createdByUserId: userId,
      nextWorkAt: 1,
      cleanupAttempts: 0,
      listed: true,
      diagnosticsId,
      createdAt: 1,
      updatedAt: 1,
    })
    return { userId, workspaceId, anchorId, appId, domainId }
  })
  const request = (body: unknown, secret = 'edge-key') =>
    t.fetch('/v1/edge/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-duet-edge-secret': secret },
      body: JSON.stringify(body),
    })
  return { t, ids, request }
}

test('custom host identity lookup requires the edge secret and exposes only a live active binding', async () => {
  const { t, ids, request } = await fixture()
  const body = { kind: 'app-host', hostname: 'aomni.co' }
  expect((await request(body, 'wrong')).status).toBe(401)
  const response = await request(body)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    appId: ids.appId,
    workspaceId: ids.workspaceId,
    workspaceSlug: 'acme',
    appSlug: 'todo',
  })
  for (const status of ['pending', 'verifying', 'failed', 'removing'] as const) {
    await t.run(ctx => ctx.db.patch(ids.domainId, { status }))
    expect((await request(body)).status).toBe(404)
  }
})

test('custom admission revalidates the binding before applying the unchanged app policy', async () => {
  const { t, ids, request } = await fixture()
  const body = {
    kind: 'app',
    host: 'aomni.co',
    workspaceSlug: 'acme',
    appSlug: 'todo',
    customBinding: { hostname: 'aomni.co', appId: ids.appId },
  }
  const active = await request(body)
  expect(active.status).toBe(200)
  expect(await active.json()).toMatchObject({
    visibility: 'public',
    origin: { httpsUrl: 'https://vm.example.test', gatewayPathPrefix: '/public/app' },
  })
  await t.run(ctx => ctx.db.patch(ids.domainId, { status: 'removing' }))
  expect((await request(body)).status).toBe(404)
  expect(
    (await request({ ...body, customBinding: undefined, host: 'todo--acme.edge.duet.so' })).status,
  ).toBe(200)
  await t.run(ctx => ctx.db.patch(ids.domainId, { status: 'active' }))
  expect(
    (await request({ ...body, customBinding: { ...body.customBinding, appId: 'different-app' } }))
      .status,
  ).toBe(404)
  await t.run(ctx => ctx.db.patch(ids.appId, { visibility: 'folder' }))
  expect((await request(body)).status).toBe(403)
  await t.run(ctx => ctx.db.patch(ids.appId, { visibility: 'public' }))
  await t.run(ctx => ctx.db.patch(ids.workspaceId, { servicingStatus: 'paused' }))
  expect(await (await request(body)).json()).toEqual({ paused: true, appName: 'todo' })
  await t.run(ctx => ctx.db.patch(ids.workspaceId, { suspendedAt: 42 }))
  expect((await request(body)).status).toBe(403)
  await t.run(ctx =>
    ctx.db.patch(ids.workspaceId, { suspendedAt: undefined, servicingStatus: 'active' }),
  )
  await t.run(ctx => ctx.db.patch(ids.anchorId, { state: 'broken' }))
  expect((await request(body)).status).toBe(404)
})

test('replacement apps discard old cookie identity while refusing old query grants', async () => {
  const { t, ids, request } = await fixture()
  const token = await mintAppAccessGrant('edge-key', {
    appId: 'old-app-id',
    userId: ids.userId,
    workspaceSlug: 'acme',
    appSlug: 'todo',
    launchExpiresAt: 20_000,
    expiresAt: 40_000,
    nonce: '0123456789abcdef0123456789abcdef',
  })
  const edge = createEdgeApp({
    convexSiteUrl: 'https://convex.example.test',
    edgeSecret: 'edge-key',
    now: () => 10_000,
    fetch: async (input, init) =>
      String(input).endsWith('/v1/edge/resolve')
        ? request(JSON.parse(String(init?.body)))
        : new Response('public replacement'),
  })
  for (const host of ['todo--acme.edge.duet.so', 'aomni.co']) {
    const response = await edge.fetch(
      new Request(`https://${host}/dashboard`, {
        headers: { host, cookie: `${DUET_APP_ACCESS_COOKIE}=${token}` },
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('public replacement')
    const query = new URLSearchParams({ [DUET_APP_ACCESS_QUERY]: token })
    const staleGrant = await edge.fetch(
      new Request(`https://${host}/dashboard?${query}`, {
        headers: { host, 'sec-fetch-dest': 'document' },
      }),
    )
    expect(staleGrant.status).toBe(403)
    expect(staleGrant.headers.get('set-cookie')).toBeNull()
  }
  await t.run(ctx => ctx.db.patch(ids.appId, { visibility: 'folder' }))
  for (const host of ['todo--acme.edge.duet.so', 'aomni.co']) {
    const guest = await edge.fetch(
      new Request(`https://${host}/dashboard`, {
        headers: {
          host,
          cookie: `${DUET_APP_ACCESS_COOKIE}=${token}`,
          'sec-fetch-dest': 'document',
        },
      }),
    )
    expect(guest.status).toBe(302)
    const location = new URL(guest.headers.get('location')!)
    expect(location.pathname).toBe('/w/acme/apps/todo/open')
    expect(location.searchParams.get('host')).toBe(host)
    expect(location.searchParams.get('path')).toBe('/dashboard')
  }
})

test('only an anonymous private denial is identified as a sign-in opportunity', async () => {
  const { t, ids, request } = await fixture()
  await t.run(ctx => ctx.db.patch(ids.appId, { visibility: 'folder' }))
  const body = {
    kind: 'app',
    host: 'todo--acme.edge.duet.so',
    workspaceSlug: 'acme',
    appSlug: 'todo',
  }
  expect(await (await request(body)).json()).toEqual({ error: 'guest_private' })
  const staleViewer = { ...body, viewerUserId: ids.userId, viewerAppId: 'former-app-id' }
  expect(await (await request({ ...staleViewer, viewerCredential: 'cookie' })).json()).toEqual({
    error: 'guest_private',
  })
  expect(await (await request({ ...staleViewer, viewerCredential: 'grant' })).json()).toEqual({
    error: 'forbidden',
  })
})

test('private app-cookie admission rechecks current membership without a sign-in loop', async () => {
  const { t, ids, request } = await fixture()
  await t.run(ctx => ctx.db.patch(ids.appId, { visibility: 'folder' }))
  const membershipId = await t.run(ctx =>
    ctx.db.insert('workspaceMembers', {
      workspaceId: ids.workspaceId,
      userId: ids.userId,
      role: 'owner',
    }),
  )
  const body = {
    kind: 'app',
    host: 'todo--acme.edge.duet.so',
    workspaceSlug: 'acme',
    appSlug: 'todo',
    viewerUserId: ids.userId,
    viewerAppId: ids.appId,
  }
  expect((await request(body)).status).toBe(200)
  await t.run(ctx => ctx.db.delete(membershipId))
  const revoked = await request(body)
  expect(revoked.status).toBe(403)
  expect(await revoked.json()).toEqual({ error: 'forbidden' })
})
