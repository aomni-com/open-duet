import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DriveFileEvent } from '@repo/contract'
import { MIRROR_FOLDER_ID } from '@repo/contract'

import { writeMirrorDevices } from '../sync/mount-store'
import {
  createSyncthingEventConsumer,
  mountStoreRegistry,
  translateDiskEvent,
  type SyncthingDiskEvent,
  type SyncthingRegistrySnapshot,
} from './syncthing-events'

// Fixtures follow the documented /rest/events/disk shape (docs + source,
// research/syncthing-operations.md §B): RemoteChangeDetected fires per applied
// remote item from the puller DB-commit path with a `modifiedBy` short device
// ID; `id` is the per-subscription sequence (gap = discontinuity).
function remoteChange(
  id: number,
  data: Partial<{
    folder: string
    path: string
    action: string
    type: string
    modifiedBy: string
    label: string
  }>,
  time = '2026-07-13T12:00:00.000Z',
): SyncthingDiskEvent {
  return {
    id,
    type: 'RemoteChangeDetected',
    time,
    data: {
      folder: 'share-1',
      path: 'notes.md',
      action: 'modified',
      type: 'file',
      modifiedBy: 'PEER1AB',
      label: 'share-1',
      ...data,
    },
  }
}

function registry(
  overrides: Partial<{
    folders: SyncthingRegistrySnapshot['folders']
    mirrorDeviceMachine: (modifiedBy: string) => string | null
  }> = {},
): SyncthingRegistrySnapshot {
  return {
    folders:
      overrides.folders ??
      new Map([
        ['share-1', { pathPrefix: 'from-peer/project', shareId: 'share-1' }],
        ['drive-mirror', { pathPrefix: '', shareId: null }],
      ]),
    mirrorDeviceMachine: overrides.mirrorDeviceMachine ?? (() => null),
  }
}

const FALLBACK_AT = 1_750_000_000_000
const FIXTURE_AT = Date.parse('2026-07-13T12:00:00.000Z')

function pathOf(event: DriveFileEvent): string {
  return 'path' in event ? event.path : ''
}

describe('translateDiskEvent', () => {
  test('maps added→create, modified→write, deleted→delete (no rename action exists)', () => {
    const cases: Array<[string, 'create' | 'write' | 'delete']> = [
      ['added', 'create'],
      ['modified', 'write'],
      ['deleted', 'delete'],
    ]
    for (const [action, kind] of cases) {
      const result = translateDiskEvent(remoteChange(1, { action }), registry(), FALLBACK_AT)
      const common = {
        path: 'from-peer/project/notes.md',
        actor: 'sync:share-1',
        at: FIXTURE_AT,
      }
      if (kind === 'write') {
        expect(result).toEqual({
          outcome: 'event',
          unknownDevice: false,
          event: { kind, ...common },
        })
      } else if (kind === 'create') {
        expect(result).toEqual({
          outcome: 'event',
          unknownDevice: false,
          event: { kind, entryKind: 'file', ...common },
        })
      } else {
        expect(result).toEqual({
          outcome: 'event',
          unknownDevice: false,
          event: { kind, entryKind: 'file', ...common },
        })
      }
    }
  })

  test('unknown action is skipped, never guessed', () => {
    expect(translateDiskEvent(remoteChange(1, { action: 'renamed' }), registry(), FALLBACK_AT)) //
      .toEqual({ outcome: 'skip', reason: 'malformed' })
  })

  test('share-folder changes resolve to sync:<shareId> via the mount registry', () => {
    const result = translateDiskEvent(remoteChange(7, {}), registry(), FALLBACK_AT)
    if (result.outcome !== 'event') throw new Error('expected event')
    expect(result.event.actor).toBe('sync:share-1')
    expect(result.event.path).toBe('from-peer/project/notes.md')
  })

  test('a bound mirror device wins over the folder share (device-first resolution)', () => {
    const result = translateDiskEvent(
      remoteChange(7, { modifiedBy: 'MACDEV1' }),
      registry({ mirrorDeviceMachine: id => (id === 'MACDEV1' ? 'cred_123' : null) }),
      FALLBACK_AT,
    )
    if (result.outcome !== 'event') throw new Error('expected event')
    expect(result.event.actor).toBe('mirror:cred_123')
  })

  test('unknown device on a shareless folder falls back to a counted system write (Q1)', () => {
    const result = translateDiskEvent(
      remoteChange(7, { folder: 'drive-mirror', path: 'src/app.ts' }),
      registry(),
      FALLBACK_AT,
    )
    expect(result).toEqual({
      outcome: 'event',
      unknownDevice: true,
      event: { kind: 'write', path: 'src/app.ts', actor: 'system', at: FIXTURE_AT },
    })
  })

  test('mask correctness: only RemoteChangeDetected translates', () => {
    const local: SyncthingDiskEvent = {
      ...remoteChange(3, {}),
      type: 'LocalChangeDetected',
    }
    expect(translateDiskEvent(local, registry(), FALLBACK_AT)) //
      .toEqual({ outcome: 'skip', reason: 'not-remote-change' })
    const other: SyncthingDiskEvent = { id: 4, type: 'ItemFinished', data: {} }
    expect(translateDiskEvent(other, registry(), FALLBACK_AT)) //
      .toEqual({ outcome: 'skip', reason: 'not-remote-change' })
  })

  test('unknown folder is skipped — no drive prefix to map into', () => {
    expect(translateDiskEvent(remoteChange(5, { folder: 'nope' }), registry(), FALLBACK_AT)) //
      .toEqual({ outcome: 'skip', reason: 'unknown-folder' })
  })

  test('directory adds/deletes carry folder kind while metadata modifications tick activity', () => {
    expect(
      translateDiskEvent(
        remoteChange(5, { type: 'dir', action: 'added' }),
        registry(),
        FALLBACK_AT,
      ),
    ).toEqual({
      outcome: 'event',
      unknownDevice: false,
      event: {
        kind: 'create',
        entryKind: 'folder',
        path: 'from-peer/project/notes.md',
        actor: 'sync:share-1',
        at: FIXTURE_AT,
      },
    })
    expect(
      translateDiskEvent(
        remoteChange(6, { type: 'dir', action: 'deleted' }),
        registry(),
        FALLBACK_AT,
      ),
    ).toEqual(
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'delete', entryKind: 'folder' }),
      }),
    )
    expect(translateDiskEvent(remoteChange(7, { type: 'dir' }), registry(), FALLBACK_AT)) //
      .toEqual({ outcome: 'activity-only', reason: 'directory' })
  })

  test('symlinks translate like files', () => {
    const result = translateDiskEvent(
      remoteChange(5, { type: 'symlink', action: 'added' }),
      registry(),
      FALLBACK_AT,
    )
    if (result.outcome !== 'event') throw new Error('expected event')
    expect(result.event.kind).toBe('create')
  })

  test('path escapes and malformed payloads are skipped, never emitted', () => {
    expect(translateDiskEvent(remoteChange(5, { path: '../escape' }), registry(), FALLBACK_AT)) //
      .toEqual({ outcome: 'skip', reason: 'invalid-path' })
    expect(
      translateDiskEvent({ id: 6, type: 'RemoteChangeDetected' }, registry(), FALLBACK_AT),
    ).toEqual({ outcome: 'skip', reason: 'malformed' })
    expect(
      translateDiskEvent(
        { id: 7, type: 'RemoteChangeDetected', data: { folder: 'share-1' } },
        registry(),
        FALLBACK_AT,
      ),
    ).toEqual({ outcome: 'skip', reason: 'malformed' })
  })

  test('an unparseable event time falls back to now', () => {
    const result = translateDiskEvent(
      { ...remoteChange(8, {}), time: 'not-a-time' },
      registry(),
      FALLBACK_AT,
    )
    if (result.outcome !== 'event') throw new Error('expected event')
    expect(result.event.at).toBe(FALLBACK_AT)
  })
})

// --- consumer loop -----------------------------------------------------------

interface ConsumerHarness {
  consumer: ReturnType<typeof createSyncthingEventConsumer>
  emitted: DriveFileEvent[]
  polls: () => string[]
  respond: (body: unknown) => void
  fail: () => void
}

function createConsumerHarness(): ConsumerHarness {
  const emitted: DriveFileEvent[] = []
  const polls: string[] = []
  const queue: Array<{ resolve: (response: Response) => void }> = []
  const pendingBodies: Array<unknown | Error> = []

  const consumer = createSyncthingEventConsumer({
    connection: async () => ({ base: 'http://127.0.0.1:8384', headers: { 'x-api-key': 'k' } }),
    fetch: async url => {
      polls.push(String(url))
      const next = pendingBodies.shift()
      if (next !== undefined) {
        if (next instanceof Error) throw next
        return Response.json(next)
      }
      return await new Promise<Response>(resolve => queue.push({ resolve }))
    },
    emit: event => emitted.push(event),
    resolveRegistry: async () => ({
      folders: new Map([['share-1', { pathPrefix: 'from-peer/project', shareId: 'share-1' }]]),
      mirrorDeviceMachine: () => null,
    }),
    now: () => FALLBACK_AT,
    backoffMs: 1,
    sleep: async () => {},
  })
  return {
    consumer,
    emitted,
    polls: () => polls,
    respond: body => {
      const waiter = queue.shift()
      if (waiter) waiter.resolve(Response.json(body))
      else pendingBodies.push(body)
    },
    fail: () => {
      const error = new Error('connection reset')
      const waiter = queue.shift()
      if (waiter)
        waiter.resolve(new Response('boom', { status: 500 })) // non-ok also counts
      else pendingBodies.push(error)
    },
  }
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

describe('syncthing event consumer', () => {
  test('learns the head first (no replay), long-polls since it, emits translated events', async () => {
    const harness = createConsumerHarness()
    // Head learn: the buffer already holds 41 events that must NOT replay.
    harness.respond([remoteChange(41, { path: 'stale.md' })])
    // First real poll delivers one new event.
    harness.respond([remoteChange(42, { path: 'fresh.md', action: 'added' })])
    harness.consumer.start()

    await until(() => harness.emitted.length === 1)
    expect(harness.polls()[0]).toContain('/rest/events/disk?limit=1&timeout=1')
    expect(harness.polls()[1]).toContain('since=41')
    expect(harness.emitted[0]).toEqual({
      kind: 'create',
      entryKind: 'file',
      path: 'from-peer/project/fresh.md',
      actor: 'sync:share-1',
      at: FIXTURE_AT,
    })
    expect(harness.consumer.stats().translated).toBe(1)
    await until(() => harness.polls().length === 3)
    expect(harness.polls()[2]).toContain('since=42')
    harness.consumer.stop()
    harness.respond([])
  })

  test('cursor gap → loss counter, no crash, no fabricated events', async () => {
    const harness = createConsumerHarness()
    harness.respond([]) // head learn: empty log, lastId = 0
    harness.respond([remoteChange(1, { path: 'a.md' })])
    // ids jump 1 → 5: three events fell out of the 1000-event buffer.
    harness.respond([remoteChange(5, { path: 'b.md' })])
    harness.consumer.start()

    await until(() => harness.emitted.length === 2)
    expect(harness.consumer.stats().gaps).toBe(1)
    expect(harness.emitted.map(pathOf)).toEqual([
      'from-peer/project/a.md',
      'from-peer/project/b.md',
    ])
    harness.consumer.stop()
    harness.respond([])
  })

  test('a local scan event is not a remote change (L17)', async () => {
    const harness = createConsumerHarness()
    harness.respond([]) // head learn
    harness.respond([]) // idle long-poll timeout
    harness.respond([
      { ...remoteChange(1, { path: 'local.md' }), type: 'LocalChangeDetected' },
      remoteChange(2, { path: 'remote.md' }),
      remoteChange(3, { type: 'dir', path: 'newdir' }),
    ])
    harness.consumer.start()

    await until(() => harness.emitted.length === 1)
    // Only the genuine remote change translates: the local scan event and the
    // idle poll produce nothing.
    expect(harness.consumer.stats().translated).toBe(1)
    harness.consumer.stop()
    harness.respond([])
  })

  test('unknown-device writes are counted and land as system (Q1)', async () => {
    const emitted: DriveFileEvent[] = []
    const consumer = createSyncthingEventConsumer({
      connection: async () => ({ base: 'http://127.0.0.1:8384', headers: {} }),
      fetch: (() => {
        const responses = [
          [],
          [remoteChange(1, { folder: 'mirror', path: 'x.ts', modifiedBy: 'WHODIS1' })],
        ]
        return async () => {
          const next = responses.shift()
          if (next) return Response.json(next)
          return await new Promise<Response>(() => {})
        }
      })(),
      emit: event => emitted.push(event),
      resolveRegistry: async () => ({
        folders: new Map([['mirror', { pathPrefix: '', shareId: null }]]),
        mirrorDeviceMachine: () => null,
      }),
      now: () => FALLBACK_AT,
      backoffMs: 1,
      sleep: async () => {},
    })
    consumer.start()
    await until(() => emitted.length === 1)
    expect(emitted[0]!.actor).toBe('system')
    expect(consumer.stats().unknownDeviceWrites).toBe(1)
    consumer.stop()
  })

  test('poll failure resets the cursor (Syncthing restart) and re-learns the head', async () => {
    const harness = createConsumerHarness()
    harness.respond([remoteChange(9, {})]) // head learn → lastId 9
    harness.fail() // long poll dies (restart)
    harness.respond([remoteChange(2, { path: 'post-restart.md' })]) // fresh head learn → lastId 2
    harness.respond([remoteChange(3, { path: 'c.md' })])
    harness.consumer.start()

    await until(() => harness.emitted.length === 1)
    const stats = harness.consumer.stats()
    expect(stats.pollErrors).toBe(1)
    expect(stats.resets).toBe(1)
    // The re-learned head is consumption state, not a replay.
    expect(pathOf(harness.emitted[0]!)).toBe('from-peer/project/c.md')
    expect(harness.polls()[2]).toContain('limit=1')
    harness.consumer.stop()
    harness.respond([])
  })
})

describe('mountStoreRegistry (slice-19 seam)', () => {
  test('resolves a mirror device short ID to its machine identity and maps the whole-drive folder', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-registry-'))
    try {
      const fullId = 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'
      await writeMirrorDevices(stateDir, [
        { machineId: 'cred_9', syncthingDeviceId: fullId, registeredAt: 1 },
      ])
      const snapshot = await mountStoreRegistry(stateDir)()

      // The whole-drive mirror folder is rooted at the drive (empty prefix, no
      // shareId) so slice 18 can translate its remote changes.
      expect(snapshot.folders.get(MIRROR_FOLDER_ID)).toEqual({ pathPrefix: '', shareId: null })
      // A RemoteChangeDetected modifiedBy (the 7-char short ID) → credential.
      expect(snapshot.mirrorDeviceMachine('K5MNBGJ')).toBe('cred_9')
      expect(snapshot.mirrorDeviceMachine('UNKNOWN')).toBeNull()

      // End to end: a mirror write on the whole-drive folder resolves to
      // mirror:<machineId>, not system.
      const result = translateDiskEvent(
        {
          id: 1,
          type: 'RemoteChangeDetected',
          time: '2026-07-13T12:00:00.000Z',
          data: {
            folder: MIRROR_FOLDER_ID,
            path: 'notes.md',
            action: 'modified',
            type: 'file',
            modifiedBy: 'K5MNBGJ',
          },
        },
        snapshot,
        1767290000000,
      )
      expect(result.outcome).toBe('event')
      if (result.outcome === 'event') {
        expect(result.event.actor).toBe('mirror:cred_9')
        expect(result.unknownDevice).toBe(false)
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
