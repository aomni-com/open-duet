import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConvexHttpClient } from 'convex/browser'
import { Hono } from 'hono'

import {
  API_VERSION,
  FileFeedEventSchema,
  FileHistoryResponseSchema,
  SeenByResponseSchema,
  type FileFeedEvent,
} from '@repo/contract'
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

import { createApiApp } from '../index'
import { type ApiRouteRuntime, type ApiVariables } from '../shared'
import { registerFileActivityRoutes } from './file-activity'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../..', 'packages/backend')
const INTERNAL_KEY = 'test-file-activity-internal-key'

let convex: ConvexDevFixture
let app: ReturnType<typeof createApiApp>
let workspace: { _id: string; slug: string }
let ownerId: string
let readKey: string
let outsiderKey: string

// The SSE knobs shrink for tests (bun has no fake timers for setInterval);
// cadence assertions measure real frames against these injected values.
const STREAM_POLL_MS = 25
const STREAM_KEEPALIVE_MS = 60

// Seeded through the one durable recorder (recordBatch). Read markers for the
// same (path, actor) collapse per bucket, so each seeded read uses a distinct
// actor and lands as its own seq. Expected seqs: 1..7 in order.
const SEED_EVENTS = [
  {
    kind: 'create',
    entryKind: 'file',
    path: 'notes/plan.md',
    actor: 'web:user1',
    at: 1_000,
  },
  {
    kind: 'write',
    path: 'notes/plan.md',
    actor: 'session:ses1',
    at: 2_000,
  },
  { kind: 'read', path: 'notes/plan.md', actor: 'api-key:key1', at: 3_000 },
  { kind: 'write', path: 'other/readme.md', actor: 'session:ses1', at: 4_000 },
  { kind: 'restore', actor: 'system', at: 5_000 },
  {
    kind: 'rename',
    entryKind: 'file',
    path: 'notes/plan.md',
    fromPath: 'notes/draft.md',
    actor: 'terminal',
    at: 6_000,
  },
  { kind: 'read', path: 'notes/plan.md', actor: 'web:user1', at: 7_000 },
] as const

describe('file-activity query surface', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_FAKE_EXE: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fileActivityStream: { pollMs: STREAM_POLL_MS, keepaliveMs: STREAM_KEEPALIVE_MS },
    })
    const owner = await signInWithMagicLink<{ _id: string }>(
      convex,
      uniqueEmail('file-activity'),
      'File Activity Owner',
    )
    ownerId = owner.user._id
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    workspace = (
      (await query(owner.client, 'domains/workspaces/queries:listMine', {})) as Array<{
        workspace: { _id: string; slug: string }
      }>
    )[0]!.workspace
    const now = Date.now()
    await mutate(owner.client, 'testing/workspaces:markWorkspaceOnboardedForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      now,
      duetName: 'File Activity Test',
    })
    readKey = (await issueKey(owner.client)).key
    const outsider = await signInWithMagicLink(
      convex,
      uniqueEmail('activity-outsider'),
      'Activity Outsider',
    )
    outsiderKey = (await issueKey(outsider.client)).key
    await convex.mutation('domains/fileActivity/api:recordBatchFromApi', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      batch: { batchId: 'slice06-seed', events: SEED_EVENTS, droppedReads: 0, overflow: 0 },
    })
    for (let index = 0; index < 20; index += 1) {
      const projection = (await convex.mutation(
        'testing/fileActivity:projectWorkspaceChunkForTest',
        { internalKey: INTERNAL_KEY, workspaceId: workspace._id },
      )) as { pending: boolean }
      if (!projection.pending) break
    }
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('all three routes require auth and the files:read scope', async () => {
    const routes = [
      `/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md`,
      `/v1/ws/${workspace.slug}/file-activity/seen-by?path=notes/plan.md`,
      `/v1/ws/${workspace.slug}/file-activity/feed`,
      `/v1/ws/${workspace.slug}/file-activity/events`,
    ]
    for (const route of routes) {
      expect((await app.request(route)).status).toBe(401)
      const refused = await get(route, outsiderKey)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual({
        error: 'insufficient_scope',
        scope: `ws:${workspace.slug}:files:read`,
      })
    }
  })

  test('history is newest-first for the selected identity, includes reads and restores, and round-trips the contract schema', async () => {
    const response = await get(`/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md`, readKey)
    expect(response.status).toBe(200)
    const body = FileHistoryResponseSchema.parse(await response.json())
    // The rename is a rename-over: its missing source creates the current
    // identity at seq 6 and retires the former plan.md identity. Exact history
    // never mixes the replaced file's earlier rows into the current file.
    expect(body.items.map(row => row.seq)).toEqual([7, 6, 5])
    expect(body.items.map(row => row.event.kind)).toEqual(['read', 'rename', 'restore'])
    expect(body.nextCursor).toBeNull()
    // The restore event covers every path, so it carries none.
    expect(body.items[2]!.event).toEqual({ kind: 'restore', actor: 'system', at: 5_000 })
    expect(body.items[0]!.event).toEqual({
      kind: 'read',
      path: 'notes/plan.md',
      actor: 'web:user1',
      userId: 'user1',
      at: 7_000,
    })
    expect(body.items[1]!.event).toMatchObject({
      kind: 'rename',
      entryKind: 'file',
      path: 'notes/plan.md',
      fromPath: 'notes/draft.md',
    })
  })

  test('history reads=0 omits read markers; feed omits reads by default and reads=1 includes them', async () => {
    const noReads = FileHistoryResponseSchema.parse(
      await (
        await get(`/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md&reads=0`, readKey)
      ).json(),
    )
    expect(noReads.items.map(row => row.seq)).toEqual([6, 5])

    const feed = FileHistoryResponseSchema.parse(
      await (await get(`/v1/ws/${workspace.slug}/file-activity/feed`, readKey)).json(),
    )
    expect(feed.items.map(row => row.seq)).toEqual([1, 2, 4, 5, 6])

    const feedWithReads = FileHistoryResponseSchema.parse(
      await (await get(`/v1/ws/${workspace.slug}/file-activity/feed?reads=1`, readKey)).json(),
    )
    expect(feedWithReads.items.map(row => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  test('real API checkpoint follows rename identity and isolates replacement identities', async () => {
    const checkpointOwner = await signInWithMagicLink<{ _id: string }>(
      convex,
      uniqueEmail('file-activity-checkpoint'),
      'File Activity Checkpoint',
    )
    const checkpointWorkspace = (
      (await query(checkpointOwner.client, 'domains/workspaces/queries:listMine', {})) as Array<{
        workspace: { _id: string; slug: string }
      }>
    )[0]!.workspace
    const checkpointNow = Date.now()
    await mutate(checkpointOwner.client, 'testing/workspaces:markWorkspaceOnboardedForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: checkpointWorkspace._id,
      now: checkpointNow,
      duetName: 'File Activity Checkpoint',
    })
    const checkpointKey = (await issueKey(checkpointOwner.client)).key
    await convex.mutation('domains/fileActivity/api:recordBatchFromApi', {
      internalKey: INTERNAL_KEY,
      workspaceId: checkpointWorkspace._id,
      batch: {
        batchId: 'canonical-recorder-checkpoint',
        events: [
          { kind: 'create', entryKind: 'file', path: 'old.md', actor: 'terminal', at: 10 },
          { kind: 'write', path: 'old.md', actor: 'terminal', at: 20 },
          {
            kind: 'rename',
            entryKind: 'file',
            fromPath: 'old.md',
            path: 'new.md',
            actor: 'terminal',
            at: 30,
          },
          { kind: 'write', path: 'new.md', actor: 'terminal', at: 40 },
          { kind: 'create', entryKind: 'file', path: 'copy.md', actor: 'terminal', at: 50 },
          { kind: 'delete', entryKind: 'file', path: 'copy.md', actor: 'terminal', at: 60 },
          { kind: 'create', entryKind: 'file', path: 'copy.md', actor: 'terminal', at: 70 },
          { kind: 'create', entryKind: 'file', path: 'old.md', actor: 'terminal', at: 80 },
        ],
        droppedReads: 0,
        overflow: 0,
      },
    })

    const response = await get(
      `/v1/ws/${checkpointWorkspace.slug}/file-activity?path=new.md`,
      checkpointKey,
    )
    expect(response.status).toBe(200)
    const body = FileHistoryResponseSchema.parse(await response.json())
    expect(
      body.items.map(row => [row.seq, 'path' in row.event ? row.event.path : undefined]),
      // The create and the write of old.md share a bucket, so they share a row
      // — the create keeps the seq and absorbs the save. The write of new.md
      // does NOT join them: the entity survived the rename but the path did
      // not, and a row states that a path was saved.
    ).toEqual([
      [4, 'new.md'],
      [3, 'new.md'],
      [1, 'old.md'],
    ])
    const copy = FileHistoryResponseSchema.parse(
      await (
        await get(`/v1/ws/${checkpointWorkspace.slug}/file-activity?path=copy.md`, checkpointKey)
      ).json(),
    )
    expect(copy.items.map(row => row.seq)).toEqual([7])
    const reusedOld = FileHistoryResponseSchema.parse(
      await (
        await get(`/v1/ws/${checkpointWorkspace.slug}/file-activity?path=old.md`, checkpointKey)
      ).json(),
    )
    expect(reusedOld.items.map(row => row.seq)).toEqual([8])

    const operations = (await convex.query('testing/fileActivity:exactHistoryOperationsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: checkpointWorkspace._id,
      path: 'new.md',
      limit: 100,
    })) as { indexedReads: number }
    expect(operations.indexedReads).toBe(4)
  }, 30_000)

  test('feed forwards newest-first folder scope', async () => {
    const feed = FileHistoryResponseSchema.parse(
      await (
        await get(
          `/v1/ws/${workspace.slug}/file-activity/feed?order=desc&path=notes&scope=subtree`,
          readKey,
        )
      ).json(),
    )
    // Restore starts a new namespace epoch: the current notes folder receives
    // the post-restore rename plus the workspace-wide restore, never rows from
    // the retired folder identity.
    expect(feed.items.map(row => row.seq)).toEqual([6, 5])
  })

  test('feed can scope newest activity to one selected file', async () => {
    const feed = FileHistoryResponseSchema.parse(
      await (
        await get(
          `/v1/ws/${workspace.slug}/file-activity/feed?order=desc&path=other/readme.md&scope=exact`,
          readKey,
        )
      ).json(),
    )
    // The restore retired this path and exact scope never falls back to the
    // workspace log while the selected identity is absent.
    expect(feed.items).toEqual([])
  })

  test('cursor pagination walks newest-first history and shares the feed cursor grammar', async () => {
    const first = FileHistoryResponseSchema.parse(
      await (
        await get(`/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md&limit=2`, readKey)
      ).json(),
    )
    expect(first.items.map(row => row.seq)).toEqual([7, 6])
    expect(first.nextCursor).not.toBeNull()

    const second = FileHistoryResponseSchema.parse(
      await (
        await get(
          `/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md&limit=2&cursor=${first.nextCursor}`,
          readKey,
        )
      ).json(),
    )
    expect(second.items.map(row => row.seq)).toEqual([5])
    expect(second.nextCursor).toBeNull()

    // One workspace sequence and cursor grammar, with direction owned by the
    // surface: history continues toward older rows while the default feed
    // continues toward newer rows.
    const feedFromHistoryCursor = FileHistoryResponseSchema.parse(
      await (
        await get(
          `/v1/ws/${workspace.slug}/file-activity/feed?cursor=${first.nextCursor}&reads=1`,
          readKey,
        )
      ).json(),
    )
    expect(feedFromHistoryCursor.items.map(row => row.seq)).toEqual([7])

    const feedPage = FileHistoryResponseSchema.parse(
      await (await get(`/v1/ws/${workspace.slug}/file-activity/feed?limit=1`, readKey)).json(),
    )
    expect(feedPage.nextCursor).not.toBeNull()
    const historyFromFeedCursor = FileHistoryResponseSchema.parse(
      await (
        await get(
          `/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md&cursor=${feedPage.nextCursor}`,
          readKey,
        )
      ).json(),
    )
    expect(historyFromFeedCursor.items).toEqual([])
  })

  test('limits are bounded: out-of-range or non-numeric limits are validation errors, 100 is accepted', async () => {
    for (const limit of ['0', '101', '500', '-5', 'abc', '2.5']) {
      for (const route of [
        `/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md&limit=${limit}`,
        `/v1/ws/${workspace.slug}/file-activity/feed?limit=${limit}`,
      ]) {
        const response = await get(route, readKey)
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_request' })
      }
    }
    expect(
      (await get(`/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md&limit=100`, readKey))
        .status,
    ).toBe(200)
  })

  test('an unknown path is a 200 page, not an error', async () => {
    // No selectable identity exists, so exact history fails closed instead of
    // presenting a workspace restore as history for a file that never existed.
    const history = await get(
      `/v1/ws/${workspace.slug}/file-activity?path=never/recorded.txt`,
      readKey,
    )
    expect(history.status).toBe(200)
    expect(await history.json()).toEqual({ items: [], nextCursor: null })

    const seenBy = await get(
      `/v1/ws/${workspace.slug}/file-activity/seen-by?path=never/recorded.txt`,
      readKey,
    )
    expect(seenBy.status).toBe(200)
    expect(await seenBy.json()).toEqual({ items: [], nextCursor: null })
  })

  test('malformed collection cursors have the shared cursor error', async () => {
    for (const route of [
      `/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md&cursor=nonsense`,
      `/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md&cursor=fa:-1`,
      `/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md&cursor=fa:01`,
      `/v1/ws/${workspace.slug}/file-activity/feed?cursor=fe1:5`,
      `/v1/ws/${workspace.slug}/file-activity/seen-by?path=notes/plan.md&cursor=nonsense`,
    ]) {
      const response = await get(route, readKey)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_cursor' })
    }
  })

  test('malformed paths, filters, and stream resumes remain invalid requests', async () => {
    for (const route of [
      `/v1/ws/${workspace.slug}/file-activity/feed?scope=subtree`,
      `/v1/ws/${workspace.slug}/file-activity/events?cursor=nonsense`,
      `/v1/ws/${workspace.slug}/file-activity/events?cursor=fa:01`,
      `/v1/ws/${workspace.slug}/file-activity/events?cursor=fa:-1`,
      `/v1/ws/${workspace.slug}/file-activity?path=../escape`,
      `/v1/ws/${workspace.slug}/file-activity?path=/absolute.txt`,
      `/v1/ws/${workspace.slug}/file-activity`,
      `/v1/ws/${workspace.slug}/file-activity/seen-by?path=notes//plan.md`,
      `/v1/ws/${workspace.slug}/file-activity/seen-by`,
    ]) {
      const response = await get(route, readKey)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    }
  })

  test('seen-by returns one row per actor, most recently active first', async () => {
    const response = await get(
      `/v1/ws/${workspace.slug}/file-activity/seen-by?path=notes/plan.md`,
      readKey,
    )
    expect(response.status).toBe(200)
    const body = SeenByResponseSchema.parse(await response.json())
    expect(body.items.map(row => row.actor)).toEqual(['web:user1', 'terminal'])
    expect(body.items[0]).toEqual({
      actor: 'web:user1',
      userId: 'user1',
      firstAt: 7_000,
      lastAt: 7_000,
      readCount: 1,
      writeCount: 0,
    })
    expect(body.items[1]).toEqual({
      actor: 'terminal',
      firstAt: 6_000,
      lastAt: 6_000,
      lastWriteAt: 6_000,
      readCount: 0,
      writeCount: 1,
    })
    const lastAts = body.items.map(row => row.lastAt)
    expect(lastAts).toEqual([...lastAts].sort((a, b) => b - a))

    const first = SeenByResponseSchema.parse(
      await (
        await get(
          `/v1/ws/${workspace.slug}/file-activity/seen-by?path=notes/plan.md&limit=1`,
          readKey,
        )
      ).json(),
    )
    expect(first.items.map(row => row.actor)).toEqual(['web:user1'])
    expect(first.nextCursor).not.toBeNull()
    const second = SeenByResponseSchema.parse(
      await (
        await get(
          `/v1/ws/${workspace.slug}/file-activity/seen-by?path=notes/plan.md&limit=1&cursor=${first.nextCursor}`,
          readKey,
        )
      ).json(),
    )
    expect(second.items.map(row => row.actor)).toEqual(['terminal'])
    expect(second.nextCursor).not.toBeNull()
    const terminal = SeenByResponseSchema.parse(
      await (
        await get(
          `/v1/ws/${workspace.slug}/file-activity/seen-by?path=notes/plan.md&limit=1&cursor=${second.nextCursor}`,
          readKey,
        )
      ).json(),
    )
    expect(terminal).toEqual({ items: [], nextCursor: null })

    const rebound = await get(
      `/v1/ws/${workspace.slug}/file-activity/seen-by?path=other/readme.md&cursor=${first.nextCursor}`,
      readKey,
    )
    expect(rebound.status).toBe(400)
  })

  test('latest-writers returns one latest write per requested dir entry', async () => {
    const url =
      `/v1/ws/${workspace.slug}/file-activity/latest-writers` +
      `?dir=notes&path=plan.md&path=never-written.md`
    const response = await get(url, readKey)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      writers: [{ path: 'plan.md', actor: 'terminal', lastWriteAt: 6_000 }],
    })

    const denied = await get(url, outsiderKey)
    expect(denied.status).toBe(403)

    const missingDir = await get(
      `/v1/ws/${workspace.slug}/file-activity/latest-writers?path=plan.md`,
      readKey,
    )
    expect(missingDir.status).toBe(400)
    expect(await missingDir.json()).toEqual({ error: 'invalid_request' })
  })

  test('the routes are activity-neutral: no gateway traffic, no lastActivityAt tick', async () => {
    // Pinned by construction: registerFileActivityRoutes never sees a gateway
    // client. This app's outbound fetch (the gateway/provider path) throws,
    // so any gateway call would fail the requests below.
    let outboundCalls = 0
    const neutralApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => {
        outboundCalls += 1
        throw new Error('file-activity routes must never make outbound requests')
      },
    })
    const before = (await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
    })) as { lastActivityAt?: number }

    for (const route of [
      `/v1/ws/${workspace.slug}/file-activity?path=notes/plan.md`,
      `/v1/ws/${workspace.slug}/file-activity/seen-by?path=notes/plan.md`,
      `/v1/ws/${workspace.slug}/file-activity/feed?reads=1`,
    ]) {
      const response = await neutralApp.request(route, {
        headers: { authorization: `Bearer ${readKey}` },
      })
      expect(response.status).toBe(200)
    }

    const after = (await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
    })) as { lastActivityAt?: number }
    expect(outboundCalls).toBe(0)
    expect(after.lastActivityAt).toBe(before.lastActivityAt)

    // Observation creates no attribution: the seeded event log is unchanged.
    const events = (await convex.query('testing/fileActivity:rawFileEventsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
    })) as unknown[]
    expect(events).toHaveLength(7)
  })

  // Runs after the query-surface tests above: these append events past the
  // seeded seq 7, which the exact-seq assertions above must never observe.
  describe('SSE feed', () => {
    test('streams the feed from the beginning by default: reads excluded, frames carry cursor ids and contract rows', async () => {
      const { frames } = await readSse(
        await get(`/v1/ws/${workspace.slug}/file-activity/events`, readKey),
        parsed => parsed.frames.length >= 5,
      )
      expect(frames.map(frame => frame.data.seq)).toEqual([1, 2, 4, 5, 6])
      // SSE ids are opaque positions in the same workspace-sequence domain as REST.
      expect(new Set(frames.map(frame => frame.id)).size).toBe(frames.length)
      expect(frames.every(frame => frame.id.length > 20)).toBe(true)
      expect(frames.map(frame => frame.event)).toEqual([
        'create',
        'write',
        'write',
        'restore',
        'rename',
      ])
      for (const frame of frames) expect(frame.event).toBe(frame.data.event.kind)
      // The data payload is the feed row verbatim, not a feed-only shape.
      expect(frames[0]!.data.event).toEqual({
        kind: 'create',
        entryKind: 'file',
        path: 'notes/plan.md',
        actor: 'web:user1',
        userId: 'user1',
        at: 1_000,
      })
    })

    test('reads=1 opts read markers in, same as the paged feed', async () => {
      const { frames } = await readSse(
        await get(`/v1/ws/${workspace.slug}/file-activity/events?reads=1`, readKey),
        parsed => parsed.frames.length >= 7,
      )
      expect(frames.map(frame => frame.data.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    })

    test('resume is exact across disconnect with interleaved appends: no gaps, no duplicates', async () => {
      // Attach at the tail, then append while connected: the live loop must
      // pick the event up without a reconnect.
      const seeded = await readSse(
        await get(`/v1/ws/${workspace.slug}/file-activity/events?reads=1`, readKey),
        parsed => parsed.frames.length >= 7,
      )
      const live = await get(`/v1/ws/${workspace.slug}/file-activity/events`, readKey, {
        'last-event-id': seeded.frames.at(-1)!.id,
      })
      const reader = live.body!.getReader()
      await appendEvents('slice17-live', [
        { kind: 'write', path: 'notes/plan.md', actor: 'session:ses1', at: 8_000 },
      ])
      const first = await readSse(live, parsed => parsed.frames.length >= 1, undefined, reader)
      expect(first.frames.map(frame => frame.data.seq)).toEqual([8])
      expect(first.frames[0]!.id).not.toBe(seeded.frames.at(-1)!.id)

      // Disconnected: more events land. Resuming from the last delivered id
      // must replay exactly the gap — nothing before it, nothing twice.
      await appendEvents('slice17-gap', [
        { kind: 'write', path: 'other/readme.md', actor: 'session:ses1', at: 9_000 },
        {
          kind: 'delete',
          entryKind: 'file',
          path: 'other/readme.md',
          actor: 'session:ses1',
          at: 10_000,
        },
      ])
      const resumed = await readSse(
        await get(`/v1/ws/${workspace.slug}/file-activity/events`, readKey, {
          'last-event-id': first.frames[0]!.id,
        }),
        parsed => parsed.frames.length >= 2,
      )
      expect(resumed.frames.map(frame => frame.data.seq)).toEqual([9, 10])
      expect(resumed.frames.map(frame => frame.event)).toEqual(['write', 'delete'])
    })

    test('Last-Event-ID wins over ?cursor=, and a malformed header is a validation error', async () => {
      const seeded = await readSse(
        await get(`/v1/ws/${workspace.slug}/file-activity/events?reads=1`, readKey),
        parsed => parsed.frames.length >= 10,
      )
      const { frames } = await readSse(
        await get(
          `/v1/ws/${workspace.slug}/file-activity/events?cursor=${encodeURIComponent(seeded.frames[0]!.id)}`,
          readKey,
          { 'last-event-id': seeded.frames[8]!.id },
        ),
        parsed => parsed.frames.length >= 1,
      )
      expect(frames[0]!.data.seq).toBe(10)

      for (const header of ['nonsense', '10', 'fa:01']) {
        const response = await get(`/v1/ws/${workspace.slug}/file-activity/events`, readKey, {
          'last-event-id': header,
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_request' })
      }
    })

    test('keepalive comment pings arrive on cadence while the feed is quiet', async () => {
      const startedAt = Date.now()
      const seeded = await readSse(
        await get(`/v1/ws/${workspace.slug}/file-activity/events?reads=1`, readKey),
        parsed => parsed.frames.length >= 10,
      )
      const quiet = await readSse(
        await get(`/v1/ws/${workspace.slug}/file-activity/events`, readKey, {
          'last-event-id': seeded.frames.at(-1)!.id,
        }),
        parsed => parsed.keepalives >= 3,
      )
      expect(quiet.frames).toEqual([])
      expect(quiet.keepalives).toBeGreaterThanOrEqual(3)
      // Pings are periodic, not a burst: three of them cannot arrive before
      // three keepalive intervals have elapsed.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3 * STREAM_KEEPALIVE_MS)
    })

    test('the stream is activity-neutral: no outbound traffic, no lastActivityAt tick, no new events', async () => {
      let outboundCalls = 0
      const neutralApp = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fileActivityStream: { pollMs: STREAM_POLL_MS, keepaliveMs: STREAM_KEEPALIVE_MS },
        fetch: async () => {
          outboundCalls += 1
          throw new Error('the file-activity stream must never make outbound requests')
        },
      })
      const before = (await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace._id,
      })) as { lastActivityAt?: number }
      const eventsBefore = (await convex.query('testing/fileActivity:rawFileEventsForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace._id,
      })) as unknown[]

      const { frames, keepalives } = await readSse(
        await neutralApp.request(`/v1/ws/${workspace.slug}/file-activity/events?reads=1`, {
          headers: { authorization: `Bearer ${readKey}` },
        }),
        // Hold the stream across event replay, an idle poll, and a keepalive —
        // the whole lifecycle must stay Convex-only.
        parsed => parsed.frames.length >= eventsBefore.length && parsed.keepalives >= 1,
      )
      expect(frames.length).toBe(eventsBefore.length)
      expect(keepalives).toBeGreaterThanOrEqual(1)

      const after = (await convex.query('testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace._id,
      })) as { lastActivityAt?: number }
      const eventsAfter = (await convex.query('testing/fileActivity:rawFileEventsForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace._id,
      })) as unknown[]
      expect(outboundCalls).toBe(0)
      expect(after.lastActivityAt).toBe(before.lastActivityAt)
      expect(eventsAfter).toHaveLength(eventsBefore.length)
    })

    test('a workspace missing from Convex is a typed 404 before any stream bytes', async () => {
      // Auth normally prunes dead workspaces, so reaching Convex with an
      // unresolvable slug is the attach race; pin the typed close of it.
      const runtime: ApiRouteRuntime = {
        convex: new ConvexHttpClient(convex.url, {
          logger: false,
          skipConvexDeploymentUrlCheck: true,
        }),
        internalKey: INTERNAL_KEY,
        apiInternalKey: INTERNAL_KEY,
        fetchImpl: fetch,
        now: Date.now,
        appUrl: 'http://localhost:3000',
        officialHubOwnerEmail: 'official-owner@example.test',
        officialHubBaseUrl: 'https://edge.example.test',
      }
      const ghostApp = new Hono<{ Variables: ApiVariables }>()
      ghostApp.use(async (c, next) => {
        c.set('auth', {
          credentialKind: 'user',
          user: { id: ownerId, email: 'ghost@example.com' },
          workspaces: [
            {
              id: workspace._id,
              slug: 'ghost-slug',
              name: 'Ghost',
              status: 'active',
              servicingStatus: 'active',
              onboardedAt: 1,
              role: 'owner',
              billingUserId: ownerId,
              funding: { plan: null, active: true },
              creditRecovery: null,
              defaultTier: { effective: 'balanced' },
            },
          ],
          scopes: ['ws:ghost-slug:files:read'],
          versions: API_VERSION,
        })
        await next()
      })
      registerFileActivityRoutes(ghostApp, runtime, {
        pollMs: STREAM_POLL_MS,
        keepaliveMs: STREAM_KEEPALIVE_MS,
      })
      const response = await ghostApp.request('/v1/ws/ghost-slug/file-activity/events')
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    })

    test('a retired workspace is a typed JSON error before any stream bytes', async () => {
      const retiree = await signInWithMagicLink<{ _id: string }>(
        convex,
        uniqueEmail('file-activity-retired'),
        'File Activity Retiree',
      )
      await mutate(
        retiree.client,
        'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
        {
          internalKey: INTERNAL_KEY,
        },
      )
      const retiredWorkspace = (
        (await query(retiree.client, 'domains/workspaces/queries:listMine', {})) as Array<{
          workspace: { _id: string; slug: string }
        }>
      )[0]!.workspace
      const retiredKey = (await issueKey(retiree.client)).key
      await convex.mutation('domains/workspaces/provisioning:markRetired', {
        internalKey: INTERNAL_KEY,
        workspaceId: retiredWorkspace._id,
        now: Date.now(),
      })
      // Retirement removes the workspace from auth resolution, so the key's
      // workspace scope is pruned before the route runs: a typed JSON error
      // the daemon can render, never an SSE response.
      const response = await app.request(`/v1/ws/${retiredWorkspace.slug}/file-activity/events`, {
        headers: { authorization: `Bearer ${retiredKey}` },
      })
      expect(response.headers.get('content-type')).not.toBe('text/event-stream')
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: 'insufficient_scope',
        scope: `ws:${retiredWorkspace.slug}:files:read`,
      })
    })
  })
})

async function get(
  path: string,
  key: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(path, { headers: { authorization: `Bearer ${key}`, ...headers } })
}

async function appendEvents(batchId: string, events: unknown[]): Promise<void> {
  await convex.mutation('domains/fileActivity/api:recordBatchFromApi', {
    internalKey: INTERNAL_KEY,
    workspaceId: workspace._id,
    batch: { batchId, events, droppedReads: 0, overflow: 0 },
  })
}

interface ParsedSse {
  frames: Array<{ id: string; event: string; data: FileFeedEvent }>
  keepalives: number
}

// Reads an SSE response until `done` is satisfied (or the deadline passes),
// then cancels the stream — the parsed result is asserted by the caller.
async function readSse(
  response: Response,
  done: (parsed: ParsedSse) => boolean,
  timeoutMs = 10_000,
  reader?: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ParsedSse> {
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const streamReader = reader ?? response.body!.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  let buffer = ''
  try {
    while (true) {
      const parsed = parseSse(buffer)
      const remaining = deadline - Date.now()
      if (done(parsed) || remaining <= 0) return parsed
      const chunk = await Promise.race([
        streamReader.read(),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), remaining)),
      ])
      if (chunk === 'timeout' || chunk.done) return parseSse(buffer)
      if (chunk.value !== undefined) buffer += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await streamReader.cancel().catch(() => {})
  }
}

function parseSse(buffer: string): ParsedSse {
  const blocks = buffer.split('\n\n')
  blocks.pop() // trailing partial (or empty) block
  const frames: ParsedSse['frames'] = []
  let keepalives = 0
  for (const block of blocks) {
    if (block.startsWith(':')) {
      keepalives += 1
      continue
    }
    const lines = block.split('\n')
    const field = (name: string) =>
      lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
    const data = field('data')
    if (data === undefined) continue
    frames.push({
      id: field('id')!,
      event: field('event')!,
      data: FileFeedEventSchema.parse(JSON.parse(data)),
    })
  }
  return { frames, keepalives }
}
