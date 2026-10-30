import { describe, expect, test } from 'bun:test'

import {
  FILE_ACTIVITY_LIMITS,
  READ_BUCKET_MS,
  type DriveFileEvent,
  type FileEventBatch,
} from '@repo/contract'

import {
  FILE_EVENT_RETRY_BACKOFF_CAP_MS,
  createFileEventPipeline,
  fileEventRetryBackoffMs,
} from './pipeline'
import { cleanUpTestTimeouts } from '../testing/timeouts.test-helper'

interface Harness {
  pipeline: ReturnType<typeof createFileEventPipeline>
  requests: Array<{ url: string; headers: Record<string, string>; batch: FileEventBatch }>
  advance(ms: number): void
  failNext(count: number): void
  respondNext(status: number): void
  limitEvents: unknown[]
}

function createHarness(
  overrides: {
    flushMs?: number
    maxEntries?: number
    apiUrl?: string
    vmToken?: string | null
    maxQueuedEvents?: number
  } = {},
): Harness {
  let currentTime = 1_000_000
  let failures = 0
  const responseStatuses: number[] = []
  const requests: Harness['requests'] = []
  const limitEvents: unknown[] = []
  const pipeline = createFileEventPipeline({
    apiUrl: 'apiUrl' in overrides ? overrides.apiUrl : 'http://api',
    getVmToken: async () => ('vmToken' in overrides ? (overrides.vmToken ?? null) : 'vm-token'),
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        headers: (init?.headers as Record<string, string>) ?? {},
        batch: JSON.parse(String(init?.body)) as FileEventBatch,
      })
      if (failures > 0) {
        failures -= 1
        return new Response('nope', { status: 503 })
      }
      const status = responseStatuses.shift()
      if (status !== undefined) return new Response('configured', { status })
      return Response.json({ ok: true })
    },
    now: () => currentTime,
    flushMs: overrides.flushMs ?? 10,
    maxEntries: overrides.maxEntries ?? 100,
    maxQueuedEvents: overrides.maxQueuedEvents,
    onQueueLimit: event => limitEvents.push(event),
  })
  return {
    pipeline,
    requests,
    limitEvents,
    advance: ms => {
      currentTime += ms
    },
    failNext: count => {
      failures = count
    },
    respondNext: status => {
      responseStatuses.push(status)
    },
  }
}

function write(path: string, actor = 'web:user1', at = 1_000_000): DriveFileEvent {
  return { kind: 'write', path, actor, at }
}

function read(path: string, actor = 'web:user1', at = 1_000_000): DriveFileEvent {
  return { kind: 'read', path, actor, at }
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('file-event pipeline', () => {
  cleanUpTestTimeouts()
  test('flushes on the timer cadence to the vm file-events endpoint', async () => {
    const harness = createHarness({ flushMs: 10 })
    harness.pipeline.emit(write('docs/a.txt'))
    expect(harness.requests).toHaveLength(0)

    await until(() => harness.requests.length === 1)
    const request = harness.requests[0]!
    expect(request.url).toBe('http://api/v1/vm/file-events')
    expect(request.headers.authorization).toBe('Bearer vm-token')
    expect(request.batch.events).toEqual([write('docs/a.txt')])
    expect(request.batch.droppedReads).toBe(0)
    expect(request.batch.overflow).toBe(0)
  })

  test('flushes immediately when the buffer reaches maxEntries', async () => {
    const harness = createHarness({ flushMs: 60_000, maxEntries: 3 })
    harness.pipeline.emit(write('a'))
    harness.pipeline.emit(write('b'))
    expect(harness.requests).toHaveLength(0)
    harness.pipeline.emit(write('c'))

    await until(() => harness.requests.length === 1)
    expect(
      harness.requests[0]!.batch.events.map(event => (event.kind === 'write' ? event.path : '?')),
    ).toEqual(['a', 'b', 'c'])
  })

  test('coalesces reads per (path, actor, bucket) within the buffer', async () => {
    const harness = createHarness()
    const bucketAt = READ_BUCKET_MS * 10
    harness.pipeline.emit(read('docs/a.txt', 'web:user1', bucketAt))
    harness.pipeline.emit(read('docs/a.txt', 'web:user1', bucketAt + 1))
    harness.pipeline.emit(read('docs/a.txt', 'web:user1', bucketAt + 2))
    harness.pipeline.emit(read('docs/a.txt', 'api-key:key1', bucketAt))
    harness.pipeline.emit(read('docs/b.txt', 'web:user1', bucketAt))
    harness.pipeline.emit(read('docs/a.txt', 'web:user1', bucketAt + READ_BUCKET_MS))
    await harness.pipeline.flush()

    expect(harness.requests).toHaveLength(1)
    expect(
      harness.requests[0]!.batch.events.map(event =>
        event.kind === 'read' ? `${event.path}|${event.actor}|${event.at}` : 'unexpected',
      ),
    ).toEqual([
      `docs/a.txt|web:user1|${bucketAt}`,
      `docs/a.txt|api-key:key1|${bucketAt}`,
      `docs/b.txt|web:user1|${bucketAt}`,
      `docs/a.txt|web:user1|${bucketAt + READ_BUCKET_MS}`,
    ])
    // Coalescing is bucket semantics, not loss.
    expect(harness.pipeline.stats().droppedReads).toBe(0)
  })

  test('folds noisy descendants by actor, root, and changed/viewed category', async () => {
    const harness = createHarness()
    harness.pipeline.emit(write('node_modules/a/index.js', 'web:user1', 10))
    harness.pipeline.emit({
      kind: 'create',
      entryKind: 'folder',
      path: 'node_modules/b',
      actor: 'web:user1',
      at: 20,
    })
    harness.pipeline.emit(read('node_modules/a/index.js', 'web:user1', 30))
    harness.pipeline.emit(write('node_modules/c/index.js', 'session:agent1', 40))
    harness.pipeline.emit(write('apps/site/node_modules/a.js', 'web:user1', 50))
    await harness.pipeline.flush()

    expect(harness.requests[0]!.batch.events).toEqual([
      { kind: 'changed-summary', path: 'node_modules', actor: 'web:user1', at: 20, count: 2 },
      { kind: 'viewed-summary', path: 'node_modules', actor: 'web:user1', at: 30, count: 1 },
      { kind: 'changed-summary', path: 'node_modules', actor: 'session:agent1', at: 40, count: 1 },
      {
        kind: 'changed-summary',
        path: 'apps/site/node_modules',
        actor: 'web:user1',
        at: 50,
        count: 1,
      },
    ])
  })

  test('git writes fold into a counted summary while reads stay a separate viewed group', async () => {
    const harness = createHarness()
    for (let index = 0; index < 2; index += 1) {
      harness.pipeline.emit(write(`.git/objects/${index}`, 'session:agent1', index))
    }
    harness.pipeline.emit(read('.git/HEAD', 'session:agent1', 500))
    await harness.pipeline.flush()

    expect(harness.requests[0]!.batch.events).toEqual([
      { kind: 'changed-summary', path: '.git', actor: 'session:agent1', at: 1, count: 2 },
      { kind: 'viewed-summary', path: '.git', actor: 'session:agent1', at: 500, count: 1 },
    ])
    expect(harness.pipeline.stats().rawEventsObserved).toBe(3)
  })

  test('folds only same-root renames and preserves precise boundary transitions', async () => {
    const harness = createHarness()
    const rename = (fromPath: string, path: string, at: number): DriveFileEvent => ({
      kind: 'rename',
      entryKind: 'file',
      fromPath,
      path,
      actor: 'web:user1',
      at,
    })
    harness.pipeline.emit(rename('node_modules/a', 'node_modules/b', 1))
    harness.pipeline.emit(rename('src/a', 'node_modules/a', 2))
    harness.pipeline.emit(rename('node_modules/b', 'src/b', 3))
    harness.pipeline.emit(rename('node_modules/c', 'apps/site/node_modules/c', 4))
    await harness.pipeline.flush()

    expect(harness.requests[0]!.batch.events).toEqual([
      { kind: 'changed-summary', path: 'node_modules', actor: 'web:user1', at: 1, count: 1 },
      rename('src/a', 'node_modules/a', 2),
      rename('node_modules/b', 'src/b', 3),
      rename('node_modules/c', 'apps/site/node_modules/c', 4),
    ])
  })

  test('preserves first-occurrence order while summaries take the newest timestamp', async () => {
    const harness = createHarness()
    harness.pipeline.emit(write('before', 'web:user1', 1))
    harness.pipeline.emit(write('.git/objects/a', 'web:user1', 2))
    harness.pipeline.emit(write('middle', 'web:user1', 3))
    harness.pipeline.emit(write('.git/objects/b', 'web:user1', 9))
    harness.pipeline.emit({
      kind: 'delete',
      entryKind: 'file',
      path: 'after',
      actor: 'web:user1',
      at: 10,
    })
    await harness.pipeline.flush()

    expect(harness.requests[0]!.batch.events).toEqual([
      write('before', 'web:user1', 1),
      { kind: 'changed-summary', path: '.git', actor: 'web:user1', at: 9, count: 2 },
      write('middle', 'web:user1', 3),
      { kind: 'delete', entryKind: 'file', path: 'after', actor: 'web:user1', at: 10 },
    ])
  })

  test('raw taps observe duplicate noisy reads before persistence coalescing and folding', async () => {
    const harness = createHarness()
    const tapped: DriveFileEvent[] = []
    harness.pipeline.onEvent(event => tapped.push(structuredClone(event)))
    const at = READ_BUCKET_MS * 2
    harness.pipeline.emit(read('node_modules/a.js', 'web:user1', at))
    harness.pipeline.emit(read('node_modules/a.js', 'web:user1', at + 1))
    await harness.pipeline.flush()

    expect(tapped).toEqual([
      read('node_modules/a.js', 'web:user1', at),
      read('node_modules/a.js', 'web:user1', at + 1),
    ])
    expect(harness.requests[0]!.batch.events).toEqual([
      {
        kind: 'viewed-summary',
        path: 'node_modules',
        actor: 'web:user1',
        at: at + 1,
        count: 2,
      },
    ])
  })

  test('the total path-segment budget creates an ordered batch boundary', async () => {
    const harness = createHarness({ flushMs: 60_000, maxEntries: 500 })
    const segmentsPerPath = FILE_ACTIVITY_LIMITS.maxPathSegments
    const eventsPerBudget = Math.floor(FILE_ACTIVITY_LIMITS.maxBatchPathSegments / segmentsPerPath)
    const deepPath = (index: number) =>
      `${Array.from({ length: segmentsPerPath - 1 }, (_, segment) => `s${segment}`).join('/')}/f${index}`
    for (let index = 0; index <= eventsPerBudget; index += 1) {
      harness.pipeline.emit(write(deepPath(index), 'web:user1', index))
    }

    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(2)
    expect(harness.requests[0]!.batch.events).toEqual(
      Array.from({ length: eventsPerBudget }, (_, index) =>
        write(deepPath(index), 'web:user1', index),
      ),
    )
    expect(harness.requests[1]!.batch.events).toEqual([
      write(deepPath(eventsPerBudget), 'web:user1', eventsPerBudget),
    ])
  })

  test('buffer pressure evicts oldest reads before writes', async () => {
    const harness = createHarness({ flushMs: 60_000, maxEntries: 3 })
    harness.failNext(1)
    // Fills the buffer and triggers the size flush, which fails and leaves
    // the batch pending in backoff.
    harness.pipeline.emit(read('r1'))
    harness.pipeline.emit(write('w1'))
    harness.pipeline.emit(write('w2'))
    await until(() => harness.requests.length === 1)

    // The next buffer fills under a stalled relay.
    harness.pipeline.emit(read('r2', 'web:user1', 1_000_001))
    harness.pipeline.emit(write('w3'))
    harness.pipeline.emit(write('w4'))
    // At capacity: the write evicts the oldest read.
    harness.pipeline.emit(write('w5'))
    // At capacity with no reads left: the incoming read is dropped.
    harness.pipeline.emit(read('r3'))
    // Writes are admitted even beyond the cap.
    harness.pipeline.emit(write('w6'))

    expect(harness.pipeline.stats().droppedReads).toBe(2)
    expect(harness.pipeline.stats().overflow).toBe(3)

    harness.advance(FILE_EVENT_RETRY_BACKOFF_CAP_MS)
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(3)
    const delivered = harness.requests.slice(1).flatMap(request => request.batch.events)
    expect(delivered.flatMap(event => (event.kind === 'write' ? [event.path] : []))).toEqual([
      'w1',
      'w2',
      'w3',
      'w4',
      'w5',
      'w6',
    ])
    // The second batch carries the loss that accumulated while stalled.
    expect(harness.requests[2]!.batch.droppedReads).toBe(2)
    expect(harness.requests[2]!.batch.overflow).toBe(3)
  })

  test('batchId is stable across a failed-then-retried flush', async () => {
    const harness = createHarness()
    harness.failNext(1)
    harness.pipeline.emit(write('docs/a.txt'))
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(1)

    harness.advance(FILE_EVENT_RETRY_BACKOFF_CAP_MS)
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(2)
    expect(harness.requests[1]!.batch.batchId).toBe(harness.requests[0]!.batch.batchId)
    expect(harness.requests[1]!.batch.events).toEqual(harness.requests[0]!.batch.events)

    // Delivered: nothing left to relay.
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(2)
  })

  test('a permanent 4xx drops only its poison batch and advances the queue', async () => {
    const harness = createHarness({ flushMs: 60_000 })
    harness.respondNext(400)
    harness.pipeline.emit(write('poison'))
    await harness.pipeline.flush()

    harness.pipeline.emit(write('healthy'))
    await harness.pipeline.flush()

    expect(harness.requests.map(request => request.batch.events)).toEqual([
      [write('poison')],
      [write('healthy')],
    ])
    expect(harness.requests[1]!.batch.overflow).toBe(1)
    expect(harness.pipeline.stats().overflow).toBe(1)
  })

  test('a retry outage keeps only the configured number of queued events', async () => {
    const harness = createHarness({ flushMs: 60_000, maxEntries: 1, maxQueuedEvents: 2 })
    harness.failNext(1)
    harness.pipeline.emit(write('pending'))
    await until(() => harness.requests.length === 1)

    harness.pipeline.emit(write('queued'))
    await harness.pipeline.flush()
    harness.pipeline.emit(write('overflow'))
    harness.advance(FILE_EVENT_RETRY_BACKOFF_CAP_MS)
    await harness.pipeline.flush()

    expect(harness.requests.map(request => request.batch.events)).toEqual([
      [write('pending')],
      [write('pending')],
      [write('queued')],
    ])
    expect(harness.pipeline.stats().overflow).toBe(1)
    expect(harness.limitEvents).toEqual([
      { action: 'events_dropped', droppedEvents: 1, maxQueuedEvents: 2 },
    ])
  })

  test('a capacity boundary seals summary counts while the pending batch retries unchanged', async () => {
    const harness = createHarness({ flushMs: 60_000, maxEntries: 2 })
    harness.failNext(1)
    harness.pipeline.emit(write('.git/objects/a', 'web:user1', 1))
    harness.pipeline.emit(write('ordinary-a', 'web:user1', 2))
    await until(() => harness.requests.length === 1)

    harness.pipeline.emit(write('.git/objects/b', 'web:user1', 3))
    harness.pipeline.emit(write('.git/objects/c', 'web:user1', 4))
    harness.pipeline.emit(write('ordinary-b', 'web:user1', 5))
    harness.advance(FILE_EVENT_RETRY_BACKOFF_CAP_MS)
    await harness.pipeline.flush()

    expect(harness.requests).toHaveLength(3)
    expect(harness.requests[1]!.batch).toEqual(harness.requests[0]!.batch)
    expect(harness.requests[2]!.batch.events).toEqual([
      { kind: 'changed-summary', path: '.git', actor: 'web:user1', at: 4, count: 2 },
      write('ordinary-b', 'web:user1', 5),
    ])
  })

  test('retries are gated by bounded backoff', async () => {
    const harness = createHarness()
    harness.failNext(10)
    harness.pipeline.emit(write('docs/a.txt'))
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(1)

    // Within the backoff window nothing is attempted.
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(1)

    harness.advance(fileEventRetryBackoffMs(1))
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(2)

    // The backoff delay grows but is capped.
    expect(fileEventRetryBackoffMs(2)).toBeGreaterThan(fileEventRetryBackoffMs(1))
    expect(fileEventRetryBackoffMs(50)).toBe(FILE_EVENT_RETRY_BACKOFF_CAP_MS)
  })

  test('a missing vm token defers the batch instead of losing it', async () => {
    const harness = createHarness({ vmToken: null })
    harness.pipeline.emit(write('docs/a.txt'))
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(0)
    expect(harness.pipeline.stats()).toEqual({
      rawEventsObserved: 1,
      droppedReads: 0,
      overflow: 0,
      mirrorReadsSkipped: 0,
      cgroupMisses: 0,
      helperRestarts: 0,
    })
  })

  test('suppress() silences emission during restore-style windows', async () => {
    const harness = createHarness()
    harness.pipeline.suppress(true)
    harness.pipeline.emit(write('storm/a'))
    harness.pipeline.emit(read('storm/b'))
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(0)
    // Suppression is policy, never loss.
    expect(harness.pipeline.stats()).toEqual({
      rawEventsObserved: 0,
      droppedReads: 0,
      overflow: 0,
      mirrorReadsSkipped: 0,
      cgroupMisses: 0,
      helperRestarts: 0,
    })

    harness.pipeline.suppress(false)
    harness.pipeline.emit(write('after/a'))
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(1)
  })

  test('unattributed reads are dropped and counted; unattributed writes relay as system', async () => {
    const harness = createHarness()
    harness.pipeline.emit(read('docs/a.txt', ''))
    harness.pipeline.emit(read('docs/a.txt', 'not-an-actor!!'))
    harness.pipeline.emit(write('docs/a.txt', ''))
    harness.pipeline.emit({
      kind: 'delete',
      entryKind: 'file',
      path: 'docs/b.txt',
      actor: 'garbage:',
      at: 1_000_000,
    })
    await harness.pipeline.flush()

    expect(harness.pipeline.stats().droppedReads).toBe(2)
    const batch = harness.requests[0]!.batch
    expect(batch.droppedReads).toBe(2)
    expect(batch.events.map(event => `${event.kind}:${event.actor}`)).toEqual([
      'write:system',
      'delete:system',
    ])
  })

  test('mergeHelperStats folds watcher loss into the one telemetry surface (L12)', async () => {
    const harness = createHarness()
    // Cumulative helper/supervisor counters; only the overflow INCREASE folds in.
    harness.pipeline.mergeHelperStats({ overflow: 4, cgroupMisses: 2, helperRestarts: 1 })
    harness.pipeline.mergeHelperStats({ overflow: 7, cgroupMisses: 3, helperRestarts: 1 })
    expect(harness.pipeline.stats()).toEqual({
      rawEventsObserved: 0,
      droppedReads: 0,
      overflow: 7,
      mirrorReadsSkipped: 0,
      cgroupMisses: 3,
      helperRestarts: 1,
    })

    // A helper restart resets its cumulative overflow to 0 — never subtract.
    harness.pipeline.mergeHelperStats({ overflow: 0, cgroupMisses: 0, helperRestarts: 2 })
    harness.pipeline.mergeHelperStats({ overflow: 2 })
    expect(harness.pipeline.stats().overflow).toBe(9)
    expect(harness.pipeline.stats().helperRestarts).toBe(2)

    // The folded FAN overflow rides the next batch to the API (visible loss).
    harness.pipeline.emit(write('after/a'))
    await harness.pipeline.flush()
    expect(harness.requests.at(-1)!.batch.overflow).toBe(9)
  })

  test('mirror reads are policy-skipped (never loss); mirror writes relay untouched', async () => {
    const harness = createHarness()
    harness.pipeline.emit(read('docs/a.txt', 'mirror:device1'))
    harness.pipeline.emit(read('docs/a.txt', 'mirror:device1'))
    harness.pipeline.emit(write('docs/a.txt', 'mirror:device1'))
    await harness.pipeline.flush()

    expect(harness.pipeline.stats()).toEqual({
      rawEventsObserved: 1,
      droppedReads: 0,
      overflow: 0,
      mirrorReadsSkipped: 2,
      cgroupMisses: 0,
      helperRestarts: 0,
    })
    const batch = harness.requests[0]!.batch
    expect(batch.droppedReads).toBe(0)
    expect(batch.events).toEqual([write('docs/a.txt', 'mirror:device1')])
  })

  test('onEvent taps admitted events post-normalization; skipped events never fire it', async () => {
    const harness = createHarness()
    const tapped: DriveFileEvent[] = []
    const unsubscribe = harness.pipeline.onEvent(event => tapped.push(event))
    harness.pipeline.onEvent(() => {
      throw new Error('broken tap') // must never affect the pipeline
    })

    harness.pipeline.emit(write('a', '')) // unattributed write → normalized to system
    harness.pipeline.emit(read('r', '')) // unattributed read → dropped, no tap
    harness.pipeline.emit(read('m', 'mirror:dev1')) // mirror read → policy skip, no tap
    harness.pipeline.emit(read('b'))
    harness.pipeline.emit(read('b')) // persistence coalesces it; raw tap still observes it
    harness.pipeline.suppress(true)
    harness.pipeline.emit(write('suppressed')) // restore window, no tap
    harness.pipeline.suppress(false)

    expect(
      tapped.map(event => `${event.kind}:${'path' in event ? event.path : ''}:${event.actor}`),
    ).toEqual(['write:a:system', 'read:b:web:user1', 'read:b:web:user1'])

    unsubscribe()
    harness.pipeline.emit(write('after-unsubscribe'))
    expect(tapped).toHaveLength(3)

    // The broken tap never lost an event.
    await harness.pipeline.flush()
    expect(harness.requests[0]!.batch.events.map(event => event.kind)).toEqual([
      'write',
      'read',
      'write',
    ])
  })

  test('without an apiUrl the pipeline discards instead of growing', async () => {
    const harness = createHarness({ apiUrl: undefined })
    harness.pipeline.emit(write('docs/a.txt'))
    await harness.pipeline.flush()
    await harness.pipeline.flush()
    expect(harness.requests).toHaveLength(0)
  })
})
