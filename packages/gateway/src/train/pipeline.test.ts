import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { serializeMemoryFile } from '@repo/agent/memory-store'
import { MAX_TRAIN_INLINE_BYTES, type DriveFileEvent } from '@repo/contract'

import { ROOT_UPLOAD_SCOPE } from '../auth/upload-scope'
import { createTrainRoutes } from '../train-runner'
import { resolveTrainScope } from './agent-scope'
import { createTrainJobLedger } from './job-ledger'
import type { TrainRunnerInput } from './pipeline'
import {
  createUploadsStore as createUploadsStoreFactory,
  type UploadsStore,
  type UploadsStoreFactory,
} from './uploads-store'

const createUploadsStore = (options: {
  uploadsDir: string
  tempDir: string
  capBytes: number
  maxFiles: number
}) => {
  const trainDir = dirname(options.uploadsDir)
  if (options.tempDir !== join(trainDir, 'temp')) throw new Error('invalid test upload layout')
  const factory = createUploadsStoreFactory({
    trainDir,
    capBytes: options.capBytes,
    maxFiles: options.maxFiles,
  })
  return Object.assign(factory.forScope(ROOT_UPLOAD_SCOPE), { factory })
}

async function listUploads(store: UploadsStore) {
  const page = await store.list({ limit: 100 })
  return { files: page.items, totalBytes: page.meta.totalBytes }
}

function rootTrainRouteOptions(
  stateDir: string,
  driveDir: string,
  uploadsStore: UploadsStore & { factory: UploadsStoreFactory },
) {
  return {
    uploadsStores: uploadsStore.factory,
    resolveScope: () => resolveTrainScope({ anchors: [], driveDir, stateDir }),
  }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duet-train-pipeline-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('gateway train source assembly', () => {
  test('maintenance stops a pending start before durable admission and preserves its uploads', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    await uploadsStore.put('retry.bin', new Blob(['retry-me']).stream())
    let indexingFinished!: () => void
    const ready = new Promise<void>(resolve => {
      indexingFinished = resolve
    })
    const jobLedger = createTrainJobLedger({ stateDir, now: Date.now })
    let blocked = false
    let started = 0
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      recordIndexesReady: ready,
      isStartBlocked: () => blocked,
      runner: async () => {
        started++
        throw new Error('fixture trainer finished')
      },
    })
    const pending = routes.request('/', { method: 'POST' })
    blocked = true
    indexingFinished()
    const refused = await pending
    expect(refused.status).toBe(503)
    expect(await refused.json()).toEqual({ error: 'runner_unavailable' })
    expect(jobLedger.reports()).toEqual([])
    expect(started).toBe(0)
    expect((await listUploads(uploadsStore)).files.map(file => file.filename)).toEqual([
      'retry.bin',
    ])
    blocked = false
    const accepted = await routes.request('/', { method: 'POST' })
    expect(accepted.status).toBe(202)
    const { jobId } = (await accepted.json()) as { jobId: string }
    await waitFor(() => jobLedger.snapshot(jobId)?.phase === 'failed')
    expect(started).toBe(1)
  })

  test('bodyless start snapshots uploaded binary bytes and returns before training finishes', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    const binary = Buffer.from([0, 255, 1, 128, 13, 10, 42])
    await uploadsStore.put('fixture.bin', new Blob([binary]).stream())
    let releaseRunner!: () => void
    const runnerReleased = new Promise<void>(resolve => {
      releaseRunner = resolve
    })
    let stagedHash: string | undefined
    const fileEvents: DriveFileEvent[] = []
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      emitFileEvent: event => fileEvents.push(event),
      runner: async input => {
        stagedHash = createHash('sha256')
          .update(await readFile(join(input.stagingDir, 'fixture.bin')))
          .digest('hex')
        await mkdir(input.storeDir, { recursive: true })
        await writeFile(
          join(input.storeDir, `${input.slug}.md`),
          serializeMemoryFile({
            version: 1,
            id: 'mem_pipeline',
            kind: 'train',
            createdAt: Date.parse('2026-07-23T00:00:00.000Z'),
            content: 'Installed pipeline memory.\n',
          }),
        )
        await runnerReleased
        return { record: null, stdout: '', stderr: '' }
      },
    })

    const response = await routes.request('/', {
      method: 'POST',
      headers: { 'x-duet-actor-context': 'web:user-one' },
    })

    expect(response.status).toBe(202)
    const { jobId } = (await response.json()) as { jobId: string }
    expect(jobId).toEqual(expect.any(String))
    await waitFor(() => stagedHash !== undefined)
    expect(stagedHash).toBe(createHash('sha256').update(binary).digest('hex'))
    expect(jobLedger.snapshot(jobId)).toMatchObject({
      phase: 'training',
      creatorUserId: 'user-one',
    })
    releaseRunner()
    await waitFor(() => jobLedger.snapshot(jobId)?.phase === 'done')
    expect(
      await readFile(
        join(driveDir, '.agents', 'memories', `${jobLedger.snapshot(jobId)!.recordSlug}.md`),
        'utf8',
      ),
    ).toBe(
      serializeMemoryFile({
        version: 1,
        id: 'mem_pipeline',
        kind: 'train',
        createdAt: Date.parse('2026-07-23T00:00:00.000Z'),
        content: 'Installed pipeline memory.\n',
      }),
    )
    expect(jobLedger.reports().map(report => report.phase)).toEqual([
      'preparing',
      'snapshotting',
      'training',
      'finalizing',
      'cleanup',
      'done',
    ])
    expect(fileEvents).toEqual([
      {
        kind: 'write',
        path: `.agents/memories/${jobLedger.snapshot(jobId)!.recordSlug}.md`,
        actor: 'web:user-one',
        at: expect.any(Number),
      },
    ])
  })

  test('success clears only its snapshot while a mid-run inbox upload survives', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    await mkdir(join(trainDir, 'jobs', 'previous-failed'), { recursive: true })
    await writeFile(join(trainDir, 'jobs', 'previous-failed', 'source.bin'), 'previous')
    await uploadsStore.put('current.bin', new Blob(['current']).stream())
    let releaseRunner!: () => void
    const runnerReleased = new Promise<void>(resolve => {
      releaseRunner = resolve
    })
    let runnerStarted = false
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async input => {
        runnerStarted = true
        await writeFakeRecord(input)
        await runnerReleased
        return { record: null, stdout: '', stderr: '' }
      },
    })

    const response = await routes.request('/', { method: 'POST' })
    const { jobId } = (await response.json()) as { jobId: string }
    await waitFor(() => runnerStarted)
    await uploadsStore.put('next.bin', new Blob(['next']).stream())
    expect(await readFile(join(trainDir, 'jobs', jobId, 'current.bin'), 'utf8')).toBe('current')

    releaseRunner()
    await waitFor(() => jobLedger.snapshot(jobId)?.phase === 'done')
    expect(
      await readFile(join(trainDir, 'jobs', jobId, 'current.bin')).catch(() => null),
    ).toBeNull()
    expect(await readFile(join(trainDir, 'jobs', 'previous-failed', 'source.bin'), 'utf8')).toBe(
      'previous',
    )
    expect((await listUploads(uploadsStore)).files.map(file => file.filename)).toEqual(['next.bin'])
  })

  test('runner failure cleans up the job-scoped snapshot', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    await uploadsStore.put('retry.bin', new Blob(['retry-me']).stream())
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async () => {
        throw new Error('trainer stopped')
      },
    })

    const response = await routes.request('/', { method: 'POST' })
    const { jobId } = (await response.json()) as { jobId: string }
    await waitFor(() => jobLedger.snapshot(jobId)?.phase === 'failed')

    expect(jobLedger.snapshot(jobId)).toMatchObject({ error: 'trainer stopped' })
    // No retry endpoint exists, so a retained snapshot is unreachable disk
    // growth (whole-spec review finding): failure cleans the job dir.
    await expect(readFile(join(trainDir, 'jobs', jobId, 'retry.bin'), 'utf8')).rejects.toThrow()
  })

  test('fails closed when the drive disappears before finalizing', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    await uploadsStore.put('source.txt', new Blob(['source']).stream())
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async input => {
        await writeFakeRecord(input)
        await rm(driveDir, { recursive: true, force: true })
        return { record: null, stdout: '', stderr: '' }
      },
    })

    const response = await routes.request('/', { method: 'POST' })
    const { jobId } = (await response.clone().json()) as { jobId: string }
    await waitFor(() => jobLedger.snapshot(jobId)?.phase === 'failed')

    expect(response.status).toBe(202)
    expect(jobLedger.snapshot(jobId)).toMatchObject({
      phase: 'failed',
      error: 'Training drive no longer exists.',
    })
    expect(await Bun.file(driveDir).exists()).toBe(false)
  })

  test('refuses a symlinked drive memory store during finalizing', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    const outsideStore = join(root, 'outside-store')
    await Promise.all([
      mkdir(trainDir, { recursive: true }),
      mkdir(join(driveDir, '.agents'), { recursive: true }),
      mkdir(outsideStore),
    ])
    await symlink(outsideStore, join(driveDir, '.agents', 'memories'))
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    await uploadsStore.put('source.txt', new Blob(['source']).stream())
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async input => {
        await writeFakeRecord(input)
        return { record: null, stdout: '', stderr: '' }
      },
    })

    const response = await routes.request('/', { method: 'POST' })
    const { jobId } = (await response.clone().json()) as { jobId: string }
    await waitFor(() => jobLedger.snapshot(jobId)?.phase === 'failed')

    expect(response.status).toBe(202)
    expect(jobLedger.snapshot(jobId)).toMatchObject({
      phase: 'failed',
      error: expect.stringContaining('cannot be symlink'),
    })
    expect(await readdir(outsideStore)).toEqual([])
  })

  test('replacing a record removes its superseded private archive', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    const targetStore = join(driveDir, '.agents', 'memories')
    const oldArchive = join(trainDir, 'archive_old')
    await Promise.all([
      mkdir(trainDir, { recursive: true }),
      mkdir(targetStore, { recursive: true }),
      mkdir(oldArchive, { recursive: true }),
    ])
    await writeFile(join(oldArchive, 'manifest.json'), '{}')
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    await uploadsStore.put('source.txt', new Blob(['source']).stream())
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async input => {
        await writeFile(
          join(targetStore, `${input.slug}.md`),
          serializeMemoryFile({
            version: 1,
            id: 'mem_old',
            kind: 'train',
            createdAt: 1,
            archiveId: 'archive_old',
            content: 'old memory',
          }),
        )
        await writeFakeRecord(input)
        return { record: null, stdout: '', stderr: '' }
      },
    })

    const response = await routes.request('/', { method: 'POST' })
    const { jobId } = (await response.clone().json()) as { jobId: string }
    await waitFor(() => jobLedger.snapshot(jobId)?.phase === 'done')

    expect(response.status).toBe(202)
    expect(await lstat(oldArchive).catch(() => null)).toBeNull()
  })

  test('two overlapping starts both return 202 and reach training', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    const releases: Array<() => void> = []
    const runnerWaits = Array.from(
      { length: 2 },
      () => new Promise<void>(resolve => releases.push(resolve)),
    )
    let runnerCount = 0
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async input => {
        const runnerIndex = runnerCount
        runnerCount += 1
        await writeFakeRecord(input)
        await runnerWaits[runnerIndex]
        return { record: null, stdout: '', stderr: '' }
      },
    })
    const first = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ filename: 'first.md', content: 'first' }] }),
    })
    const firstJobId = ((await first.clone().json()) as { jobId: string }).jobId
    await waitFor(() => jobLedger.snapshot(firstJobId)?.phase === 'training')
    const second = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ filename: 'second.md', content: 'second' }] }),
    })
    const secondJobId = ((await second.clone().json()) as { jobId: string }).jobId

    await waitFor(() => jobLedger.snapshot(secondJobId)?.phase === 'training')
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(firstJobId).not.toBe(secondJobId)
    expect(jobLedger.snapshot(firstJobId)).toMatchObject({ phase: 'training' })
    expect(jobLedger.snapshot(secondJobId)).toMatchObject({ phase: 'training' })

    releases[1]!()
    await waitFor(() => jobLedger.snapshot(secondJobId)?.phase === 'done')
    expect(jobLedger.snapshot(firstJobId)).toMatchObject({ phase: 'training' })
    releases[0]!()
    await waitFor(() => jobLedger.snapshot(firstJobId)?.phase === 'done')
  })

  test('empty corpus returns typed 400 and leaves no running job', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async () => ({ record: null, stdout: '', stderr: '' }),
    })

    const response = await routes.request('/', { method: 'POST' })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'empty_corpus' })
    const jobId = jobLedger.reports().at(-1)!.jobId
    expect(jobLedger.snapshot(jobId)).toMatchObject({ phase: 'failed', error: 'empty_corpus' })
    expect(jobLedger.hasRunningJob()).toBe(false)
  })

  test('assembles snapshot then raw inline then drive bytes into a job-local store', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    await uploadsStore.put('same.bin', new Blob([Buffer.from([1, 2, 3])]).stream())
    const inline = Buffer.from([4, 0, 255, 5])
    const drive = Buffer.from([9, 8, 0, 128, 7])
    await writeFile(join(driveDir, 'same.bin'), drive)
    let observed: { bytes: Buffer; storeDir: string } | undefined
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async input => {
        observed = {
          bytes: await readFile(join(input.stagingDir, 'same.bin')),
          storeDir: input.storeDir,
        }
        await writeFakeRecord(input)
        return { record: null, stdout: '', stderr: '' }
      },
    })

    const response = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [{ filename: 'same.bin', content: inline.toString('base64'), encoding: 'base64' }],
        driveFiles: ['same.bin'],
      }),
    })
    const { jobId } = (await response.clone().json()) as { jobId: string }
    await waitFor(() => jobLedger.snapshot(jobId)?.phase === 'done')

    expect(response.status).toBe(202)
    expect(observed?.bytes).toEqual(drive)
    expect(observed?.storeDir).toMatch(/\/train\/jobs\/[^/]+\/store$/)
  })

  test('rejects inline bytes above the contract cap before starting a job', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async () => ({ record: null, stdout: '', stderr: '' }),
    })

    const response = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [{ filename: 'too-large.bin', content: 'x'.repeat(MAX_TRAIN_INLINE_BYTES + 1) }],
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
    expect(jobLedger.reports()).toEqual([])
    expect(jobLedger.hasRunningJob()).toBe(false)
  })

  test('rejects drive traversal and records assembly failure without running', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    let runnerCalled = false
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async () => {
        runnerCalled = true
        return { record: null, stdout: '', stderr: '' }
      },
    })

    const response = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ driveFiles: ['../outside.bin'] }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
    expect(jobLedger.snapshot(jobLedger.reports().at(-1)!.jobId)).toMatchObject({
      phase: 'failed',
      error: 'invalid_request',
    })
    expect(runnerCalled).toBe(false)
  })

  test('rejects a drive-file symlink instead of copying through it', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const trainDir = join(stateDir, 'train')
    await Promise.all([mkdir(trainDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    await writeFile(join(root, 'outside.bin'), 'outside')
    await symlink(join(root, 'outside.bin'), join(driveDir, 'linked.bin'))
    const uploadsStore = createUploadsStore({
      uploadsDir: join(trainDir, 'uploads'),
      tempDir: join(trainDir, 'temp'),
      capBytes: 1024 * 1024,
      maxFiles: 200,
    })
    const jobLedger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      ...rootTrainRouteOptions(stateDir, driveDir, uploadsStore),
      jobLedger,
      runner: async () => ({ record: null, stdout: '', stderr: '' }),
    })

    const response = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ driveFiles: ['linked.bin'] }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
    expect(jobLedger.snapshot(jobLedger.reports().at(-1)!.jobId)).toMatchObject({ phase: 'failed' })
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(1)
  }
}

async function writeFakeRecord(input: TrainRunnerInput): Promise<void> {
  await mkdir(input.storeDir, { recursive: true })
  await writeFile(
    join(input.storeDir, `${input.slug}.md`),
    serializeMemoryFile({
      version: 1,
      id: `mem_${input.slug.replaceAll('-', '_')}`,
      kind: 'train',
      createdAt: Date.parse('2026-07-23T00:00:00.000Z'),
      content: 'Fake synthesized memory.\n',
    }),
  )
}
