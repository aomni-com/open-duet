import { afterEach, expect, test } from 'bun:test'

import { componentsGeneric, makeFunctionReference, type FunctionReference } from 'convex/server'

import type { Id } from '../convex/_generated/dataModel'
import { appDomainTarget } from '../convex/config'
import {
  cleanupCustomDomainFixtures,
  createCustomDomainFixture,
  settleDomainWork,
} from './custom-domains-fixture'

afterEach(cleanupCustomDomainFixtures)

const savedFetch = globalThis.fetch

const mutation = (name: string) =>
  makeFunctionReference<'mutation'>(`domains/customDomains/model:${name}`)
const query = (name: string) =>
  makeFunctionReference<'query'>(`domains/customDomains/model:${name}`)
test('one normalized slot per app reserves its hostname across app attachments', async () => {
  const { t, args } = await createCustomDomainFixture()
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: ' HTTPS://Example.COM/ ',
    now: 100,
  })
  expect(first).toMatchObject({ hostname: 'example.com', status: 'pending', records: [] })
  expect(
    await t.mutation(mutation('attach'), {
      ...args,
      slug: 'one',
      hostname: 'example.com',
      now: 200,
    }),
  ).toEqual(first)
  await expect(
    t.mutation(mutation('attach'), { ...args, slug: 'one', hostname: 'other.example.com' }),
  ).rejects.toThrow('domain_occupied')
  await expect(
    t.mutation(mutation('attach'), { ...args, slug: 'two', hostname: 'example.com' }),
  ).rejects.toThrow('hostname_in_use')
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toEqual(first)
  const app = await t.run(ctx => ctx.db.get(first.appId as Id<'apps'>))
  expect(app?.visibility).toBe('folder')
})

test('provider readiness activates the slot', async () => {
  const { t, args } = await createCustomDomainFixture()
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'ready.example.com',
  })
  await settleDomainWork(t)
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toMatchObject({ id: first.id, status: 'active', records: [], conflicts: [] })
})

test('a domain assigned to another project explains the conflict and recovers after it is released', async () => {
  const { t, args, assignments } = await createCustomDomainFixture()
  const transport = globalThis.fetch
  let occupied = true
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (occupied && init?.method === 'POST' && path.endsWith('/domains'))
        return Response.json({ error: { code: 'domain_already_in_use' } }, { status: 409 })
      return transport(input, init)
    },
    { preconnect: transport.preconnect },
  )
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'occupied.example.com',
  })
  await settleDomainWork(t)
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toMatchObject({
    id: first.id,
    status: 'failed',
    lastError:
      'This domain is already assigned to another Vercel project. Remove that assignment or contact support, then recheck.',
  })
  expect(assignments.has('occupied.example.com')).toBe(false)

  occupied = false
  await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
  await settleDomainWork(t)
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toMatchObject({ id: first.id, hostname: 'occupied.example.com', status: 'active' })
})

test('app deletion immediately disables its host and retains cleanup independent of the app row', async () => {
  const { t, args, assignments } = await createCustomDomainFixture()
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'deleted.example.com',
  })
  await settleDomainWork(t)
  await t.mutation(makeFunctionReference<'mutation'>('domains/apps/model:deleteApp'), {
    internalKey: args.internalKey,
    actorId: args.identity.actorId,
    workspaceId: args.workspaceId,
    slug: 'one',
  })
  const retained = await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>))
  expect(retained).toMatchObject({ status: 'removing', hostname: 'deleted.example.com' })
  expect(
    await t.query(query('resolveHostname'), {
      internalKey: args.internalKey,
      hostname: 'deleted.example.com',
    }),
  ).toBeNull()
  await settleDomainWork(t)
  expect(assignments.has('deleted.example.com')).toBe(false)
  expect(await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>))).toBeNull()
  expect(await t.run(ctx => ctx.db.get(retained!.diagnosticsId))).toBeNull()
})

test('automatic checks verify ownership and replace DNS instructions when routing becomes ready', async () => {
  const { t, args, provider, requests } = await createCustomDomainFixture()
  provider.ownershipVerified = false
  provider.misconfigured = true
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'dns.example.com',
  })
  await settleDomainWork(t)
  const waiting = await t.query(query('get'), {
    internalKey: args.internalKey,
    workspaceId: args.workspaceId,
    slug: 'one',
  })
  expect(waiting).toMatchObject({
    id: first.id,
    status: 'verifying',
    records: [
      expect.objectContaining({ type: 'TXT', value: 'ownership-proof' }),
      expect.objectContaining({ type: 'A', value: '76.76.21.21' }),
    ],
  })
  const before = requests.filter(row => row.path.endsWith('/verify')).length
  await t.mutation(makeFunctionReference<'mutation'>('domains/customDomains/work:dispatchDue'), {
    now: Date.now() + 60_001,
  })
  await settleDomainWork(t)
  expect(requests.filter(row => row.path.endsWith('/verify')).length).toBeGreaterThan(before)
  provider.ownershipVerified = true
  provider.misconfigured = false
  await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
  await settleDomainWork(t)
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toMatchObject({ status: 'active', records: [], conflicts: [] })
})

test('removal waits for a delayed provider add, then erases the final assignment before releasing the reservation', async () => {
  const { t, args, assignments } = await createCustomDomainFixture()
  const transport = globalThis.fetch
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && new URL(String(input)).pathname.endsWith('/domains')) {
        entered()
        await held
      }
      return transport(input, init)
    },
    { preconnect: savedFetch.preconnect },
  )
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'race.example.com',
  })
  await started
  try {
    expect(await t.mutation(mutation('remove'), { ...args, slug: 'one' })).toMatchObject({
      status: 'removing',
    })
    await expect(
      t.mutation(mutation('attach'), { ...args, slug: 'two', hostname: 'race.example.com' }),
    ).rejects.toThrow('hostname_in_use')
    expect(
      await t.query(query('resolveHostname'), {
        internalKey: args.internalKey,
        hostname: 'race.example.com',
      }),
    ).toBeNull()
  } finally {
    release()
  }
  await settleDomainWork(t)
  await t.mutation(makeFunctionReference<'mutation'>('domains/customDomains/work:dispatchDue'), {})
  await settleDomainWork(t)
  expect(assignments.has('race.example.com')).toBe(false)
  expect(await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>))).toBeNull()
  const replacement = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'two',
    hostname: 'race.example.com',
  })
  await settleDomainWork(t)
  expect(
    await t.query(query('resolveHostname'), {
      internalKey: args.internalKey,
      hostname: 'race.example.com',
    }),
  ).toMatchObject({ appId: replacement.appId, appSlug: 'two' })
})

test('workspace deletion accepts cleanup for all bindings without relying on app-row deletion', async () => {
  const { t, args, assignments } = await createCustomDomainFixture()
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'workspace.example.com',
  })
  await settleDomainWork(t)
  const { deleteWorkspaceImpl } = await import('../convex/domains/workspaces/mutations')
  await t.run(ctx =>
    deleteWorkspaceImpl(ctx, { workspaceId: args.workspaceId, actorId: args.identity.actorId }),
  )
  expect(
    await t.query(query('resolveHostname'), {
      internalKey: args.internalKey,
      hostname: first.hostname,
    }),
  ).toBeNull()
  await settleDomainWork(t)
  expect(assignments.has('workspace.example.com')).toBe(false)
})

test('replica convergence removal also detaches its local domain', async () => {
  const { t, args, assignments } = await createCustomDomainFixture()
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'replica.example.com',
  })
  await settleDomainWork(t)
  const { appSharedReplicaAdapter } = await import('../convex/domains/apps/replication')
  await t.run(async ctx => {
    const app = (await ctx.db.get(first.appId as Id<'apps'>))!
    await appSharedReplicaAdapter(ctx).deleteReplica(app, Date.now())
  })
  expect(await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>))).toMatchObject({
    status: 'removing',
  })
  await settleDomainWork(t)
  expect(assignments.has('replica.example.com')).toBe(false)
})

test('live app and gateway projections carry the same active hostname without changing runtime fields', async () => {
  const { t, args } = await createCustomDomainFixture()
  await t.mutation(mutation('attach'), { ...args, slug: 'one', hostname: 'projection.example.com' })
  await settleDomainWork(t)
  const app = await t.query(makeFunctionReference<'query'>('domains/apps/model:getBySlug'), {
    internalKey: args.internalKey,
    workspaceId: args.workspaceId,
    slug: 'one',
  })
  const configs = await t.query(
    makeFunctionReference<'query'>('domains/apps/model:runConfigForWorkspace'),
    { internalKey: args.internalKey, workspaceId: args.workspaceId },
  )
  expect(app).toMatchObject({
    customDomain: { hostname: 'projection.example.com', status: 'active' },
    runtimeStatus: 'reconciled',
  })
  expect(configs.find((row: { slug: string }) => row.slug === 'one')).toMatchObject({
    customDomain: { hostname: 'projection.example.com', status: 'active' },
    command: 'bun run start',
    port: 4001,
  })
})

test('failed orphan cleanup retains an immutable repair receipt and can be retried without its parents', async () => {
  const { t, args, assignments } = await createCustomDomainFixture()
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'repair.example.com',
  })
  await settleDomainWork(t)
  const assignment = assignments.get('repair.example.com')!
  assignment.gitBranch = 'another-environment'
  await t.mutation(makeFunctionReference<'mutation'>('domains/apps/model:deleteApp'), {
    internalKey: args.internalKey,
    actorId: args.identity.actorId,
    workspaceId: args.workspaceId,
    slug: 'one',
  })
  await settleDomainWork(t)
  const failures = await t.query(
    makeFunctionReference<'query'>('domains/customDomains/internal:listCleanupFailures'),
    { cursor: null, limit: 1 },
  )
  expect(failures.page).toEqual([
    expect.objectContaining({
      domainId: first.id,
      hostname: 'repair.example.com',
      target: appDomainTarget(),
      error: 'Vercel domain belongs to a different project or branch',
    }),
  ])
  expect(
    await t.query(query('listByWorkspace'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      paginationOpts: { cursor: null, numItems: 100 },
    }),
  ).toMatchObject({ page: [], isDone: true })
  expect(assignments.get('repair.example.com')?.gitBranch).toBe('another-environment')
  await t.run(ctx => ctx.db.delete(args.workspaceId))
  assignment.gitBranch = 'staging'
  await t.mutation(
    makeFunctionReference<'mutation'>('domains/customDomains/internal:retryCleanup'),
    { domainId: first.id },
  )
  await settleDomainWork(t)
  expect(assignments.has('repair.example.com')).toBe(false)
  expect(await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>))).toBeNull()
  expect(
    await t.mutation(
      makeFunctionReference<'mutation'>('domains/customDomains/internal:retryCleanup'),
      { domainId: first.id },
    ),
  ).toBeNull()
})

test('workspace principals manage local disabled/broken apps while human viewers cannot write', async () => {
  const { t, args } = await createCustomDomainFixture()
  await t.run(async ctx => {
    const member = (await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', args.workspaceId).eq('userId', args.identity.actorId),
      )
      .unique())!
    await ctx.db.patch(member._id, { role: 'viewer' })
    const app = (await ctx.db
      .query('apps')
      .withIndex('by_workspace_and_slug', q =>
        q.eq('workspaceId', args.workspaceId).eq('slug', 'one'),
      )
      .unique())!
    await ctx.db.patch(app._id, { disabledAt: 10 })
    await ctx.db.patch(app.anchorId, { state: 'broken' })
  })
  await expect(
    t.mutation(mutation('attach'), { ...args, slug: 'one', hostname: 'workspace-key.example.com' }),
  ).rejects.toThrow('forbidden')
  const attached = await t.mutation(mutation('attach'), {
    ...args,
    identity: { principal: { kind: 'workspace' }, actorId: args.identity.actorId },
    slug: 'one',
    hostname: 'workspace-key.example.com',
  })
  expect(attached).toMatchObject({ hostname: 'workspace-key.example.com', status: 'pending' })
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toEqual(attached)
})

test('domain listing uses live indexed pages and keeps orphan cleanup outside the continuation', async () => {
  const { t, args } = await createCustomDomainFixture()
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'list-one.example.com',
  })
  const second = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'two',
    hostname: 'list-two.example.com',
  })
  const page = await t.query(query('listByWorkspace'), {
    internalKey: args.internalKey,
    workspaceId: args.workspaceId,
    paginationOpts: { cursor: null, numItems: 1 },
  })
  expect(page.page.map((row: { domain: { hostname: string } }) => row.domain.hostname)).toEqual([
    'list-one.example.com',
  ])
  expect(page.isDone).toBe(false)
  const next = await t.query(query('listByWorkspace'), {
    internalKey: args.internalKey,
    workspaceId: args.workspaceId,
    paginationOpts: { cursor: page.continueCursor, numItems: 1 },
  })
  expect(next.page.map((row: { domain: { id: string } }) => row.domain.id)).toEqual([second.id])
  const { beginDomainRemovalForApp } = await import('../convex/domains/customDomains/model')
  await t.run(ctx =>
    beginDomainRemovalForApp(ctx, first.appId as Id<'apps'>, Date.now(), { orphan: true }),
  )
  const live = await t.query(query('listByWorkspace'), {
    internalKey: args.internalKey,
    workspaceId: args.workspaceId,
    paginationOpts: { cursor: null, numItems: 100 },
  })
  expect(live.page.map((row: { domain: { id: string } }) => row.domain.id)).toEqual([second.id])
})

test('maximum diagnostics remain readable in five-row pages while all 100 app configs stay bounded', async () => {
  const { t, args } = await createCustomDomainFixture({ transactionLimits: true })
  const records = Array.from({ length: 32 }, (_, index) => ({
    type: 'TXT',
    domain: `record-${index}.example.com`,
    value: 'v'.repeat(4_096),
    reason: 'r'.repeat(1_024),
  }))
  const conflicts = Array.from({ length: 32 }, (_, index) => ({
    type: 'TXT',
    name: `conflict-${index}.example.com`,
    value: 'c'.repeat(4_096),
  }))
  for (let index = 0; index < 100; index += 1)
    await t.run(async ctx => {
      const slug = index === 0 ? 'one' : index === 1 ? 'two' : `bulk-${index}`
      let app = await ctx.db
        .query('apps')
        .withIndex('by_workspace_and_slug', q =>
          q.eq('workspaceId', args.workspaceId).eq('slug', slug),
        )
        .unique()
      if (app === null) {
        const anchorId = await ctx.db.insert('anchors', {
          workspaceId: args.workspaceId,
          path: `apps/${slug}`,
          markerNonce: slug,
          kind: 'app',
          state: 'active',
          settings: {},
          createdAt: 1,
          updatedAt: 1,
        })
        const appId = await ctx.db.insert('apps', {
          workspaceId: args.workspaceId,
          anchorId,
          slug,
          command: 'bun run start',
          apiScopes: [],
          port: 5_000 + index,
          visibility: 'public',
          runtimeStatus: 'reconciled',
          createdByUserId: args.identity.actorId,
          createdAt: 1,
          updatedAt: 1,
        })
        app = (await ctx.db.get(appId))!
      }
      const diagnosticsId = await ctx.db.insert('customDomainDiagnostics', { records, conflicts })
      await ctx.db.insert('customDomains', {
        workspaceId: args.workspaceId,
        appId: app._id,
        hostname: `bulk-${index}.example.com`,
        listed: true,
        diagnosticsId,
        target: appDomainTarget(),
        status: 'active',
        revision: 1,
        providerAssigned: true,
        workRunning: false,
        cleanupAttempts: 0,
        createdByUserId: args.identity.actorId,
        createdAt: 1,
        updatedAt: 1,
      })
    })
  const configs = await t.query(
    makeFunctionReference<'query'>('domains/apps/model:runConfigForWorkspace'),
    { internalKey: args.internalKey, workspaceId: args.workspaceId },
  )
  expect(configs).toHaveLength(100)
  expect(configs.find((row: { slug: string }) => row.slug === 'bulk-99').customDomain).toEqual({
    hostname: 'bulk-99.example.com',
    status: 'active',
  })
  const page = await t.query(query('listByWorkspace'), {
    internalKey: args.internalKey,
    workspaceId: args.workspaceId,
    paginationOpts: { cursor: null, numItems: 100 },
  })
  expect(page.page.map((row: { domain: { hostname: string } }) => row.domain.hostname)).toEqual(
    Array.from({ length: 5 }, (_, index) => `bulk-${index}.example.com`),
  )
  expect(page.page[0].domain.records).toEqual(records)
  expect(page.page[0].domain.conflicts).toEqual(conflicts)
  expect(page.isDone).toBe(false)
  const next = await t.query(query('listByWorkspace'), {
    internalKey: args.internalKey,
    workspaceId: args.workspaceId,
    paginationOpts: { cursor: page.continueCursor, numItems: 100 },
  })
  expect(next.page[0].domain.hostname).toBe('bulk-5.example.com')
})

test('malformed provider reads preserve an active binding; authoritative unready or missing observations demote it', async () => {
  const { t, args, provider, assignments } = await createCustomDomainFixture()
  await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'operational.example.com',
  })
  await settleDomainWork(t)
  const transport = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        new URL(String(input)).pathname.endsWith('/domains/operational.example.com') &&
        (init?.method ?? 'GET') === 'GET'
      )
        return Response.json({ malformed: true })
      return transport(input, init)
    },
    { preconnect: savedFetch.preconnect },
  )
  await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
  await settleDomainWork(t)
  const observed = await t.query(query('get'), {
    internalKey: args.internalKey,
    workspaceId: args.workspaceId,
    slug: 'one',
  })
  expect(observed).toMatchObject({
    status: 'active',
    records: [],
    conflicts: [],
    lastError: 'Vercel domain response is invalid',
  })
  expect(
    await t.query(query('resolveHostname'), {
      internalKey: args.internalKey,
      hostname: 'operational.example.com',
    }),
  ).toMatchObject({ appSlug: 'one' })
  globalThis.fetch = transport
  await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
  await settleDomainWork(t)
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).not.toHaveProperty('lastError')
  provider.ownershipVerified = false
  provider.misconfigured = true
  await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
  await settleDomainWork(t)
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toMatchObject({ status: 'verifying' })
  assignments.delete('operational.example.com')
  await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
  await settleDomainWork(t)
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toMatchObject({ status: 'failed', lastError: 'Vercel domain assignment is missing' })
})

test('a canceled add stays quarantined after its run is pruned until operator-confirmed cleanup', async () => {
  const { t, args, assignments, requests } = await createCustomDomainFixture()
  const transport = globalThis.fetch
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && new URL(String(input)).pathname.endsWith('/domains')) {
        entered()
        await held
      }
      return transport(input, init)
    },
    { preconnect: savedFetch.preconnect },
  )
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'cancel.example.com',
  })
  // convex-test rejects a canceled in-progress scheduled callback. Pause only
  // the fixture trigger, then run the real worker under its admitted component run.
  await t.run(async ctx => {
    for (const scheduled of await ctx.db.system.query('_scheduled_functions').collect())
      if (scheduled.state.kind === 'pending') await ctx.scheduler.cancel(scheduled._id)
  })
  await t.mutation(makeFunctionReference<'mutation'>('domains/customDomains/work:dispatchDue'), {})
  await t.run(ctx =>
    ctx.runMutation(
      componentsGeneric().actionRetrier!.fixture!.cancelPending! as FunctionReference<'mutation'>,
      {},
    ),
  )
  const admitted = (await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>)))!
  const worker = t.action(
    makeFunctionReference<'action'>('domains/customDomains/actions:perform'),
    { domainId: first.id, revision: admitted.runRevision, operation: 'add' },
  )
  await started
  try {
    await t.mutation(mutation('remove'), { ...args, slug: 'one' })
    const pending = (await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>)))!
    await t.run(ctx =>
      ctx.runMutation(
        componentsGeneric().actionRetrier!.public!.cancel! as FunctionReference<'mutation'>,
        { runId: pending.runId },
      ),
    )
    // Component terminal status and pruning cannot certify remote completion.
    await t.run(ctx =>
      ctx.runMutation(
        componentsGeneric().actionRetrier!.public!.cleanup! as FunctionReference<'mutation'>,
        { runId: pending.runId },
      ),
    )
    await t.mutation(makeFunctionReference<'mutation'>('domains/customDomains/work:dispatchDue'), {
      now: Date.now() + 60_001,
    })
    expect(await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>))).toMatchObject({
      status: 'removing',
      workRunning: false,
      repairReason: 'uncertain',
    })
    await expect(
      t.mutation(mutation('attach'), { ...args, slug: 'two', hostname: 'cancel.example.com' }),
    ).rejects.toThrow('hostname_in_use')
    expect(requests.filter(row => row.method === 'DELETE')).toEqual([])
  } finally {
    release()
    await worker
  }
  await settleDomainWork(t)
  expect(assignments.has('cancel.example.com')).toBe(true)
  await t.mutation(
    makeFunctionReference<'mutation'>('domains/customDomains/internal:retryCleanup'),
    {
      domainId: first.id,
      effectSettlementConfirmed: true,
    },
  )
  await t.mutation(makeFunctionReference<'mutation'>('domains/customDomains/work:dispatchDue'), {})
  await settleDomainWork(t)
  expect(assignments.has('cancel.example.com')).toBe(false)
  expect(await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>))).toBeNull()
}, 2_000)

test('more than fifty due slots all progress while waiting DNS and failures never exceed five concurrent provider requests', async () => {
  const { t, args, assignments, provider } = await createCustomDomainFixture()
  provider.misconfigured = true
  const transport = globalThis.fetch
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  let activeRequests = 0
  let peakRequests = 0
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      activeRequests += 1
      peakRequests = Math.max(peakRequests, activeRequests)
      if (activeRequests === 5) entered()
      try {
        await held
        if (init?.method === 'POST' && JSON.parse(String(init.body)).name === 'batch-0.example.com')
          return Response.json({}, { status: 503 })
        return await transport(input, init)
      } finally {
        activeRequests -= 1
      }
    },
    { preconnect: savedFetch.preconnect },
  )
  try {
    for (let index = 0; index < 55; index += 1) {
      const slug = `batch-${index}`
      await t.run(async ctx => {
        const anchorId = await ctx.db.insert('anchors', {
          workspaceId: args.workspaceId,
          path: `apps/${slug}`,
          markerNonce: slug,
          kind: 'app',
          state: 'active',
          settings: {},
          createdAt: 1,
          updatedAt: 1,
        })
        await ctx.db.insert('apps', {
          workspaceId: args.workspaceId,
          anchorId,
          slug,
          command: 'bun run start',
          apiScopes: [],
          port: 5_000 + index,
          visibility: 'folder',
          runtimeStatus: 'reconciled',
          createdByUserId: args.identity.actorId,
          createdAt: 1,
          updatedAt: 1,
        })
      })
      await t.mutation(mutation('attach'), { ...args, slug, hostname: `${slug}.example.com` })
    }
    await started
    expect(peakRequests).toBe(5)
  } finally {
    release()
  }
  await settleDomainWork(t)
  for (let tick = 0; tick < 12; tick += 1) {
    await t.mutation(
      makeFunctionReference<'mutation'>('domains/customDomains/work:dispatchDue'),
      {},
    )
    await settleDomainWork(t)
  }
  const rows = await t.run(ctx =>
    ctx.db
      .query('customDomains')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .collect(),
  )
  expect(rows.filter(row => row.lastCheckedAt === undefined).map(row => row.hostname)).toEqual([])
  expect(rows.find(row => row.hostname === 'batch-0.example.com')?.status).toBe('removing')
  expect(rows.filter(row => row.hostname !== 'batch-0.example.com').map(row => row.status)).toEqual(
    Array.from({ length: 54 }, () => 'verifying'),
  )
  expect([...assignments.keys()].sort()).toEqual(
    Array.from({ length: 54 }, (_, index) => `batch-${index + 1}.example.com`).sort(),
  )
  expect(peakRequests).toBe(5)
})

test('missing runtime credentials leave reads available and removal durable while new provider work refuses admission', async () => {
  const { t, args } = await createCustomDomainFixture()
  await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'credentials.example.com',
  })
  await settleDomainWork(t)
  delete process.env.DUET_VERCEL_DOMAINS_TOKEN
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toMatchObject({ status: 'active' })
  await expect(
    t.mutation(mutation('attach'), { ...args, slug: 'two', hostname: 'another.example.com' }),
  ).rejects.toThrow('domain_not_configured')
  await expect(t.mutation(mutation('recheck'), { ...args, slug: 'one' })).rejects.toThrow(
    'domain_not_configured',
  )
  expect(await t.mutation(mutation('remove'), { ...args, slug: 'one' })).toMatchObject({
    status: 'removing',
  })
  expect(
    await t.query(query('resolveHostname'), {
      internalKey: args.internalKey,
      hostname: 'credentials.example.com',
    }),
  ).toBeNull()
})

test('cleanup stops after six actual attempts, keeps its reservation, and public recheck retries the same work', async () => {
  const { t, args, assignments, requests, provider } = await createCustomDomainFixture()
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'retry.example.com',
  })
  await settleDomainWork(t)
  const readsBefore = requests.filter(
    row => row.method === 'GET' && row.path.endsWith('/domains/retry.example.com'),
  ).length
  provider.errorStatus = 503
  await t.mutation(mutation('remove'), { ...args, slug: 'one' })
  const deadline = Date.now() + 110_000
  let failed = await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>))
  while (failed?.repairReason !== 'exhausted' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    failed = await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>))
  }
  expect(failed).toMatchObject({
    status: 'removing',
    cleanupAttempts: 6,
    repairReason: 'exhausted',
  })
  expect(
    requests.filter(row => row.method === 'GET' && row.path.endsWith('/domains/retry.example.com'))
      .length - readsBefore,
  ).toBe(6)
  expect(assignments.has('retry.example.com')).toBe(true)
  await expect(
    t.mutation(mutation('attach'), { ...args, slug: 'two', hostname: 'retry.example.com' }),
  ).rejects.toThrow('hostname_in_use')
  provider.errorStatus = 0
  expect(await t.mutation(mutation('recheck'), { ...args, slug: 'one' })).toMatchObject({
    id: first.id,
    status: 'removing',
  })
  await settleDomainWork(t)
  expect(assignments.has('retry.example.com')).toBe(false)
  expect(await t.run(ctx => ctx.db.get(first.id as Id<'customDomains'>))).toBeNull()
}, 120_000)

test('recheck retries a failed initial add only after observing the assignment absent', async () => {
  const { t, args, provider, assignments } = await createCustomDomainFixture()
  provider.errorStatus = 429
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'initial-retry.example.com',
  })
  await settleDomainWork(t)
  expect(assignments.has('initial-retry.example.com')).toBe(false)
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toMatchObject({ id: first.id, status: 'failed' })
  provider.errorStatus = 0
  await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
  await settleDomainWork(t)
  expect(assignments.get('initial-retry.example.com')?.name).toBe('initial-retry.example.com')
  expect(
    await t.query(query('get'), {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
      slug: 'one',
    }),
  ).toMatchObject({ id: first.id, status: 'active' })
})

function holdProviderTransport() {
  const transport = globalThis.fetch
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).hostname === 'api.vercel.com') {
        entered()
        await held
      }
      return transport(input, init)
    },
    { preconnect: savedFetch.preconnect },
  )
  return { started, release }
}

test('manual active recheck exposes queued and running work without disabling its hostname', async () => {
  const { t, args } = await createCustomDomainFixture()
  const first = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'recheck.example.com',
  })
  await settleDomainWork(t)
  const lookup = { internalKey: args.internalKey, workspaceId: args.workspaceId, slug: 'one' }
  const before = await t.query(query('get'), lookup)
  const { started, release } = holdProviderTransport()
  try {
    expect(await t.mutation(mutation('recheck'), { ...args, slug: 'one' })).toMatchObject({
      id: first.id,
      status: 'active',
      checking: true,
    })
    await started
    expect(await t.query(query('get'), lookup)).toMatchObject({ status: 'active', checking: true })
    expect(
      await t.query(query('resolveHostname'), {
        internalKey: args.internalKey,
        hostname: first.hostname,
      }),
    ).toMatchObject({ appId: first.appId, appSlug: 'one' })
  } finally {
    release()
  }
  await settleDomainWork(t)
  const settled = await t.query(query('get'), lookup)
  expect(settled.status).toBe('active')
  expect(settled.checking).toBeUndefined()
  expect(settled.lastCheckedAt).toBeGreaterThan(before.lastCheckedAt)
})

test('manual failed recheck stays observable until provider recovery settles', async () => {
  const { t, args, provider } = await createCustomDomainFixture()
  provider.errorStatus = 400
  await t.mutation(mutation('attach'), { ...args, slug: 'one', hostname: 'recover.example.com' })
  await settleDomainWork(t)
  const lookup = { internalKey: args.internalKey, workspaceId: args.workspaceId, slug: 'one' }
  const before = await t.query(query('get'), lookup)
  expect(before.status).toBe('failed')
  expect(before.checking).toBeUndefined()
  provider.errorStatus = 0
  const { started, release } = holdProviderTransport()
  try {
    expect(await t.mutation(mutation('recheck'), { ...args, slug: 'one' })).toMatchObject({
      status: 'failed',
      checking: true,
    })
    await started
    expect(await t.query(query('get'), lookup)).toMatchObject({ status: 'failed', checking: true })
  } finally {
    release()
  }
  await settleDomainWork(t)
  const settled = await t.query(query('get'), lookup)
  expect(settled.status).toBe('active')
  expect(settled.checking).toBeUndefined()
  expect(settled.lastError).toBeUndefined()
  expect(settled.lastCheckedAt).toBeGreaterThan(before.lastCheckedAt)
})

test('action retrier cleanup drains large expired batches within transaction limits', async () => {
  const { t } = await createCustomDomainFixture({ transactionLimits: true })
  const fixture = componentsGeneric().actionRetrier!.fixture!
  const seed = fixture.seedExpiredRuns! as FunctionReference<'mutation'>
  const hasRuns = fixture.hasRuns! as FunctionReference<'query'>
  const cleanup = componentsGeneric().actionRetrier!.run!
    .cleanupExpiredRuns! as FunctionReference<'mutation'>

  // 1,100 rows of ~20 KB: one unbounded 1,024-row scan would exceed the 16 MiB
  // read limit, so cleanup only drains if each turn stays bounded and the
  // component's own continuation carries the remainder.
  for (let batch = 0; batch < 22; batch += 1) {
    await t.mutation(seed, { count: 50, payloadBytes: 20_000 })
  }
  expect(await t.query(hasRuns, {})).toBe(true)

  await t.mutation(cleanup, {})
  for (let turn = 0; turn < 8 && (await t.query(hasRuns, {})); turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await t.finishInProgressScheduledFunctions()
  }

  expect(await t.query(hasRuns, {})).toBe(false)
})
