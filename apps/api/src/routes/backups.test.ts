import { expect, test } from 'bun:test'

import { getFunctionName, type FunctionReference } from 'convex/server'
import { Hono } from 'hono'

import { API_VERSION } from '@repo/contract'

import type { BackupBlobStore } from '../backups/blob'
import type { ApiRouteRuntime, ApiVariables, AuthPayload } from '../shared'
import { registerBackupRoutes } from './backups'

const stored = {
  _id: 'backup-1',
  workspaceId: 'ws-1',
  purpose: 'export',
  status: 'ready',
  createdAt: 100,
  updatedAt: 200,
  bytes: 42,
  sha256: 'a'.repeat(64),
  completeness: 'complete',
  progress: {
    processedFiles: 2,
    processedRecords: 3,
    capturedBytes: 40,
    uploadedBytes: 42,
    warningCount: 0,
    warningSummary: [],
  },
  objectPath: 'private/ws-1/backup-1.zip',
  attemptId: 'secret-attempt',
  uploadGrantExpiresAt: 900,
}
function fixture(scope: string) {
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('*', async (c, next) => {
    c.set('auth', {
      credentialKind: 'browser_session',
      user: { id: 'user-1', email: 'owner@example.test' },
      workspaces: [{ id: 'ws-1', slug: 'acme', role: 'owner', onboardedAt: 1 }],
      scopes: [scope],
      versions: API_VERSION,
    } as AuthPayload)
    await next()
  })
  const runtime = {
    internalKey: 'internal',
    convex: { query: async () => stored },
  } as unknown as ApiRouteRuntime
  const store = {
    download: async () => ({ url: 'https://private.example/secret', expiresAt: 1000 }),
  } as unknown as BackupBlobStore
  registerBackupRoutes(app, runtime, store)
  return app
}

test('workspace admin can inspect retained backups without exposing storage authority', async () => {
  const app = fixture('ws:acme:admin')
  const response = await app.request('/v1/ws/acme/backups/backup-1')
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.backup).toMatchObject({ id: 'backup-1', status: 'ready', bytes: 42 })
  expect(JSON.stringify(body)).not.toContain('secret-attempt')
  expect(JSON.stringify(body)).not.toContain('private/ws-1')
  expect((await fixture('ws:acme:files').request('/v1/ws/acme/backups/backup-1')).status).toBe(403)
})

test('VM completion cannot make a mismatched provider object downloadable', async () => {
  const { registerBackupControlRoutes } = await import('./backup-control')
  let state = 'running'
  const app = new Hono<{ Variables: ApiVariables }>()
  const runtime = {
    internalKey: 'internal',
    now: () => 100,
    convex: {
      query: async () => ({
        backup: { ...stored, status: state },
        workspace: { _id: 'ws-1', name: 'Acme', slug: 'acme', vmTokenNonce: 'generation-1' },
      }),
      mutation: async (reference: FunctionReference<'mutation'>) => {
        const name = getFunctionName(reference)
        if (name === 'domains/workspaceBackups/jobs:fail') state = 'failed'
        else if (name === 'domains/workspaceBackups/jobs:complete') state = 'ready'
        else throw new Error(`Unexpected backup mutation: ${name}`)
        return true
      },
    },
  } as unknown as ApiRouteRuntime
  registerBackupControlRoutes(
    app,
    runtime,
    {} as never,
    {
      verify: async () => {
        throw new Error('backup_artifact_mismatch')
      },
    } as unknown as BackupBlobStore,
  )
  const response = await app.request('/v1/vm/backups/backup-1/complete', {
    method: 'POST',
    headers: { authorization: 'Bearer vm-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      attemptId: 'secret-attempt',
      bytes: 42,
      sha256: 'a'.repeat(64),
      completeness: 'complete',
      progress: stored.progress,
    }),
  })
  expect(response.status).toBe(409)
  expect(state).toBe('failed')
})

test('a transient provider confirmation failure retries the same completion without failing the job', async () => {
  const { registerBackupControlRoutes } = await import('./backup-control')
  let state = 'running'
  let checks = 0
  const app = new Hono<{ Variables: ApiVariables }>()
  registerBackupControlRoutes(
    app,
    {
      internalKey: 'internal',
      now: () => 100,
      convex: {
        query: async () => ({
          backup: { ...stored, status: state },
          workspace: { _id: 'ws-1', name: 'Acme', slug: 'acme', vmTokenNonce: 'generation-1' },
        }),
        mutation: async (reference: FunctionReference<'mutation'>) => {
          const name = getFunctionName(reference)
          if (name === 'domains/workspaceBackups/jobs:fail') state = 'failed'
          else if (name === 'domains/workspaceBackups/jobs:complete') state = 'ready'
          else throw new Error(`Unexpected backup mutation: ${name}`)
          return true
        },
      },
    } as unknown as ApiRouteRuntime,
    {} as never,
    {
      verify: async () => {
        if (checks++ === 0) throw new Error('Provider temporarily unavailable')
        return {}
      },
    } as unknown as BackupBlobStore,
  )
  const submit = () =>
    app.request('/v1/vm/backups/backup-1/complete', {
      method: 'POST',
      headers: { authorization: 'Bearer vm-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        attemptId: 'secret-attempt',
        bytes: 42,
        sha256: 'a'.repeat(64),
        completeness: 'complete',
        progress: stored.progress,
      }),
    })
  expect((await submit()).status).toBe(503)
  expect(state).toBe('running')
  expect((await submit()).status).toBe(200)
  expect(state).toBe('ready')
})

test('a deleted backup settles a surviving VM journal and permits the next backup', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createBackupWorker } = await import('../../../../packages/gateway/src/backups/worker')
  const { registerBackupControlRoutes } = await import('./backup-control')
  const root = await mkdtemp(join(tmpdir(), 'deleted-backup-worker-'))
  try {
    const stateDir = join(root, 'state')
    await mkdir(join(stateDir, 'backups'), { recursive: true })
    await writeFile(
      join(stateDir, 'backups/worker.json'),
      JSON.stringify({
        backupId: 'deleted-backup',
        attemptId: 'attempt',
        state: 'uploaded',
        phase: 'finalizing',
        progress: stored.progress,
        completion: {
          attemptId: 'attempt',
          bytes: 42,
          sha256: 'a'.repeat(64),
          completeness: 'complete',
          progress: stored.progress,
        },
      }),
    )
    const app = new Hono<{ Variables: ApiVariables }>()
    registerBackupControlRoutes(
      app,
      {
        internalKey: 'internal',
        convex: {
          query: async () => ({
            backup: null,
            workspace: { _id: 'ws-1', name: 'Acme', slug: 'acme', vmTokenNonce: 'generation-1' },
          }),
        },
      } as unknown as ApiRouteRuntime,
      {} as never,
      {} as never,
    )
    const worker = createBackupWorker({
      driveDir: join(root, 'drive'),
      stateDir,
      apiUrl: 'https://control.test',
      getVmToken: async () => 'vm-token',
      fetch: async (input, init) => app.request(String(input), init),
    })
    await worker.reconcile()
    expect(worker.snapshot()).toBeNull()
    expect(worker.start('next-backup', 'next-attempt')).toEqual({ accepted: true })
    await worker.cancel('next-backup', 'next-attempt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
