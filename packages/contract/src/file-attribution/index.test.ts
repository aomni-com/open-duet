import { describe, expect, test } from 'bun:test'

import { COLLECTION_PAGE_DEFAULT_LIMIT, COLLECTION_PAGE_MAX_LIMIT } from '../pagination/index'

import {
  actorEmitsReadMarkers,
  DriveFileEventSchema,
  encodeActorContext,
  FILE_ACTIVITY_LIMITS,
  FileEventBatchSchema,
  FileActivityFeedQuerySchema,
  FileHistoryResponseSchema,
  FileHistoryQuerySchema,
  FileSeenByQuerySchema,
  SeenByResponseSchema,
  FileFeedEventSchema,
  parseActorContext,
  READ_BUCKET_MS,
  readBucketStart,
  type FileActorContext,
} from './index'

const ALL_ACTORS: FileActorContext[] = [
  { kind: 'session', sessionId: 'sess_123' },
  { kind: 'api-key', keyId: 'key-abc' },
  { kind: 'web', userId: 'user_9' },
  { kind: 'sync', shareId: 'share_5' },
  { kind: 'mirror', deviceId: 'device_7' },
  { kind: 'terminal' },
  { kind: 'system' },
]

describe('actor-context grammar', () => {
  test('encode/parse round-trips all seven kinds', () => {
    for (const actor of ALL_ACTORS) {
      const encoded = encodeActorContext(actor)
      expect(parseActorContext(encoded), encoded).toEqual(actor)
    }
  })

  test('encoded forms are the documented strings', () => {
    expect(encodeActorContext({ kind: 'session', sessionId: 'a1' })).toBe('session:a1')
    expect(encodeActorContext({ kind: 'api-key', keyId: 'a1' })).toBe('api-key:a1')
    expect(encodeActorContext({ kind: 'web', userId: 'a1' })).toBe('web:a1')
    expect(encodeActorContext({ kind: 'sync', shareId: 'a1' })).toBe('sync:a1')
    expect(encodeActorContext({ kind: 'mirror', deviceId: 'a1' })).toBe('mirror:a1')
    expect(encodeActorContext({ kind: 'terminal' })).toBe('terminal')
    expect(encodeActorContext({ kind: 'system' })).toBe('system')
  })

  test('hostile inputs parse to null, never throw', () => {
    for (const value of [
      '',
      'session:',
      'mirror:',
      'session:a:b',
      'session:a\nb',
      'session:a b',
      'session',
      'unknown:abc',
      'Session:abc',
      ' session:abc',
      'terminal:x',
      'system:x',
      'web:',
      ':abc',
      'mirror:déjà',
    ]) {
      expect(parseActorContext(value), JSON.stringify(value)).toBeNull()
    }
  })

  test('encode rejects ids that would break the grammar', () => {
    expect(() => encodeActorContext({ kind: 'session', sessionId: 'a:b' })).toThrow()
    expect(() => encodeActorContext({ kind: 'mirror', deviceId: '' })).toThrow()
    expect(() => encodeActorContext({ kind: 'web', userId: 'a\nb' })).toThrow()
  })

  test('read markers are emitted by every kind except mirror', () => {
    for (const actor of ALL_ACTORS) {
      expect(actorEmitsReadMarkers(actor), actor.kind).toBe(actor.kind !== 'mirror')
    }
  })
})

describe('read buckets', () => {
  test('bucket start is stable within a bucket and moves at the boundary', () => {
    const t = 41 * READ_BUCKET_MS + 12_345
    expect(readBucketStart(t)).toBe(41 * READ_BUCKET_MS)
    expect(readBucketStart(t)).toBe(
      readBucketStart(t + (READ_BUCKET_MS - 1 - (t % READ_BUCKET_MS))),
    )
    expect(readBucketStart(41 * READ_BUCKET_MS)).toBe(41 * READ_BUCKET_MS)
    expect(readBucketStart(42 * READ_BUCKET_MS)).toBe(42 * READ_BUCKET_MS)
    expect(readBucketStart(42 * READ_BUCKET_MS - 1)).toBe(41 * READ_BUCKET_MS)
  })
})

describe('drive file event schema', () => {
  const base = { actor: 'session:s1', at: 1_700_000_000_000 }

  test('accepts only the canonical event variants', () => {
    for (const event of [
      { kind: 'write', path: 'src/app.ts', ...base },
      { kind: 'create', entryKind: 'file', path: 'notes.md', ...base },
      { kind: 'delete', entryKind: 'folder', path: 'old', ...base },
      { kind: 'rename', entryKind: 'file', path: 'b.txt', fromPath: 'a.txt', ...base },
      { kind: 'read', path: 'README.md', ...base },
      { kind: 'changed-summary', path: 'node_modules', count: 2_000, ...base },
      { kind: 'viewed-summary', path: '.git', count: 3, ...base },
      { kind: 'restore', ...base },
    ]) {
      const result = DriveFileEventSchema.safeParse(event)
      expect(result.success, JSON.stringify(event)).toBe(true)
    }
  })

  // A save count is derived server-side by coalescing the watcher's syscall
  // stream. The gateway reports events; it does not get to assert how many
  // saves they amount to — the same rule that refuses a caller-supplied
  // userId. So the count rides the read side only.
  test('a save count is readable on a change event but never ingestible', () => {
    const change = { kind: 'write', path: 'src/app.ts', count: 3, ...base }
    expect(DriveFileEventSchema.safeParse(change).success).toBeFalse()
    expect(FileFeedEventSchema.safeParse({ seq: 1, event: change }).success).toBeTrue()
    expect(
      FileFeedEventSchema.safeParse({
        seq: 1,
        event: { kind: 'write', path: 'src/app.ts', ...base },
      }).success,
    ).toBeTrue()
  })

  test('rejects legacy, identity, and wrong-variant fields', () => {
    for (const event of [
      { kind: 'write', path: 'x.txt', size: 3, ...base },
      { kind: 'write', path: 'x.txt', mtimeMs: 5, ...base },
      { kind: 'write', path: 'x.txt', userId: 'spoofed-user', ...base },
      { kind: 'delete', entryKind: 'file', path: 'x.txt', fromPath: 'old.txt', ...base },
      { kind: 'restore', path: 'x.txt', ...base },
    ]) {
      expect(DriveFileEventSchema.safeParse(event).success, JSON.stringify(event)).toBeFalse()
    }
  })

  test('requires entryKind only on structural namespace events', () => {
    for (const event of [
      { kind: 'create', path: 'x.txt', ...base },
      { kind: 'delete', path: 'x.txt', ...base },
      { kind: 'rename', path: 'b', fromPath: 'a', ...base },
      { kind: 'create', entryKind: 'symlink', path: 'x.txt', ...base },
    ]) {
      expect(DriveFileEventSchema.safeParse(event).success, JSON.stringify(event)).toBeFalse()
    }
    expect(
      DriveFileEventSchema.safeParse({ kind: 'write', entryKind: 'file', path: 'x.txt', ...base })
        .success,
    ).toBeFalse()
  })

  test('summary counts are positive safe integers and paths name noisy roots', () => {
    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        DriveFileEventSchema.safeParse({
          kind: 'changed-summary',
          path: 'node_modules',
          count,
          ...base,
        }).success,
        String(count),
      ).toBeFalse()
    }
    for (const path of ['src/app.ts', 'node_modules/pkg/file.ts', '.github']) {
      expect(
        DriveFileEventSchema.safeParse({ kind: 'viewed-summary', path, count: 1, ...base }).success,
        path,
      ).toBeFalse()
    }
  })

  test('path byte and segment ceilings accept the boundary and reject one beyond it', () => {
    const byteBoundary = 'a'.repeat(FILE_ACTIVITY_LIMITS.maxPathBytes)
    const segmentBoundary = Array.from(
      { length: FILE_ACTIVITY_LIMITS.maxPathSegments },
      () => 'a',
    ).join('/')
    expect(
      DriveFileEventSchema.safeParse({ kind: 'write', path: byteBoundary, ...base }).success,
    ).toBeTrue()
    expect(
      DriveFileEventSchema.safeParse({ kind: 'write', path: `${byteBoundary}a`, ...base }).success,
    ).toBeFalse()
    expect(
      DriveFileEventSchema.safeParse({ kind: 'write', path: segmentBoundary, ...base }).success,
    ).toBeTrue()
    expect(
      DriveFileEventSchema.safeParse({ kind: 'write', path: `${segmentBoundary}/a`, ...base })
        .success,
    ).toBeFalse()
  })

  test('rejects invalid actors, absolute paths, traversal, and reserved paths', () => {
    expect(
      DriveFileEventSchema.safeParse({ kind: 'write', path: 'a.txt', actor: 'nope', at: 1 })
        .success,
    ).toBe(false)
    for (const path of ['/etc/passwd', '../up.txt', 'safe/../up.txt', '.duet/vm-token']) {
      const result = DriveFileEventSchema.safeParse({ kind: 'write', path, ...base })
      expect(result.success, path).toBe(false)
    }
    // restore covers every path, so it carries none; other kinds require one
    expect(DriveFileEventSchema.safeParse({ kind: 'write', path: '', ...base }).success).toBe(false)
    expect(DriveFileEventSchema.safeParse({ kind: 'write', ...base }).success).toBe(false)
    expect(
      DriveFileEventSchema.safeParse({ kind: 'restore', path: 'a.txt', ...base }).success,
    ).toBe(false)
    expect(DriveFileEventSchema.safeParse({ kind: 'restore', path: '', ...base }).success).toBe(
      false,
    )
  })

  test('rename requires fromPath; other kinds strip it', () => {
    expect(DriveFileEventSchema.safeParse({ kind: 'rename', path: 'b', ...base }).success).toBe(
      false,
    )
    expect(
      DriveFileEventSchema.safeParse({
        kind: 'delete',
        entryKind: 'file',
        path: 'b',
        fromPath: 'a',
        ...base,
      }).success,
    ).toBeFalse()
  })
})

describe('file event batch schema', () => {
  test('accepts a well-formed batch and rejects a missing batchId', () => {
    const batch = {
      batchId: 'b-1',
      events: [{ kind: 'write', path: 'a.txt', actor: 'terminal', at: 1 }],
      droppedReads: 0,
      overflow: 2,
    }
    expect(FileEventBatchSchema.safeParse(batch).success).toBe(true)
    expect(FileEventBatchSchema.safeParse({ ...batch, batchId: '' }).success).toBe(false)
    expect(FileEventBatchSchema.safeParse({ ...batch, droppedReads: -1 }).success).toBe(false)
  })

  test('pins event-count and aggregate path-segment ceilings', () => {
    const event = { kind: 'write' as const, path: 'a', actor: 'terminal', at: 1 }
    const batch = {
      batchId: 'bounds',
      events: Array.from({ length: FILE_ACTIVITY_LIMITS.maxEventsPerBatch }, () => event),
      droppedReads: 0,
      overflow: 0,
    }
    expect(FileEventBatchSchema.safeParse(batch).success).toBeTrue()
    expect(
      FileEventBatchSchema.safeParse({ ...batch, events: [...batch.events, event] }).success,
    ).toBeFalse()

    const path = (segments: number) => Array.from({ length: segments }, () => 'a').join('/')
    // Leave one segment of room per path, so overflow reaches the aggregate
    // guard rather than the independent per-path guard.
    const segmentsPerEvent = FILE_ACTIVITY_LIMITS.maxPathSegments - 1
    const fullEvents = Math.floor(FILE_ACTIVITY_LIMITS.maxBatchPathSegments / segmentsPerEvent)
    const remainder = FILE_ACTIVITY_LIMITS.maxBatchPathSegments % segmentsPerEvent
    const exactSegments = [
      ...Array.from({ length: fullEvents }, () => ({ ...event, path: path(segmentsPerEvent) })),
      ...(remainder === 0 ? [] : [{ ...event, path: path(remainder) }]),
    ]
    expect(FileEventBatchSchema.safeParse({ ...batch, events: exactSegments }).success).toBeTrue()
    const overflow = FileEventBatchSchema.safeParse({
      ...batch,
      events: [
        ...exactSegments.slice(0, -1),
        { ...event, path: path((remainder || segmentsPerEvent) + 1) },
      ],
    })
    expect(overflow.success).toBeFalse()
    if (!overflow.success) {
      expect(overflow.error.issues.map(issue => issue.message)).toEqual([
        'batch exceeds path-segment limit',
      ])
    }
  })
})

describe('feed event schema', () => {
  test('wraps { seq, event } with a positive seq', () => {
    const event = { kind: 'write', path: 'a.txt', actor: 'terminal', at: 1 }
    expect(FileFeedEventSchema.safeParse({ seq: 1, event }).success).toBe(true)
    expect(FileFeedEventSchema.safeParse({ seq: 0, event }).success).toBe(false)
  })

  test('history and seen-by use the universal page envelope', () => {
    const events = [
      {
        seq: 1,
        event: { kind: 'write' as const, path: 'a.txt', actor: 'terminal', at: 1 },
      },
    ]
    expect(FileHistoryResponseSchema.parse({ items: events, nextCursor: 'opaque' })).toEqual({
      items: events,
      nextCursor: 'opaque',
    })
    expect(
      FileHistoryResponseSchema.safeParse({ events, nextCursor: 'opaque' }).success,
    ).toBeFalse()
    expect(SeenByResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBeTrue()
    expect(SeenByResponseSchema.safeParse({ seenBy: [], nextCursor: null }).success).toBeFalse()
  })
})

describe('file activity feed query', () => {
  test('accepts newest-first exact and subtree scopes, but no orphan scope', () => {
    expect(
      FileActivityFeedQuerySchema.parse({ order: 'desc', path: 'notes', scope: 'subtree' }),
    ).toMatchObject({ order: 'desc', path: 'notes', scope: 'subtree' })
    expect(
      FileActivityFeedQuerySchema.parse({ order: 'desc', path: 'notes/plan.md', scope: 'exact' }),
    ).toMatchObject({ order: 'desc', path: 'notes/plan.md', scope: 'exact' })
    expect(FileActivityFeedQuerySchema.safeParse({ scope: 'subtree' }).success).toBe(false)
  })

  test('uses shared page defaults and ceilings and rejects unknown query keys', () => {
    expect(FileHistoryQuerySchema.parse({ path: 'notes/a.md' }).limit).toBe(COLLECTION_PAGE_DEFAULT_LIMIT)
    expect(FileActivityFeedQuerySchema.parse({}).limit).toBe(COLLECTION_PAGE_DEFAULT_LIMIT)
    expect(FileSeenByQuerySchema.parse({ path: 'notes/a.md' }).limit).toBe(COLLECTION_PAGE_DEFAULT_LIMIT)
    expect(FileActivityFeedQuerySchema.safeParse({ limit: COLLECTION_PAGE_MAX_LIMIT + 1 }).success).toBe(false)
    expect(FileHistoryQuerySchema.safeParse({ path: 'notes/a.md', extra: 'nope' }).success).toBe(
      false,
    )
  })
})
