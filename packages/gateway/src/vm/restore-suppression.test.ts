import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DriveFileEvent, FileEventBatch } from '@repo/contract'

import { createFileEventPipeline } from '../attribution/pipeline'
import { cleanUpTestTimeouts } from '../testing/timeouts.test-helper'
import { completePendingRestore, persistPendingRestore, type RestoreSuppression } from './archive'

// Slice-11 restore suppression (L6): the drive replacement is a copy/swap
// storm of new inodes; the watcher would emit one event per file. The gateway
// suppresses the pipeline (and the helper) around the swap and emits ONE
// `{ kind: 'restore', actor: 'system' }` event instead. These tests drive
// completePendingRestore against a REAL pipeline and assert the storm is
// swallowed, exactly one restore event survives, and suppression always lifts.

cleanUpTestTimeouts()

async function buildArchive(): Promise<Uint8Array> {
  const child = Bun.spawn(
    [
      'python3',
      '-c',
      'import io,tarfile,sys\nwith tarfile.open(fileobj=sys.stdout.buffer,mode="w|") as archive:\n data=b"restored"\n entry=tarfile.TarInfo("drive/file.txt")\n entry.size=len(data)\n archive.addfile(entry,io.BytesIO(data))',
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const stdout = new Response(child.stdout).arrayBuffer()
  const stderr = new Response(child.stderr).text()
  try {
    const [body, errors, code] = await Promise.all([stdout, stderr, child.exited])
    if (code !== 0) throw new Error(errors)
    return new Uint8Array(body)
  } finally {
    child.kill()
    await Promise.all([stdout, stderr, child.exited])
  }
}
function seedDescriptor(body: Uint8Array) {
  return {
    kind: 'birth-seed' as const,
    url: 'http://backend/seed',
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

interface Captured {
  pipeline: ReturnType<typeof createFileEventPipeline>
  delivered: DriveFileEvent[]
}

function capturingPipeline(): Captured {
  const delivered: DriveFileEvent[] = []
  const pipeline = createFileEventPipeline({
    apiUrl: 'http://api',
    getVmToken: async () => 'vm-token',
    fetch: async (_url, init) => {
      const batch = JSON.parse(String(init?.body)) as FileEventBatch
      delivered.push(...batch.events)
      return Response.json({ ok: true })
    },
    now: () => 5_000,
    flushMs: 5,
  })
  return { pipeline, delivered }
}

describe('restore attribution suppression (L6)', () => {
  test('one restore event; watcher noise in the window is swallowed; suppression lifts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'duet-restore-'))
    try {
      const driveDir = join(tempDir, 'drive')
      const stateDir = join(tempDir, '.duet')
      const archive = await buildArchive()
      await persistPendingRestore(stateDir, seedDescriptor(archive))

      const { pipeline, delivered } = capturingPipeline()
      const suppression: RestoreSuppression = {
        begin: () => {
          pipeline.suppress(true)
          // Fake helper events arriving mid-swap — every one must be dropped.
          pipeline.emit({ kind: 'write', path: 'a.txt', actor: 'terminal', at: 1 })
          pipeline.emit({
            kind: 'delete',
            entryKind: 'file',
            path: 'b.txt',
            actor: 'terminal',
            at: 2,
          })
          pipeline.emit({
            kind: 'create',
            entryKind: 'file',
            path: 'c.txt',
            actor: 'session:s1',
            at: 3,
          })
        },
        end: () => {
          pipeline.suppress(false)
        },
        emitOne: () => {
          pipeline.emit({ kind: 'restore', actor: 'system', at: 9 })
        },
      }

      await completePendingRestore({
        driveDir,
        stateDir,
        fetch: async () =>
          new Response(new Uint8Array(archive).slice(), {
            headers: { 'content-type': 'application/x-tar' },
          }),
        getVmToken: () => 'vm-token',
        extraHeaders: {},
        runCommand: async () => ({ exitCode: 0 }),
        suppression,
      })
      await pipeline.flush()

      // Only the single restore event ever reaches the API — no per-file storm.
      expect(delivered).toEqual([{ kind: 'restore', actor: 'system', at: 9 }])
      const after = { kind: 'write' as const, path: 'after.txt', actor: 'terminal', at: 10 }
      pipeline.emit(after)
      await pipeline.flush()
      expect(delivered).toEqual([{ kind: 'restore', actor: 'system', at: 9 }, after])
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('suppression lifts (finally) and emits nothing when the restore fails', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'duet-restore-fail-'))
    try {
      const driveDir = join(tempDir, 'drive')
      const stateDir = join(tempDir, '.duet')
      await persistPendingRestore(stateDir, seedDescriptor(new Uint8Array()))

      const { pipeline, delivered } = capturingPipeline()
      const suppression: RestoreSuppression = {
        begin: () => pipeline.suppress(true),
        end: () => {
          pipeline.suppress(false)
        },
        emitOne: () => pipeline.emit({ kind: 'restore', actor: 'system', at: 9 }),
      }

      await expect(
        completePendingRestore({
          driveDir,
          stateDir,
          // Download fails → restoreArchive throws inside the try.
          fetch: async () => new Response('nope', { status: 500 }),
          getVmToken: () => 'vm-token',
          extraHeaders: {},
          runCommand: async () => ({ exitCode: 0 }),
          suppression,
        }),
      ).rejects.toThrow('Restore download failed: 500')
      await pipeline.flush()

      expect(delivered).toEqual([])
      const after = { kind: 'write' as const, path: 'after.txt', actor: 'terminal', at: 10 }
      pipeline.emit(after)
      await pipeline.flush()
      expect(delivered).toEqual([after])
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test('with no pending restore, the suppression seam is never touched', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'duet-restore-none-'))
    try {
      let touched = false
      const spy = () => {
        touched = true
      }
      await completePendingRestore({
        driveDir: join(tempDir, 'drive'),
        stateDir: join(tempDir, '.duet'),
        fetch: async () => new Response('unused'),
        getVmToken: () => 'vm-token',
        extraHeaders: {},
        suppression: { begin: spy, end: spy, emitOne: spy },
      })
      expect(touched).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
