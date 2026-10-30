import { beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import { DRIVE_UPLOAD_MAX_BYTES } from '@repo/contract'

import { createFilesRoutes } from './files'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duet-files-reserve-'))
})

test('PUT below the reserve returns typed 507 before creating an upload temp file', async () => {
  const driveDir = join(root, 'drive')
  const uploadDir = join(driveDir, '.duet', 'uploads')
  await mkdir(driveDir, { recursive: true })
  const app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir: uploadDir,
      diskGuard: { ensureWritable: async () => 'full' },
    }),
  )

  const response = await app.request('/v1/files/blocked.txt', {
    method: 'PUT',
    body: 'must not stage',
  })

  expect(response.status).toBe(507)
  expect(await response.json()).toEqual({ error: 'storage_full' })
  expect(await readdir(uploadDir).catch(() => [])).toEqual([])
})

// Two limits refuse a PUT, and which one answers is itself a contract: a file
// no disk could hold should be told the thing its owner can act on. Both live
// here so an edit cannot silently reorder them.
test('PUT over the per-file cap is refused before anything is staged', async () => {
  const driveDir = join(root, 'drive')
  const uploadDir = join(driveDir, '.duet', 'uploads')
  await mkdir(driveDir, { recursive: true })
  const app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir: uploadDir,
      // Plenty of room — the cap must refuse on its own, not as a faster path
      // to the space check.
      diskGuard: { ensureWritable: async () => 'ok' },
    }),
  )

  const response = await app.request('/v1/files/enormous.bin', {
    method: 'PUT',
    headers: { 'content-length': String(DRIVE_UPLOAD_MAX_BYTES + 1) },
    body: 'the browser is still sending',
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({
    error: 'file_too_large',
    limitBytes: DRIVE_UPLOAD_MAX_BYTES,
  })
  expect(await readdir(uploadDir).catch(() => [])).toEqual([])
})

// On a Starter workspace the cap exceeds the whole disk, so in the wild the
// space check would always answer first. This is the only place the ordering
// is observable at all.
test('the cap answers ahead of the space check when both would refuse', async () => {
  const driveDir = join(root, 'drive')
  await mkdir(driveDir, { recursive: true })
  const app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir: join(driveDir, '.duet', 'uploads'),
      diskGuard: { ensureWritable: async () => 'full' },
    }),
  )

  const response = await app.request('/v1/files/enormous.bin', {
    method: 'PUT',
    headers: { 'content-length': String(DRIVE_UPLOAD_MAX_BYTES + 1) },
    body: 'bytes',
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({
    error: 'file_too_large',
    limitBytes: DRIVE_UPLOAD_MAX_BYTES,
  })
})

// Deliberate, not an oversight: a caller that declares no length is bounded by
// free disk alone. No shipping client sends one — XHR always sets the header
// and the API proxy forwards it — and counting bytes mid-stream to close a hole
// nobody stands in would trade a readable up-front refusal for one that arrives
// after minutes of transfer. If you are here to "fix" this, read spec decision
// D7 first.
test('a body that declares no length is bounded by disk, not by the cap', async () => {
  const driveDir = join(root, 'drive')
  await mkdir(driveDir, { recursive: true })
  const app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir: join(driveDir, '.duet', 'uploads'),
      diskGuard: { ensureWritable: async () => 'ok' },
    }),
  )

  const response = await app.request('/v1/files/undeclared.bin', {
    method: 'PUT',
    body: 'no content-length reaches the route for this request',
  })

  expect(response.status).toBe(200)
})

// A multi-gigabyte upload streams for minutes. Deciding it fits only once the
// bytes have already arrived means the caller pays the whole transfer to learn
// it never could have landed — so the declared size is weighed first.
test('PUT is refused up front when the declared size cannot fit beside the reserve', async () => {
  const driveDir = join(root, 'drive')
  const uploadDir = join(driveDir, '.duet', 'uploads')
  await mkdir(driveDir, { recursive: true })
  const weighed: number[] = []
  const app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir: uploadDir,
      diskGuard: {
        ensureWritable: async (incomingBytes = 0) => {
          weighed.push(incomingBytes)
          return incomingBytes > 4096 ? 'full' : 'ok'
        },
      },
      cursorSubject: 'workspace:test',
    }),
  )

  const response = await app.request('/v1/files/huge.bin', {
    method: 'PUT',
    headers: { 'content-length': '7516192768' },
    body: 'the browser is still sending',
  })

  expect(response.status).toBe(507)
  expect(await response.json()).toEqual({ error: 'storage_full' })
  expect(weighed).toEqual([7_516_192_768])
  expect(await readdir(uploadDir).catch(() => [])).toEqual([])
})

test('PUT that fits beside the reserve lands whole', async () => {
  const driveDir = join(root, 'drive')
  await mkdir(driveDir, { recursive: true })
  const app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir: join(driveDir, '.duet', 'uploads'),
      diskGuard: {
        ensureWritable: async (incomingBytes = 0) => (incomingBytes > 4096 ? 'full' : 'ok'),
      },
    }),
  )

  const response = await app.request('/v1/files/fits.txt', {
    method: 'PUT',
    headers: { 'content-length': '11' },
    body: 'small enough',
  })

  expect(response.status).toBe(200)
  expect(await readFile(join(driveDir, 'fits.txt'), 'utf8')).toBe('small enough')
})

// Probed against a real socket while planning this change, because nothing
// proved it: `pipeline` could plausibly have resolved on a short read, and then
// the rename would publish half a file under the name its owner chose. It
// errors instead, and the existing catch unlinks. This test is what keeps that
// true — it is the whole safety argument for the Files tab's cancel button.
test('a client that vanishes mid-body publishes nothing and stages nothing', async () => {
  const driveDir = join(root, 'drive')
  const tempDir = join(driveDir, '.duet', 'uploads')
  await mkdir(driveDir, { recursive: true })
  const app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir,
      diskGuard: { ensureWritable: async () => 'ok' },
    }),
  )
  const server = Bun.serve({ port: 0, maxRequestBodySize: 1024 ** 3, fetch: app.fetch })

  try {
    const declared = 4096
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port: server.port!,
      socket: { data: () => {}, close: () => {} },
    })
    socket.write(
      [
        'PUT /v1/files/severed.bin HTTP/1.1',
        `Host: 127.0.0.1:${server.port}`,
        `Content-Length: ${declared}`,
        '',
        '',
      ].join('\r\n'),
    )
    socket.write(new Uint8Array(declared / 2).fill(65))
    await Bun.sleep(150)
    socket.terminate()
    await Bun.sleep(600)

    expect(await readdir(tempDir).catch(() => [])).toEqual([])
    expect(await stat(join(driveDir, 'severed.bin')).catch(() => null)).toBeNull()
  } finally {
    server.stop(true)
  }
})

test('only capacity-growing actions are refused below the reserve', async () => {
  const driveDir = join(root, 'drive')
  await mkdir(join(driveDir, 'docs'), { recursive: true })
  await writeFile(join(driveDir, 'docs', 'source.txt'), 'source')
  await writeFile(join(driveDir, 'docs', 'delete.txt'), 'delete')
  let guardCalls = 0
  const app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir: join(driveDir, '.duet', 'uploads'),
      diskGuard: {
        ensureWritable: async () => {
          guardCalls += 1
          return 'full'
        },
      },
      cursorSubject: 'workspace:test',
    }),
  )
  const action = (body: Record<string, unknown>) =>
    app.request('/v1/files/actions', { method: 'POST', body: JSON.stringify(body) })

  for (const operation of [
    { operation: 'mkdir', path: 'new-dir' },
    { operation: 'symlink', path: 'new-link', target: 'docs/source.txt' },
    {
      operation: 'copy',
      source: 'docs/source.txt',
      destination: 'docs/copy.txt',
    },
  ]) {
    const response = await action(operation)
    expect(response.status).toBe(507)
    expect(await response.json()).toEqual({ error: 'storage_full' })
  }

  expect((await app.request('/v1/files/docs/source.txt')).status).toBe(200)
  expect((await app.request('/v1/files/docs?list=1')).status).toBe(200)
  expect(
    (
      await action({
        operation: 'move',
        source: 'docs/source.txt',
        destination: 'docs/moved.txt',
      })
    ).status,
  ).toBe(200)
  expect(
    (await action({ operation: 'delete', path: 'docs/delete.txt', recursive: false })).status,
  ).toBe(200)
  expect(guardCalls).toBe(3)
})
