import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { getFunctionName } from 'convex/server'

import { DUET_COLLECTION_SUBJECT_HEADER } from '@repo/contract'

import {
  DUET_APP_ACCESS_QUERY,
  INTERNAL_KEY,
  app,
  authed,
  authedWith,
  bootApiSuite,
  convex,
  createApiApp,
  issueKey,
  humanWorkspaceFixture,
  listMine,
  mintBrowserSession,
  mutate,
  owner,
  provisionRegisteredWorkspace,
  query,
  resetApiSuiteBetweenTests,
  signInWithMagicLink,
  stopApiSuite,
  uniqueEmail,
  uniqueSlug,
  verifyAppAccessGrant,
  workspace,
} from './index-suite'
import type { AnchorRow, App, AppResponse, UserRow, WorkspaceRow } from './index-suite'

// App CRUD and reconciliation, anchors and reanchoring, shares, publishes.
// One topic slice of the api v1 suite; each slice file boots its own
// deployment through the shared kit in index-suite.ts.
describe('api v1: apps, shares, and publishing', () => {
  beforeAll(bootApiSuite, 240_000)
  afterAll(stopApiSuite)
  afterEach(resetApiSuiteBetweenTests)

  test('anchors list uses files:read scope and returns identity rows only', async () => {
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: uniqueSlug('api-anchors-list'),
      name: 'API Anchors List',
    })) as string
    const listedWorkspace = ((await listMine(owner.client)) as WorkspaceRow[]).find(
      row => row.workspace._id === workspaceId,
    )!
    const anchor = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'apps/site',
      kind: 'app',
      settings: {},
      now: 12_000,
    })) as AnchorRow
    const trailingAnchor = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'publishes/trailing',
      kind: 'publish',
      settings: {},
      now: 13_000,
    })) as AnchorRow
    const readKey = await issueKey(owner.client)
    const outsiderKey = await issueKey((await humanWorkspaceFixture(workspaceId, null)).client)

    const denied = await authed(`/v1/ws/${listedWorkspace.workspace.slug}/anchors`, outsiderKey.key)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${listedWorkspace.workspace.slug}:files:read`,
    })

    const response = await authed(
      `/v1/ws/${listedWorkspace.workspace.slug}/anchors?limit=1`,
      readKey.key,
    )
    expect(response.status).toBe(200)
    const firstPage = (await response.json()) as { items: unknown[]; nextCursor: string | null }
    expect(firstPage).toMatchObject({
      items: [
        {
          id: anchor.id,
          workspaceId,
          path: 'apps/site',
          kind: 'app',
          settings: {},
          state: 'active',
          createdAt: 12_000,
          updatedAt: 12_000,
        },
      ],
    })
    expect(firstPage).not.toHaveProperty('anchors')
    expect(firstPage.nextCursor).toBeString()
    const secondPage = await authed(
      `/v1/ws/${listedWorkspace.workspace.slug}/anchors?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      readKey.key,
    )
    expect(await secondPage.json()).toMatchObject({
      items: [expect.objectContaining({ id: trailingAnchor.id, path: 'publishes/trailing' })],
    })
  })

  test('apps routes enforce apps scope and push reconcile config to the origin gateway', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('apps-proxy'))
    const outsiderKey = await issueKey(
      (await humanWorkspaceFixture(proxied.workspaceId, null)).client,
    )
    const appsKey = await issueKey(owner.client)
    const gatewayRequests: Array<{ url: string; method: string; headers: Headers; body: unknown }> =
      []
    const proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      edgeSecret: 'edge-secret',
      now: () => 789_000,
      fetch: async (input, init) => {
        gatewayRequests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        })
        return Response.json({ ok: true })
      },
    })

    const denied = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, outsiderKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'apps/site',
        command: 'bun run start',
        apiScopes: [],
        port: 4173,
        slug: 'site',
      }),
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${proxied.slug}:apps`,
    })

    const missingSlug = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'apps/site',
        command: 'bun run start',
        apiScopes: [],
        port: 4173,
      }),
    })
    expect(missingSlug.status).toBe(400)
    expect(await missingSlug.json()).toEqual({ error: 'invalid_request' })

    const missingPath = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'bun run start', apiScopes: [], port: 4173, slug: 'site' }),
    })
    expect(missingPath.status).toBe(400)
    expect(await missingPath.json()).toEqual({ error: 'invalid_request' })

    const missingScopes = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'apps/site',
        command: 'bun run start',
        port: 4173,
        slug: 'site',
      }),
    })
    expect(missingScopes.status).toBe(400)
    expect(await missingScopes.json()).toEqual({ error: 'invalid_request' })

    const registered = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'apps/site',
        command: 'bun run start',
        apiScopes: ['services', 'files:read', 'services'],
        installCommand: '  bun install  ',
        slug: 'site',
        name: 'Status Board',
        icon: 'assets/icon.png',
      }),
    })
    expect(registered.status).toBe(201)
    const registeredBody = await registered.json()
    expect(registeredBody).toMatchObject({
      app: {
        workspaceId: proxied.workspaceId,
        anchorPath: 'apps/site',
        slug: 'site',
        command: 'bun run start',
        apiScopes: ['files:read', 'services'],
        installCommand: 'bun install',
        name: 'Status Board',
        icon: 'assets/icon.png',
        visibility: 'folder',
      },
    })
    const allocatedPort = registeredBody.app.port as number
    expect(allocatedPort).toBeGreaterThanOrEqual(41_000)
    expect(allocatedPort).toBeLessThanOrEqual(41_999)

    const list = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key)
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      items: [
        {
          slug: 'site',
          apiScopes: ['files:read', 'services'],
          anchorPath: 'apps/site',
          name: 'Status Board',
          icon: 'assets/icon.png',
          canonicalUrl: `https://site--${proxied.slug}.edge.duet.so/`,
          runtimeStatus: 'reconciled',
          controls: {
            manageDomain: true,
            updateRuntime: true,
            makePublic: true,
            makePrivate: true,
            delete: true,
          },
        },
      ],
      meta: { capabilities: { register: true } },
    })
    const detail = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps/site`, appsKey.key)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      app: {
        slug: 'site',
        name: 'Status Board',
        icon: 'assets/icon.png',
        canonicalUrl: `https://site--${proxied.slug}.edge.duet.so/`,
      },
    })
    const launch = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/apps/site/launch`,
      appsKey.key,
    )
    expect(launch.status).toBe(302)
    const launchUrl = new URL(launch.headers.get('location')!)
    expect(launchUrl.origin).toBe(`https://site--${proxied.slug}.edge.duet.so`)
    expect(launchUrl.pathname).toBe('/')
    const accessGrant = launchUrl.searchParams.get(DUET_APP_ACCESS_QUERY)
    expect(accessGrant).not.toBeNull()
    expect(await verifyAppAccessGrant('edge-secret', accessGrant!, 789_000)).toMatchObject({
      appId: registeredBody.app.id,
      userId: owner.user._id,
      workspaceSlug: proxied.slug,
      appSlug: 'site',
      launchExpiresAt: 909_000,
      expiresAt: 29_589_000,
    })

    const launchPath = `/v1/ws/${proxied.slug}/apps/site/launch`
    const invalidReturn = await authedWith(
      proxyApp,
      `${launchPath}?host=evil.test&path=%2Fdeep`,
      appsKey.key,
    )
    expect(invalidReturn.status).toBe(400)
    expect(await invalidReturn.json()).toEqual({ error: 'invalid_request' })
    const deepQuery = new URLSearchParams({
      host: `site--${proxied.slug}.edge.duet.so`,
      path: '/deep?q=a%2Fb&duet_access=stale',
    })
    const deepLaunch = await authedWith(proxyApp, `${launchPath}?${deepQuery}`, appsKey.key)
    expect(deepLaunch.status).toBe(302)
    const deepUrl = new URL(deepLaunch.headers.get('location')!)
    expect(deepUrl.pathname).toBe('/deep')
    expect(deepUrl.searchParams.get('q')).toBe('a/b')
    expect(deepUrl.searchParams.getAll(DUET_APP_ACCESS_QUERY)).toHaveLength(1)
    expect(deepUrl.searchParams.get(DUET_APP_ACCESS_QUERY)).not.toBe('stale')
    expect((await authedWith(proxyApp, `${launchPath}?host=aomni.co`, appsKey.key)).status).toBe(
      400,
    )

    let domainStatus: 'active' | 'removing' = 'active'
    let denyReturn = false
    const returnClient = new Proxy(convex.client, {
      get(target, property) {
        if (property !== 'query') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (...args: Parameters<typeof convex.client.query>) => {
          const name = getFunctionName(args[0])
          if (name === 'domains/apps/model:resolveForEdge' && args[1].customBinding !== undefined) {
            if (denyReturn) return { denied: true, visibility: 'folder' }
            // This transport owns the remote binding observation; the backend's
            // real custom binding/admission combination is pinned in its HTTP suite.
            return target.query(args[0], { ...args[1], customBinding: undefined })
          }
          const row = await Reflect.apply(target.query, target, args)
          return name === 'domains/apps/model:getBySlug' && row !== null
            ? { ...row, customDomain: { hostname: 'aomni.co', status: domainStatus } }
            : row
        }
      },
    })
    const returnApi = createApiApp({
      convexUrl: convex.url,
      convexClient: returnClient,
      internalKey: INTERNAL_KEY,
      edgeSecret: 'edge-secret',
      now: () => 789_000,
    })
    const customQuery = new URLSearchParams({ host: 'aomni.co', path: '/deep?q=1&duet_access=old' })
    const customLaunch = await authedWith(returnApi, `${launchPath}?${customQuery}`, appsKey.key)
    expect(customLaunch.status).toBe(302)
    const customUrl = new URL(customLaunch.headers.get('location')!)
    expect(customUrl.origin).toBe('https://aomni.co')
    expect(customUrl.pathname).toBe('/deep')
    expect(customUrl.searchParams.get('q')).toBe('1')
    expect(customUrl.searchParams.getAll(DUET_APP_ACCESS_QUERY)).toHaveLength(1)
    expect(
      await verifyAppAccessGrant(
        'edge-secret',
        customUrl.searchParams.get(DUET_APP_ACCESS_QUERY)!,
        789_000,
      ),
    ).toMatchObject({ appId: registeredBody.app.id, userId: owner.user._id })
    denyReturn = true
    expect((await authedWith(returnApi, `${launchPath}?${customQuery}`, appsKey.key)).status).toBe(
      403,
    )
    denyReturn = false
    domainStatus = 'removing'
    expect((await authedWith(returnApi, `${launchPath}?${customQuery}`, appsKey.key)).status).toBe(
      400,
    )
    const embedded = await authedWith(returnApi, launchPath, appsKey.key)
    expect(new URL(embedded.headers.get('location')!).host).toBe(
      `site--${proxied.slug}.edge.duet.so`,
    )

    expect(gatewayRequests).toHaveLength(1)
    expect(gatewayRequests[0]!.url).toBe('https://gateway-proxy.exe.xyz/v1/apps/reconcile')
    expect(gatewayRequests[0]!.method).toBe('POST')
    expect(gatewayRequests[0]!.headers.get('authorization')).toBe(`Bearer ${proxied.vmToken}`)
    expect(gatewayRequests[0]!.body).toEqual({
      apps: [
        {
          appId: registeredBody.app.id,
          slug: 'site',
          command: 'bun run start',
          installCommand: 'bun install',
          name: 'Status Board',
          port: allocatedPort,
          anchorPath: 'apps/site',
          apiScopes: ['files:read', 'services'],
          visibility: 'folder',
        },
      ],
      requiredReadySlugs: ['site'],
    })

    const viewer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('apps-viewer'),
      'Apps Viewer',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      userId: viewer.user._id,
      role: 'viewer',
    })
    const viewerKey = await issueKey(viewer.client)
    const viewerList = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, viewerKey.key)
    expect(viewerList.status).toBe(200)
    expect(await viewerList.json()).toMatchObject({
      meta: { capabilities: { register: false } },
      items: [
        {
          slug: 'site',
          controls: {
            manageDomain: false,
            updateRuntime: false,
            makePublic: false,
            makePrivate: false,
            delete: false,
          },
        },
      ],
    })
    const viewerMutation = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/apps/site`,
      viewerKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 4174 }),
      },
    )
    expect(viewerMutation.status).toBe(403)
    const viewerDelete = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/apps/site`,
      viewerKey.key,
      { method: 'DELETE' },
    )
    expect(viewerDelete.status).toBe(403)
    const viewerWriteShareRegistration = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/apps`,
      viewerKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: 'apps/from-share',
          command: 'bun run start',
          apiScopes: [],
          port: 4174,
          slug: 'from-share',
        }),
      },
    )
    expect(viewerWriteShareRegistration.status).toBe(403)

    const editor = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('apps-editor'),
      'Apps Editor',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      userId: editor.user._id,
      role: 'editor',
    })
    const editorKey = await issueKey(editor.client)
    const editorList = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, editorKey.key)
    expect(await editorList.json()).toMatchObject({
      meta: { capabilities: { register: true } },
      items: [
        {
          slug: 'site',
          controls: {
            manageDomain: true,
            updateRuntime: true,
            makePublic: false,
            makePrivate: true,
            delete: true,
          },
        },
      ],
    })
    const editorPublic = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/apps/site/visibility`,
      editorKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'public' }),
      },
    )
    expect(editorPublic.status).toBe(403)
    const editorUpdate = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/apps/site`,
      editorKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command: 'bun run start',
          apiScopes: ['members'],
          installCommand: 'bun install --frozen-lockfile',
          port: 4173,
        }),
      },
    )
    expect(editorUpdate.status).toBe(200)
    expect(await editorUpdate.json()).toMatchObject({
      app: { apiScopes: ['members'], installCommand: 'bun install --frozen-lockfile' },
    })
    expect(gatewayRequests.at(-1)?.body).toMatchObject({
      apps: [
        expect.objectContaining({
          apiScopes: ['members'],
          installCommand: 'bun install --frozen-lockfile',
        }),
      ],
    })
    const ownerPublic = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/apps/site/visibility`,
      appsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'public' }),
      },
    )
    expect(ownerPublic.status).toBe(200)
    // Visibility toggles deliberately do not push (nothing restarts; the
    // gateway learns on the next sync poll). The next legitimate push must
    // carry the enriched metadata.
    const pushesBeforeRefresh = gatewayRequests.length
    const editorRefresh = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/apps/site`,
      appsKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command: 'bun run start',
          apiScopes: ['members'],
          installCommand: 'bun install --frozen-lockfile',
          port: 4173,
        }),
      },
    )
    expect(editorRefresh.status).toBe(200)
    expect(gatewayRequests.length).toBeGreaterThan(pushesBeforeRefresh)
    expect(gatewayRequests.at(-1)?.body).toMatchObject({
      apps: [
        expect.objectContaining({
          visibility: 'public',
          canonicalUrl: `https://site--${proxied.slug}.edge.duet.so/`,
        }),
      ],
    })
    const editorPrivate = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/apps/site/visibility`,
      editorKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'folder' }),
      },
    )
    expect(editorPrivate.status).toBe(200)

    const failedApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 790_000,
      fetch: async () => Response.json({ error: 'gateway_unavailable' }, { status: 503 }),
    })
    const failed = await authedWith(failedApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'apps/failing',
        command: 'bun run start',
        apiScopes: [],
        port: 4174,
        slug: 'failing',
      }),
    })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({
      error: 'app_reconcile_failed',
      operation: 'register',
      reason: 'gateway_unavailable',
      app: { slug: 'failing', runtimeStatus: 'reconcile_failed' },
    })
    const failedUpdate = await authedWith(
      failedApp,
      `/v1/ws/${proxied.slug}/apps/site`,
      appsKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command: 'broken command',
          apiScopes: ['publish'],
          installCommand: 'broken install',
          port: 4999,
          name: 'Renamed During Reconcile',
          icon: 'assets/replaced.png',
        }),
      },
    )
    expect(failedUpdate.status).toBe(502)
    expect(await failedUpdate.json()).toMatchObject({
      error: 'app_reconcile_failed',
      operation: 'update',
      app: {
        slug: 'site',
        command: 'bun run start',
        apiScopes: ['members'],
        installCommand: 'bun install --frozen-lockfile',
        port: 4173,
        name: 'Renamed During Reconcile',
        icon: 'assets/replaced.png',
        runtimeStatus: 'reconcile_failed',
      },
    })
    const detailAfterFailedUpdate = await authedWith(
      failedApp,
      `/v1/ws/${proxied.slug}/apps/site`,
      appsKey.key,
    )
    expect(await detailAfterFailedUpdate.json()).toMatchObject({
      app: {
        command: 'bun run start',
        apiScopes: ['members'],
        installCommand: 'bun install --frozen-lockfile',
        port: 4173,
        name: 'Renamed During Reconcile',
        icon: 'assets/replaced.png',
        runtimeStatus: 'reconcile_failed',
      },
    })
    const failedDelete = await authedWith(
      failedApp,
      `/v1/ws/${proxied.slug}/apps/failing`,
      appsKey.key,
      { method: 'DELETE' },
    )
    expect(failedDelete.status).toBe(502)
    expect(await failedDelete.json()).toMatchObject({
      error: 'app_reconcile_failed',
      operation: 'delete',
      reason: 'gateway_unavailable',
      app: { slug: 'failing' },
    })
    const listAfterFailedDelete = await authedWith(
      failedApp,
      `/v1/ws/${proxied.slug}/apps`,
      appsKey.key,
    )
    expect(await listAfterFailedDelete.json()).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ slug: 'failing' })]),
    })
    const deleted = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps/site`, editorKey.key, {
      method: 'DELETE',
    })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })
    const afterDelete = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key)
    expect((await afterDelete.json()).items).not.toContainEqual(
      expect.objectContaining({ slug: 'site' }),
    )
  }, 60_000)

  // Registration may answer with a slug DIFFERENT from the request: an
  // existing path keeps its born slug, and a taken slug gets suffixed. The
  // route must reconcile the slug the registration RETURNED — keying anything
  // on the requested slug waits on the wrong app, or 500s on a slug that is
  // in no config at all.
  test('app register reconciles the returned slug, not the requested one', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('apps-born-slug'))
    const appsKey = await issueKey(owner.client)
    const gatewayRequests: Array<{ url: string; body: { requiredReadySlugs?: string[] } }> = []
    const proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        gatewayRequests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return Response.json({ ok: true })
      },
    })
    const register = (body: unknown) =>
      authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const born = await register({
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      slug: 'site',
    })
    expect(born.status).toBe(201)

    // Same path re-registered under a different requested slug: the app keeps
    // the slug it was born with, and the readiness gate names that slug.
    const reregistered = await register({
      path: 'apps/site',
      command: 'bun run start --updated',
      apiScopes: [],
      slug: 'renamed',
    })
    expect(reregistered.status).toBe(201)
    expect((await reregistered.json()).app).toMatchObject({
      slug: 'site',
      command: 'bun run start --updated',
      runtimeStatus: 'reconciled',
    })
    expect(gatewayRequests.at(-1)!.url).toBe('https://gateway-proxy.exe.xyz/v1/apps/reconcile')
    expect(gatewayRequests.at(-1)!.body.requiredReadySlugs).toEqual(['site'])

    // New path colliding with a taken slug: the registration suffixes it, and
    // the readiness gate names the suffixed slug, not the old app's.
    const collided = await register({
      path: 'apps/other',
      command: 'bun run start',
      apiScopes: [],
      slug: 'site',
    })
    expect(collided.status).toBe(201)
    expect((await collided.json()).app.slug).toBe('site-2')
    expect(gatewayRequests.at(-1)!.body.requiredReadySlugs).toEqual(['site-2'])
  }, 60_000)

  // The rollback snapshot for a failed register must come from the row the
  // PATH names: the requested slug can name a different app (collision) or no
  // app at all (re-register under a new requested slug).
  test('a failed re-register restores the runtime of the row at its path', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('apps-rereg-restore'))
    const appsKey = await issueKey(owner.client)
    const proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: true }),
    })
    const registered = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'apps/site',
        command: 'bun run start',
        apiScopes: [],
        port: 4180,
        slug: 'site',
      }),
    })
    expect(registered.status).toBe(201)

    const failingApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ error: 'gateway_unavailable' }, { status: 503 }),
    })
    const failed = await authedWith(failingApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'apps/site',
        command: 'bun run broken',
        apiScopes: [],
        port: 4181,
        slug: 'renamed',
      }),
    })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({
      error: 'app_reconcile_failed',
      operation: 'register',
      reason: 'gateway_unavailable',
      app: {
        slug: 'site',
        command: 'bun run start',
        port: 4180,
        runtimeStatus: 'reconcile_failed',
      },
    })
  }, 60_000)

  test('apps list validates and applies the public path and scope query matrix', async () => {
    const listed = await provisionRegisteredWorkspace(uniqueSlug('apps-list-query'))
    const appsKey = await issueKey(owner.client)
    const outsiderKey = await issueKey(
      (await humanWorkspaceFixture(listed.workspaceId, null)).client,
    )
    for (const registration of [
      { path: 'welcome', slug: 'welcome' },
      { path: 'welcome/hello', slug: 'hello' },
      { path: 'welcome/hello/deep', slug: 'deep' },
      { path: 'other', slug: 'other' },
    ]) {
      await mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId: listed.workspaceId,
        path: registration.path,
        command: 'bun run start',
        apiScopes: [],
        slug: registration.slug,
      })
    }

    const listSlugs = async (query = '') => {
      const response = await authedWith(app, `/v1/ws/${listed.slug}/apps${query}`, appsKey.key)
      expect(response.status).toBe(200)
      return ((await response.json()) as { items: Array<{ slug: string }> }).items.map(
        listedApp => listedApp.slug,
      )
    }

    expect(await listSlugs()).toEqual(['deep', 'hello', 'other', 'welcome'])
    expect(await listSlugs('?path=')).toEqual(['deep', 'hello', 'other', 'welcome'])
    expect(await listSlugs('?path=&scope=subtree')).toEqual(['deep', 'hello', 'other', 'welcome'])
    expect(await listSlugs('?path=&scope=children')).toEqual(['other', 'welcome'])
    expect(await listSlugs('?path=&scope=self')).toEqual([])
    expect(await listSlugs('?path=welcome')).toEqual(['deep', 'hello', 'welcome'])
    expect(await listSlugs('?path=welcome&scope=subtree')).toEqual(['deep', 'hello', 'welcome'])
    expect(await listSlugs('?path=welcome&scope=children')).toEqual(['hello'])
    expect(await listSlugs('?path=welcome%2F%2F&scope=self')).toEqual(['welcome'])

    for (const query of ['?scope=children', '?path=..%2Fsecret']) {
      const invalid = await authedWith(app, `/v1/ws/${listed.slug}/apps${query}`, appsKey.key)
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'invalid_request' })
    }

    const denied = await authedWith(app, `/v1/ws/${listed.slug}/apps?path=welcome`, outsiderKey.key)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${listed.slug}:apps`,
    })
    const unauthorized = await app.request(`/v1/ws/${listed.slug}/apps?path=welcome`)
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({ error: 'unauthorized' })
  })

  test('apps list resolves exact ids and deepest containing cwd without draining a large list', async () => {
    const listed = await provisionRegisteredWorkspace(uniqueSlug('apps-targeted-query'))
    const appsKey = await issueKey(owner.client)
    await mutate(owner.client, 'testing/apps:seedWorkspaceAppsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: listed.workspaceId,
      createdByUserId: owner.user._id,
      count: 98,
      matchingPath: 'matching',
    })
    const seeded = (await query(owner.client, 'testing/apps:rawAppsForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ _id: string; workspaceId: string; slug: string }>
    const target = seeded.find(
      candidate => candidate.workspaceId === listed.workspaceId && candidate.slug === 'seed-097',
    )!
    for (const [path, slug] of [
      ['projects/tool', 'tool'],
      ['projects/tool/packages/panel', 'panel'],
    ] as const) {
      await mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId: listed.workspaceId,
        path,
        command: 'bun run start',
        apiScopes: [],
        slug,
      })
    }

    const firstPage = await authedWith(app, `/v1/ws/${listed.slug}/apps?limit=50`, appsKey.key)
    expect(firstPage.status).toBe(200)
    const firstPageBody = (await firstPage.json()) as {
      items: Array<{ id: string }>
      nextCursor: string | null
    }
    expect(firstPageBody.nextCursor).toBeString()
    expect(firstPageBody.items.some(item => item.id === target._id)).toBe(false)

    const exact = await authedWith(
      app,
      `/v1/ws/${listed.slug}/apps?id=${encodeURIComponent(target._id)}`,
      appsKey.key,
    )
    expect(exact.status).toBe(200)
    expect(await exact.json()).toMatchObject({
      items: [{ id: target._id, slug: 'seed-097' }],
      nextCursor: null,
    })

    const containing = await authedWith(
      app,
      `/v1/ws/${listed.slug}/apps?cwd=projects%2Ftool%2Fpackages%2Fpanel%2Fsrc`,
      appsKey.key,
    )
    expect(containing.status).toBe(200)
    expect(await containing.json()).toMatchObject({
      items: [{ slug: 'panel', anchorPath: 'projects/tool/packages/panel' }],
      nextCursor: null,
    })

    for (const suffix of [
      `id=${encodeURIComponent(target._id)}&cursor=not-a-cursor`,
      `id=${encodeURIComponent(target._id)}&cursor=${encodeURIComponent(firstPageBody.nextCursor!)}`,
      `cwd=projects%2Ftool&cursor=${encodeURIComponent(firstPageBody.nextCursor!)}`,
    ]) {
      const invalidCursor = await authedWith(
        app,
        `/v1/ws/${listed.slug}/apps?${suffix}`,
        appsKey.key,
      )
      expect(invalidCursor.status).toBe(400)
      expect(await invalidCursor.json()).toEqual({ error: 'invalid_cursor' })
    }

    for (const suffix of [
      `id=${encodeURIComponent(target._id)}&cwd=projects%2Ftool`,
      `id=${encodeURIComponent(target._id)}&path=projects`,
      'cwd=projects%2Ftool&scope=self',
    ]) {
      const invalidRequest = await authedWith(
        app,
        `/v1/ws/${listed.slug}/apps?${suffix}`,
        appsKey.key,
      )
      expect(invalidRequest.status).toBe(400)
      expect(await invalidRequest.json()).toEqual({ error: 'invalid_request' })
    }
  })

  test('create-share route forwards ignorePatterns so a sharer can exclude files', async () => {
    const key = await issueKey(owner.client)
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: true }),
    })
    const created = await authedWith(routeApp, `/v1/ws/${workspace.slug}/shares`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'share-ignore-src',
        toEmail: owner.user.email,
        mode: 'read',
        ignorePatterns: ['.env', 'secret.key'],
      }),
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { share: { ignorePatterns: string[] } }
    // Additive: the breakage-preventing default floor stays, user patterns append.
    expect(body.share.ignorePatterns).toEqual([
      '**/.git',
      '(?d)**/node_modules',
      '.duet-anchor',
      '**/.duet-anchor',
      '.env',
      'secret.key',
    ])

    const duplicate = await authedWith(routeApp, `/v1/ws/${workspace.slug}/shares`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'share-ignore-src',
        toEmail: owner.user.email,
        mode: 'read',
      }),
    })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'already_shared' })
  })

  test('apps replica disable endpoint round-trips disable and enable', async () => {
    const recipient = await provisionRegisteredWorkspace(uniqueSlug('replica-disable-api'))
    await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: Date.now(),
    })
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: workspace._id,
      path: 'api-replica-source/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'shared-web',
    })
    const shareResult = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspace._id,
      toEmail: owner.user.email,
      path: 'api-replica-source',
      mode: 'read',
    })) as { share: { id: string } }
    const share = shareResult.share
    const key = await issueKey(owner.client)
    const browserKey = await mintBrowserSession(owner.client)
    const gatewayBodies: unknown[] = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        gatewayBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true })
      },
    })

    const accepted = await authedWith(
      routeApp,
      `/v1/share-requests/${share.id}/accept`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toWorkspaceId: recipient.workspaceId,
          mountPath: 'shared/api-replica-source',
        }),
      },
    )
    expect(accepted.status).toBe(200)
    expect(gatewayBodies).toHaveLength(1)
    expect(gatewayBodies[0]).toMatchObject({
      anchors: [
        expect.objectContaining({ kind: 'share-mount', path: 'shared/api-replica-source' }),
        expect.objectContaining({ kind: 'app', path: 'shared/api-replica-source/web' }),
      ],
    })
    gatewayBodies.length = 0

    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: recipient.workspaceId,
      path: 'blocked',
      command: 'bun run local',
      apiScopes: [],
      slug: 'blocked',
    })
    const collidingShareResult = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspace._id,
      toEmail: owner.user.email,
      path: 'api-collision-source',
      mode: 'read',
    })) as { share: { id: string } }
    const collidingShare = collidingShareResult.share
    const collision = await authedWith(
      routeApp,
      `/v1/share-requests/${collidingShare.id}/accept`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toWorkspaceId: recipient.workspaceId,
          mountPath: 'blocked/nested',
        }),
      },
    )
    expect(collision.status).toBe(400)
    expect(await collision.json()).toEqual({ error: 'invalid_request' })

    const disabled = await authedWith(
      routeApp,
      `/v1/ws/${recipient.slug}/apps/shared-web/disabled`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      },
    )
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toMatchObject({
      app: { slug: 'shared-web', sourceShareId: share.id, disabledAt: expect.any(Number) },
    })
    expect(gatewayBodies.at(-1)).toMatchObject({
      apps: expect.not.arrayContaining([expect.objectContaining({ slug: 'shared-web' })]),
      requiredReadySlugs: [],
    })

    const enabled = await authedWith(
      routeApp,
      `/v1/ws/${recipient.slug}/apps/shared-web/disabled`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: false }),
      },
    )
    expect(enabled.status).toBe(200)
    expect((await enabled.json()).app).not.toHaveProperty('disabledAt')
    expect(gatewayBodies.at(-1)).toMatchObject({
      apps: expect.arrayContaining([expect.objectContaining({ slug: 'shared-web' })]),
      requiredReadySlugs: ['shared-web'],
    })

    const failingRouteApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ error: 'gateway_unavailable' }, { status: 503 }),
    })
    const failed = await authedWith(
      failingRouteApp,
      `/v1/ws/${recipient.slug}/apps/shared-web/disabled`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      },
    )
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({
      error: 'app_reconcile_failed',
      operation: 'disable',
      reason: 'gateway_unavailable',
      app: {
        slug: 'shared-web',
        runtimeStatus: 'reconcile_failed',
        disabledAt: expect.any(Number),
      },
    })
  })

  test('failed publish snapshot confirmation leaves the publish unpaused', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('publish-freeze-fail'))
    await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: proxied.workspaceId,
      path: 'hub',
      kind: 'folder',
      slug: 'official',
    })
    const publishKey = await issueKey(owner.client)
    const pauseApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ error: 'snapshot_failed' }, { status: 500 }),
    })

    const response = await authedWith(
      pauseApp,
      `/v1/ws/${proxied.slug}/publishes/official/pause`,
      publishKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused: true }),
      },
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'publish_snapshot_failed' })
    expect(
      await query(owner.client, 'domains/publishes/model:getBySlug', {
        workspaceId: proxied.workspaceId,
        slug: 'official',
      }),
    ).not.toHaveProperty('pausedAt')

    const malformedConfirmationApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: false }),
    })
    const malformed = await authedWith(
      malformedConfirmationApp,
      `/v1/ws/${proxied.slug}/publishes/official/pause`,
      publishKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused: true }),
      },
    )
    expect(malformed.status).toBe(502)
    expect(
      await query(owner.client, 'domains/publishes/model:getBySlug', {
        workspaceId: proxied.workspaceId,
        slug: 'official',
      }),
    ).not.toHaveProperty('pausedAt')
  })

  test('bespoke ai generation routes are gone', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('ai-routes-gone'))
    const key = await issueKey(owner.client)
    const aiApp = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

    for (const path of [
      `/v1/ws/${workspace.slug}/ai/generate`,
      `/v1/ws/${workspace.slug}/ai/generate-media`,
    ]) {
      const response = await authedWith(aiApp, path, key.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'logo sketch' }),
      })
      expect(response.status).toBe(404)
    }
  })

  test('reanchor hides non-member anchors and repairs broken anchors', async () => {
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: uniqueSlug('api-reanchor'),
      name: 'API Reanchor',
    })) as string
    const listedWorkspace = ((await listMine(owner.client)) as WorkspaceRow[]).find(
      row => row.workspace._id === workspaceId,
    )!
    const anchor = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'apps/site',
      kind: 'app',
      settings: {},
    })) as AnchorRow
    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: anchor.id,
      reason: 'api_test',
    })
    const outsiderKey = await issueKey((await humanWorkspaceFixture(workspaceId, null)).client)
    const appsKey = await issueKey(owner.client)

    const denied = await authedWith(
      app,
      `/v1/ws/${listedWorkspace.workspace.slug}/anchors/${anchor.id}/reanchor`,
      outsiderKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'apps/site-fixed' }),
      },
    )
    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual({ error: 'not_found' })

    const malformed = await authedWith(
      app,
      `/v1/ws/${listedWorkspace.workspace.slug}/anchors/not-an-id/reanchor`,
      appsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'apps/site-fixed' }),
      },
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'invalid_request' })

    const repaired = await authedWith(
      app,
      `/v1/ws/${listedWorkspace.workspace.slug}/anchors/${anchor.id}/reanchor`,
      appsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'apps/site-fixed' }),
      },
    )
    expect(repaired.status).toBe(200)
    expect(await repaired.json()).toMatchObject({
      anchor: {
        id: anchor.id,
        workspaceId,
        path: 'apps/site-fixed',
        kind: 'app',
        settings: {},
        state: 'active',
      },
    })
  })

  test('name-only app PATCH does not push runtime reconciliation or transition runtime status', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('apps-name-only'))
    const appsKey = await issueKey(owner.client)
    const gatewayRequests: unknown[] = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        gatewayRequests.push(input)
        return Response.json({ ok: true })
      },
    })
    const registered = await authedWith(routeApp, `/v1/ws/${workspace.slug}/apps`, appsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'apps/named',
        command: 'bun run start',
        apiScopes: [],
        slug: 'named',
        name: 'Original Name',
        icon: 'icon.png',
      }),
    })
    expect(registered.status).toBe(201)
    const before = (await registered.json()) as AppResponse
    const reconcileCount = gatewayRequests.length

    const renamed = await authedWith(routeApp, `/v1/ws/${workspace.slug}/apps/named`, appsKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed App' }),
    })

    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({
      app: {
        name: 'Renamed App',
        icon: 'icon.png',
        runtimeStatus: 'reconciled',
        updatedAt: expect.any(Number),
      },
    })
    const detail = await authedWith(routeApp, `/v1/ws/${workspace.slug}/apps/named`, appsKey.key)
    const after = (await detail.json()) as AppResponse
    expect(after.app.updatedAt).toBeGreaterThan(before.app.updatedAt)
    expect(after.app.runtimeStatus).toBe('reconciled')
    expect(gatewayRequests).toHaveLength(reconcileCount)
  })

  test('OA-SLICE-07-KZQ7 share pause authorizes either active participant and refuses pending or terminal rows', async () => {
    const recipient = await provisionRegisteredWorkspace(uniqueSlug('share-pause-recipient'))
    const outsider = await provisionRegisteredWorkspace(uniqueSlug('share-pause-outsider'))
    await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: Date.now(),
    })
    const browserKey = await mintBrowserSession(owner.client)
    const gatewayCalls: unknown[] = []
    let now = 500_000
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => now,
      fetch: async input => {
        gatewayCalls.push(input)
        return Response.json({ ok: true })
      },
    })
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspace._id,
      toEmail: owner.user.email,
      path: 'control-plane/paused',
      mode: 'write',
      now: now - 10,
    })) as { share: { id: string } }
    const pause = (workspaceSlug: string, paused: boolean) =>
      authedWith(routeApp, `/v1/ws/${workspaceSlug}/shares/${created.share.id}/pause`, browserKey, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused }),
      })

    const pending = await pause(workspace.slug, true)
    expect(pending.status).toBe(409)
    expect(await pending.json()).toEqual({ error: 'share_not_active' })

    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: recipient.workspaceId,
      mountPath: 'shared/paused',
      now: now - 5,
    })
    const paused = await pause(workspace.slug, true)
    expect(paused.status).toBe(200)
    expect(await paused.json()).toMatchObject({
      share: { id: created.share.id, state: 'active', pausedAt: 500_000 },
    })

    now += 1
    const repeated = await pause(recipient.slug, true)
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({ share: { pausedAt: 500_000 } })

    const forbidden = await pause(outsider.slug, false)
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ error: 'forbidden' })

    const resumed = await pause(recipient.slug, false)
    expect(resumed.status).toBe(200)
    expect((await resumed.json()).share).not.toHaveProperty('pausedAt')

    await mutate(owner.client, 'domains/shares/model:revokeShare', {
      shareId: created.share.id,
      fromWorkspaceId: workspace._id,
      now: now + 1,
    })
    const terminal = await pause(workspace.slug, true)
    expect(terminal.status).toBe(409)
    expect(await terminal.json()).toEqual({ error: 'share_not_active' })
    expect(gatewayCalls).toEqual([])
  })

  test('origin app register and update keep their API shape while best-effort pushing recipients', async () => {
    const origin = await provisionRegisteredWorkspace(uniqueSlug('fanout-origin'))
    const recipient = await provisionRegisteredWorkspace(uniqueSlug('fanout-recipient'))
    const shareResult = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: origin.workspaceId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }
    const share = shareResult.share
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: share.id,
      toWorkspaceId: recipient.workspaceId,
      mountPath: 'shared/project',
    })
    const key = await issueKey(owner.client)
    const calls: Array<{ authorization: string | null; body: unknown }> = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get('authorization')
        calls.push({ authorization, body: JSON.parse(String(init?.body)) })
        return authorization === `Bearer ${recipient.vmToken}`
          ? Response.json({ error: 'recipient_offline' }, { status: 503 })
          : Response.json({ ok: true })
      },
    })

    const registered = await authedWith(routeApp, `/v1/ws/${origin.slug}/apps`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'project/web',
        command: 'bun run old',
        apiScopes: [],
        slug: 'web',
      }),
    })
    expect(registered.status).toBe(201)
    expect(await registered.json()).toMatchObject({
      app: { workspaceId: origin.workspaceId, slug: 'web', command: 'bun run old' },
    })
    expect(calls.map(call => call.authorization)).toEqual([
      `Bearer ${origin.vmToken}`,
      `Bearer ${recipient.vmToken}`,
    ])

    const updated = await authedWith(routeApp, `/v1/ws/${origin.slug}/apps/web`, key.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'bun run new', installCommand: 'bun install' }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      app: {
        workspaceId: origin.workspaceId,
        command: 'bun run new',
        installCommand: 'bun install',
      },
    })
    expect(calls.slice(2).map(call => call.authorization)).toEqual([
      `Bearer ${origin.vmToken}`,
      `Bearer ${recipient.vmToken}`,
    ])
    expect(calls.at(-1)?.body).toMatchObject({
      apps: [expect.objectContaining({ command: 'bun run new', installCommand: 'bun install' })],
    })
  })

  test('origin app reanchor best-effort pushes newly recreated recipient replicas', async () => {
    const origin = await provisionRegisteredWorkspace(uniqueSlug('reanchor-origin'))
    const recipient = await provisionRegisteredWorkspace(uniqueSlug('reanchor-recipient'))
    const source = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: origin.workspaceId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })) as { anchorId: string }
    const shareResult = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: origin.workspaceId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }
    const share = shareResult.share
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: share.id,
      toWorkspaceId: recipient.workspaceId,
      mountPath: 'shared/project',
    })
    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: source.anchorId,
    })
    const key = await issueKey(owner.client)
    const calls: string[] = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        calls.push(new Headers(init?.headers).get('authorization') ?? '')
        return await new Promise<Response>(() => {})
      },
    })

    const response = await authedWith(
      routeApp,
      `/v1/ws/${origin.slug}/anchors/${source.anchorId}/reanchor`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'project/web' }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      anchor: { id: source.anchorId, path: 'project/web', state: 'active' },
    })
    expect(calls).toEqual([`Bearer ${recipient.vmToken}`, `Bearer ${recipient.vmToken}`])
  })

  test('repairs a broken app by slug and returns the refreshed app wire value', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('app-slug-reanchor'))
    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: target.workspaceId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })) as { anchorId: string; id: string }
    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: registered.anchorId,
    })
    const key = await issueKey(owner.client)
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: true }),
    })

    const response = await authedWith(
      routeApp,
      `/v1/ws/${target.slug}/apps/web/reanchor`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'project/web-restored' }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      app: {
        id: registered.id,
        slug: 'web',
        anchorPath: 'project/web-restored',
        anchorState: 'active',
      },
    })
  })

  test('returns not found when the app slug does not exist during reanchor', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('app-reanchor-missing'))
    const key = await issueKey(owner.client)

    const response = await authedWith(app, `/v1/ws/${target.slug}/apps/missing/reanchor`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'project/web' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  })

  test('requires the workspace apps scope for slug reanchor', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('app-reanchor-scope'))
    const key = await issueKey((await humanWorkspaceFixture(target.workspaceId, null)).client)

    const response = await authedWith(app, `/v1/ws/${target.slug}/apps/missing/reanchor`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'project/web' }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${target.slug}:apps`,
    })
  })

  test('rejects reanchoring an app whose anchor is not broken', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('app-reanchor-active'))
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: target.workspaceId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })
    const key = await issueKey(owner.client)

    const response = await authedWith(app, `/v1/ws/${target.slug}/apps/web/reanchor`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'project/web-restored' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
  })

  test('rejects a slug reanchor when the destination path is already anchored', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('app-reanchor-collision'))
    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: target.workspaceId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })) as { anchorId: string }
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: target.workspaceId,
      path: 'project/occupied',
      command: 'bun run start',
      apiScopes: [],
      slug: 'occupied',
    })
    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: registered.anchorId,
    })
    const key = await issueKey(owner.client)

    const response = await authedWith(app, `/v1/ws/${target.slug}/apps/web/reanchor`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'project/occupied' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
  })

  test('rejects slug reanchor for a broken shared-app replica', async () => {
    const origin = await provisionRegisteredWorkspace(uniqueSlug('rep-reanchor-src'))
    const recipient = await provisionRegisteredWorkspace(uniqueSlug('rep-reanchor-dst'))
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: origin.workspaceId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })
    const shareResult = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: origin.workspaceId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }
    const share = shareResult.share
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: share.id,
      toWorkspaceId: recipient.workspaceId,
      mountPath: 'shared/project',
    })
    const replica = (await query(owner.client, 'domains/apps/model:getBySlug', {
      workspaceId: recipient.workspaceId,
      slug: 'web',
    })) as { anchorId: string }
    await mutate(owner.client, 'testing/anchors:forceBrokenForTest', {
      internalKey: INTERNAL_KEY,
      anchorId: replica.anchorId,
    })
    const key = await issueKey(owner.client)

    const response = await authedWith(app, `/v1/ws/${recipient.slug}/apps/web/reanchor`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'shared/project/web-restored' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
  })

  test('publish routes require publish scope, detect file kind through the gateway, and mutate slugs without redirects', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('publish-proxy'))
    const viewerKey = await issueKey(
      (await humanWorkspaceFixture(proxied.workspaceId, 'viewer')).client,
    )
    const publishKey = await issueKey(owner.client)
    const gatewayRequests: Array<{ url: string; headers: Headers }> = []
    const proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 987_000,
      fetch: async (input, init) => {
        const url = String(input)
        const headers = new Headers(init?.headers)
        gatewayRequests.push({ url, headers })
        if (url.endsWith('/reports/archive?list=1')) {
          return headers.get(DUET_COLLECTION_SUBJECT_HEADER) === `workspace:${proxied.workspaceId}`
            ? Response.json({ items: [], nextCursor: null })
            : Response.json({ error: 'invalid_request' }, { status: 400 })
        }
        if (url.endsWith('?list=1'))
          return Response.json({ error: 'not_directory' }, { status: 409 })
        return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/1' } })
      },
    })

    const denied = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/publishes`, viewerKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'reports/q2.md' }),
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${proxied.slug}:publish`,
    })

    const created = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/publishes`, publishKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'reports/q2.md', slug: 'q2' }),
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      publish: {
        workspaceId: proxied.workspaceId,
        anchorPath: 'reports/q2.md',
        slug: 'q2',
        kind: 'file',
      },
    })

    const renamed = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/publishes/q2`,
      publishKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'q2-live' }),
      },
    )
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ publish: { slug: 'q2-live' } })

    await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: proxied.workspaceId,
      path: 'reports/q3.md',
      kind: 'file',
      slug: 'q3',
    })
    const firstList = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/publishes?limit=1`,
      publishKey.key,
    )
    expect(firstList.status).toBe(200)
    const firstPage = (await firstList.json()) as {
      items: Array<{ slug: string; anchorPath: string }>
      nextCursor: string | null
    }
    expect(firstPage).toMatchObject({
      items: [{ slug: 'q2-live', anchorPath: 'reports/q2.md' }],
    })
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    const secondList = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/publishes?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      publishKey.key,
    )
    expect(secondList.status).toBe(200)
    const secondPage = (await secondList.json()) as {
      items: Array<{ slug: string; anchorPath: string }>
      nextCursor: string | null
    }
    expect(secondPage).toMatchObject({
      items: [{ slug: 'q3', anchorPath: 'reports/q3.md' }],
    })
    expect(secondPage.nextCursor).toEqual(expect.any(String))

    const exhaustedList = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/publishes?limit=1&cursor=${encodeURIComponent(secondPage.nextCursor!)}`,
      publishKey.key,
    )
    expect(exhaustedList.status).toBe(200)
    expect(await exhaustedList.json()).toEqual({ items: [], nextCursor: null })

    const folderCreated = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/publishes`,
      publishKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'reports/archive', slug: 'archive' }),
      },
    )
    expect(folderCreated.status).toBe(201)
    expect(await folderCreated.json()).toMatchObject({
      publish: {
        workspaceId: proxied.workspaceId,
        anchorPath: 'reports/archive',
        slug: 'archive',
        kind: 'folder',
      },
    })

    const deleted = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/publishes/q2-live`,
      publishKey.key,
      {
        method: 'DELETE',
      },
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })
    expect(gatewayRequests.map(request => request.url)).toEqual([
      'https://gateway-proxy.exe.xyz/v1/files/reports/q2.md?list=1',
      'https://gateway-proxy.exe.xyz/v1/files/reports/q2.md',
      'https://gateway-proxy.exe.xyz/v1/files/reports/archive?list=1',
      // Deleting a publish reaps its frozen-snapshot shadow tree.
      'https://gateway-proxy.exe.xyz/v1/publishes/freeze/gc',
    ])
    expect(gatewayRequests[0]!.headers.get('authorization')).toBe(`Bearer ${proxied.vmToken}`)
    expect(gatewayRequests[2]!.headers.get(DUET_COLLECTION_SUBJECT_HEADER)).toBe(
      `workspace:${proxied.workspaceId}`,
    )
  })

  test('publish pause remains live until the gateway confirms its durable snapshot', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('publish-freeze-order'))
    await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: proxied.workspaceId,
      path: 'hub',
      kind: 'folder',
      slug: 'official',
    })
    const publishKey = await issueKey(owner.client)
    let confirmSnapshot!: () => void
    const snapshotConfirmation = new Promise<void>(resolve => {
      confirmSnapshot = resolve
    })
    let snapshotStarted!: () => void
    const snapshotStart = new Promise<void>(resolve => {
      snapshotStarted = resolve
    })
    const pauseApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        if (String(input).endsWith('/v1/publishes/freeze/gc')) return Response.json({ ok: true })
        expect(String(input)).toBe('https://gateway-proxy.exe.xyz/v1/publishes/freeze')
        snapshotStarted()
        await snapshotConfirmation
        return Response.json({ ok: true })
      },
    })

    const pauseRequest = authedWith(
      pauseApp,
      `/v1/ws/${proxied.slug}/publishes/official/pause`,
      publishKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused: true }),
      },
    )
    expect(
      await Promise.race([
        pauseRequest.then(() => 'completed' as const),
        snapshotStart.then(() => 'snapshot_started' as const),
      ]),
    ).toBe('snapshot_started')
    expect(
      await query(owner.client, 'domains/publishes/model:getBySlug', {
        workspaceId: proxied.workspaceId,
        slug: 'official',
      }),
    ).not.toHaveProperty('pausedAt')
    const stillLive = (await query(owner.client, 'domains/publishes/model:resolveForEdge', {
      internalKey: INTERNAL_KEY,
      workspaceSlug: proxied.slug,
      publishSlug: 'official',
    })) as { publish: { freeze?: { generation: string } } }
    expect(stillLive.publish.freeze).toBeUndefined()

    confirmSnapshot()
    const paused = await pauseRequest
    expect(paused.status).toBe(200)
    const pausedBody = (await paused.json()) as { publish: { pauseGeneration: string } }
    expect(pausedBody.publish.pauseGeneration).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(pausedBody).toMatchObject({
      publish: {
        slug: 'official',
        pausedAt: expect.any(Number),
        pauseGeneration: expect.any(String),
      },
    })
  })

  test('same-value icon app PATCH is allowed and bumps updatedAt for deliberate cache busting', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('apps-icon-cache-bust'))
    const appsKey = await issueKey(owner.client)
    const gatewayRequests: unknown[] = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 40_000,
      fetch: async input => {
        gatewayRequests.push(input)
        return Response.json({ ok: true })
      },
    })
    const registered = await authedWith(routeApp, `/v1/ws/${workspace.slug}/apps`, appsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'apps/icon-cache-bust',
        command: 'bun run start',
        apiScopes: [],
        slug: 'icon-cache-bust',
        icon: 'icon.png',
      }),
    })
    expect(registered.status).toBe(201)
    const before = (await mutate(owner.client, 'domains/apps/model:setReconciliationStatus', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      slug: 'icon-cache-bust',
      status: 'reconcile_failed',
      error: 'gateway unavailable',
      now: 41_000,
    })) as Omit<App, 'canonicalUrl'>
    const reconcileCount = gatewayRequests.length

    const cacheBusted = await authedWith(
      routeApp,
      `/v1/ws/${workspace.slug}/apps/icon-cache-bust`,
      appsKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ icon: 'icon.png' }),
      },
    )

    expect(cacheBusted.status).toBe(200)
    const after = (await cacheBusted.json()) as AppResponse
    expect(after.app.icon).toBe('icon.png')
    expect(after.app.runtimeStatus).toBe(before.runtimeStatus)
    expect(after.app.updatedAt).toBeGreaterThan(before.updatedAt)
    expect(after.app).toMatchObject({ reconciliationError: 'gateway unavailable' })
    expect(gatewayRequests).toHaveLength(reconcileCount)
  })

  test('share lifecycle routes push recipient anchor projections without app reconciliation', async () => {
    const recipient = await provisionRegisteredWorkspace(uniqueSlug('share-control-plane'))
    await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now: Date.now(),
    })
    const browserKey = await mintBrowserSession(owner.client)
    const gatewayCalls: unknown[] = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        gatewayCalls.push(input)
        return Response.json({ ok: true })
      },
    })

    const create = async (path: string) => {
      const response = await authedWith(routeApp, `/v1/ws/${workspace.slug}/shares`, browserKey, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, toEmail: owner.user.email, mode: 'read' }),
      })
      expect(response.status).toBe(201)
      return (await response.json()).share as { id: string }
    }

    const acceptedShare = await create('control-plane/accepted')
    const pendingIds: string[] = []
    let pendingCursor: string | null = null
    do {
      const pending = await authedWith(
        routeApp,
        `/v1/share-requests${pendingCursor === null ? '' : `?cursor=${encodeURIComponent(pendingCursor)}`}`,
        browserKey,
      )
      expect(pending.status).toBe(200)
      const page = (await pending.json()) as {
        items: Array<{ id: string }>
        nextCursor: string | null
      }
      pendingIds.push(...page.items.map(item => item.id))
      pendingCursor = page.nextCursor
    } while (pendingCursor !== null)
    expect(pendingIds).toContain(acceptedShare.id)
    const accepted = await authedWith(
      routeApp,
      `/v1/share-requests/${acceptedShare.id}/accept`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toWorkspaceId: recipient.workspaceId,
          mountPath: 'shared/control-plane-accepted',
        }),
      },
    )
    expect(accepted.status).toBe(200)
    const repeatedAccept = await authedWith(
      routeApp,
      `/v1/share-requests/${acceptedShare.id}/accept`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toWorkspaceId: recipient.workspaceId,
          mountPath: 'shared/control-plane-accepted',
        }),
      },
    )
    expect(repeatedAccept.status).toBe(400)
    expect(await repeatedAccept.json()).toEqual({ error: 'invalid_request' })

    const listed = await authedWith(routeApp, `/v1/ws/${workspace.slug}/shares`, browserKey)
    expect(listed.status).toBe(200)
    const shares = (await listed.json()).items as Array<Record<string, unknown>>
    const outgoing = shares.find(share => share.id === acceptedShare.id)
    expect(outgoing).toMatchObject({ id: acceptedShare.id, direction: 'outgoing' })
    expect(outgoing).not.toHaveProperty('mountPath')

    const unlinked = await authedWith(
      routeApp,
      `/v1/ws/${recipient.slug}/shares/${acceptedShare.id}/unlink`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    )
    expect(unlinked.status).toBe(200)
    const repeatedUnlink = await authedWith(
      routeApp,
      `/v1/ws/${recipient.slug}/shares/${acceptedShare.id}/unlink`,
      browserKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    )
    expect(repeatedUnlink.status).toBe(400)
    expect(await repeatedUnlink.json()).toEqual({ error: 'invalid_request' })

    const declinedShare = await create('control-plane/declined')
    const declined = await authedWith(
      routeApp,
      `/v1/share-requests/${declinedShare.id}/decline`,
      browserKey,
      { method: 'POST' },
    )
    expect(declined.status).toBe(200)
    const repeatedDecline = await authedWith(
      routeApp,
      `/v1/share-requests/${declinedShare.id}/decline`,
      browserKey,
      { method: 'POST' },
    )
    expect(repeatedDecline.status).toBe(400)
    expect(await repeatedDecline.json()).toEqual({ error: 'invalid_request' })

    const revokedShare = await create('control-plane/revoked')
    const revoked = await authedWith(
      routeApp,
      `/v1/ws/${workspace.slug}/shares/${revokedShare.id}`,
      browserKey,
      { method: 'DELETE' },
    )
    expect(revoked.status).toBe(200)

    const tokenShareResult = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspace._id,
      toEmail: owner.user.email,
      path: 'control-plane/token',
      mode: 'read',
    })) as { share: { id: string }; invitationToken: string }
    const tokenShare = {
      ...tokenShareResult.share,
      invitationToken: tokenShareResult.invitationToken,
    }
    const resolved = await authedWith(
      routeApp,
      `/v1/share-requests/${tokenShare.invitationToken}`,
      browserKey,
    )
    expect(resolved.status).toBe(200)
    expect((await resolved.json()).share).toMatchObject({ id: tokenShare.id })

    expect(gatewayCalls).toEqual([
      'https://gateway-proxy.exe.xyz/v1/anchors/reconcile',
      'https://gateway-proxy.exe.xyz/v1/anchors/reconcile',
    ])
  })

  test('share pages preserve two directions for one share and bind continuation to the workspace', async () => {
    const source = await provisionRegisteredWorkspace(uniqueSlug('share-page-source'))
    const other = await provisionRegisteredWorkspace(uniqueSlug('share-page-other'))
    const shareResult = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: source.workspaceId,
      toEmail: owner.user.email,
      path: 'source',
      mode: 'read',
      now: 91_000,
    })) as { share: { id: string } }
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: shareResult.share.id,
      toWorkspaceId: source.workspaceId,
      mountPath: 'received',
      now: 91_001,
    })
    const browserKey = await mintBrowserSession(owner.client)
    const routeApp = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

    const firstResponse = await authedWith(
      routeApp,
      `/v1/ws/${source.slug}/shares?limit=1`,
      browserKey,
    )
    const first = (await firstResponse.json()) as {
      items: Array<{ id: string; direction: string }>
      nextCursor: string | null
    }
    expect(first.items.map(row => [row.id, row.direction])).toEqual([
      [shareResult.share.id, 'incoming'],
    ])
    expect(first.nextCursor).toBeString()

    const secondResponse = await authedWith(
      routeApp,
      `/v1/ws/${source.slug}/shares?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      browserKey,
    )
    const second = (await secondResponse.json()) as {
      items: Array<{ id: string; direction: string }>
      nextCursor: string | null
    }
    expect(second.items.map(row => [row.id, row.direction])).toEqual([
      [shareResult.share.id, 'outgoing'],
    ])
    expect(second.nextCursor).toBeString()
    const completeResponse = await authedWith(
      routeApp,
      `/v1/ws/${source.slug}/shares?limit=1&cursor=${encodeURIComponent(second.nextCursor!)}`,
      browserKey,
    )
    expect(await completeResponse.json()).toEqual({ items: [], nextCursor: null })

    const wrongWorkspace = await authedWith(
      routeApp,
      `/v1/ws/${other.slug}/shares?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      browserKey,
    )
    expect(wrongWorkspace.status).toBe(400)
    expect(await wrongWorkspace.json()).toEqual({ error: 'invalid_cursor' })
  })

  test('pending share requests remain publicly traversable beyond 500 rows', async () => {
    const source = await provisionRegisteredWorkspace(uniqueSlug('pending-page-source'))
    const createdAt = Date.now()
    const template = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: source.workspaceId,
      toEmail: owner.user.email,
      path: 'template',
      mode: 'read',
      now: createdAt,
    })) as { share: { id: string } }
    const seededIds = (await mutate(owner.client, 'testing/shares:seedPendingSharesForTest', {
      internalKey: INTERNAL_KEY,
      templateShareId: template.share.id,
      count: 501,
      createdAtStart: createdAt + 1,
    })) as string[]
    const browserKey = await mintBrowserSession(owner.client)
    let requestNow = Date.now()
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => requestNow,
    })
    const walked: string[] = []
    let cursor: string | null = null
    do {
      const url = `/v1/share-requests?limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      let response = await authedWith(routeApp, url, browserKey)
      // Supporting-work bounds can yield one share per page. Honor the API's
      // budget while walking hundreds of pages, using its advertised backoff.
      if (response.status === 429) {
        const refusal = (await response.json()) as { retryAfterSeconds: number }
        expect(refusal.retryAfterSeconds).toBeGreaterThan(0)
        requestNow += refusal.retryAfterSeconds * 1_000
        response = await authedWith(routeApp, url, browserKey)
      }
      expect(response.status).toBe(200)
      const page = (await response.json()) as {
        items: Array<{ id: string }>
        nextCursor: string | null
      }
      walked.push(...page.items.map(row => row.id))
      cursor = page.nextCursor
    } while (cursor !== null)

    const expected = [template.share.id, ...seededIds]
    const expectedSet = new Set(expected)
    expect(walked.filter(id => expectedSet.has(id))).toEqual(expected)
  }, 120_000)

  test('write-mode replica update returns the replica and pushes origin plus other recipients', async () => {
    const origin = await provisionRegisteredWorkspace(uniqueSlug('write-edit-origin'))
    const editor = await provisionRegisteredWorkspace(uniqueSlug('write-edit-editor'))
    const recipient = await provisionRegisteredWorkspace(uniqueSlug('write-edit-recipient'))
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: origin.workspaceId,
      path: 'project/web',
      command: 'bun run old',
      apiScopes: [],
      slug: 'web',
    })
    for (const target of [editor, recipient]) {
      const shareResult = (await mutate(owner.client, 'testing/shares:createShareForTest', {
        internalKey: INTERNAL_KEY,
        fromWorkspaceId: origin.workspaceId,
        toEmail: owner.user.email,
        path: 'project',
        mode: 'write',
      })) as { share: { id: string } }
      const share = shareResult.share
      await mutate(owner.client, 'domains/shares/model:acceptShare', {
        shareId: share.id,
        toWorkspaceId: target.workspaceId,
        mountPath: `shared/${target.slug}`,
      })
    }
    const key = await issueKey(owner.client)
    const calls: string[] = []
    let failEditorPush = false
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get('authorization') ?? ''
        calls.push(authorization)
        return failEditorPush && authorization === `Bearer ${editor.vmToken}`
          ? Response.json({ error: 'gateway_unavailable' }, { status: 503 })
          : Response.json({ ok: true })
      },
    })

    const response = await authedWith(routeApp, `/v1/ws/${editor.slug}/apps/web`, key.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'bun run shared', installCommand: 'bun install shared' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      app: {
        workspaceId: editor.workspaceId,
        sourceShareId: expect.any(String),
        command: 'bun run shared',
        installCommand: 'bun install shared',
        runtimeStatus: 'reconciled',
      },
    })
    expect(calls[0]).toBe(`Bearer ${editor.vmToken}`)
    expect(new Set(calls.slice(1))).toEqual(
      new Set([`Bearer ${origin.vmToken}`, `Bearer ${recipient.vmToken}`]),
    )

    const slugEdit = await authedWith(routeApp, `/v1/ws/${editor.slug}/apps/web`, key.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'bun run renamed', slug: 'renamed' }),
    })
    expect(slugEdit.status).toBe(400)
    expect(await slugEdit.json()).toEqual({ error: 'invalid_request' })

    failEditorPush = true
    const failed = await authedWith(routeApp, `/v1/ws/${editor.slug}/apps/web`, key.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'bun run rejected' }),
    })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({
      app: {
        workspaceId: editor.workspaceId,
        command: 'bun run shared',
        runtimeStatus: 'reconcile_failed',
      },
    })
    for (const target of [origin, editor, recipient]) {
      const apps = await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: target.workspaceId,
      })
      expect(apps).toEqual([
        expect.objectContaining({
          command: 'bun run shared',
          installCommand: 'bun install shared',
        }),
      ])
    }
  })

  test('slug reanchor pushes the recreated app config to affected recipients', async () => {
    const origin = await provisionRegisteredWorkspace(uniqueSlug('slug-reanchor-origin'))
    const recipient = await provisionRegisteredWorkspace(uniqueSlug('slug-reanchor-recipient'))
    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: origin.workspaceId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })) as { anchorId: string }
    const shareResult = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: origin.workspaceId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }
    const share = shareResult.share
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: share.id,
      toWorkspaceId: recipient.workspaceId,
      mountPath: 'shared/project',
    })
    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: registered.anchorId,
    })
    const key = await issueKey(owner.client)
    const calls: string[] = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        calls.push(new Headers(init?.headers).get('authorization') ?? '')
        return Response.json({ ok: true })
      },
    })

    const response = await authedWith(
      routeApp,
      `/v1/ws/${origin.slug}/apps/web/reanchor`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'project/web-restored' }),
      },
    )

    expect(response.status).toBe(200)
    expect(calls).toEqual([`Bearer ${recipient.vmToken}`])
  })
})
