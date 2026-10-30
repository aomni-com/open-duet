import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import { FILE_EVENT_RETENTION_MS, READ_BUCKET_MS } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  issueKey,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-api-internal-key'

// A fixed epoch on a read-bucket boundary keeps bucket fixtures exact.
const BUCKET = READ_BUCKET_MS * 10_000
const T0 = BUCKET + 1_000
// Retention sweeps every workspace at once, so a prune fixture must expire only
// its OWN rows. Seeding them well before T0 keeps every other test's events
// newer than the prune's cutoff and out of the sweep.
const ANCIENT = T0 - 50 * 24 * 60 * 60 * 1000

let convex: ConvexDevFixture
let owner: SignedInUser
let outsider: SignedInUser
let sequence = 0

describe('file activity', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('file-activity-owner'),
      'File Activity Owner',
    )
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    outsider = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('file-activity-outsider'),
      'File Activity Outsider',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('read markers dedupe within a bucket and split across buckets', async () => {
    const ws = await createWorkspace('fa-read-buckets')
    const read = (at: number) => ({
      kind: 'read',
      path: 'notes/plan.md',
      actor: 'session:ses1',
      at,
    })

    expect((await record(ws.id, [read(T0)])).appended).toBe(1)
    expect((await record(ws.id, [read(T0 + 1_000)])).appended).toBe(0)
    expect((await record(ws.id, [read(T0 + READ_BUCKET_MS)])).appended).toBe(1)

    const history = await fileHistory(ws.slug, 'notes/plan.md')
    expect(history.events.map(row => row.event.kind)).toEqual(['read', 'read'])
    expect(history.events.map(row => row.seq)).toEqual([3, 1])

    // The rollup counts every read, including deduped ones.
    const seen = await seenBy(ws.slug, 'notes/plan.md')
    expect(seen.seenBy).toEqual([
      expect.objectContaining({ actor: 'session:ses1', readCount: 3, writeCount: 0 }),
    ])
  })

  // Landmine L-A. The read-marker lookup keys on
  // (workspace, entity, actor, bucketStart) and treats ANY hit as "a marker
  // already exists". Once folding makes change rows carry a bucket too, an
  // un-discriminated index lets a change row answer that lookup — and read
  // markers stop being written, silently, in an audit log.
  test('a change row bearing a bucket never satisfies the read-marker lookup', async () => {
    const ws = await createWorkspace('fa-bucket-kinds')
    const path = 'notes/shared.md'
    const actor = 'session:ses1'

    expect((await record(ws.id, [{ kind: 'write', path, actor, at: T0 }])).appended).toBe(1)
    const written = (await rawFileEvents(ws.id)).find(row => row.kind === 'write')
    if (written === undefined) throw new Error('write row missing')
    await stampChangeBucket(written._id, BUCKET)

    expect((await record(ws.id, [{ kind: 'read', path, actor, at: T0 + 1 }])).appended).toBe(1)
    expect(
      (await rawFileEvents(ws.id))
        .map(row => row.kind)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(['read', 'write'])
  })

  // The watcher reports one event per write() syscall, so a single large file
  // streaming to disk arrives as hundreds of events for one path within a
  // fraction of a second. On production data 96% of repeated writes to a path
  // are this, not repeated saves — so counting them as edits makes the feed
  // state a falsehood.
  test('a syscall stream is one save, not one row per write', async () => {
    const ws = await createWorkspace('fa-stream')
    const path = 'research/big.json'
    const actor = 'session:ses1'
    const stream = Array.from({ length: 40 }, (unused, index) => ({
      kind: 'write',
      path,
      actor,
      at: T0 + index * 5,
    }))

    expect((await record(ws.id, stream)).appended).toBe(1)
    const rows = (await rawFileEvents(ws.id)).filter(row => row.kind === 'write')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.count).toBeUndefined()

    // The rollup still knows the real magnitude the feed row hides (MAP L-C).
    const seen = await seenBy(ws.slug, path)
    expect(seen.seenBy).toEqual([expect.objectContaining({ actor, writeCount: 40, readCount: 0 })])
  })

  test('writes spread past the coalesce window count as separate saves', async () => {
    const ws = await createWorkspace('fa-saves')
    const path = 'notes/draft.md'
    const actor = 'session:ses1'

    // Three saves, seconds apart — a person or agent editing, not a stream.
    for (const offset of [0, 4_000, 9_000]) {
      await record(ws.id, [{ kind: 'write', path, actor, at: T0 + offset }])
    }

    const rows = (await rawFileEvents(ws.id)).filter(row => row.kind === 'write')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.count).toBe(3)
    // `at` stays at the first save so seq order and timestamp order agree.
    expect(rows[0]?.at).toBe(T0)
  })

  // A build or automation touching a whole directory is the case worth folding:
  // nobody wants 103 rows for one `turbo build`. The threshold counts DISTINCT
  // FILES, not events, so repeated saves can never push ordinary work over it.
  test('a burst of distinct files folds to one folder summary', async () => {
    const ws = await createWorkspace('fa-fold')
    const actor = 'session:ses1'
    const burst = Array.from({ length: 12 }, (unused, index) => ({
      kind: 'write',
      path: `build/out/chunk-${index}.js`,
      actor,
      at: T0 + index,
    }))

    await record(ws.id, burst)

    const rows = await rawFileEvents(ws.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(
      expect.objectContaining({ kind: 'changed-summary', path: 'build/out', count: 12 }),
    )
  })

  // An entity keeps its identity across a rename, so its bucket row can outlive
  // the path it describes. Merging a post-rename save into the pre-rename row
  // would leave the feed naming a location the file no longer has.
  test('a save after a rename starts a new row rather than merging under the old path', async () => {
    const ws = await createWorkspace('fa-rename-split')
    await record(ws.id, [
      { kind: 'write', path: 'old/notes.md', actor: 'terminal', at: T0 },
      {
        kind: 'rename',
        entryKind: 'file',
        fromPath: 'old/notes.md',
        path: 'new/notes.md',
        actor: 'terminal',
        at: T0 + 1,
      },
      { kind: 'write', path: 'new/notes.md', actor: 'terminal', at: T0 + 2 },
    ])

    const paths = (await rawFileEvents(ws.id))
      .filter(row => row.kind === 'write')
      .map(row => row.path)
      .sort((left, right) => (left ?? '').localeCompare(right ?? ''))
    expect(paths).toEqual(['new/notes.md', 'old/notes.md'])
  })

  // `count` on a summary means raw EVENTS when the gateway folded a regenerable
  // tree and distinct FILES when the server folded a directory. Adding files
  // into an events-unit row would leave a number meaning neither, still
  // labelled as the gateway's — so the fold declines and the burst stays
  // per-file. Costing rows is recoverable; corrupting the unit is not.
  test('a burst never adds its file count into a gateway summary', async () => {
    const ws = await createWorkspace('fa-fold-units')
    const actor = 'session:ses1'
    // The gateway folds noisy trees itself and reports the tree root.
    await record(ws.id, [
      { kind: 'changed-summary', path: 'node_modules', count: 487, actor, at: T0 },
    ])
    await record(
      ws.id,
      Array.from({ length: 12 }, (unused, index) => ({
        kind: 'write',
        path: `node_modules/pkg-${index}.js`,
        actor,
        at: T0 + 1_000 + index,
      })),
    )

    const summaries = (await rawFileEvents(ws.id)).filter(row => row.kind === 'changed-summary')
    expect(summaries).toHaveLength(1)
    // Untouched: still the gateway's event count, not 487 + 12.
    expect(summaries[0]?.count).toBe(487)
    // And the burst is recorded rather than dropped on the floor.
    expect((await rawFileEvents(ws.id)).filter(row => row.kind === 'write').length).toBeGreaterThan(
      0,
    )
  })

  // Coalescing compares against the LAST event folded into the row, not the
  // first. Without `lastAt` the comparison falls back to `at` and two saves a
  // second apart either side of the window read as one gap from the start.
  test('the coalesce window measures from the last save, not the first', async () => {
    const ws = await createWorkspace('fa-coalesce-anchor')
    const path = 'notes/creep.md'
    const actor = 'session:ses1'

    // Each step is inside the 1s window of the one before it, but the last is
    // 1.8s from the first — so anchoring on `at` would count a second save.
    for (const offset of [0, 900, 1_800]) {
      await record(ws.id, [{ kind: 'write', path, actor, at: T0 + offset }])
    }

    const rows = (await rawFileEvents(ws.id)).filter(row => row.kind === 'write')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.count).toBeUndefined()
  })

  test('an ordinary multi-file edit stays per-file', async () => {
    const ws = await createWorkspace('fa-no-fold')
    const actor = 'session:ses1'
    const edit = ['header.tsx', 'footer.tsx', 'nav.tsx'].map((name, index) => ({
      kind: 'write',
      path: `spa/files/${name}`,
      actor,
      at: T0 + index * 5_000,
    }))

    await record(ws.id, edit)

    const rows = await rawFileEvents(ws.id)
    expect(rows.map(row => row.path).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual([
      'spa/files/footer.tsx',
      'spa/files/header.tsx',
      'spa/files/nav.tsx',
    ])
  })

  // Folding bounds how many rows a burst makes; retention bounds how long they
  // live. Each event owns roughly one scope row per path segment, so an event
  // deleted without its scopes leaves the subtree feed pointing at nothing.
  test('the prune drops events past retention and takes their scopes with them', async () => {
    const ws = await createWorkspace('fa-prune')
    const now = ANCIENT + FILE_EVENT_RETENTION_MS + 1_000
    await record(ws.id, [
      { kind: 'write', path: 'deep/nested/old.md', actor: 'terminal', at: ANCIENT },
    ])
    await record(ws.id, [
      { kind: 'write', path: 'deep/nested/fresh.md', actor: 'terminal', at: now - 100 },
    ])
    await projectFully(ws.id)

    const before = await rawProjection(ws.id)
    const expired = (await rawFileEvents(ws.id)).find(row => row.path === 'deep/nested/old.md')
    if (expired === undefined) throw new Error('seeded event missing')
    expect(before.scopes.filter(scope => scope.eventId === expired._id).length).toBeGreaterThan(0)

    expect(await prune(now)).toEqual({ pruned: 1, done: true })

    expect((await rawFileEvents(ws.id)).map(row => row.path)).toEqual(['deep/nested/fresh.md'])
    const after = await rawProjection(ws.id)
    expect(after.scopes.filter(scope => scope.eventId === expired._id)).toEqual([])
    expect(after.scopes.length).toBeGreaterThan(0)
  })

  // The batch ledger exists to make a relay retry a no-op, and a retry happens
  // within seconds. Nothing deleted it, so one row per delivery accumulated
  // forever — on an active workspace that outruns the events themselves.
  test('the prune drops delivery records past retention too', async () => {
    const ws = await createWorkspace('fa-prune-batches')
    const now = ANCIENT + FILE_EVENT_RETENTION_MS + 1_000
    // A batch expires on when the SERVER received it, not on the event's own
    // clock — the ledger is about deliveries, not about file history.
    await record(ws.id, [{ kind: 'write', path: 'old/batch.md', actor: 'terminal', at: ANCIENT }], {
      batchId: 'fa-prune-batches-old',
      now: ANCIENT,
    })
    await record(
      ws.id,
      [{ kind: 'write', path: 'new/batch.md', actor: 'terminal', at: now - 100 }],
      {
        batchId: 'fa-prune-batches-new',
        now,
      },
    )
    expect((await rawFileEventBatches(ws.id)).length).toBe(2)

    await prune(now)

    expect((await rawFileEventBatches(ws.id)).map(row => row.batchId)).toEqual([
      'fa-prune-batches-new',
    ])
  })

  test('the prune keeps an event exactly at the retention boundary', async () => {
    const ws = await createWorkspace('fa-prune-edge')
    const now = ANCIENT + FILE_EVENT_RETENTION_MS
    await record(ws.id, [{ kind: 'write', path: 'edge.md', actor: 'terminal', at: ANCIENT }])

    expect(await prune(now)).toEqual({ pruned: 0, done: true })
    expect((await rawFileEvents(ws.id)).map(row => row.path)).toEqual(['edge.md'])

    expect(await prune(now + 1)).toEqual({ pruned: 1, done: true })
    expect(await rawFileEvents(ws.id)).toEqual([])
  })

  test('the prune bounds its own batch and reschedules the remainder', async () => {
    const ws = await createWorkspace('fa-prune-batch')
    const now = ANCIENT + FILE_EVENT_RETENTION_MS + 1_000
    await record(
      ws.id,
      ['a.md', 'b.md', 'c.md'].map(name => ({
        kind: 'write',
        path: name,
        actor: 'terminal',
        at: ANCIENT,
      })),
    )

    // One pass takes only its batch and reports itself unfinished, then
    // reschedules — so the remainder drains without anyone driving it.
    expect(await prune(now, 2)).toEqual({ pruned: 2, done: false })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await rawFileEvents(ws.id)).length === 0) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(await rawFileEvents(ws.id)).toEqual([])
  })

  // The prune leaves holes in the sequence. The projector already advances its
  // cursor past a missing seq rather than stalling on it, so nothing in the
  // prune compensates for the gaps — this pins that it stays true.
  test('projection advances past the sequence gaps a prune leaves behind', async () => {
    const ws = await createWorkspace('fa-prune-projection')
    const now = ANCIENT + FILE_EVENT_RETENTION_MS + 1_000
    await record(ws.id, [
      { kind: 'write', path: 'one.md', actor: 'terminal', at: ANCIENT },
      { kind: 'write', path: 'two.md', actor: 'terminal', at: ANCIENT + 1 },
    ])
    await record(ws.id, [{ kind: 'write', path: 'three.md', actor: 'terminal', at: now - 100 }])
    await projectFully(ws.id)

    expect(await prune(now)).toEqual({ pruned: 2, done: true })
    await projectFully(ws.id)

    const projection = await rawProjection(ws.id)
    expect(projection.state?.completedSeq).toBe(3)
    expect(projection.scopes.every(scope => scope.seq === 3)).toBe(true)
  })

  test('dedupe is uniform for non-mirror actors; a mirror read is a durable no-op', async () => {
    const ws = await createWorkspace('fa-actor-kinds')
    const actors = ['session:s1', 'api-key:k1', 'web:u1', 'sync:sh1', 'terminal', 'system']
    for (const actor of actors) {
      await record(ws.id, [
        { kind: 'read', path: 'shared.md', actor, at: T0 },
        { kind: 'read', path: 'shared.md', actor, at: T0 + 5_000 },
      ])
    }
    const twoMirrorReads = await record(ws.id, [
      { kind: 'read', path: 'shared.md', actor: 'mirror:dev1', at: T0 },
      { kind: 'read', path: 'shared.md', actor: 'mirror:dev1', at: T0 + 5_000 },
    ])
    expect(twoMirrorReads.appended).toBe(0)

    const rows = await rawFileEvents(ws.id)
    for (const actor of actors) {
      expect(rows.filter(row => row.actorContext === actor)).toHaveLength(1)
    }
    // No row and no rollup for the mirror: durable backstop, not just emission.
    expect(rows.filter(row => row.actorContext === 'mirror:dev1')).toHaveLength(0)
    const seen = await seenBy(ws.slug, 'shared.md')
    expect(seen.seenBy.map(entry => entry.actor)).not.toContain('mirror:dev1')
    expect(seen.seenBy.every(entry => entry.readCount === 2)).toBeTrue()

    // Mirror writes append normally.
    const mirrorWrite = await record(ws.id, [
      { kind: 'write', path: 'shared.md', actor: 'mirror:dev1', at: T0 + 10_000 },
    ])
    expect(mirrorWrite.appended).toBe(1)
    const seenAfterWrite = await seenBy(ws.slug, 'shared.md')
    expect(seenAfterWrite.seenBy[0]).toEqual(
      expect.objectContaining({ actor: 'mirror:dev1', readCount: 0, writeCount: 1 }),
    )
  })

  test('one recorded batch creates one projection wakeup', async () => {
    const ws = await createWorkspace('fa-one-wakeup')

    const result = (await convex.mutation(
      'testing/fileActivity:recordBatchWithProjectionDiagnosticsForTest',
      {
        internalKey: INTERNAL_KEY,
        workspaceId: ws.id,
        batch: {
          batchId: uniqueSlug('batch'),
          events: [
            { kind: 'create', entryKind: 'file', path: 'one.md', actor: 'terminal', at: T0 },
            { kind: 'create', entryKind: 'file', path: 'two.md', actor: 'terminal', at: T0 + 1 },
            { kind: 'create', entryKind: 'file', path: 'three.md', actor: 'terminal', at: T0 + 2 },
          ],
          droppedReads: 0,
          overflow: 0,
        },
        now: T0,
      },
    )) as RecordResult & { projectionWakeups: number }

    expect(result.appended).toBe(3)
    expect((await rawFileEvents(ws.id)).map(event => event.path)).toEqual([
      'one.md',
      'two.md',
      'three.md',
    ])
    expect(result.projectionWakeups).toBe(1)
  })

  test('legacy size and mtimeMs ingest fields are rejected', async () => {
    const ws = await createWorkspace('fa-size-mtime')
    await expect(
      record(ws.id, [
        {
          kind: 'create',
          entryKind: 'file',
          path: 'a.bin',
          actor: 'web:u1',
          at: T0,
          size: 12,
          mtimeMs: T0 - 50,
        },
        {
          kind: 'write',
          path: 'a.bin',
          actor: 'web:u1',
          at: T0 + 1,
          size: 34_567,
          mtimeMs: T0,
        },
      ]),
    ).rejects.toThrow()
    expect(await rawFileEvents(ws.id)).toHaveLength(0)
  })

  // Replaces an earlier contract ("writes are never coalesced") that this
  // feature deliberately reverses: it asserted four writes at the SAME instant
  // were four edits, which is the falsehood folding exists to fix.
  test('writes share a bucket row and split across buckets', async () => {
    const ws = await createWorkspace('fa-write-buckets')
    const write = (at: number) => ({ kind: 'write', path: 'log.txt', actor: 'session:s1', at })

    expect((await record(ws.id, [write(T0), write(T0), write(T0)])).appended).toBe(1)
    expect((await record(ws.id, [write(T0)])).appended).toBe(0)
    expect((await record(ws.id, [write(T0 + READ_BUCKET_MS)])).appended).toBe(1)

    const history = await fileHistory(ws.slug, 'log.txt')
    expect(history.events.map(row => row.event.kind)).toEqual(['write', 'write'])
    expect(history.events.map(row => row.seq)).toEqual([5, 1])

    // Four simultaneous writes are one save; the rollup still counts all five.
    const seen = await seenBy(ws.slug, 'log.txt')
    expect(seen.seenBy[0]).toEqual(expect.objectContaining({ writeCount: 5 }))
  })

  test('rename stores both paths', async () => {
    const ws = await createWorkspace('fa-rename')
    await record(ws.id, [
      {
        kind: 'rename',
        entryKind: 'file',
        path: 'new/name.md',
        fromPath: 'old/name.md',
        actor: 'terminal',
        at: T0,
      },
    ])
    const history = await fileHistory(ws.slug, 'new/name.md')
    expect(history.events).toEqual([
      {
        seq: 1,
        event: {
          kind: 'rename',
          entryKind: 'file',
          path: 'new/name.md',
          fromPath: 'old/name.md',
          actor: 'terminal',
          at: T0,
        },
      },
    ])
  })

  test('restore rows carry no path and appear in every file history', async () => {
    const ws = await createWorkspace('fa-restore')
    await record(ws.id, [
      { kind: 'write', path: 'x.txt', actor: 'web:u1', at: T0 },
      { kind: 'restore', actor: 'system', at: T0 + 1_000 },
      { kind: 'write', path: 'y.txt', actor: 'web:u1', at: T0 + 2_000 },
    ])
    const restoreRow = (await rawFileEvents(ws.id)).find(row => row.kind === 'restore')
    expect(restoreRow).toBeDefined()
    expect(restoreRow!.path).toBeUndefined()

    // Selection resolves inside the current restore epoch. The current entry
    // sees the workspace-wide restore; the retired old epoch is unselectable.
    expect((await fileHistory(ws.slug, 'x.txt')).events).toEqual([])
    expect((await fileHistory(ws.slug, 'y.txt')).events.map(row => row.event.kind)).toEqual([
      'write',
      'restore',
    ])
    const feed = await workspaceActivity(ws.slug)
    expect(feed.events.map(row => row.event.kind)).toEqual(['write', 'restore', 'write'])
  })

  test('seenBy resolves web actors from actorContext and leaves unknown sessions unresolved', async () => {
    const ws = await createWorkspace('fa-seen-by')
    await record(ws.id, [
      { kind: 'write', path: 'doc.md', actor: 'web:u1', at: T0 },
      { kind: 'read', path: 'doc.md', actor: 'session:s1', at: T0 + 5_000 },
    ])
    const seen = await seenBy(ws.slug, 'doc.md')
    expect(seen.seenBy).toEqual([
      {
        actor: 'session:s1',
        firstAt: T0 + 5_000,
        lastAt: T0 + 5_000,
        readCount: 1,
        writeCount: 0,
      },
      {
        actor: 'web:u1',
        userId: 'u1',
        firstAt: T0,
        lastAt: T0,
        lastWriteAt: T0,
        readCount: 0,
        writeCount: 1,
      },
    ])
  })

  test('seenBy resolves a session actor to its owning user at read time', async () => {
    const ws = await createWorkspace('fa-session-user')
    const session = (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: ws.id,
      prompt: 'attribute this session',
      now: T0,
    })) as { sessionId: string }
    await record(ws.id, [
      {
        kind: 'write',
        path: 'session-owned.md',
        actor: `session:${session.sessionId}`,
        at: T0,
      },
    ])

    expect(await seenBy(ws.slug, 'session-owned.md')).toEqual({
      seenBy: [
        {
          actor: `session:${session.sessionId}`,
          userId: owner.user._id,
          firstAt: T0,
          lastAt: T0,
          lastWriteAt: T0,
          readCount: 0,
          writeCount: 1,
        },
      ],
    })
  })

  test('file history resolves a session actor to its owning user at read time', async () => {
    const ws = await createWorkspace('fa-history-session-user')
    const session = (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: ws.id,
      prompt: 'attribute this history row',
      now: T0,
    })) as { sessionId: string }
    await record(ws.id, [
      {
        kind: 'write',
        path: 'history-owned.md',
        actor: `session:${session.sessionId}`,
        at: T0,
      },
    ])

    expect((await fileHistory(ws.slug, 'history-owned.md')).events).toEqual([
      {
        seq: 1,
        event: {
          kind: 'write',
          path: 'history-owned.md',
          actor: `session:${session.sessionId}`,
          userId: owner.user._id,
          at: T0,
        },
      },
    ])
  })

  test('latest writers resolves an API-key actor to its owning user at read time', async () => {
    const ws = await createWorkspace('fa-writer-api-key-user')
    const issued = await issueKey(owner.client)
    const keyRows = (await convex.query('testing/apiKeys:rawApiKeysForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ _id: string; prefix: string }>
    const key = keyRows.find(row => row.prefix === issued.prefix)
    if (key === undefined) throw new Error('issued API key fixture was not persisted')
    await record(ws.id, [
      {
        kind: 'write',
        path: 'docs/key-owned.md',
        actor: `api-key:${key._id}`,
        at: T0,
      },
    ])

    expect(
      await query(owner.client, 'domains/fileActivity/queries:latestWritersForDir', {
        workspaceSlug: ws.slug,
        dirPath: 'docs',
        paths: ['key-owned.md'],
      }),
    ).toEqual({
      writers: [
        {
          path: 'key-owned.md',
          actor: `api-key:${key._id}`,
          userId: owner.user._id,
          lastWriteAt: T0,
        },
      ],
    })
  })

  test('redelivering a batch with the same batchId inserts nothing', async () => {
    const ws = await createWorkspace('fa-redelivery')
    const batch = {
      batchId: 'relay-retry-1',
      events: [
        { kind: 'write', path: 'a.md', actor: 'session:s1', at: T0 },
        { kind: 'read', path: 'a.md', actor: 'web:u1', at: T0 + 1 },
      ],
      droppedReads: 2,
      overflow: 1,
    }
    const first = await recordRaw(ws.id, batch)
    expect(first).toEqual({ deduped: false, appended: 2, lastSeq: 2 })
    const second = await recordRaw(ws.id, batch)
    expect(second).toEqual({ deduped: true, appended: 0, lastSeq: 2 })

    expect(await rawFileEvents(ws.id)).toHaveLength(2)
    // The rollup is not double-bumped either.
    const seen = await seenBy(ws.slug, 'a.md')
    expect(seen.seenBy.map(entry => [entry.actor, entry.readCount, entry.writeCount])).toEqual([
      ['web:u1', 1, 0],
      ['session:s1', 0, 1],
    ])
    const batches = await rawFileEventBatches(ws.id)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual(
      expect.objectContaining({ batchId: 'relay-retry-1', droppedReads: 2, overflow: 1 }),
    )
    const namespace = await rawNamespace(ws.id)
    expect(namespace).toMatchObject({ nextSequence: 3 })
  })

  test('summary rows keep counts through canonical history and entity rollups', async () => {
    const ws = await createWorkspace('fa-summary-count')
    await record(ws.id, [
      {
        kind: 'changed-summary',
        path: 'node_modules',
        count: 37,
        actor: 'terminal',
        at: T0,
      },
      {
        kind: 'viewed-summary',
        path: 'node_modules',
        count: 11,
        actor: 'terminal',
        at: T0 + 1,
      },
    ])

    expect((await fileHistory(ws.slug, 'node_modules')).events).toEqual([
      expect.objectContaining({
        seq: 2,
        event: expect.objectContaining({ kind: 'viewed-summary', count: 11 }),
      }),
      expect.objectContaining({
        seq: 1,
        event: expect.objectContaining({ kind: 'changed-summary', count: 37 }),
      }),
    ])
    expect(await seenBy(ws.slug, 'node_modules')).toEqual({
      seenBy: [expect.objectContaining({ actor: 'terminal', readCount: 11, writeCount: 37 })],
    })
  })

  test('rename identity owns exact history, seen-by, and latest writer state', async () => {
    const ws = await createWorkspace('fa-rename-rollup')
    await record(ws.id, [
      { kind: 'write', path: 'old.md', actor: 'web:u1', at: T0 },
      {
        kind: 'rename',
        entryKind: 'file',
        fromPath: 'old.md',
        path: 'new.md',
        actor: 'terminal',
        at: T0 + 1,
      },
      { kind: 'read', path: 'new.md', actor: 'session:s1', at: T0 + 2 },
    ])

    expect((await fileHistory(ws.slug, 'new.md')).events.map(row => row.seq)).toEqual([3, 2, 1])
    expect((await seenBy(ws.slug, 'new.md')).seenBy.map(row => row.actor)).toEqual([
      'session:s1',
      'terminal',
      'web:u1',
    ])
    expect(
      await query(owner.client, 'domains/fileActivity/queries:latestWritersForDir', {
        workspaceSlug: ws.slug,
        dirPath: '',
        paths: ['new.md'],
      }),
    ).toEqual({
      writers: [{ path: 'new.md', actor: 'terminal', lastWriteAt: T0 + 1 }],
    })
  })

  test('path reuse, rename-over, copy, and delete-recreate keep histories isolated', async () => {
    const ws = await createWorkspace('fa-isolated-identities')
    await record(ws.id, [
      { kind: 'write', path: 'source.md', actor: 'terminal', at: T0 },
      { kind: 'write', path: 'destination.md', actor: 'terminal', at: T0 + 1 },
      {
        kind: 'rename',
        entryKind: 'file',
        fromPath: 'source.md',
        path: 'destination.md',
        actor: 'terminal',
        at: T0 + 2,
      },
      { kind: 'create', entryKind: 'file', path: 'copy.md', actor: 'terminal', at: T0 + 3 },
      { kind: 'delete', entryKind: 'file', path: 'copy.md', actor: 'terminal', at: T0 + 4 },
      { kind: 'create', entryKind: 'file', path: 'copy.md', actor: 'terminal', at: T0 + 5 },
      { kind: 'create', entryKind: 'file', path: 'source.md', actor: 'terminal', at: T0 + 6 },
    ])

    expect((await fileHistory(ws.slug, 'destination.md')).events.map(row => row.seq)).toEqual([
      3, 1,
    ])
    expect((await fileHistory(ws.slug, 'copy.md')).events.map(row => row.seq)).toEqual([6])
    expect((await fileHistory(ws.slug, 'source.md')).events.map(row => row.seq)).toEqual([7])
  })

  test('exact newest-first pages remain gap-safe when read markers dedupe', async () => {
    const ws = await createWorkspace('fa-exact-gap-pages')
    await record(ws.id, [
      { kind: 'write', path: 'gap.md', actor: 'terminal', at: T0 },
      { kind: 'read', path: 'gap.md', actor: 'web:u1', at: T0 + 1 },
      { kind: 'read', path: 'gap.md', actor: 'web:u1', at: T0 + 2 },
      // A later bucket on purpose: this test is about read-marker dedupe
      // leaving seq gaps, so the writes must stay two separate rows. Within one
      // bucket they would share a row however far apart they fall.
      { kind: 'write', path: 'gap.md', actor: 'terminal', at: T0 + READ_BUCKET_MS },
    ])

    const first = await fileHistory(ws.slug, 'gap.md', { limit: 2 })
    expect(first.events.map(row => row.seq)).toEqual([4, 2])
    expect(first.nextCursor).toBe('2')
    const second = await fileHistory(ws.slug, 'gap.md', {
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.events.map(row => row.seq)).toEqual([1])
    expect(second.nextCursor).toBeUndefined()
  })

  test('cursor pagination is stable under equal timestamps', async () => {
    const ws = await createWorkspace('fa-pagination')
    await record(
      ws.id,
      ['e1', 'e2', 'e3', 'e4', 'e5'].map(name => ({
        kind: 'write',
        path: `same/${name}.txt`,
        actor: 'session:s1',
        at: T0, // all five share one timestamp; ordering rides seq alone
      })),
    )
    const page1 = await workspaceActivity(ws.slug, { limit: 2, order: 'asc' })
    expect(page1.events.map(row => row.seq)).toEqual([1, 2])
    expect(page1.nextCursor).toBe('2')
    const page2 = await workspaceActivity(ws.slug, {
      limit: 2,
      order: 'asc',
      cursor: page1.nextCursor,
    })
    expect(page2.events.map(row => row.seq)).toEqual([3, 4])
    const page3 = await workspaceActivity(ws.slug, {
      limit: 2,
      order: 'asc',
      cursor: page2.nextCursor,
    })
    expect(page3.events.map(row => row.seq)).toEqual([5])
    expect(page3.nextCursor).toBeUndefined()

    // History and feed cursors are positions in the one workspace sequence —
    // interchangeable by contract (docs-first review, slice 06).
    const history = await fileHistory(ws.slug, 'same/e2.txt', { cursor: page1.nextCursor })
    expect(history.events).toEqual([])
  })

  test('workspace feed can page from newest activity toward older activity', async () => {
    const ws = await createWorkspace('fa-feed-newest')
    await record(ws.id, [
      { kind: 'write', path: 'one.md', actor: 'terminal', at: T0 },
      { kind: 'write', path: 'two.md', actor: 'terminal', at: T0 + 1 },
      { kind: 'write', path: 'three.md', actor: 'terminal', at: T0 + 2 },
    ])

    const first = await workspaceActivity(ws.slug, { limit: 2, order: 'desc' })
    expect(first.events.map(row => row.seq)).toEqual([3, 2])
    expect(first.nextCursor).toBe('2')

    const second = await workspaceActivity(ws.slug, {
      limit: 2,
      order: 'desc',
      cursor: first.nextCursor,
    })
    expect(second.events.map(row => row.seq)).toEqual([1])
    expect(second.nextCursor).toBeUndefined()
  })

  test('pending folder projection never falls back to scanning the workspace log', async () => {
    const ws = await createWorkspace('fa-feed-folder')
    await convex.mutation('testing/fileActivity:recordBatchWithProjectionDiagnosticsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: ws.id,
      pauseProjection: true,
      now: T0,
      batch: {
        batchId: uniqueSlug('batch'),
        droppedReads: 0,
        overflow: 0,
        events: [
          { kind: 'write', path: 'notes/plan.md', actor: 'terminal', at: T0 },
          { kind: 'write', path: 'notes/archive/old.md', actor: 'terminal', at: T0 + 1 },
          { kind: 'write', path: 'notes/😀.md', actor: 'terminal', at: T0 + 2 },
          { kind: 'write', path: 'other.md', actor: 'terminal', at: T0 + 3 },
          {
            kind: 'rename',
            entryKind: 'file',
            path: 'moved.md',
            fromPath: 'notes/draft.md',
            actor: 'terminal',
            at: T0 + 4,
          },
        ],
      },
    })

    expect(
      (
        await workspaceActivity(ws.slug, {
          path: 'notes',
          scope: 'subtree',
          order: 'desc',
        })
      ).events,
    ).toEqual([])

    await projectFully(ws.id)
    const page = await workspaceActivity(ws.slug, {
      path: 'notes',
      scope: 'subtree',
      order: 'desc',
    })
    expect(page.events.map(row => row.seq)).toEqual([3, 2, 1])
  })

  test('pending folder pages remain bounded to indexed restore rows', async () => {
    const ws = await createWorkspace('fa-feed-scoped-pages')
    await record(ws.id, [
      { kind: 'write', path: 'notes/a.md', actor: 'terminal', at: T0 },
      { kind: 'write', path: 'other.md', actor: 'terminal', at: T0 + 1 },
      {
        kind: 'rename',
        entryKind: 'file',
        path: 'archive/old.md',
        fromPath: 'notes/old.md',
        actor: 'terminal',
        at: T0 + 2,
      },
      { kind: 'restore', actor: 'system', at: T0 + 3 },
      { kind: 'write', path: 'notes/b.md', actor: 'terminal', at: T0 + 4 },
      { kind: 'read', path: 'notes/b.md', actor: 'session:s1', at: T0 + 5 },
    ])

    await projectFully(ws.id)
    const first = await workspaceActivity(ws.slug, {
      path: 'notes',
      scope: 'subtree',
      order: 'desc',
      limit: 2,
    })
    expect(first.events.map(row => row.seq)).toEqual([5, 4])
    expect(first.nextCursor).toBeUndefined()

    const withReads = await workspaceActivity(ws.slug, {
      path: 'notes',
      scope: 'subtree',
      order: 'desc',
      includeReads: true,
      limit: 2,
    })
    expect(withReads.events.map(row => row.seq)).toEqual([6, 5])
  })

  test('deep projection chunks hide partial memberships and stay within the operation limit', async () => {
    const ws = await createWorkspace('fa-deep-projection')
    const folders = Array.from({ length: 70 }, (_, index) => `d${index}`)
    await record(ws.id, [
      { kind: 'write', path: `${folders.join('/')}/leaf.md`, actor: 'terminal', at: T0 },
    ])

    const first = (await convex.mutation(
      'testing/fileActivity:resetAndProjectWorkspaceChunkForTest',
      { internalKey: INTERNAL_KEY, workspaceId: ws.id },
    )) as ProjectionRunResult & { physicalMemberships: number; visibleMemberships: number }
    expect(first).toEqual({
      completedSeq: 0,
      projectionOperations: 63,
      pending: true,
      physicalMemberships: 63,
      visibleMemberships: 0,
    })

    await projectFully(ws.id)
    expect(
      (
        await workspaceActivity(ws.slug, {
          path: folders[0],
          scope: 'subtree',
          order: 'desc',
        })
      ).events.map(row => row.seq),
    ).toEqual([1])
  })

  test('folder moves preserve stable subtree history without grafting it to the new parent', async () => {
    const ws = await createWorkspace('fa-folder-move')
    await record(ws.id, [
      { kind: 'write', path: 'old/box/nested/a.md', actor: 'terminal', at: T0 },
      {
        kind: 'rename',
        entryKind: 'folder',
        fromPath: 'old/box',
        path: 'new/box',
        actor: 'terminal',
        at: T0 + 1,
      },
      { kind: 'write', path: 'new/box/nested/a.md', actor: 'terminal', at: T0 + 2 },
    ])
    await projectFully(ws.id)

    const sequences = async (path: string) =>
      (await workspaceActivity(ws.slug, { path, scope: 'subtree', order: 'desc' })).events.map(
        row => row.seq,
      )
    expect(await sequences('new/box')).toEqual([3, 2, 1])
    expect(await sequences('old')).toEqual([2, 1])
    expect(await sequences('new')).toEqual([3, 2])
    expect((await fileHistory(ws.slug, 'new/box/nested/a.md')).events.map(row => row.seq)).toEqual([
      3, 1,
    ])
  })

  test('deduped-read sequence gaps advance projection and restore merges stay bounded', async () => {
    const ws = await createWorkspace('fa-projection-gaps')
    await record(ws.id, [
      { kind: 'write', path: 'notes/a.md', actor: 'terminal', at: T0 },
      { kind: 'read', path: 'notes/a.md', actor: 'web:u1', at: T0 + 1 },
      { kind: 'read', path: 'notes/a.md', actor: 'web:u1', at: T0 + 2 },
      { kind: 'restore', actor: 'system', at: T0 + 3 },
      { kind: 'write', path: 'notes/b.md', actor: 'terminal', at: T0 + 4 },
    ])
    await projectFully(ws.id)
    const page = await workspaceActivity(ws.slug, {
      path: 'notes',
      scope: 'subtree',
      order: 'desc',
    })
    expect(page.events.map(row => row.seq)).toEqual([5, 4])
    const projection = await rawProjection(ws.id)
    expect(projection.state).toMatchObject({ completedSeq: 5 })
    expect(projection.state && 'cursor' in projection.state).toBeFalse()
    expect(new Set(projection.scopes.map(row => `${row.eventId}:${row.scopeEntityId}`)).size).toBe(
      projection.scopes.length,
    )
  })

  test('folder pages have no cursor gaps or duplicates', async () => {
    const ws = await createWorkspace('fa-folder-pages')
    await record(
      ws.id,
      Array.from({ length: 5 }, (_, index) => ({
        kind: 'write',
        path: `notes/${index}.md`,
        actor: 'terminal',
        at: T0 + index,
      })),
    )
    await projectFully(ws.id)
    const first = await workspaceActivity(ws.slug, {
      path: 'notes',
      scope: 'subtree',
      order: 'desc',
      limit: 2,
    })
    const second = await workspaceActivity(ws.slug, {
      path: 'notes',
      scope: 'subtree',
      order: 'desc',
      limit: 2,
      cursor: first.nextCursor,
    })
    const third = await workspaceActivity(ws.slug, {
      path: 'notes',
      scope: 'subtree',
      order: 'desc',
      limit: 2,
      cursor: second.nextCursor,
    })
    expect([first, second, third].flatMap(page => page.events.map(row => row.seq))).toEqual([
      5, 4, 3, 2, 1,
    ])
    expect(third.nextCursor).toBeUndefined()
  })

  test('folder move projection cost is independent of descendants and prior history', async () => {
    const ws = await createWorkspace('fa-folder-move-cost')
    const history = Array.from({ length: 100 }, (_, index) => ({
      kind: 'write',
      path: `old/box/nested/${index}.md`,
      actor: 'terminal',
      at: T0 + index,
    }))
    await record(ws.id, history)
    await projectFully(ws.id)
    await record(ws.id, [
      {
        kind: 'rename',
        entryKind: 'folder',
        fromPath: 'old/box',
        path: 'new/box',
        actor: 'terminal',
        at: T0 + 101,
      },
    ])

    // Rewind to just before the rename, read from what was actually recorded
    // rather than assumed. Hardcoding "the rename is seq 101" pins the ambient
    // numbering of the hundred writes above, so any change to how that history
    // is appended silently retargets the chunk this measures.
    const renameSeq = (await rawFileEvents(ws.id)).at(-1)!.seq
    const renameOnly = (await convex.mutation(
      'testing/fileActivity:resetAndProjectWorkspaceChunkForTest',
      { internalKey: INTERNAL_KEY, workspaceId: ws.id, completedSeq: renameSeq - 1 },
    )) as ProjectionRunResult & { physicalMemberships: number }
    expect(renameOnly).toMatchObject({
      completedSeq: renameSeq,
      projectionOperations: 8,
      pending: false,
    })
  })

  test('projection status exposes contiguous lag and oldest pending age', async () => {
    const ws = await createWorkspace('fa-projection-status')
    await record(ws.id, [{ kind: 'write', path: 'notes/a.md', actor: 'terminal', at: T0 }])
    const pending = (await query(owner.client, 'domains/fileActivity/queries:projectionStatus', {
      workspaceSlug: ws.slug,
    })) as { latestSeq: number; completedSeq: number; lag: number; oldestPendingAgeMs?: number }
    expect(pending.latestSeq).toBe(1)
    expect(pending.lag).toBeGreaterThanOrEqual(0)
    await projectFully(ws.id)
    expect(
      await query(owner.client, 'domains/fileActivity/queries:projectionStatus', {
        workspaceSlug: ws.slug,
      }),
    ).toEqual({ latestSeq: 1, completedSeq: 1, lag: 0 })
  })

  test('history includes reads by default; the feed excludes them by default', async () => {
    const ws = await createWorkspace('fa-include-reads')
    await record(ws.id, [
      { kind: 'write', path: 'mix.md', actor: 'web:u1', at: T0 },
      { kind: 'read', path: 'mix.md', actor: 'session:s1', at: T0 + 1 },
    ])
    expect((await fileHistory(ws.slug, 'mix.md')).events.map(row => row.event.kind)).toEqual([
      'read',
      'write',
    ])
    expect(
      (await fileHistory(ws.slug, 'mix.md', { includeReads: false })).events.map(
        row => row.event.kind,
      ),
    ).toEqual(['write'])
    expect((await workspaceActivity(ws.slug)).events.map(row => row.event.kind)).toEqual(['write'])
    expect(
      (await workspaceActivity(ws.slug, { includeReads: true })).events.map(row => row.event.kind),
    ).toEqual(['read', 'write'])
  })

  test('read-free exact and workspace feeds jump across a long indexed read run', async () => {
    const ws = await createWorkspace('fa-long-read-run')
    await record(ws.id, [{ kind: 'write', path: 'mix.md', actor: 'web:u1', at: T0 }])
    for (let startSeq = 2; startSeq < 35_002; startSeq += 7_000) {
      await convex.mutation('testing/fileActivity:seedIndexedRunForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: ws.id,
        path: 'mix.md',
        startSeq,
        count: 7_000,
        kind: 'read',
      })
      // Pace every chunk, including the last: the next test shares this local
      // deployment and otherwise starts inside Convex's rolling write window.
      await Bun.sleep(1_100)
    }

    expect((await fileHistory(ws.slug, 'mix.md', { includeReads: false })).events).toEqual([
      expect.objectContaining({ seq: 1, event: expect.objectContaining({ kind: 'write' }) }),
    ])
    expect((await workspaceActivity(ws.slug)).events).toEqual([
      expect.objectContaining({ seq: 1, event: expect.objectContaining({ kind: 'write' }) }),
    ])
  }, 120_000)

  test('ascending subtree restore reads stop at the indexed projection boundary', async () => {
    const ws = await createWorkspace('fa-restore-range')
    await record(ws.id, [{ kind: 'write', path: 'folder/file.md', actor: 'web:u1', at: T0 }])
    await projectFully(ws.id)
    for (let startSeq = 2; startSeq < 35_002; startSeq += 7_000) {
      await convex.mutation('testing/fileActivity:seedIndexedRunForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: ws.id,
        path: 'folder',
        startSeq,
        count: 7_000,
        kind: 'restore',
      })
      await Bun.sleep(1_100)
    }

    expect(
      (
        await workspaceActivity(ws.slug, {
          path: 'folder',
          scope: 'subtree',
          order: 'asc',
        })
      ).events,
    ).toEqual([
      expect.objectContaining({ seq: 1, event: expect.objectContaining({ kind: 'write' }) }),
    ])
  }, 120_000)

  test('workspaces are isolated from each other and from non-members', async () => {
    const wsA = await createWorkspace('fa-iso-a')
    const wsB = await createWorkspace('fa-iso-b')
    await record(wsA.id, [{ kind: 'write', path: 'same.md', actor: 'web:u1', at: T0 }])
    await record(wsB.id, [
      { kind: 'write', path: 'same.md', actor: 'web:u2', at: T0 },
      // A second path, so this stays two rows: this test is about per-workspace
      // sequence numbering, not about how writes to one file collapse.
      { kind: 'write', path: 'other.md', actor: 'web:u2', at: T0 + 1 },
    ])

    const historyA = await fileHistory(wsA.slug, 'same.md')
    expect(historyA.events).toHaveLength(1)
    expect(historyA.events[0]!.event.actor).toBe('web:u1')
    // Sequences are per-workspace: both start at 1.
    expect((await rawFileEvents(wsA.id)).map(row => row.seq)).toEqual([1])
    expect((await rawFileEvents(wsB.id)).map(row => row.seq)).toEqual([1, 2])

    // A signed-in non-member cannot read.
    await expect(
      query(outsider.client, 'domains/fileActivity/queries:fileHistory', {
        workspaceSlug: wsA.slug,
        path: 'same.md',
      }),
    ).rejects.toThrow('Requires viewer access')
    // The API server acting for a non-member cannot read either.
    await expect(
      convex.query('domains/fileActivity/queries:fileHistory', {
        workspaceSlug: wsA.slug,
        path: 'same.md',
        internalKey: INTERNAL_KEY,
        actorId: outsider.user._id,
      }),
    ).rejects.toThrow('Requires viewer access')
    // actorId without the internal key is never accepted.
    await expect(
      query(owner.client, 'domains/fileActivity/queries:fileHistory', {
        workspaceSlug: wsA.slug,
        path: 'same.md',
        actorId: owner.user._id,
      }),
    ).rejects.toThrow('actorId requires internalKey')
  })

  test('invalid actors, paths, kinds, and cursors are rejected', async () => {
    const ws = await createWorkspace('fa-invalid')
    // A malformed actor, an escaping path, or a kind that does not exist is
    // still a hard rejection: nothing downstream can make sense of them.
    const rejected = [
      [{ kind: 'write', path: 'ok.md', actor: 'mirror:', at: T0 }],
      [{ kind: 'write', path: 'ok.md', actor: 'martian:m1', at: T0 }],
      [{ kind: 'write', path: '../escape.md', actor: 'web:u1', at: T0 }],
      [{ kind: 'write', path: '/etc/passwd', actor: 'web:u1', at: T0 }],
      [{ kind: 'write', path: '.duet/state', actor: 'web:u1', at: T0 }],
      [{ kind: 'chmod', path: 'ok.md', actor: 'web:u1', at: T0 }],
    ]
    for (const events of rejected) {
      await expect(record(ws.id, events)).rejects.toThrow()
    }
    expect(await rawFileEvents(ws.id)).toHaveLength(0)

    await expect(fileHistory(ws.slug, '../escape.md')).rejects.toThrow('Invalid path')
    await expect(fileHistory(ws.slug, 'ok.md', { cursor: 'nope' })).rejects.toThrow(
      'Invalid cursor',
    )
    await expect(seenBy(ws.slug, '')).rejects.toThrow('Invalid path')

    // A valid path with no history is an empty page, not an error.
    expect(await fileHistory(ws.slug, 'never/recorded.md')).toEqual({ events: [] })
    expect(await seenBy(ws.slug, 'never/recorded.md')).toEqual({ seenBy: [] })
  })

  test('a field belonging to another kind rejects the hard-cutover batch', async () => {
    const ws = await createWorkspace('fa-stray-field')
    await expect(
      record(ws.id, [{ kind: 'restore', path: 'ok.md', actor: 'system', at: T0 }]),
    ).rejects.toThrow()
    expect(await rawFileEvents(ws.id)).toEqual([])
  })

  test('injected now stamps batch bookkeeping; event rows carry their own at', async () => {
    const ws = await createWorkspace('fa-clock')
    const injectedNow = 42_000_000
    await record(ws.id, [{ kind: 'write', path: 'clock.md', actor: 'web:u1', at: T0 }], {
      now: injectedNow,
    })
    const batches = await rawFileEventBatches(ws.id)
    expect(batches[0]!.recordedAt).toBe(injectedNow)
    const rows = await rawFileEvents(ws.id)
    expect(rows[0]!.at).toBe(T0)
  })

  test('seq is monotonic per workspace — a PINNED public-cursor invariant', async () => {
    // The per-workspace seq is the public cursor (REST pagination, the SSE
    // feed, every sync daemon's persisted resume point). Strictly increasing
    // per workspace is contract, not implementation detail.
    const wsA = await createWorkspace('fa-seq-a')
    const wsB = await createWorkspace('fa-seq-b')
    for (let i = 0; i < 3; i += 1) {
      const a = await record(wsA.id, [
        { kind: 'write', path: `f${i}.txt`, actor: 'session:s1', at: T0 + i },
        { kind: 'read', path: `f${i}.txt`, actor: 'web:u1', at: T0 + i },
        // A deduped read (same bucket as above) between appends must not
        // disturb the sequence.
        { kind: 'read', path: `f${i}.txt`, actor: 'web:u1', at: T0 + i + 1 },
      ])
      const b = await record(wsB.id, [
        {
          kind: 'delete',
          entryKind: 'file',
          path: `f${i}.txt`,
          actor: 'terminal',
          at: T0 + i,
        },
      ])
      expect(a.appended).toBe(2)
      expect(b.appended).toBe(1)
    }
    for (const ws of [wsA, wsB]) {
      const seqs = (await rawFileEvents(ws.id)).map(row => row.seq)
      expect(seqs.length).toBeGreaterThan(0)
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
      }
    }
    expect((await rawFileEvents(wsA.id)).map(row => row.seq)).toEqual([1, 2, 4, 5, 7, 8])
    expect((await rawFileEvents(wsB.id)).map(row => row.seq)).toEqual([1, 2, 3])
  })

  test('latestWritersForDir returns the latest writer per entry, bounded', async () => {
    const ws = await createWorkspace('fa-dir-writers')
    await record(ws.id, [
      { kind: 'write', path: 'docs/a.md', actor: 'web:u1', at: T0 },
      { kind: 'write', path: 'docs/a.md', actor: 'session:s1', at: T0 + 5_000 },
      {
        kind: 'create',
        entryKind: 'file',
        path: 'docs/b.md',
        actor: 'web:u1',
        at: T0 + 1_000,
      },
      { kind: 'read', path: 'docs/c.md', actor: 'web:u1', at: T0 },
      { kind: 'write', path: 'root.md', actor: 'terminal', at: T0 },
    ])
    const result = (await query(owner.client, 'domains/fileActivity/queries:latestWritersForDir', {
      workspaceSlug: ws.slug,
      dirPath: 'docs',
      paths: ['a.md', 'b.md', 'c.md', 'missing.md'],
    })) as DirWritersResponse
    expect(result.writers).toEqual([
      { path: 'a.md', actor: 'session:s1', lastWriteAt: T0 + 5_000 },
      { path: 'b.md', actor: 'web:u1', userId: 'u1', lastWriteAt: T0 + 1_000 },
    ])

    // Drive root works; read-only entries surface no writer.
    const root = (await query(owner.client, 'domains/fileActivity/queries:latestWritersForDir', {
      workspaceSlug: ws.slug,
      dirPath: '',
      paths: ['root.md'],
    })) as DirWritersResponse
    expect(root.writers).toEqual([{ path: 'root.md', actor: 'terminal', lastWriteAt: T0 }])

    // The batch is bounded — no unbounded fan-out.
    await expect(
      query(owner.client, 'domains/fileActivity/queries:latestWritersForDir', {
        workspaceSlug: ws.slug,
        dirPath: 'docs',
        paths: Array.from({ length: 501 }, (_, i) => `f${i}.md`),
      }),
    ).rejects.toThrow('Too many paths')
  })

  test('recordBatchFromApi requires the internal key', async () => {
    const ws = await createWorkspace('fa-internal-key')
    await expect(
      convex.mutation('domains/fileActivity/api:recordBatchFromApi', {
        internalKey: 'wrong-internal-key',
        workspaceId: ws.id,
        batch: {
          batchId: 'nope',
          events: [{ kind: 'write', path: 'a.md', actor: 'web:u1', at: T0 }],
          droppedReads: 0,
          overflow: 0,
        },
      }),
    ).rejects.toThrow('Unauthorized API internal key')
    expect(await rawFileEvents(ws.id)).toHaveLength(0)
  })

  test('a selected logical entry retains history across direct rename chains', async () => {
    const ws = await createWorkspace('fa-risk-rename-chain')
    await record(ws.id, [
      { kind: 'write', path: 'a.md', actor: 'terminal', at: T0 },
      {
        kind: 'rename',
        entryKind: 'file',
        fromPath: 'a.md',
        path: 'b.md',
        actor: 'terminal',
        at: T0 + 1,
      },
      {
        kind: 'rename',
        entryKind: 'file',
        fromPath: 'b.md',
        path: 'c.md',
        actor: 'terminal',
        at: T0 + 2,
      },
    ])

    expect((await fileHistory(ws.slug, 'c.md')).events.map(row => row.seq)).toEqual([3, 2, 1])
    const measured = (await convex.query('testing/fileActivity:exactHistoryOperationsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: ws.id,
      path: 'c.md',
      limit: 100,
    })) as { indexedReads: number; response: ConvexHistoryPage }
    expect(measured.indexedReads).toBe(4)
    expect(measured.response.page.map(row => row.seq)).toEqual([3, 2, 1])
  })
})

interface RecordResult {
  deduped: boolean
  appended: number
  lastSeq: number
}

interface HistoryResponse {
  events: Array<{
    seq: number
    event: {
      kind: string
      path?: string
      fromPath?: string
      entryKind?: 'file' | 'folder'
      count?: number
      actor: string
      userId?: string
      at: number
    }
  }>
  nextCursor?: string
}

interface ConvexHistoryPage {
  page: HistoryResponse['events']
  continueCursor: string
  isDone: boolean
}

interface SeenByResponse {
  seenBy: Array<{
    actor: string
    userId?: string
    firstAt: number
    lastAt: number
    lastWriteAt?: number
    readCount: number
    writeCount: number
  }>
}

interface DirWritersResponse {
  writers: Array<{ path: string; actor: string; userId?: string; lastWriteAt: number }>
}

interface RawFileEvent {
  _id: string
  seq: number
  kind: string
  path?: string
  fromPath?: string
  entryKind?: 'file' | 'folder'
  count?: number
  actorContext: string
  bucketStart?: number
  at: number
}

interface RawFileEventBatch {
  batchId: string
  recordedAt: number
  droppedReads: number
  overflow: number
}

interface ProjectionRunResult {
  completedSeq: number
  projectionOperations: number
  pending: boolean
}

interface RawProjection {
  state: { completedSeq: number; cursor?: unknown } | null
  scopes: Array<{ eventId: string; scopeEntityId: string; seq: number }>
}

async function createWorkspace(slugPrefix: string): Promise<{ id: string; slug: string }> {
  const slug = uniqueSlug(slugPrefix)
  const id = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug,
    name: `${slugPrefix} fixture`,
  })) as string
  return { id, slug }
}

async function record(
  workspaceId: string,
  events: unknown[],
  opts: { batchId?: string; now?: number } = {},
): Promise<RecordResult> {
  return await recordRaw(
    workspaceId,
    {
      batchId: opts.batchId ?? uniqueSlug('batch'),
      events,
      droppedReads: 0,
      overflow: 0,
    },
    opts.now,
  )
}

async function recordRaw(workspaceId: string, batch: unknown, now?: number): Promise<RecordResult> {
  return (await convex.mutation('domains/fileActivity/api:recordBatchFromApi', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    batch,
    ...(now === undefined ? {} : { now }),
  })) as RecordResult
}

async function fileHistory(
  workspaceSlug: string,
  path: string,
  opts: { cursor?: string; limit?: number; includeReads?: boolean } = {},
): Promise<HistoryResponse> {
  const page = (await query(owner.client, 'domains/fileActivity/queries:fileHistory', {
    workspaceSlug,
    path,
    ...opts,
  })) as ConvexHistoryPage
  return { events: page.page, ...(page.isDone ? {} : { nextCursor: page.continueCursor }) }
}

async function workspaceActivity(
  workspaceSlug: string,
  opts: {
    cursor?: string
    limit?: number
    includeReads?: boolean
    order?: 'asc' | 'desc'
    path?: string
    scope?: 'exact' | 'subtree'
  } = {},
): Promise<HistoryResponse> {
  const page = (await query(owner.client, 'domains/fileActivity/queries:workspaceActivity', {
    workspaceSlug,
    ...opts,
  })) as ConvexHistoryPage
  return { events: page.page, ...(page.isDone ? {} : { nextCursor: page.continueCursor }) }
}

async function seenBy(workspaceSlug: string, path: string): Promise<SeenByResponse> {
  const page = (await query(owner.client, 'domains/fileActivity/queries:seenBy', {
    workspaceSlug,
    path,
    limit: 100,
  })) as { page: SeenByResponse['seenBy']; continueCursor: string; isDone: boolean }
  return { seenBy: page.page }
}

async function rawFileEvents(workspaceId: string): Promise<RawFileEvent[]> {
  return (await convex.query('testing/fileActivity:rawFileEventsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as RawFileEvent[]
}

async function stampChangeBucket(eventId: string, bucketStart: number): Promise<void> {
  await mutate(owner.client, 'testing/fileActivity:stampChangeBucketForTest', {
    internalKey: INTERNAL_KEY,
    eventId,
    bucketStart,
  })
}

async function rawFileEventBatches(workspaceId: string): Promise<RawFileEventBatch[]> {
  return (await convex.query('testing/fileActivity:rawFileEventBatchesForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as RawFileEventBatch[]
}

async function rawNamespace(workspaceId: string): Promise<Record<string, unknown> | null> {
  return (await convex.query('testing/fileActivity:rawFileActivityNamespaceForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Record<string, unknown> | null
}

async function projectChunk(workspaceId: string): Promise<ProjectionRunResult> {
  return (await convex.mutation('testing/fileActivity:projectWorkspaceChunkForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as ProjectionRunResult
}

async function projectFully(workspaceId: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (!(await projectChunk(workspaceId)).pending) return
  }
  throw new Error('projection did not settle')
}

async function prune(now: number, limit?: number): Promise<{ pruned: number; done: boolean }> {
  return (await mutate(owner.client, 'domains/fileActivity/retention:pruneFileEvents', {
    internalKey: INTERNAL_KEY,
    now,
    ...(limit === undefined ? {} : { limit }),
  })) as { pruned: number; done: boolean }
}

async function rawProjection(workspaceId: string): Promise<RawProjection> {
  return (await convex.query('testing/fileActivity:rawProjectionForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as RawProjection
}

function uniqueSlug(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

interface UserRow {
  _id: string
  email: string
}
