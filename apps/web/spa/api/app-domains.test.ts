import { expect, test } from 'bun:test'

import { DuetApiClient } from './client'

test('domain client addresses the single slot through REST and preserves accepted cleanup', async () => {
  const requests: Array<{ path: string; method: string; body?: string }> = []
  const domain = {
    id: 'domain_1',
    workspaceId: 'workspace_1',
    appId: 'app_1',
    hostname: 'site.example.com',
    status: 'removing' as const,
    records: [],
    conflicts: [],
    createdAt: 1,
    updatedAt: 2,
  }
  const client = new DuetApiClient(async (input, init) => {
    requests.push({
      path: String(input),
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    })
    return Response.json(
      String(input).includes('/app-domains') ? { items: [], nextCursor: null } : { domain },
    )
  })
  expect(await client.getAppDomain('acme space', 'site/one')).toEqual({ domain })
  await client.attachAppDomain('acme space', 'site/one', { hostname: 'site.example.com' })
  await client.recheckAppDomain('acme space', 'site/one')
  expect(await client.removeAppDomain('acme space', 'site/one')).toEqual({ domain })
  expect(await client.listAppDomains('acme space', { cursor: 'older page', limit: 12 })).toEqual({
    items: [],
    nextCursor: null,
  })
  expect(requests).toEqual([
    { path: '/api/duet/ws/acme%20space/apps/site%2Fone/domain', method: 'GET' },
    {
      path: '/api/duet/ws/acme%20space/apps/site%2Fone/domain',
      method: 'PUT',
      body: '{"hostname":"site.example.com"}',
    },
    { path: '/api/duet/ws/acme%20space/apps/site%2Fone/domain/recheck', method: 'POST' },
    { path: '/api/duet/ws/acme%20space/apps/site%2Fone/domain', method: 'DELETE' },
    { path: '/api/duet/ws/acme%20space/app-domains?cursor=older+page&limit=12', method: 'GET' },
  ])
})

test('domain acceptance updates its slot and refreshes app addresses and workspace inventory together', async () => {
  const { QueryClient } = await import('@tanstack/react-query')
  const { appDomainMutationOptions, appDomainQueryOptions } = await import('./app-domains')
  const { duetQueryKeys } = await import('./query-keys')
  const client = new DuetApiClient(async () => Response.json({ domain: null }))
  const cache = new QueryClient()
  const appKey = duetQueryKeys.workspaces.apps.app('acme', 'site')
  const listKey = duetQueryKeys.workspaces.apps.list('acme')
  const inventoryKey = duetQueryKeys.workspaces.appDomains('acme')
  const unrelatedKey = duetQueryKeys.workspaces.apps.list('other')
  for (const key of [appKey, listKey, inventoryKey, unrelatedKey]) cache.setQueryData(key, {})
  const options = appDomainMutationOptions(cache, 'acme', 'site')
  await options.onSuccess({ domain: null })
  expect(
    cache.getQueryData<unknown>(appDomainQueryOptions(client, 'acme', 'site').queryKey),
  ).toEqual({ domain: null })
  for (const key of [appKey, listKey, inventoryKey])
    expect(cache.getQueryState(key)?.isInvalidated).toBe(true)
  expect(cache.getQueryState(unrelatedKey)?.isInvalidated).toBe(false)
})

test('domain polling stops at terminal states, exhausted cleanup, operator repair, and panel unmount', async () => {
  const child = Bun.spawn(
    [process.execPath, new URL('./app-domain-poll-lifecycle.fixture.ts', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ calls: 5, status: 'removing', operatorRepairRequired: true })
}, 20_000)

test('inventory observes queued recheck completion after its app manager closes, then stops polling', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('./app-domain-inventory-lifecycle.fixture.ts', import.meta.url).pathname,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    hostname: 'portal.example.com',
    status: 'active',
    checking: false,
    checkedAt: Date.UTC(2026, 8, 30, 12, 0, 1),
    recordValue: 'cname.vercel-dns.com',
  })
}, 15_000)

test('queued manual rechecks retain admission while queued and observe successful provider completion', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('./app-domain-recheck-lifecycle.fixture.ts', import.meta.url).pathname,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    completed: [
      { before: 'active', status: 'active', checkedAt: Date.UTC(2026, 8, 30, 12, 0, 1) },
      { before: 'failed', status: 'active', checkedAt: Date.UTC(2026, 8, 30, 12, 0, 11) },
    ],
  })
}, 20_000)
