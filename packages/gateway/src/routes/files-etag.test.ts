import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import { FileStatResponseSchema } from '@repo/contract'

import { createFilesRoutes } from './files'

let driveDir: string
let filePath: string
let app: Hono
let rootDir: string

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'duet-files-etag-'))
  driveDir = join(rootDir, 'drive')
  filePath = join(driveDir, 'notes.txt')
  await mkdir(driveDir, { recursive: true })
  await writeFile(filePath, 'first')
  app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir: join(driveDir, '.duet', 'uploads'),
      diskGuard: { ensureWritable: async () => 'ok' },
    }),
  )
})

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

describe('authenticated file version identity', () => {
  test('stat and content reads expose the same quoted file-version ETag', async () => {
    const content = await app.request('/v1/files/notes.txt')
    const stat = await app.request('/v1/files/notes.txt?stat=1')

    expect(content.status).toBe(200)
    expect(stat.status).toBe(200)
    const contentEtag = content.headers.get('etag')
    expect(contentEtag).toMatch(/^".+"$/)
    expect(FileStatResponseSchema.parse(await stat.json()).etag).toBe(contentEtag)
    await content.arrayBuffer()
  })

  test('a same-size rewrite with a new modification time changes the stat ETag', async () => {
    const initialStat = await stat(filePath)
    const before = FileStatResponseSchema.parse(
      await (await app.request('/v1/files/notes.txt?stat=1')).json(),
    )

    await writeFile(filePath, 'other')
    // Immediate writes can share a filesystem timestamp tick.
    await utimes(filePath, initialStat.atime, new Date(initialStat.mtimeMs + 1000))

    const after = FileStatResponseSchema.parse(
      await (await app.request('/v1/files/notes.txt?stat=1')).json(),
    )
    expect(after.entry.size).toBe(before.entry.size)
    expect(after.etag).not.toBe(before.etag)
  })

  test('non-file stat entries expose a null ETag', async () => {
    await mkdir(join(driveDir, 'folder'))
    await symlink('notes.txt', join(driveDir, 'current'))

    for (const path of ['folder', 'current']) {
      const response = await app.request(`/v1/files/${path}?stat=1`)
      expect(response.status, path).toBe(200)
      expect(FileStatResponseSchema.parse(await response.json()).etag, path).toBeNull()
    }
  })
})
