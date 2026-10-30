import { expect, test } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'

import { createAppDomainFixtureCleanup } from './staging-live-app-domain-cleanup'
import { StagingResourceLedger } from './staging-live-resource-ledger'

test('domain fixture cleanup verifies captured generations after workspace and auth teardown', async () => {
  let authorized = true
  let workspaceDeleted = false
  let providerPresent = true
  const apps = new Map([['replacement', { id: 'replacement', slug: 'probe' }]])
  const deleted: string[] = []
  const convex = new ConvexHttpClient('https://fixture.convex.cloud', {
    fetch: Object.assign(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const body = JSON.parse(String(init?.body))
        const args = body.args[0]
        const value =
          body.path === 'domains/apps/model:listByWorkspace'
            ? apps.has(args.id)
              ? [apps.get(args.id)]
              : []
            : args.workspaceId === 'captured-workspace'
              ? { status: workspaceDeleted ? 'deleted' : 'active' }
              : null
        return Response.json({ status: 'success', value })
      },
      { preconnect: () => undefined },
    ),
  })
  const ledger = new StagingResourceLedger('cleanup-proof', Date.now, async () => undefined)
  const fixture = createAppDomainFixtureCleanup({
    ledger,
    convex,
    internalKey: 'internal',
    workspaceId: 'captured-workspace',
    base: 'https://api.invalid/v1/ws/fixture',
    hostname: 'aomni.co',
    appPath: 'apps/probe',
    apiToken: 'fixture',
    request: async url => {
      if (!authorized) return new Response(null, { status: 401 })
      if (url.endsWith('/domain')) providerPresent = false
      else if (url.endsWith('/apps/probe')) {
        deleted.push('replacement')
        apps.delete('replacement')
      }
      return Response.json({ ok: true })
    },
    waitProviderAbsent: async () => expect(providerPresent).toBe(false),
    providerAbsent: async () => !providerPresent,
  })
  fixture.recordDomain('original')
  fixture.recordApp('original')
  fixture.recordDirectory()
  fixture.recordDomain('replacement')
  fixture.recordApp('replacement')
  ledger.record({
    kind: 'workspace',
    id: 'captured-workspace',
    label: 'cleanup-proof:workspace',
    cleanup: async () => {
      workspaceDeleted = true
    },
    verify: async () => workspaceDeleted,
  })
  ledger.record({
    kind: 'user',
    id: 'fixture-user',
    label: 'cleanup-proof:user',
    cleanupPriority: -100,
    cleanup: async () => {
      authorized = false
    },
    verify: async () => !authorized,
  })
  const report = await ledger.cleanupAll()
  expect(report).toMatchObject({ status: 'pass', orphans: [] })
  expect(
    report.resources.filter(row => row.kind === 'app').map(row => [row.id, row.status]),
  ).toEqual([
    ['original', 'deleted'],
    ['replacement', 'deleted'],
  ])
  expect(deleted).toEqual(['replacement'])
  expect(authorized).toBe(false)
})

test('a deleted parent does not hide a surviving provider assignment', async () => {
  const convex = new ConvexHttpClient('https://fixture.convex.cloud', {
    fetch: Object.assign(async () => Response.json({ status: 'success', value: [] }), {
      preconnect: () => undefined,
    }),
  })
  const ledger = new StagingResourceLedger('partial-cleanup', Date.now, async () => undefined)
  const fixture = createAppDomainFixtureCleanup({
    ledger,
    convex,
    internalKey: 'internal',
    workspaceId: 'deleted-parent',
    base: 'https://api.invalid/v1/ws/deleted',
    hostname: 'aomni.co',
    appPath: 'apps/probe',
    apiToken: 'retired',
    request: async () => new Response(null, { status: 401 }),
    waitProviderAbsent: async () => {
      throw new Error('provider assignment still present')
    },
    providerAbsent: async () => false,
  })
  fixture.recordDomain('deleted-app')
  const report = await ledger.cleanupAll()
  expect(report.status).toBe('fail')
  expect(report.orphans).toEqual([
    {
      kind: 'app-domain',
      id: 'aomni.co:deleted-app',
      label: 'partial-cleanup:domain:aomni.co:deleted-app',
    },
  ])
  expect(report.resources[0]?.error).toBe('provider assignment still present')
})
