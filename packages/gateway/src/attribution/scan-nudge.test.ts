import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DriveFileEvent } from '@repo/contract'

import { writeMounts } from '../sync/mount-store'
import {
  SCAN_NUDGE_MAX_SUBS_PER_SCAN,
  createScanNudge,
  mountStoreScanTargets,
  type ScanTargetResolver,
} from './scan-nudge'

// Deterministic fake timers: the debounce window only elapses when the test
// says so.
interface FakeTimers {
  timers: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
  fire(): void
  scheduled(): number[]
  cleared(): number
}

function fakeTimers(): FakeTimers {
  let nextHandle = 1
  const pending = new Map<number, () => void>()
  const delays: number[] = []
  let clearedCount = 0
  return {
    timers: {
      setTimeout(callback, ms) {
        const handle = nextHandle++
        pending.set(handle, callback)
        delays.push(ms)
        return handle
      },
      clearTimeout(handle) {
        if (pending.delete(handle as number)) clearedCount += 1
      },
    },
    fire() {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    },
    scheduled: () => delays,
    cleared: () => clearedCount,
  }
}

interface Harness {
  nudge: ReturnType<typeof createScanNudge>
  clock: FakeTimers
  requests: string[]
  failNext(count: number): void
}

function createHarness(
  overrides: { resolveTargets?: ScanTargetResolver; debounceMs?: number } = {},
): Harness {
  const clock = fakeTimers()
  const requests: string[] = []
  let failures = 0
  const nudge = createScanNudge({
    connection: async () => ({ base: 'http://127.0.0.1:8384', headers: { 'x-api-key': 'k' } }),
    fetch: async url => {
      requests.push(String(url))
      if (failures > 0) {
        failures -= 1
        return new Response('nope', { status: 500 })
      }
      return new Response('ok')
    },
    resolveTargets:
      overrides.resolveTargets ??
      (async paths =>
        paths.map(path => ({
          folderId: 'share-1',
          sub: path === 'from-peer/project' ? '' : path.replace(/^from-peer\/project\//, ''),
        }))),
    debounceMs: overrides.debounceMs ?? 250,
    timers: clock.timers,
  })
  return {
    nudge,
    clock,
    requests,
    failNext: count => {
      failures = count
    },
  }
}

function write(path: string, actor = 'session:sess_1'): DriveFileEvent {
  return { kind: 'write', path, actor, at: 1_000_000 }
}

describe('scan nudge', () => {
  test('debounces and batches paths into one repeated-sub scan call', async () => {
    const harness = createHarness()
    harness.nudge.onEvent(write('from-peer/project/a.txt'))
    harness.nudge.onEvent(write('from-peer/project/b.txt'))
    harness.nudge.onEvent(write('from-peer/project/a.txt')) // dedupes
    expect(harness.requests).toHaveLength(0)
    expect(harness.clock.scheduled()).toEqual([250]) // one timer for the burst

    harness.clock.fire()
    await harness.nudge.settle()
    expect(harness.requests).toEqual([
      'http://127.0.0.1:8384/rest/db/scan?folder=share-1&sub=a.txt&sub=b.txt',
    ])
    expect(harness.nudge.stats()).toMatchObject({ scans: 1, failures: 0, loopGuardSkips: 0 })
  })

  test('groups by folder and scans each folder once', async () => {
    const harness = createHarness({
      resolveTargets: async paths =>
        paths.map(path =>
          path.startsWith('one/')
            ? { folderId: 'f-one', sub: path.slice(4) }
            : { folderId: 'f-two', sub: path.slice(4) },
        ),
    })
    harness.nudge.onEvent(write('one/a.txt'))
    harness.nudge.onEvent(write('two/b.txt'))
    harness.clock.fire()
    await harness.nudge.settle()
    expect(harness.requests).toEqual([
      'http://127.0.0.1:8384/rest/db/scan?folder=f-one&sub=a.txt',
      'http://127.0.0.1:8384/rest/db/scan?folder=f-two&sub=b.txt',
    ])
  })

  test('rename nudges both sides; reads and restores never nudge', () => {
    const harness = createHarness()
    harness.nudge.onEvent({
      kind: 'rename',
      entryKind: 'file',
      path: 'from-peer/project/new.txt',
      fromPath: 'from-peer/project/old.txt',
      actor: 'session:sess_1',
      at: 1,
    })
    harness.nudge.onEvent({ kind: 'read', path: 'from-peer/project/r.txt', actor: 'web:u1', at: 1 })
    harness.nudge.onEvent({ kind: 'restore', actor: 'system', at: 1 })
    harness.clock.fire()
    return harness.nudge.settle().then(() => {
      expect(harness.requests).toEqual([
        'http://127.0.0.1:8384/rest/db/scan?folder=share-1&sub=new.txt&sub=old.txt',
      ])
    })
  })

  test('LOOP GUARD: sync:* and mirror:* actors never nudge', async () => {
    const harness = createHarness()
    harness.nudge.onEvent(write('from-peer/project/a.txt', 'sync:share-1'))
    harness.nudge.onEvent(write('from-peer/project/b.txt', 'mirror:cred_1'))
    harness.nudge.onEvent({
      kind: 'delete',
      entryKind: 'file',
      path: 'from-peer/project/c.txt',
      actor: 'sync:share-1',
      at: 1,
    })
    expect(harness.clock.scheduled()).toHaveLength(0) // nothing even schedules
    await harness.nudge.settle()
    expect(harness.requests).toHaveLength(0)
    expect(harness.nudge.stats().loopGuardSkips).toBe(3)

    // Foreign writes still nudge — the guard is per-actor, not global.
    harness.nudge.onEvent(write('from-peer/project/d.txt', 'terminal'))
    harness.nudge.onEvent(write('from-peer/project/e.txt', 'system'))
    harness.clock.fire()
    await harness.nudge.settle()
    expect(harness.requests).toEqual([
      'http://127.0.0.1:8384/rest/db/scan?folder=share-1&sub=d.txt&sub=e.txt',
    ])
  })

  test('collapses to a whole-folder scan above the sub cap or when the root changed', async () => {
    const harness = createHarness()
    for (let i = 0; i <= SCAN_NUDGE_MAX_SUBS_PER_SCAN; i++) {
      harness.nudge.onEvent(write(`from-peer/project/f${i}.txt`))
    }
    harness.clock.fire()
    await harness.nudge.settle()
    expect(harness.requests).toEqual(['http://127.0.0.1:8384/rest/db/scan?folder=share-1'])

    harness.nudge.onEvent(write('from-peer/project')) // sub '' = the folder root
    harness.clock.fire()
    await harness.nudge.settle()
    expect(harness.requests[1]).toBe('http://127.0.0.1:8384/rest/db/scan?folder=share-1')
  })

  test('diagnostics retain a bounded ring of raw descendant paths before folding', () => {
    const harness = createHarness()
    for (let index = 0; index < 40; index += 1) {
      harness.nudge.onEvent(write(`generated/node_modules/pkg/cache/${index}.js`))
    }

    const stats = harness.nudge.stats()
    expect(stats.rawPathsObserved).toBe(40)
    expect(stats.latestPaths).toHaveLength(32)
    expect(stats.latestPaths[0]).toBe('generated/node_modules/pkg/cache/8.js')
    expect(stats.latestPaths.at(-1)).toBe('generated/node_modules/pkg/cache/39.js')
  })

  test('failures are counted, never retried, and later nudges still run', async () => {
    const harness = createHarness()
    harness.failNext(1)
    harness.nudge.onEvent(write('from-peer/project/a.txt'))
    harness.clock.fire()
    await harness.nudge.settle()
    expect(harness.nudge.stats()).toMatchObject({ scans: 0, failures: 1, loopGuardSkips: 0 })
    expect(harness.requests).toHaveLength(1) // no hot retry

    harness.nudge.onEvent(write('from-peer/project/b.txt'))
    harness.clock.fire()
    await harness.nudge.settle()
    expect(harness.requests).toHaveLength(2)
    expect(harness.nudge.stats().scans).toBe(1)
  })

  test('a resolver failure is one counted failure, not a crash', async () => {
    const harness = createHarness({
      resolveTargets: async () => {
        throw new Error('mount store unreadable')
      },
    })
    harness.nudge.onEvent(write('from-peer/project/a.txt'))
    harness.clock.fire()
    await harness.nudge.settle()
    expect(harness.requests).toHaveLength(0)
    expect(harness.nudge.stats().failures).toBe(1)
  })

  test('paths outside any synced folder resolve to no scan at all', async () => {
    const harness = createHarness({
      resolveTargets: mountStoreScanTargets('/nonexistent-state-dir'),
    })
    harness.nudge.onEvent(write('not-synced/a.txt'))
    harness.clock.fire()
    await harness.nudge.settle()
    expect(harness.requests).toHaveLength(0)
    expect(harness.nudge.stats()).toMatchObject({ scans: 0, failures: 0, loopGuardSkips: 0 })
  })

  test('one creator path resolves to every recipient folder that shares it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-scan-targets-'))
    try {
      await writeMounts(root, [
        {
          id: 'share-a',
          shareId: 'share-a',
          path: 'project',
          mode: 'read',
          role: 'origin',
          ignorePatterns: [],
        },
        {
          id: 'share-b',
          shareId: 'share-b',
          path: 'project',
          mode: 'write',
          role: 'origin',
          ignorePatterns: [],
        },
      ])

      await expect(mountStoreScanTargets(root)(['project/notes.txt'])).resolves.toEqual([
        { folderId: 'share-a', sub: 'notes.txt' },
        { folderId: 'share-b', sub: 'notes.txt' },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('stop() clears the pending debounce window', () => {
    const harness = createHarness()
    harness.nudge.onEvent(write('from-peer/project/a.txt'))
    harness.nudge.stop()
    expect(harness.clock.cleared()).toBe(1)
    harness.nudge.onEvent(write('from-peer/project/b.txt'))
    expect(harness.clock.scheduled()).toHaveLength(1) // nothing new after stop
  })
})
