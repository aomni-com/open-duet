import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serializeMemoryFile } from '@repo/agent/memory-store'

import type { GatewayAnchor } from '@repo/contract'

import { createTrainRoutes } from '../train-runner'
import { resolveTrainScope } from './agent-scope'
import { createTrainJobLedger } from './job-ledger'
import type { TrainRunnerInput } from './pipeline'
import { rebuildTrainRecordIndex } from './record-index'
import { createUploadsStore } from './uploads-store'

let root: string

const MTIME_OLDER = new Date('2026-07-23T00:00:00.000Z')
const MTIME_NEWER = new Date('2026-07-23T01:00:00.000Z')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duet-train-agent-routes-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('scope-parameterized train routes', () => {
  test('returns owned memory counts for every agent scope in one root request', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const parentRoot = join(driveDir, 'agents', 'parent')
    const childRoot = join(parentRoot, 'child')
    const parentStore = join(parentRoot, '.agents', 'memories')
    const childStore = join(childRoot, '.agents', 'memories')
    const brokenRoot = join(driveDir, 'agents', 'broken')
    const brokenStore = join(brokenRoot, '.agents', 'memories')
    await Promise.all(
      [parentStore, childStore, brokenStore].map(store => mkdir(store, { recursive: true })),
    )
    await Promise.all([
      writeRecord(parentStore, 'parent-one', 'mem_parent_one'),
      writeRecord(parentStore, 'parent-two', 'mem_parent_two'),
      writeRecord(childStore, 'child-one', 'mem_child_one'),
      writeFile(join(brokenStore, 'malformed.md'), 'not a memory record'),
      writeFile(join(childRoot, 'agent.json'), JSON.stringify({ trainable: false })),
    ])
    const parent = gatewayAnchor('anchor-parent', 'agents/parent', 'agent-parent')
    const child = gatewayAnchor('anchor-child', 'agents/parent/child', 'agent-child')
    const broken = gatewayAnchor('anchor-broken', 'agents/broken', 'agent-broken')
    const scopeArgs = { anchors: [parent, child, broken], driveDir, stateDir }
    const rootScope = resolveTrainScope(scopeArgs)
    const parentScope = resolveTrainScope({ ...scopeArgs, anchorId: parent.id })
    const childScope = resolveTrainScope({ ...scopeArgs, anchorId: child.id })
    await mkdir(rootScope.memoriesDir, { recursive: true })
    await Promise.all(
      Array.from({ length: 51 }, (_, index) =>
        writeRecord(rootScope.memoriesDir, `root-${index}`, `mem_root_${index}`),
      ),
    )
    await Promise.all([
      rebuildTrainRecordIndex(rootScope, stateDir),
      rebuildTrainRecordIndex(parentScope, stateDir),
      rebuildTrainRecordIndex(childScope, stateDir),
    ])
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      uploadsStores: createUploadsStore({
        trainDir: join(stateDir, 'train'),
        capBytes: 1024,
        maxFiles: 10,
      }),
      resolveScope: () => resolveTrainScope(scopeArgs),
      listAgentScopes: () =>
        [parent, child, broken].map(anchor => ({
          key: anchor.id,
          scope: resolveTrainScope({ ...scopeArgs, anchorId: anchor.id }),
        })),
      jobLedger: createTrainJobLedger({ stateDir, now: () => Date.now() }),
    })

    const response = await routes.request('/memory-counts')
    const firstRootPage = await routes.request('/records?limit=50')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      rootCount: 51,
      counts: {
        'anchor-parent': 2,
        'anchor-child': 1,
        'anchor-broken': null,
      },
      trainableAgents: ['anchor-parent', 'anchor-broken'],
    })
    expect((await firstRootPage.json()).items).toHaveLength(50)
  })

  test('refuses a retrain target that lives in another scope, and starts no job', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    const agentStore = join(agentRoot, '.agents', 'memories')
    await Promise.all([
      mkdir(join(driveDir, '.agents', 'memories'), { recursive: true }),
      mkdir(agentStore, { recursive: true }),
    ])
    // The memory exists — but only in the agent's store.
    await writeFile(
      join(agentStore, 'agent-only.md'),
      serializeMemoryFile({
        version: 1,
        id: 'mem_agent_only',
        kind: 'train',
        createdAt: 1,
        content: 'agent body',
      }),
    )
    const anchor = gatewayAnchor('anchor-reviewer', 'agents/reviewer', 'agent-reviewer')
    const scopeArgs = { anchors: [anchor], driveDir, stateDir }
    const uploadsStores = createUploadsStore({
      trainDir: join(stateDir, 'train'),
      capBytes: 1024,
      maxFiles: 10,
    })
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const rootRoutes = createTrainRoutes({
      stateDir,
      driveDir,
      uploadsStores,
      resolveScope: () => resolveTrainScope(scopeArgs),
      jobLedger,
      runner: async () => ({ record: null, stdout: '', stderr: '' }),
    })
    await uploadsStores
      .forScope(resolveTrainScope(scopeArgs).uploadsScope)
      .put('corpus.txt', new Blob(['corpus']).stream())

    const response = await rootRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetSlug: 'agent-only' }),
    })

    // Tolerating this would install a NEW memory called `agent-only` in the
    // root store while the agent's original sat untouched — the user would be
    // told their memory was replaced, and it would not have been.
    expect(response.status).toBe(404)
    expect(jobLedger.reports()).toHaveLength(0)
    expect(await Bun.file(join(driveDir, '.agents', 'memories', 'agent-only.md')).exists()).toBe(
      false,
    )
  })

  test('root and agent mounts have own-record CRUD parity without crossing stores', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const rootStore = join(driveDir, '.agents', 'memories')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    const agentStore = join(agentRoot, '.agents', 'memories')
    await Promise.all([
      mkdir(rootStore, { recursive: true }),
      mkdir(agentStore, { recursive: true }),
    ])
    const recordBytes = serializeMemoryFile({
      version: 1,
      id: 'mem_handbook',
      kind: 'train',
      createdAt: Date.parse('2026-07-23T00:00:00.000Z'),
      content: 'original',
    })
    await Promise.all([
      writeFile(join(rootStore, 'handbook.md'), recordBytes),
      writeFile(join(agentStore, 'handbook.md'), recordBytes),
      writeRecord(rootStore, 'counts', 'mem_counts'),
      writeRecord(agentStore, 'counts', 'mem_counts'),
    ])
    // Records sharing a createdAt are listed most-recently-written first, so
    // concurrent writes would leave the two stores in opposite orders and the
    // parity comparison below would decide on a race. Pin both stores to the
    // same mtimes.
    await Promise.all(
      [rootStore, agentStore].flatMap(store => [
        utimes(join(store, 'handbook.md'), MTIME_OLDER, MTIME_OLDER),
        utimes(join(store, 'counts.md'), MTIME_NEWER, MTIME_NEWER),
      ]),
    )
    const anchor = gatewayAnchor('anchor-reviewer', 'agents/reviewer', 'agent-reviewer')
    const scopeArgs = { anchors: [anchor], driveDir, stateDir }
    const uploadsStores = createUploadsStore({
      trainDir: join(stateDir, 'train'),
      capBytes: 1024,
      maxFiles: 10,
    })
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const rootRoutes = createTrainRoutes({
      stateDir,
      driveDir,
      uploadsStores,
      resolveScope: () => resolveTrainScope(scopeArgs),
      jobLedger,
    })
    const agentRoutes = createTrainRoutes({
      stateDir,
      driveDir,
      uploadsStores,
      resolveScope: () => resolveTrainScope({ ...scopeArgs, anchorId: anchor.id }),
      jobLedger,
    })

    const [rootCountsRecord, agentCountsRecord] = await Promise.all([
      rootRoutes.request('/records/counts'),
      agentRoutes.request('/records/counts'),
    ])
    expect(await rootCountsRecord.json()).toMatchObject({
      record: { slug: 'counts', memoryId: 'mem_counts' },
    })
    expect(await agentCountsRecord.json()).toMatchObject({
      record: { slug: 'counts', memoryId: 'mem_counts' },
    })

    const rootResults = await exerciseCrud(rootRoutes)
    expect(await Bun.file(join(agentStore, 'handbook.md')).exists()).toBe(true)
    const agentResults = await exerciseCrud(agentRoutes)

    expect(agentResults).toEqual(rootResults)
    expect(await Bun.file(join(rootStore, 'handbook.md')).exists()).toBe(false)
    expect(await Bun.file(join(agentStore, 'handbook.md')).exists()).toBe(false)
  })

  test('lists ancestor records as inherited and names their owner on rejected mutations', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const parentRoot = join(driveDir, 'agents', 'parent')
    const childRoot = join(parentRoot, 'child')
    const rootStore = join(driveDir, '.agents', 'memories')
    const parentStore = join(parentRoot, '.agents', 'memories')
    const childStore = join(childRoot, '.agents', 'memories')
    await Promise.all(
      [rootStore, parentStore, childStore].map(store => mkdir(store, { recursive: true })),
    )
    await Promise.all([
      writeRecord(rootStore, 'root-guide', 'mem_root'),
      writeRecord(parentStore, 'parent-guide', 'mem_parent'),
      writeRecord(childStore, 'child-guide', 'mem_child'),
    ])
    await Promise.all([
      utimes(join(parentStore, 'parent-guide.md'), MTIME_NEWER, MTIME_NEWER),
      utimes(join(childStore, 'child-guide.md'), MTIME_OLDER, MTIME_OLDER),
      utimes(join(rootStore, 'root-guide.md'), MTIME_OLDER, MTIME_OLDER),
    ])
    const parent = gatewayAnchor('anchor-parent', 'agents/parent', 'agent-parent')
    const child = gatewayAnchor('anchor-child', 'agents/parent/child', 'agent-child')
    const childScope = resolveTrainScope({
      anchorId: child.id,
      anchors: [parent, child],
      driveDir,
      stateDir,
    })
    const parentScope = resolveTrainScope({
      anchorId: parent.id,
      anchors: [parent, child],
      driveDir,
      stateDir,
    })
    const rootScope = resolveTrainScope({ anchors: [parent, child], driveDir, stateDir })
    const uploadsStores = createUploadsStore({
      trainDir: join(stateDir, 'train'),
      capBytes: 1024,
      maxFiles: 10,
    })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      uploadsStores,
      resolveScope: () => childScope,
      recordIndexesReady: Promise.all([
        rebuildTrainRecordIndex(rootScope, stateDir),
        rebuildTrainRecordIndex(parentScope, stateDir),
        rebuildTrainRecordIndex(childScope, stateDir),
      ]).then(() => undefined),
      jobLedger: createTrainJobLedger({ stateDir, now: () => Date.now() }),
    })

    const listed = await routes.request('/records')
    const detail = await routes.request('/records/parent-guide')
    const patched = await routes.request('/records/parent-guide', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'replacement' }),
    })
    const patchedWithInvalidBody = await routes.request('/records/parent-guide', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    })
    const deleted = await routes.request('/records/root-guide', { method: 'DELETE' })

    expect((await listed.json()) as unknown).toMatchObject({
      items: [
        { slug: 'parent-guide', inherited: true, ownerScope: 'anchor-parent' },
        { slug: 'child-guide' },
        { slug: 'root-guide', inherited: true, ownerScope: 'root' },
      ],
    })
    expect(await detail.json()).toMatchObject({
      record: { slug: 'parent-guide', inherited: true, ownerScope: 'anchor-parent' },
    })
    expect([patched.status, patchedWithInvalidBody.status, deleted.status]).toEqual([409, 409, 409])
    expect(await patched.json()).toEqual({
      error: 'inherited_record_read_only',
      ownerScope: 'anchor-parent',
    })
    expect(await patchedWithInvalidBody.json()).toEqual({
      error: 'inherited_record_read_only',
      ownerScope: 'anchor-parent',
    })
    expect(await deleted.json()).toEqual({
      error: 'inherited_record_read_only',
      ownerScope: 'root',
    })
    expect(await Bun.file(join(parentStore, 'parent-guide.md')).exists()).toBe(true)
    expect(await Bun.file(join(rootStore, 'root-guide.md')).exists()).toBe(true)
  })

  test('isolates inboxes and job views while jobs run concurrently across scopes', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const anchors = [
      gatewayAnchor('anchor-a', 'agents/a', 'agent-a'),
      gatewayAnchor('anchor-b', 'agents/b', 'agent-b'),
    ]
    await Promise.all(
      [driveDir, ...anchors.map(anchor => join(driveDir, anchor.path))].map(path =>
        mkdir(path, { recursive: true }),
      ),
    )
    const uploadsStores = createUploadsStore({
      trainDir: join(stateDir, 'train'),
      capBytes: 1024,
      maxFiles: 10,
    })
    const scopes = {
      root: resolveTrainScope({ anchors, driveDir, stateDir }),
      a: resolveTrainScope({ anchorId: 'anchor-a', anchors, driveDir, stateDir }),
      b: resolveTrainScope({ anchorId: 'anchor-b', anchors, driveDir, stateDir }),
    }
    await Promise.all([
      uploadsStores.forScope(scopes.root.uploadsScope).put('root.txt', new Blob(['root']).stream()),
      uploadsStores.forScope(scopes.a.uploadsScope).put('a.txt', new Blob(['a']).stream()),
      uploadsStores.forScope(scopes.b.uploadsScope).put('b.txt', new Blob(['b']).stream()),
    ])
    const started = new Set<string>()
    const releases = new Map<string, () => void>()
    const gates = Object.fromEntries(
      ['root', 'a', 'b'].map(key => [
        key,
        new Promise<void>(resolve => {
          releases.set(key, resolve)
        }),
      ]),
    ) as Record<string, Promise<void>>
    const runner = async (input: TrainRunnerInput) => {
      const source = (await readdir(input.stagingDir)).find(name => name.endsWith('.txt'))!
      const scopeKey = source.slice(0, -'.txt'.length)
      started.add(scopeKey)
      await gates[scopeKey]
      await mkdir(input.storeDir, { recursive: true })
      await writeRecord(input.storeDir, input.slug, `mem_${scopeKey}`)
      return { record: null, stdout: '', stderr: '' }
    }
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = Object.fromEntries(
      Object.entries(scopes).map(([key, scope]) => [
        key,
        createTrainRoutes({
          stateDir,
          driveDir,
          uploadsStores,
          resolveScope: () => scope,
          runner,
          jobLedger,
        }),
      ]),
    ) as Record<'root' | 'a' | 'b', ReturnType<typeof createTrainRoutes>>

    const startedA = await routes.a.request('/', { method: 'POST' })
    const jobA = ((await startedA.json()) as { jobId: string }).jobId
    await waitFor(() => started.has('a'))
    expect((await uploadsStores.forScope(scopes.a.uploadsScope).list()).items).toEqual([])
    expect(
      (await uploadsStores.forScope(scopes.root.uploadsScope).list()).items.map(
        file => file.filename,
      ),
    ).toEqual(['root.txt'])
    expect(
      (await uploadsStores.forScope(scopes.b.uploadsScope).list()).items.map(file => file.filename),
    ).toEqual(['b.txt'])

    const [startedRoot, startedB] = await Promise.all([
      routes.root.request('/', { method: 'POST' }),
      routes.b.request('/', { method: 'POST' }),
    ])
    const jobRoot = ((await startedRoot.json()) as { jobId: string }).jobId
    const jobB = ((await startedB.json()) as { jobId: string }).jobId
    await waitFor(() => started.size === 3)

    const [rootJobs, aJobs, bJobs, crossScopeJob] = await Promise.all([
      routes.root.request('/jobs'),
      routes.a.request('/jobs'),
      routes.b.request('/jobs'),
      routes.a.request(`/jobs/${jobB}`),
    ])
    expect(
      ((await rootJobs.json()) as { jobs: Array<{ jobId: string }> }).jobs.map(job => job.jobId),
    ).toEqual([jobRoot])
    expect(
      ((await aJobs.json()) as { jobs: Array<{ jobId: string }> }).jobs.map(job => job.jobId),
    ).toEqual([jobA])
    expect(
      ((await bJobs.json()) as { jobs: Array<{ jobId: string }> }).jobs.map(job => job.jobId),
    ).toEqual([jobB])
    expect(crossScopeJob.status).toBe(404)
    expect(jobLedger.hasRunningJob()).toBe(true)

    releases.get('root')!()
    releases.get('a')!()
    releases.get('b')!()
    await waitFor(() =>
      [jobRoot, jobA, jobB].every(jobId => jobLedger.snapshot(jobId)?.phase === 'done'),
    )
  })

  test('re-resolves an agent anchor before installing the trained record', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const oldRoot = join(driveDir, 'agents', 'old-home')
    const newRoot = join(driveDir, 'agents', 'new-home')
    await mkdir(oldRoot, { recursive: true })
    let anchor = gatewayAnchor('anchor-moving', 'agents/old-home', 'agent-moving')
    const uploadsStores = createUploadsStore({
      trainDir: join(stateDir, 'train'),
      capBytes: 1024,
      maxFiles: 10,
    })
    const uploadScope = resolveTrainScope({
      anchorId: anchor.id,
      anchors: [anchor],
      driveDir,
      stateDir,
    }).uploadsScope
    await uploadsStores.forScope(uploadScope).put('moving.txt', new Blob(['move']).stream())
    let runnerStarted = false
    let releaseRunner!: () => void
    const runnerGate = new Promise<void>(resolve => {
      releaseRunner = resolve
    })
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      uploadsStores,
      resolveScope: () =>
        resolveTrainScope({ anchorId: anchor.id, anchors: [anchor], driveDir, stateDir }),
      runner: async input => {
        runnerStarted = true
        await runnerGate
        await mkdir(input.storeDir, { recursive: true })
        await writeRecord(input.storeDir, input.slug, 'mem_moved')
        return { record: null, stdout: '', stderr: '' }
      },
      jobLedger,
    })

    const response = await routes.request('/', { method: 'POST' })
    const jobId = ((await response.json()) as { jobId: string }).jobId
    await waitFor(() => runnerStarted)
    await mkdir(newRoot, { recursive: true })
    anchor = { ...anchor, path: 'agents/new-home' }
    releaseRunner()
    await waitFor(() => jobLedger.snapshot(jobId)?.phase === 'done')
    const slug = jobLedger.snapshot(jobId)!.recordSlug

    expect(await Bun.file(join(newRoot, '.agents', 'memories', `${slug}.md`)).exists()).toBe(true)
    expect(await Bun.file(join(oldRoot, '.agents', 'memories', `${slug}.md`)).exists()).toBe(false)
  })
})

async function exerciseCrud(routes: ReturnType<typeof createTrainRoutes>) {
  const list = await routes.request('/records')
  const detail = await routes.request('/records/handbook')
  const updated = await routes.request('/records/handbook', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'updated' }),
  })
  const deleted = await routes.request('/records/handbook', { method: 'DELETE' })
  return {
    list: { status: list.status, body: await list.json() },
    detail: { status: detail.status, body: await detail.json() },
    updated: { status: updated.status, body: await updated.json() },
    deleted: { status: deleted.status, body: await deleted.json() },
  }
}

async function writeRecord(storeDir: string, slug: string, id: string): Promise<void> {
  await writeFile(
    join(storeDir, `${slug}.md`),
    serializeMemoryFile({
      version: 1,
      id,
      kind: 'train',
      createdAt: Date.parse('2026-07-23T00:00:00.000Z'),
      content: `${slug} body`,
    }),
  )
}

function gatewayAnchor(id: string, path: string, agentId: string): GatewayAnchor {
  return {
    id,
    agentId,
    workspaceId: 'workspace-1',
    path,
    kind: 'agent',
    settings: {},
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    markerNonce: `nonce-${id}`,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for train route state')
    await Bun.sleep(5)
  }
}
