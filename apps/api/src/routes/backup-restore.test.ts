import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConvexHttpClient } from 'convex/browser'

import { VmRegisterResponseSchema } from '@repo/contract'

import { buildWorkspaceBackup } from '../../../../packages/gateway/src/backups/archive'
import {
  completePendingRestore,
  persistPendingRestore,
} from '../../../../packages/gateway/src/vm/archive'
import type { BackupBlobStore } from '../backups/blob'
import { createApiApp } from '../index'

test('post-commit registration fallback retains a refreshable backup without signing authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'api-restore-'))
  try {
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(source, 'proof.txt'), 'Recovered through the API refresh response')
    const archive = buildWorkspaceBackup({
      driveDir: source,
      records: (async function* () {})(),
      capture: {
        backupId: 'backup-1',
        workspace: { name: 'Fixture', slug: 'acme' },
        createdAt: Date.now(),
      },
    })
    const bytes = new Uint8Array(await new Response(archive.body).arrayBuffer())
    await archive.completed
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const reference = {
      kind: 'workspace-backup',
      backupId: 'backup-1',
      objectPath: 'private/ws/backup.zip',
      bytes: bytes.byteLength,
      sha256,
    }
    const app = createApiApp({
      internalKey: 'internal',
      convexUrl: 'https://fixture.convex.cloud',
      convexClient: {
        mutation: async (_ref: unknown, args: { command?: { kind: string } }) =>
          args.command
            ? args.command.kind === 'claim'
              ? { status: 'running', processedBytes: 0, processedEntries: 0 }
              : { ok: true }
            : {
                workspaceId: 'workspace-1',
                workspaceSlug: 'acme',
                vmToken: 'duet_vm_token',
                restore: reference,
              },
        query: async () => reference,
      } as unknown as ConvexHttpClient,
      backupBlobStore: {
        download: async () => ({
          url: 'https://private.example/backup.zip?signed=read',
          expiresAt: Date.now() + 60_000,
        }),
      } as unknown as BackupBlobStore,
      vmRegistrationPostCommitTestHooks: {
        before: seam => {
          if (seam === 'core_projection') throw new Error('Projection temporarily unavailable')
        },
      },
    })
    const registered = await app.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: 'provisioning-token',
        workspaceHint: 'workspace-1',
        runtimeVersion: '1.0.0',
        imageVersion: '1.0.0',
      }),
    })
    expect(registered.status).toBe(200)
    const body = VmRegisterResponseSchema.parse(await registered.json())
    expect(body.vmToken).toBe('duet_vm_token')
    expect(body.restore).toEqual({
      kind: 'workspace-backup',
      backupId: 'backup-1',
      bytes: bytes.byteLength,
      sha256,
      refreshUrl: 'http://localhost/v1/vm/workspaces/workspace-1/restore',
    })
    expect(JSON.stringify(body)).not.toContain('private/ws')
    const refreshed = await app.request(
      body.restore!.kind === 'workspace-backup' ? body.restore!.refreshUrl : '',
      { headers: { authorization: `Bearer ${body.vmToken}` } },
    )
    expect(refreshed.status).toBe(200)
    expect(refreshed.headers.get('cache-control')).toBe('private, no-store')
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'destination')
    if (body.restore?.kind !== 'workspace-backup') throw new Error('Missing backup handoff')
    await persistPendingRestore(stateDir, body.restore)
    await completePendingRestore({
      driveDir,
      stateDir,
      getVmToken: () => body.vmToken,
      extraHeaders: {},
      runCommand: async () => ({ exitCode: 0 }),
      fetch: async (url, init) => {
        if (String(url).startsWith('http://localhost/')) return app.request(String(url), init)
        expect(String(url)).toBe('https://private.example/backup.zip?signed=read')
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        return new Response(bytes.slice())
      },
    })
    expect(await readFile(join(driveDir, 'proof.txt'), 'utf8')).toBe(
      'Recovered through the API refresh response',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore reports are VM authenticated, schema checked and preserve backend claim floors', async () => {
  const calls: Array<Record<string, unknown>> = []
  const app = createApiApp({
    internalKey: 'internal',
    convexUrl: 'https://fixture.convex.cloud',
    convexClient: {
      mutation: async (_ref: unknown, args: Record<string, unknown>) => {
        calls.push(args)
        return { status: 'running', processedBytes: 100, processedEntries: 2 }
      },
    } as unknown as ConvexHttpClient,
  })
  const request = (body: unknown, authenticated = true) =>
    app.request('/v1/vm/workspaces/workspace-1/restore', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { authorization: 'Bearer duet_vm_token' } : {}),
      },
      body: JSON.stringify(body),
    })
  expect(
    (await request({ kind: 'claim', backupId: 'backup-1', attemptId: 'attempt' }, false)).status,
  ).toBe(401)
  expect(
    (
      await request({
        kind: 'progress',
        backupId: 'backup-1',
        attemptId: 'attempt',
        phase: 'download',
        processedBytes: -1,
        processedEntries: 0,
      })
    ).status,
  ).toBe(400)
  const result = await request({ kind: 'claim', backupId: 'backup-1', attemptId: 'attempt' })
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({
    status: 'running',
    processedBytes: 100,
    processedEntries: 2,
  })
  expect(calls).toEqual([
    expect.objectContaining({
      internalKey: 'internal',
      workspaceId: 'workspace-1',
      vmTokenHash: expect.any(String),
      command: { kind: 'claim', backupId: 'backup-1', attemptId: 'attempt' },
    }),
  ])
  expect(calls[0]!.vmTokenHash).not.toBe('duet_vm_token')
})
