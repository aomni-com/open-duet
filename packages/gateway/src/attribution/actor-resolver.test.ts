import { describe, expect, test } from 'bun:test'

import type { DriveFileEvent } from '@repo/contract'

import { cgroupLeafForSession } from '../runner/cgroup'
import { createActorResolver } from './actor-resolver'
import type { HelperFsEvent } from './helper-protocol'

const SESSION_ID = 'sess_alpha1'
const SESSION_LEAF = cgroupLeafForSession(SESSION_ID)

function fsEvent(overrides: Partial<HelperFsEvent> = {}): HelperFsEvent {
  const event = {
    t: 'fs',
    kind: 'write',
    path: 'notes.md',
    pid: 4321,
    unit: null,
    at: 1000,
    ...overrides,
  }
  return (
    event.kind === 'create' || event.kind === 'delete' || event.kind === 'rename'
      ? { ...event, entryKind: event.entryKind ?? 'file' }
      : event
  ) as HelperFsEvent
}

describe('createActorResolver — the Q1 attribution matrix', () => {
  const resolve = createActorResolver().resolve

  describe('session unit → session:<id>, every kind', () => {
    for (const kind of ['read', 'write', 'create', 'delete'] as const) {
      test(kind, () => {
        const event = resolve(fsEvent({ kind, unit: SESSION_LEAF }))
        const base = { path: 'notes.md', actor: `session:${SESSION_ID}`, at: 1000 }
        const expected: DriveFileEvent =
          kind === 'create' || kind === 'delete'
            ? { ...base, kind, entryKind: 'file' }
            : { ...base, kind }
        expect(event).toEqual(expected)
      })
    }

    test('rename carries fromPath', () => {
      const event = resolve(fsEvent({ kind: 'rename', unit: SESSION_LEAF, fromPath: 'old.md' }))
      expect(event).toEqual({
        kind: 'rename',
        entryKind: 'file',
        path: 'notes.md',
        fromPath: 'old.md',
        actor: `session:${SESSION_ID}`,
        at: 1000,
      })
    })
  })

  describe('terminal — non-session unit and null unit alike audit write-class', () => {
    for (const unit of [null, 'user.slice', 'docker-1234', '1234', '']) {
      test(`unit=${JSON.stringify(unit)} write → terminal`, () => {
        const event = resolve(fsEvent({ kind: 'write', unit }))
        expect(event).toEqual({ kind: 'write', path: 'notes.md', actor: 'terminal', at: 1000 })
      })
    }
  })

  describe('reads from an unattributed actor are dropped (Q1)', () => {
    for (const unit of [null, '1234', 'user.slice', '']) {
      test(`unit=${JSON.stringify(unit)} read → null`, () => {
        expect(resolve(fsEvent({ kind: 'read', unit }))).toBeNull()
      })
    }

    test('a session read is NOT dropped', () => {
      expect(resolve(fsEvent({ kind: 'read', unit: SESSION_LEAF }))?.actor).toBe(
        `session:${SESSION_ID}`,
      )
    })
  })

  describe('the slice-09 open-less rm/mv boundary: null-unit delete/rename → terminal', () => {
    test('bare rm (null unit) is a terminal delete — path right, actor coarse', () => {
      const event = resolve(fsEvent({ kind: 'delete', unit: null, path: 'm/created.txt' }))
      expect(event).toEqual({
        kind: 'delete',
        entryKind: 'file',
        path: 'm/created.txt',
        actor: 'terminal',
        at: 1000,
      })
    })

    test('bare mv (null unit) with a joined fromPath is a terminal rename', () => {
      const event = resolve(
        fsEvent({ kind: 'rename', unit: null, path: 'm/new.txt', fromPath: 'm/old.txt' }),
      )
      expect(event).toEqual({
        kind: 'rename',
        entryKind: 'file',
        path: 'm/new.txt',
        fromPath: 'm/old.txt',
        actor: 'terminal',
        at: 1000,
      })
    })
  })

  test('a rename with no in-drive source (moved in from outside) becomes a create', () => {
    const event = resolve(fsEvent({ kind: 'rename', unit: SESSION_LEAF, fromPath: undefined }))
    expect(event).toEqual({
      kind: 'create',
      entryKind: 'file',
      path: 'notes.md',
      actor: `session:${SESSION_ID}`,
      at: 1000,
    })
  })
})

describe('identity ownership', () => {
  test('a session event carries only session:<id>; user resolution is server-side', () => {
    const resolve = createActorResolver().resolve
    const event = resolve(fsEvent({ kind: 'write', unit: SESSION_LEAF }))
    expect(event).toEqual({
      kind: 'write',
      path: 'notes.md',
      actor: `session:${SESSION_ID}`,
      at: 1000,
    })
  })
})

describe('gateway-pid defensive drop (belt-and-suspenders to the in-helper L9 drop)', () => {
  test('a gateway-pid event is dropped even if the helper let it through', () => {
    const resolve = createActorResolver({ gatewayPid: 999 }).resolve
    expect(resolve(fsEvent({ pid: 999, kind: 'write', unit: SESSION_LEAF }))).toBeNull()
    expect(resolve(fsEvent({ pid: 999, kind: 'delete', unit: null }))).toBeNull()
  })

  test('a non-gateway pid is unaffected', () => {
    const resolve = createActorResolver({ gatewayPid: 999 }).resolve
    expect(resolve(fsEvent({ pid: 1000, kind: 'write', unit: null }))?.actor).toBe('terminal')
  })
})

describe('sync attribution is NOT the resolver — no path-prefix, no double count', () => {
  // Firewall (semantic events win): a session editing a file that happens to sit
  // inside a Syncthing share folder is still the SESSION's edit. The resolver has
  // no notion of mount paths, so it can never re-label a local write as sync — the
  // remote sync copy is attributed once, by slice 18, from a Syncthing event.
  test('a session write under a would-be share path resolves session, not sync', () => {
    const resolve = createActorResolver().resolve
    const event = resolve(fsEvent({ kind: 'write', unit: SESSION_LEAF, path: 'shared/report.md' }))
    expect(event?.actor).toBe(`session:${SESSION_ID}`)
  })

  test('a terminal write under a would-be share path resolves terminal, not sync', () => {
    const resolve = createActorResolver().resolve
    const event = resolve(fsEvent({ kind: 'write', unit: null, path: 'shared/report.md' }))
    expect(event?.actor).toBe('terminal')
  })
})
