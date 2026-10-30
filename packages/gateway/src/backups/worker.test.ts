import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BackupMultipartSdk } from './upload'
import { createBackupWorker } from './worker'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'backup-worker-'))
  roots.push(root)
  const driveDir = join(root, 'drive'),
    stateDir = join(root, 'state')
  await mkdir(driveDir)
  await mkdir(stateDir)
  await writeFile(join(driveDir, '.env'), 'fixture')
  return { root, driveDir, stateDir }
}
async function until(condition: () => boolean) {
  const end = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > end) throw new Error('Worker did not settle')
    await Bun.sleep(5)
  }
}
function transport() {
  const calls: Array<{ operation: string; body: Record<string, unknown>; token: string | null }> =
    []
  const uploaded: Buffer[] = []
  let failComplete = false
  const sdk: BackupMultipartSdk = {
    async createMultipartUpload() {
      return { key: 'key', uploadId: 'upload' }
    },
    async uploadPart(_path, body, options) {
      uploaded[options.partNumber - 1] = Buffer.from(await new Response(body as Blob).arrayBuffer())
      return { etag: 'etag', partNumber: options.partNumber }
    },
    async completeMultipartUpload(path) {
      return {
        pathname: path,
        url: 'https://fixture.private.blob.vercel-storage.com/backup.zip',
        downloadUrl: 'https://fixture.private.blob.vercel-storage.com/backup.zip',
        contentType: 'application/zip',
        contentDisposition: 'attachment',
        etag: 'fixture-etag',
      }
    },
  }
  return {
    calls,
    uploaded,
    sdk,
    setFailComplete: (value: boolean) => {
      failComplete = value
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const operation = String(input).split('/').at(-1)!
      const body = JSON.parse(String(init?.body))
      calls.push({ operation, body, token: new Headers(init?.headers).get('authorization') })
      if (operation === 'claim')
        return Response.json({
          backup: {
            id: 'backup',
            attemptId: 'attempt',
            objectPath: 'backups/fixture.zip',
            createdAt: 1700000000000,
          },
          workspace: { name: 'Fixture', slug: 'fixture' },
        })
      if (operation === 'capture')
        return Response.json({
          records:
            body.collection === 'settings'
              ? [{ kind: 'settings', name: 'Fixture', slug: 'fixture' }]
              : [],
          warnings: [],
          nextCursor: null,
        })
      if (operation === 'grant')
        return Response.json({
          pathname: 'backups/fixture.zip',
          token: 'grant',
          expiresAt: Date.now() + 15 * 60_000,
        })
      if (operation === 'complete' && failComplete)
        return Response.json({ error: 'unavailable' }, { status: 503 })
      return Response.json({ accepted: true })
    },
  }
}
test('acknowledges start before upload and captures complete bytes in the background', async () => {
  const dirs = await fixture(),
    network = transport()
  const worker = createBackupWorker({
    ...dirs,
    apiUrl: 'https://control.test',
    getVmToken: async () => 'vm-token',
    fetch: network.fetch,
    sdk: network.sdk,
  })
  expect(worker.start('backup', 'attempt')).toEqual({ accepted: true })
  expect(network.uploaded).toEqual([])
  await until(() => network.calls.some(call => call.operation === 'complete'))
  await until(() => worker.snapshot() === null)
  const complete = network.calls.find(call => call.operation === 'complete')!.body
  const bytes = Buffer.concat(network.uploaded)
  expect(complete.bytes).toBe(bytes.length)
  expect(complete.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(complete.completeness).toBe('complete')
  expect(
    network.calls.every(
      call => call.token === 'Bearer vm-token' && call.body.attemptId === 'attempt',
    ),
  ).toBe(true)
  expect(await readdir(join(dirs.stateDir, 'backups/scratch'))).toEqual([])
})

test('a late progress acknowledgement cannot erase completion', async () => {
  const dirs = await fixture(),
    network = transport()
  const provider = Promise.withResolvers<void>(),
    progress = Promise.withResolvers<void>(),
    providerReached = Promise.withResolvers<void>()
  const finish = network.sdk.completeMultipartUpload
  network.sdk.completeMultipartUpload = async (...args) => {
    providerReached.resolve()
    await provider.promise
    return finish(...args)
  }
  const worker = createBackupWorker({
    ...dirs,
    apiUrl: 'https://control.test',
    getVmToken: async () => 'token',
    sdk: network.sdk,
    fetch: async (input, init) => {
      if (String(input).endsWith('/progress')) await progress.promise
      return network.fetch(input, init)
    },
  })
  worker.start('backup', 'attempt')
  await providerReached.promise
  const reporting = worker.reconcile()
  provider.resolve()
  await until(() => worker.snapshot()?.state === 'uploaded')
  progress.resolve()
  await reporting
  await until(() => network.calls.some(call => call.operation === 'complete'))
  expect(worker.snapshot()).toBeNull()
}, 10000)

test('restart retries a lost completion acknowledgement without capture or upload', async () => {
  const dirs = await fixture(),
    network = transport()
  network.setFailComplete(true)
  const options = {
    ...dirs,
    apiUrl: 'https://control.test',
    getVmToken: async () => 'token',
    fetch: network.fetch,
    sdk: network.sdk,
  }
  const first = createBackupWorker(options)
  first.start('backup', 'attempt')
  await until(() => first.snapshot()?.state === 'uploaded' && !first.isRunning())
  const original = Buffer.concat(network.uploaded)
  network.setFailComplete(false)
  const restarted = createBackupWorker(options)
  await restarted.reconcile()
  expect(restarted.snapshot()).toBeNull()
  expect(network.calls.filter(call => call.operation === 'claim')).toHaveLength(1)
  expect(network.calls.filter(call => call.operation === 'complete')).toHaveLength(2)
  expect(Buffer.concat(network.uploaded)).toEqual(original)
})

test('progress waits for the attempt claim to be accepted', async () => {
  const dirs = await fixture(),
    network = transport()
  const claim = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>()
  const worker = createBackupWorker({
    ...dirs,
    apiUrl: 'https://control.test',
    getVmToken: async () => 'token',
    sdk: network.sdk,
    fetch: async (input, init) => {
      if (String(input).endsWith('/claim')) {
        entered.resolve()
        await claim.promise
      }
      return network.fetch(input, init)
    },
  })
  worker.start('backup', 'attempt')
  await entered.promise
  await worker.reconcile()
  expect(network.calls.some(call => call.operation === 'progress')).toBe(false)
  await worker.cancel('backup', 'attempt')
})

test('boot fails an interrupted capture, reclaims part scratch and accepts a later job', async () => {
  const dirs = await fixture(),
    network = transport()
  await mkdir(join(dirs.stateDir, 'backups/scratch'), { recursive: true })
  await writeFile(join(dirs.stateDir, 'backups/scratch/abandoned-part'), 'partial')
  await writeFile(
    join(dirs.stateDir, 'backups/worker.json'),
    JSON.stringify({
      backupId: 'backup',
      attemptId: 'attempt',
      state: 'capturing',
      phase: 'files',
      progress: {
        processedFiles: 0,
        processedRecords: 0,
        capturedBytes: 0,
        uploadedBytes: 0,
        warningCount: 0,
        warningSummary: [],
      },
    }),
  )
  const worker = createBackupWorker({
    ...dirs,
    apiUrl: 'https://control.test',
    getVmToken: async () => 'token',
    fetch: network.fetch,
    sdk: network.sdk,
  })
  await worker.reconcile()
  expect(network.calls.find(call => call.operation === 'fail')?.body.error).toEqual({
    code: 'interrupted',
    message: 'Gateway restarted during capture or upload',
  })
  expect(await readdir(join(dirs.stateDir, 'backups/scratch'))).toEqual([])
  expect(worker.start('backup', 'attempt')).toEqual({ accepted: true })
  await until(() => worker.snapshot() === null && !worker.isRunning())
  expect(network.calls.some(call => call.operation === 'complete')).toBe(true)
})

test('no-progress cancellation reports stalled instead of keeping a dead stream alive', async () => {
  const { BACKUP_STALL_MS } = await import('@repo/contract')
  const dirs = await fixture(),
    network = transport(),
    entered = Promise.withResolvers<void>()
  let time = Date.now()
  const worker = createBackupWorker({
    ...dirs,
    apiUrl: 'https://control.test',
    getVmToken: async () => 'token',
    sdk: network.sdk,
    now: () => time,
    fetch: async (input, init) => {
      if (String(input).endsWith('/capture')) {
        entered.resolve()
        return new Promise(() => {})
      }
      return network.fetch(input, init)
    },
  })
  worker.start('backup', 'attempt')
  await entered.promise
  time += BACKUP_STALL_MS + 1
  await worker.reconcile()
  await until(() => !worker.isRunning())
  time += 15001
  await worker.reconcile()
  expect(network.calls.find(call => call.operation === 'fail')?.body.error).toEqual({
    code: 'stalled',
    message: 'Backup capture was interrupted',
  })
  expect(worker.snapshot()).toBeNull()
  expect(await readdir(join(dirs.stateDir, 'backups/scratch'))).toEqual([])
})

test('concurrent file, metadata and upload progress never regresses the reported phase', async () => {
  const dirs = await fixture(),
    network = transport()
  await writeFile(
    join(dirs.driveDir, 'large'),
    crypto.getRandomValues(new Uint8Array(16 * 1024 * 1024)),
  )
  let time = Date.now(),
    rank = -1
  const phases = ['metadata', 'files', 'upload', 'finalizing']
  const worker = createBackupWorker({
    ...dirs,
    apiUrl: 'https://control.test',
    getVmToken: async () => 'token',
    sdk: network.sdk,
    now: () => time,
    fetch: async (input, init) => {
      if (String(input).endsWith('/capture')) await Bun.sleep(180)
      if (String(input).endsWith('/progress')) {
        const phase = JSON.parse(String(init?.body)).phase
        const next = phases.indexOf(phase)
        if (next < rank) return Response.json({ error: 'phase_regression' }, { status: 409 })
        rank = next
      }
      return network.fetch(input, init)
    },
  })
  worker.start('backup', 'attempt')
  while (worker.isRunning()) {
    time += 15001
    await worker.reconcile()
    await Bun.sleep(30)
  }
  expect(network.calls.some(call => call.operation === 'complete')).toBe(true)
  expect(network.calls.some(call => call.operation === 'fail')).toBe(false)
}, 10000)

test('an exhausted part upload fails visibly, cleans scratch, and does not poison the next backup', async () => {
  const dirs = await fixture(),
    network = transport()
  const upload = network.sdk.uploadPart
  network.sdk.uploadPart = async () => {
    throw new Error('SDK retries exhausted')
  }
  const worker = createBackupWorker({
    ...dirs,
    apiUrl: 'https://control.test',
    getVmToken: async () => 'token',
    sdk: network.sdk,
    fetch: network.fetch,
  })
  worker.start('backup', 'attempt')
  await until(() => !worker.isRunning())
  expect(network.calls.find(call => call.operation === 'fail')?.body.error).toEqual({
    code: 'upload_failed',
    message: 'Backup upload or archive encoding failed',
  })
  expect(await readdir(join(dirs.stateDir, 'backups/scratch'))).toEqual([])
  network.sdk.uploadPart = upload
  expect(worker.start('backup', 'attempt')).toEqual({ accepted: true })
  await until(() => !worker.isRunning())
  expect(network.calls.some(call => call.operation === 'complete')).toBe(true)
})
