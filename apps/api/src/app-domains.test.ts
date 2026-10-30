import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { getFunctionName } from 'convex/server'

import { resolveEdgeHost } from './config'
import {
  INTERNAL_KEY,
  authedWith,
  bootApiSuite,
  convex,
  createApiApp,
  issueKey,
  humanWorkspaceFixture,
  mutate,
  owner,
  provisionRegisteredWorkspace,
  resetApiSuiteBetweenTests,
  signInWithMagicLink,
  stopApiSuite,
  uniqueEmail,
  uniqueSlug,
} from './index-suite'
import type { UserRow } from './index-suite'

describe('app domains REST boundary', () => {
  beforeAll(bootApiSuite, 240_000)
  afterAll(stopApiSuite)
  afterEach(resetApiSuiteBetweenTests)

  test('inspects an app domain without requiring provider credentials', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('domain-read'))
    const key = await issueKey(owner.client)
    const api = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: true }),
    })
    const registered = await authedWith(api, `/v1/ws/${workspace.slug}/apps`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'apps/site',
        slug: 'site',
        command: 'bun run start',
        apiScopes: [],
        port: 4173,
      }),
    })
    expect(registered.status).toBe(201)
    const response = await authedWith(api, `/v1/ws/${workspace.slug}/apps/site/domain`, key.key)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ domain: null })
  })

  test('refuses malformed domain requests before scheduling provider work', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('domain-invalid'))
    const key = await issueKey(owner.client)
    const api = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
    const response = await authedWith(api, `/v1/ws/${workspace.slug}/apps/site/domain`, key.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'https://example.com/path' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
  })

  test('removing an absent domain is idempotent without provider credentials', async () => {
    const { api, key, workspace } = await registeredSite('domain-remove')
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await authedWith(api, `/v1/ws/${workspace.slug}/apps/site/domain`, key.key, {
        method: 'DELETE',
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ domain: null })
    }
  })

  test('viewers can inspect domains but cannot attach one', async () => {
    const { api, workspace } = await registeredSite('domain-viewer')
    const viewer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('domain-viewer'),
      'Viewer',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      userId: viewer.user._id,
      role: 'viewer',
    })
    const key = await issueKey(viewer.client)
    const path = `/v1/ws/${workspace.slug}/apps/site/domain`
    const read = await authedWith(api, path, key.key)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ domain: null })
    const write = await authedWith(api, path, key.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'example.com' }),
    })
    expect(write.status).toBe(403)
    expect(await write.json()).toEqual({ error: 'forbidden' })
  })

  test('attach and recheck report missing provider configuration without changing visibility', async () => {
    const { api, key, workspace } = await registeredSite('domain-config')
    const path = `/v1/ws/${workspace.slug}/apps/site/domain`
    for (const operation of [
      { path, method: 'PUT', body: JSON.stringify({ hostname: 'example.com' }) },
      { path: `${path}/recheck`, method: 'POST' },
    ]) {
      const response = await authedWith(api, operation.path, key.key, {
        method: operation.method,
        headers: { 'content-type': 'application/json' },
        body: operation.body,
      })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'domain_not_configured' })
    }
    const response = await authedWith(api, `/v1/ws/${workspace.slug}/apps/site`, key.key)
    expect(await response.json()).toMatchObject({ app: { visibility: 'folder' } })
  })

  test('workspace domain inventory uses the ordinary apps scope and collection grammar', async () => {
    const { api, key, workspace } = await registeredSite('domain-list')
    const path = `/v1/ws/${workspace.slug}/app-domains`
    const response = await authedWith(api, `${path}?limit=1`, key.key)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [], nextCursor: null })
    const cursor = await authedWith(api, `${path}?cursor=not-a-cursor`, key.key)
    expect(cursor.status).toBe(400)
    expect(await cursor.json()).toEqual({ error: 'invalid_cursor' })
    const outsiderKey = await issueKey(
      (await humanWorkspaceFixture(workspace.workspaceId, null)).client,
    )
    const refused = await authedWith(api, path, outsiderKey.key)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${workspace.slug}:apps`,
    })
  })

  test('domain metadata callback authenticates internally and pushes current app configuration', async () => {
    const { workspace } = await registeredSite('domain-callback')
    const requests: Array<{ url: string; body: unknown }> = []
    const api = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return Response.json({ ok: true })
      },
    })
    const path = '/v1/internal/apps/reconcile'
    const init = {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: workspace.workspaceId }),
    }
    const refused = await api.request(path, {
      ...init,
      headers: { ...init.headers, authorization: 'Bearer wrong' },
    })
    expect(refused.status).toBe(401)
    expect(requests).toEqual([])
    const accepted = await api.request(path, init)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ status: 'reconciled' })
    expect(requests).toEqual([
      {
        url: 'https://gateway-proxy.exe.xyz/v1/apps/reconcile',
        body: { apps: [expect.objectContaining({ slug: 'site', visibility: 'folder' })] },
      },
    ])
  })

  test('standalone app projection switches domains while default launch stays on Duet', async () => {
    const { key, workspace } = await registeredSite('domain-primary')
    let status: 'active' | 'removing' = 'active'
    const client = new Proxy(convex.client, {
      get(target, property) {
        if (property !== 'query') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (...args: Parameters<typeof convex.client.query>) => {
          const row = await Reflect.apply(target.query, target, args)
          if (getFunctionName(args[0]) === 'domains/apps/model:getBySlug' && row !== null) {
            return { ...row, customDomain: { hostname: 'tools.example.com', status } }
          }
          return row
        }
      },
    })
    const api = createApiApp({
      convexUrl: convex.url,
      convexClient: client,
      internalKey: INTERNAL_KEY,
      edgeSecret: 'launch-test-secret',
    })
    const path = `/v1/ws/${workspace.slug}/apps/site`
    const active = await authedWith(api, path, key.key)
    expect(await active.json()).toMatchObject({
      app: { canonicalUrl: 'https://tools.example.com/' },
    })
    const launch = await authedWith(api, `${path}/launch`, key.key)
    expect(launch.status).toBe(302)
    expect(new URL(launch.headers.get('location')!).hostname).toBe(
      `site--${workspace.slug}.${resolveEdgeHost()}`,
    )
    status = 'removing'
    const removed = await authedWith(api, path, key.key)
    expect(await removed.json()).toMatchObject({
      app: { canonicalUrl: `https://site--${workspace.slug}.${resolveEdgeHost()}/` },
    })
  })
})

async function registeredSite(prefix: string) {
  const workspace = await provisionRegisteredWorkspace(uniqueSlug(prefix))
  const key = await issueKey(owner.client)
  const api = createApiApp({
    convexUrl: convex.url,
    internalKey: INTERNAL_KEY,
    fetch: async () => Response.json({ ok: true }),
  })
  const response = await authedWith(api, `/v1/ws/${workspace.slug}/apps`, key.key, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: 'apps/site',
      slug: 'site',
      command: 'bun run start',
      apiScopes: [],
      port: 4173,
    }),
  })
  expect(response.status).toBe(201)
  return { api, key, workspace }
}
