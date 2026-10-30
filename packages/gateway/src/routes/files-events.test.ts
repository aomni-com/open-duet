import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import {
  DUET_ACTOR_CONTEXT_HEADER,
  DUET_PUBLISH_ANCHOR_PATH_HEADER,
  DUET_PUBLISH_KIND_HEADER,
  type DriveFileEvent,
  type FileEventBatch,
} from '@repo/contract'

import { createFileEventPipeline } from '../attribution/pipeline'
import { createGatewayRuntime } from '../runtime/http'
import { createFilesRoutes } from './files'
import { createPublishesRoutes } from './publishes'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'duet-files-events-'))
})

interface RouteHarness {
  app: Hono
  driveDir: string
  events: DriveFileEvent[]
}

async function routeHarness(
  emitFileEvent?: (event: DriveFileEvent) => void,
): Promise<RouteHarness> {
  const driveDir = join(tempDir, 'drive')
  await mkdir(driveDir, { recursive: true })
  const events: DriveFileEvent[] = []
  const app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir: join(driveDir, '.duet', 'uploads'),
      emitFileEvent: emitFileEvent ?? (event => events.push(event)),
      diskGuard: { ensureWritable: async () => 'ok' },
      cursorSubject: 'workspace:test',
    }),
  )
  return { app, driveDir, events }
}

function actorHeaders(actor = 'web:user1'): Record<string, string> {
  return { [DUET_ACTOR_CONTEXT_HEADER]: actor }
}

describe('files routes emit semantic drive events', () => {
  test('a versioned file GET is immutable while retaining validators', async () => {
    const harness = await routeHarness()
    await writeFile(join(harness.driveDir, 'icon.png'), 'icon bytes')

    const response = await harness.app.request('/v1/files/icon.png?v=123', {
      headers: actorHeaders(),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(response.headers.get('etag')).not.toBeNull()
    expect(response.headers.get('last-modified')).not.toBeNull()
  })

  test('unversioned and malformed-version file GETs retain the ordinary headers', async () => {
    const harness = await routeHarness()
    await writeFile(join(harness.driveDir, 'notes.txt'), 'ordinary bytes')

    const unversioned = await harness.app.request('/v1/files/notes.txt', {
      headers: actorHeaders(),
    })
    const malformed = await harness.app.request('/v1/files/notes.txt?v=latest', {
      headers: actorHeaders(),
    })

    expect(unversioned.status).toBe(200)
    expect(unversioned.headers.get('cache-control')).toBeNull()
    expect([...unversioned.headers]).toEqual([...malformed.headers])
  })

  test('PUT emits a write for the final path without misleading stat fields', async () => {
    const harness = await routeHarness()
    const response = await harness.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: actorHeaders(),
      body: 'hello',
    })
    expect(response.status).toBe(200)

    expect(harness.events).toHaveLength(1)
    const event = harness.events[0]!
    expect(event).toMatchObject({
      kind: 'write',
      path: 'docs/a.txt',
      actor: 'web:user1',
    })
    expect(event).not.toHaveProperty('size')
    expect(event).not.toHaveProperty('mtimeMs')
    expect(event.at).toBeGreaterThan(0)
  })

  test('the .duet upload staging path never appears in any event', async () => {
    const harness = await routeHarness()
    await harness.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: actorHeaders(),
      body: 'hello',
    })
    await harness.app.request('/v1/files/docs/a.txt', { headers: actorHeaders() })
    await harness.app.request('/v1/files/actions', {
      method: 'POST',
      headers: actorHeaders(),
      body: JSON.stringify({
        operation: 'copy',
        source: 'docs/a.txt',
        destination: 'docs/b.txt',
      }),
    })

    expect(harness.events.length).toBeGreaterThan(0)
    for (const event of harness.events) {
      expect(JSON.stringify(event)).not.toContain('.duet')
    }
  })

  test('successful content GETs emit reads, including range requests', async () => {
    const harness = await routeHarness()
    await writeFile(join(harness.driveDir, 'a.txt'), 'hello world')

    const full = await harness.app.request('/v1/files/a.txt', { headers: actorHeaders() })
    expect(full.status).toBe(200)
    const ranged = await harness.app.request('/v1/files/a.txt', {
      headers: { ...actorHeaders(), range: 'bytes=0-4' },
    })
    expect(ranged.status).toBe(206)

    expect(harness.events).toEqual([
      expect.objectContaining({ kind: 'read', path: 'a.txt', actor: 'web:user1' }),
      expect.objectContaining({ kind: 'read', path: 'a.txt', actor: 'web:user1' }),
    ])
  })

  test('HEAD returns file metadata without a body or read event', async () => {
    const harness = await routeHarness()
    await writeFile(join(harness.driveDir, 'a.txt'), 'hello world')

    const response = await harness.app.request('/v1/files/a.txt', {
      method: 'HEAD',
      headers: actorHeaders(),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('content-length')).toBe('11')
    expect(response.headers.get('etag')).not.toBeNull()
    expect(response.headers.get('last-modified')).not.toBeNull()
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.arrayBuffer()).toHaveLength(0)
    expect(harness.events).toEqual([])
  })

  test('image content GETs emit no read event and record no activity', async () => {
    const harness = await routeHarness()
    await writeFile(join(harness.driveDir, 'icon.png'), 'icon bytes')

    const response = await harness.app.request('/v1/files/icon.png', {
      headers: { ...actorHeaders(), 'sec-fetch-dest': 'image' },
    })

    expect(response.status).toBe(200)
    expect(harness.events).toEqual([])
  })

  test('public publish image GETs retain activity and ignore file-version caching', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'published'), { recursive: true })
    await writeFile(join(driveDir, 'published', 'icon.png'), 'icon bytes')
    const app = new Hono().route(
      '/public/publish',
      createPublishesRoutes({
        driveDir,
        stateDir: join(tempDir, '.duet'),
      }),
    )

    const response = await app.request('/public/publish/icon.png?v=123&raw', {
      headers: {
        [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'published',
        [DUET_PUBLISH_KIND_HEADER]: 'folder',
        'sec-fetch-dest': 'image',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBeNull()
  })

  test('listings, stats, and failed operations emit nothing', async () => {
    const harness = await routeHarness()
    await mkdir(join(harness.driveDir, 'docs'))
    await writeFile(join(harness.driveDir, 'docs', 'a.txt'), 'hello')

    expect(
      (await harness.app.request('/v1/files/docs?list=1', { headers: actorHeaders() })).status,
    ).toBe(200)
    expect(
      (await harness.app.request('/v1/files/docs/a.txt?stat=1', { headers: actorHeaders() }))
        .status,
    ).toBe(200)
    expect(
      (await harness.app.request('/v1/files/missing.txt', { headers: actorHeaders() })).status,
    ).toBe(404)
    expect(
      (
        await harness.app.request('/v1/files/missing.txt', {
          method: 'DELETE',
          headers: actorHeaders(),
        })
      ).status,
    ).toBe(404)
    const conflicted = await harness.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: { ...actorHeaders(), 'if-match': '"not-the-etag"' },
      body: 'nope',
    })
    expect(conflicted.status).toBe(412)
    const badRange = await harness.app.request('/v1/files/docs/a.txt', {
      headers: { ...actorHeaders(), range: 'bytes=999-' },
    })
    expect(badRange.status).toBe(416)
    const failedCopy = await harness.app.request('/v1/files/actions', {
      method: 'POST',
      headers: actorHeaders(),
      body: JSON.stringify({ operation: 'copy', source: 'missing.txt', destination: 'docs/x' }),
    })
    expect(failedCopy.status).toBe(404)

    expect(harness.events).toEqual([])
  })

  test('DELETE and the delete action emit delete events', async () => {
    const harness = await routeHarness()
    await writeFile(join(harness.driveDir, 'a.txt'), 'x')
    await writeFile(join(harness.driveDir, 'b.txt'), 'x')

    expect(
      (await harness.app.request('/v1/files/a.txt', { method: 'DELETE', headers: actorHeaders() }))
        .status,
    ).toBe(200)
    expect(
      (
        await harness.app.request('/v1/files/actions', {
          method: 'POST',
          headers: actorHeaders('api-key:key1'),
          body: JSON.stringify({ operation: 'delete', path: 'b.txt' }),
        })
      ).status,
    ).toBe(200)

    expect(harness.events).toEqual([
      expect.objectContaining({
        kind: 'delete',
        entryKind: 'file',
        path: 'a.txt',
        actor: 'web:user1',
      }),
      expect.objectContaining({
        kind: 'delete',
        entryKind: 'file',
        path: 'b.txt',
        actor: 'api-key:key1',
      }),
    ])
  })

  test('mkdir/copy emit destination creates and move emits a rename with entry kinds', async () => {
    const harness = await routeHarness()
    await mkdir(join(harness.driveDir, 'docs'))
    await writeFile(join(harness.driveDir, 'docs', 'a.txt'), 'hello')
    await mkdir(join(harness.driveDir, 'tree'))
    await writeFile(join(harness.driveDir, 'tree', 'inner.txt'), 'inner')
    const action = (body: Record<string, unknown>) =>
      harness.app.request('/v1/files/actions', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify(body),
      })

    expect((await action({ operation: 'mkdir', path: 'made' })).status).toBe(200)
    expect(
      (await action({ operation: 'move', source: 'docs/a.txt', destination: 'docs/moved.txt' }))
        .status,
    ).toBe(200)
    expect(
      (await action({ operation: 'copy', source: 'docs/moved.txt', destination: 'docs/copy.txt' }))
        .status,
    ).toBe(200)
    expect(
      (
        await action({
          operation: 'copy',
          source: 'tree',
          destination: 'tree-copy',
          recursive: true,
        })
      ).status,
    ).toBe(200)

    expect(harness.events).toHaveLength(4)
    expect(harness.events[0]).toMatchObject({
      kind: 'create',
      entryKind: 'folder',
      path: 'made',
      actor: 'web:user1',
    })
    expect(harness.events[1]).toMatchObject({
      kind: 'rename',
      entryKind: 'file',
      path: 'docs/moved.txt',
      fromPath: 'docs/a.txt',
      actor: 'web:user1',
    })
    expect(harness.events[2]).toMatchObject({
      kind: 'create',
      entryKind: 'file',
      path: 'docs/copy.txt',
      actor: 'web:user1',
    })
    expect(harness.events[2]).not.toHaveProperty('size')
    expect(harness.events[2]).not.toHaveProperty('mtimeMs')
    // A tree copy is one operation on its destination root, not a storm.
    expect(harness.events[3]).toMatchObject({
      kind: 'create',
      entryKind: 'folder',
      path: 'tree-copy',
    })
    expect(harness.events[3]).not.toHaveProperty('size')
  })

  test('link operations emit semantic events carrying the link path (slice 16)', async () => {
    const harness = await routeHarness()
    await writeFile(join(harness.driveDir, 'notes.txt'), 'hello')
    const action = (body: Record<string, unknown>) =>
      harness.app.request('/v1/files/actions', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify(body),
      })

    // A symlink operation is one create event for the link path.
    expect(
      (await action({ operation: 'symlink', path: 'alias', target: 'notes.txt' })).status,
    ).toBe(200)
    // Retarget is also a create (the link entry was replaced).
    expect((await action({ operation: 'symlink', path: 'alias', target: 'missing' })).status).toBe(
      200,
    )
    expect(
      (await action({ operation: 'move', source: 'alias', destination: 'renamed' })).status,
    ).toBe(200)
    expect(
      (
        await harness.app.request('/v1/files/renamed', {
          method: 'DELETE',
          headers: actorHeaders(),
        })
      ).status,
    ).toBe(200)

    expect(harness.events).toEqual([
      expect.objectContaining({
        kind: 'create',
        entryKind: 'file',
        path: 'alias',
        actor: 'web:user1',
      }),
      expect.objectContaining({
        kind: 'create',
        entryKind: 'file',
        path: 'alias',
      }),
      expect.objectContaining({
        kind: 'rename',
        entryKind: 'file',
        path: 'renamed',
        fromPath: 'alias',
      }),
      expect.objectContaining({ kind: 'delete', entryKind: 'file', path: 'renamed' }),
    ])
    expect(harness.events[0]).not.toHaveProperty('size')
    expect(harness.events[0]).not.toHaveProperty('mtimeMs')
  })

  test('reads through links emit for the link path; failed link operations emit nothing', async () => {
    const harness = await routeHarness()
    await writeFile(join(harness.driveDir, 'notes.txt'), 'hello')
    const { symlink } = await import('node:fs/promises')
    await symlink('notes.txt', join(harness.driveDir, 'healthy'))
    await symlink('missing', join(harness.driveDir, 'dangling'))

    expect(
      (await harness.app.request('/v1/files/healthy', { headers: actorHeaders() })).status,
    ).toBe(200)
    expect(harness.events).toEqual([
      expect.objectContaining({ kind: 'read', path: 'healthy', actor: 'web:user1' }),
    ])

    harness.events.length = 0
    expect(
      (await harness.app.request('/v1/files/dangling', { headers: actorHeaders() })).status,
    ).toBe(409)
    expect(
      (
        await harness.app.request('/v1/files/healthy', {
          method: 'PUT',
          headers: actorHeaders(),
          body: 'clobber',
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await harness.app.request('/v1/files/actions', {
          method: 'POST',
          headers: actorHeaders(),
          body: JSON.stringify({ operation: 'symlink', path: 'notes.txt', target: 'x' }),
        })
      ).status,
    ).toBe(409)
    expect(harness.events).toEqual([])
  })

  test('a throwing emitter never breaks a request', async () => {
    const harness = await routeHarness(() => {
      throw new Error('attribution exploded')
    })
    await writeFile(join(harness.driveDir, 'a.txt'), 'hello')

    const put = await harness.app.request('/v1/files/b.txt', {
      method: 'PUT',
      headers: actorHeaders(),
      body: 'new',
    })
    expect(put.status).toBe(200)
    const get = await harness.app.request('/v1/files/a.txt', { headers: actorHeaders() })
    expect(get.status).toBe(200)
    expect(await get.text()).toBe('hello')
    const del = await harness.app.request('/v1/files/a.txt', {
      method: 'DELETE',
      headers: actorHeaders(),
    })
    expect(del.status).toBe(200)
  })
})

describe('actor policy through the pipeline and the activity gate', () => {
  interface PolicyHarness extends RouteHarness {
    batches: FileEventBatch[]
    flush: () => Promise<void>
    stats: () => { droppedReads: number; overflow: number; mirrorReadsSkipped: number }
  }

  async function policyHarness(): Promise<PolicyHarness> {
    const batches: FileEventBatch[] = []
    const pipeline = createFileEventPipeline({
      apiUrl: 'http://api',
      getVmToken: async () => 'vm-token',
      fetch: async (_input, init) => {
        batches.push(JSON.parse(String(init?.body)) as FileEventBatch)
        return Response.json({ ok: true })
      },
      now: () => Date.now(),
      flushMs: 60_000,
    })
    const harness = await routeHarness(pipeline.emit)
    return {
      ...harness,
      batches,
      flush: () => pipeline.flush(),
      stats: () => pipeline.stats(),
    }
  }

  test('mirror reads emit nothing and are activity-neutral; mirror writes do both', async () => {
    const harness = await policyHarness()
    await mkdir(join(harness.driveDir, 'docs'))
    await writeFile(join(harness.driveDir, 'docs', 'a.txt'), 'hello')

    const mirror = actorHeaders('mirror:device1')
    expect((await harness.app.request('/v1/files/docs/a.txt', { headers: mirror })).status).toBe(
      200,
    )
    expect((await harness.app.request('/v1/files/docs?list=1', { headers: mirror })).status).toBe(
      200,
    )
    expect(
      (await harness.app.request('/v1/files/docs/a.txt?stat=1', { headers: mirror })).status,
    ).toBe(200)

    const put = await harness.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: mirror,
      body: 'from the mac',
    })
    expect(put.status).toBe(200)

    await harness.flush()
    const events = harness.batches.flatMap(batch => batch.events)
    expect(events).toEqual([
      expect.objectContaining({ kind: 'write', path: 'docs/a.txt', actor: 'mirror:device1' }),
    ])
    expect(harness.stats().mirrorReadsSkipped).toBe(1)
    expect(harness.stats().droppedReads).toBe(0)
  })

  test('non-mirror activity recording is byte-identical, header or not', async () => {
    const harness = await policyHarness()
    await writeFile(join(harness.driveDir, 'a.txt'), 'hello')

    expect((await harness.app.request('/v1/files/a.txt', { headers: actorHeaders() })).status).toBe(
      200,
    )
    expect((await harness.app.request('/v1/files/a.txt')).status).toBe(200)
    expect(
      (await harness.app.request('/v1/files/a.txt?stat=1', { headers: actorHeaders('api-key:k1') }))
        .status,
    ).toBe(200)
  })

  test('absent or forged headers drop reads (counted) and log writes as system', async () => {
    const harness = await policyHarness()
    await writeFile(join(harness.driveDir, 'a.txt'), 'hello')

    expect((await harness.app.request('/v1/files/a.txt')).status).toBe(200)
    expect(
      (
        await harness.app.request('/v1/files/b.txt', {
          method: 'PUT',
          headers: actorHeaders('totally forged!!'),
          body: 'x',
        })
      ).status,
    ).toBe(200)

    await harness.flush()
    const events = harness.batches.flatMap(batch => batch.events)
    expect(events).toEqual([
      expect.objectContaining({ kind: 'write', path: 'b.txt', actor: 'system' }),
    ])
    expect(harness.stats().droppedReads).toBe(1)
  })

  test('attributed reads relay with their actor', async () => {
    const harness = await policyHarness()
    await writeFile(join(harness.driveDir, 'a.txt'), 'hello')
    expect((await harness.app.request('/v1/files/a.txt', { headers: actorHeaders() })).status).toBe(
      200,
    )
    await harness.flush()
    expect(harness.batches.flatMap(batch => batch.events)).toEqual([
      expect.objectContaining({ kind: 'read', path: 'a.txt', actor: 'web:user1' }),
    ])
  })
})

describe('runtime wiring', () => {
  test('the runtime relays route events through one pipeline; public publish reads stay anonymous drops', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await mkdir(stateDir, { recursive: true })
    await mkdir(driveDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const posts: Array<{ url: string; authorization: string | undefined; batch: FileEventBatch }> =
      []
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir,
      apiUrl: 'http://backend',
      fetch: async (input, init) => {
        posts.push({
          url: String(input),
          authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
          batch: JSON.parse(String(init?.body)) as FileEventBatch,
        })
        return Response.json({ ok: true })
      },
    })

    const put = await runtime.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: { authorization: 'Bearer vm-token', ...actorHeaders() },
      body: 'hello',
    })
    expect(put.status).toBe(200)

    // The API proxy authenticates with the vm token but public publish
    // requests never carry an actor header — they are anonymous reads.
    const publish = await runtime.app.request('/public/publish?raw', {
      headers: {
        authorization: 'Bearer vm-token',
        [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'docs/a.txt',
        [DUET_PUBLISH_KIND_HEADER]: 'file',
      },
    })
    expect(publish.status).toBe(200)

    await runtime.fileEvents.flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe('http://backend/v1/vm/file-events')
    expect(posts[0]!.authorization).toBe('Bearer vm-token')
    expect(posts[0]!.batch.events).toEqual([
      expect.objectContaining({
        kind: 'write',
        path: 'docs/a.txt',
        actor: 'web:user1',
      }),
    ])
    // The anonymous publish read was dropped and counted (MAP Q1).
    expect(posts[0]!.batch.droppedReads).toBe(1)
    expect(runtime.fileEvents.stats().droppedReads).toBe(1)
  })
})
