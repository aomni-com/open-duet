import { beforeEach, describe, expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import {
  FileListResponseSchema,
  FileStatResponseSchema,
  MAX_RECURSIVE_FILE_ENTRIES,
} from '@repo/contract'

import { createFilesRoutes } from './files'

// Slice 16 route matrix: every verb × {healthy, dangling, escaping, dir-link}.
// Links are first-class entries — listed and stat'ed as themselves, read
// through only while realpath containment holds, never written through, and
// reproduced (never followed) by structural operations.

let tempDir: string
let driveDir: string
let app: Hono

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'duet-files-symlinks-'))
  driveDir = join(tempDir, 'drive')
  await mkdir(join(driveDir, 'docs'), { recursive: true })
  await writeFile(join(driveDir, 'notes.txt'), 'hello world')
  await writeFile(join(driveDir, 'docs', 'inner.txt'), 'inner')
  await writeFile(join(tempDir, 'outside.txt'), 'secret')
  await symlink('notes.txt', join(driveDir, 'link-file'))
  await symlink('docs', join(driveDir, 'link-dir'))
  await symlink('missing.txt', join(driveDir, 'link-dangling'))
  await symlink(join(tempDir, 'outside.txt'), join(driveDir, 'link-escape'))
  app = new Hono().route(
    '/v1/files',
    createFilesRoutes({
      driveDir,
      tempDir: join(driveDir, '.duet', 'uploads'),
      diskGuard: { ensureWritable: async () => 'ok' },
      cursorSubject: 'workspace:test',
    }),
  )
})

const action = (body: Record<string, unknown>) =>
  app.request('/v1/files/actions', { method: 'POST', body: JSON.stringify(body) })

describe('listing and stat report links as their own entries', () => {
  // The shipping bound (zip, copy, publish) caps what a folder can reproduce;
  // a listing reproduces nothing, so an agent that writes a thousand
  // artifacts flat into its own folder can still be browsed.
  test('a directory past the shipping ceiling still lists completely across pages', async () => {
    const oversized = join(driveDir, 'oversized')
    await mkdir(oversized)
    const expected = Array.from(
      { length: MAX_RECURSIVE_FILE_ENTRIES + 1 },
      (_, index) => `entry-${String(index).padStart(4, '0')}`,
    )
    await Promise.all(expected.map(name => writeFile(join(oversized, name), '')))

    const actual: string[] = []
    let cursor: string | null = null
    do {
      const query = new URLSearchParams({ list: '1', limit: '100' })
      if (cursor !== null) query.set('cursor', cursor)
      const response = await app.request(`/v1/files/oversized?${query}`)
      expect(response.status).toBe(200)
      const page = FileListResponseSchema.parse(await response.json())
      actual.push(...page.items.map(entry => entry.name))
      cursor = page.nextCursor
    } while (cursor !== null)

    expect(actual).toEqual(expected)
  })

  test('an accepted directory walks completely across multiple response pages', async () => {
    const paged = join(driveDir, 'paged')
    await mkdir(paged)
    const expected = Array.from(
      { length: 105 },
      (_, index) => `entry-${String(index).padStart(3, '0')}`,
    )
    await Promise.all(expected.map(name => writeFile(join(paged, name), '')))

    const actual: string[] = []
    let cursor: string | null = null
    do {
      const query = new URLSearchParams({ list: '1', limit: '37' })
      if (cursor !== null) query.set('cursor', cursor)
      const response = await app.request(`/v1/files/paged?${query}`)
      expect(response.status).toBe(200)
      const page = FileListResponseSchema.parse(await response.json())
      actual.push(...page.items.map(entry => entry.name))
      cursor = page.nextCursor
    } while (cursor !== null)

    expect(actual).toEqual(expected)
    expect(new Set(actual).size).toBe(actual.length)
  })

  test('every link walks through deterministic bounded pages as its own entry', async () => {
    const firstResponse = await app.request('/v1/files?list=1&limit=2')
    expect(firstResponse.status).toBe(200)
    const firstJson = await firstResponse.json()
    const first = FileListResponseSchema.parse(firstJson)
    expect(first.items.map(entry => entry.name)).toEqual(['docs', 'link-dangling'])
    expect(first.nextCursor).not.toBeNull()

    const secondResponse = await app.request(
      `/v1/files?list=1&limit=100&cursor=${encodeURIComponent(first.nextCursor!)}`,
    )
    expect(secondResponse.status).toBe(200)
    const second = FileListResponseSchema.parse(await secondResponse.json())
    expect(second.nextCursor).toBeNull()
    const entries = [...first.items, ...second.items]
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    expect(byName.get('link-file')).toMatchObject({
      type: 'symlink',
      target: 'notes.txt',
      size: Buffer.byteLength('notes.txt'),
    })
    expect(byName.get('link-dir')).toMatchObject({ type: 'symlink', target: 'docs' })
    expect(byName.get('link-dangling')).toMatchObject({ type: 'symlink', target: 'missing.txt' })
    expect(byName.get('link-escape')).toMatchObject({
      type: 'symlink',
      target: join(tempDir, 'outside.txt'),
    })
    expect(byName.get('notes.txt')).toMatchObject({ type: 'file', size: 11 })
    expect(byName.get('docs')).toMatchObject({ type: 'directory' })
    expect(firstJson as Record<string, unknown>).not.toHaveProperty('entries')
  })

  test('cursor is opaque, directory-bound, subject-bound, and rejects old or malformed input', async () => {
    const first = FileListResponseSchema.parse(
      await (await app.request('/v1/files?list=1&limit=1')).json(),
    )
    expect(first.nextCursor).not.toBeNull()
    expect(first.nextCursor).not.toContain('docs')

    for (const url of [
      '/v1/files?list=1&cursor=not-a-cursor',
      `/v1/files/docs?list=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ]) {
      const response = await app.request(url)
      expect(response.status, url).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_cursor' })
    }

    for (const url of ['/v1/files?list=1&limit=101', '/v1/files?list=1&entries=1']) {
      const response = await app.request(url)
      expect(response.status, url).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    }

    const otherSubject = new Hono().route(
      '/v1/files',
      createFilesRoutes({
        driveDir,
        tempDir: join(driveDir, '.duet', 'uploads'),
        diskGuard: { ensureWritable: async () => 'ok' },
        cursorSubject: 'workspace:other',
      }),
    )
    const rebound = await otherSubject.request(
      `/v1/files?list=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
    )
    expect(rebound.status).toBe(400)
    expect(await rebound.json()).toEqual({ error: 'invalid_cursor' })
  })

  test('keyset continuation remains duplicate-free when the directory mutates between pages', async () => {
    const first = FileListResponseSchema.parse(
      await (await app.request('/v1/files?list=1&limit=2')).json(),
    )
    await writeFile(join(driveDir, 'aaa-before-cursor'), 'before')
    await writeFile(join(driveDir, 'middle-after-cursor'), 'after')

    const second = FileListResponseSchema.parse(
      await (
        await app.request(
          `/v1/files?list=1&limit=100&cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).json(),
    )
    const walked = [...first.items, ...second.items].map(entry => entry.name)
    expect(new Set(walked).size).toBe(walked.length)
    expect(walked).toContain('middle-after-cursor')
    expect(walked).not.toContain('aaa-before-cursor')
  })

  test('stat reports the link itself with the link mtime, not the target', async () => {
    for (const [name, target] of [
      ['link-file', 'notes.txt'],
      ['link-dir', 'docs'],
      ['link-dangling', 'missing.txt'],
      ['link-escape', join(tempDir, 'outside.txt')],
    ] as const) {
      const response = await app.request(`/v1/files/${name}?stat=1`)
      expect(response.status, name).toBe(200)
      const { entry } = FileStatResponseSchema.parse(await response.json())
      expect(entry).toMatchObject({
        name,
        path: name,
        type: 'symlink',
        target,
        size: Buffer.byteLength(target),
      })
      const linkInfo = await lstat(join(driveDir, name))
      expect(entry.mtime).toBe(linkInfo.mtime.toISOString())
    }
  })
})

describe('GET reads through a link only while containment holds', () => {
  test('a healthy link serves the target byte-for-byte: same ETag, ranges, conditionals', async () => {
    const direct = await app.request('/v1/files/notes.txt')
    const throughLink = await app.request('/v1/files/link-file')
    expect(throughLink.status).toBe(200)
    expect(await throughLink.text()).toBe('hello world')
    expect(throughLink.headers.get('etag')).toBe(direct.headers.get('etag'))
    expect(throughLink.headers.get('content-length')).toBe('11')

    const ranged = await app.request('/v1/files/link-file', {
      headers: { range: 'bytes=0-4' },
    })
    expect(ranged.status).toBe(206)
    expect(await ranged.text()).toBe('hello')
    expect(ranged.headers.get('content-range')).toBe('bytes 0-4/11')
  })

  test('dangling and escaping links fail typed with the verbatim target', async () => {
    const dangling = await app.request('/v1/files/link-dangling')
    expect(dangling.status).toBe(409)
    expect(await dangling.json()).toEqual({
      error: 'symlink_unresolvable',
      target: 'missing.txt',
    })

    const escaping = await app.request('/v1/files/link-escape')
    expect(escaping.status).toBe(409)
    expect(await escaping.json()).toEqual({
      error: 'symlink_unresolvable',
      target: join(tempDir, 'outside.txt'),
    })
  })

  test('a plain GET on a directory link behaves like a GET on a directory', async () => {
    const response = await app.request('/v1/files/link-dir')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'not_file' })
  })

  test('listings never follow links, whatever the target type', async () => {
    for (const name of ['link-dir', 'link-file', 'link-dangling', 'link-escape']) {
      const response = await app.request(`/v1/files/${name}?list=1`)
      expect(response.status, name).toBe(409)
      expect(await response.json()).toEqual({ error: 'path_is_symlink' })
    }
  })

  test('directory links in intermediate segments resolve normally while contained', async () => {
    const read = await app.request('/v1/files/link-dir/inner.txt')
    expect(read.status).toBe(200)
    expect(await read.text()).toBe('inner')
  })
})

describe('PUT never acts through or replaces a link', () => {
  test('a pre-planted link at the final path fails typed and leaves the target untouched', async () => {
    for (const name of ['link-file', 'link-dir', 'link-dangling', 'link-escape']) {
      const response = await app.request(`/v1/files/${name}`, {
        method: 'PUT',
        body: 'clobber',
      })
      expect(response.status, name).toBe(409)
      expect(await response.json()).toEqual({ error: 'path_is_symlink' })
      expect((await lstat(join(driveDir, name))).isSymbolicLink(), name).toBe(true)
    }
    expect(await readFile(join(driveDir, 'notes.txt'), 'utf8')).toBe('hello world')
    expect(await readFile(join(tempDir, 'outside.txt'), 'utf8')).toBe('secret')
  })

  test('a PUT through an intermediate directory link lands inside the resolved directory', async () => {
    const response = await app.request('/v1/files/link-dir/put.txt', {
      method: 'PUT',
      body: 'through',
    })
    expect(response.status).toBe(200)
    expect(await readFile(join(driveDir, 'docs', 'put.txt'), 'utf8')).toBe('through')
  })
})

describe('mkdir and the symlink operation apply final-component discipline', () => {
  test('mkdir addressed at a link fails typed — even a link to a directory', async () => {
    for (const name of ['link-dir', 'link-dangling']) {
      const response = await action({ operation: 'mkdir', path: name })
      expect(response.status, name).toBe(409)
      expect(await response.json()).toEqual({ error: 'path_is_symlink' })
    }
  })

  test('symlink creates, round-trips via stat, and upserts same-type only', async () => {
    const created = await action({ operation: 'symlink', path: 'current', target: 'docs' })
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({ ok: true, affectedEntries: 1 })
    expect(await readlink(join(driveDir, 'current'))).toBe('docs')

    const statted = await app.request('/v1/files/current?stat=1')
    const { entry } = FileStatResponseSchema.parse(await statted.json())
    expect(entry).toMatchObject({ type: 'symlink', target: 'docs' })

    // Retarget: replacing an existing symlink is the upsert path.
    const retargeted = await action({ operation: 'symlink', path: 'current', target: 'notes.txt' })
    expect(retargeted.status).toBe(200)
    expect(await readlink(join(driveDir, 'current'))).toBe('notes.txt')

    // Any other entry type conflicts; cross-type replace is delete-then-create.
    for (const path of ['notes.txt', 'docs']) {
      const conflicted = await action({ operation: 'symlink', path, target: 'anywhere' })
      expect(conflicted.status, path).toBe(409)
      expect(await conflicted.json()).toEqual({ error: 'path_exists' })
    }

    const orphaned = await action({ operation: 'symlink', path: 'no/such/parent', target: 'x' })
    expect(orphaned.status).toBe(409)
    expect(await orphaned.json()).toEqual({ error: 'parent_not_found' })

    const empty = await action({ operation: 'symlink', path: 'empty', target: '' })
    expect(empty.status).toBe(400)
  })

  test('dangling and escaping targets are legal to store, never readable through', async () => {
    const stored = await action({ operation: 'symlink', path: 'later', target: 'not-yet-here' })
    expect(stored.status).toBe(200)
    const read = await app.request('/v1/files/later')
    expect(read.status).toBe(409)
    expect(await read.json()).toEqual({ error: 'symlink_unresolvable', target: 'not-yet-here' })

    // The target becomes readable the moment it exists — no state was cached.
    await writeFile(join(driveDir, 'not-yet-here'), 'arrived')
    const readAgain = await app.request('/v1/files/later')
    expect(readAgain.status).toBe(200)
    expect(await readAgain.text()).toBe('arrived')
  })
})

describe('DELETE removes the link, never the target', () => {
  test('every link kind is deletable and the targets survive', async () => {
    for (const name of ['link-file', 'link-dir', 'link-dangling', 'link-escape']) {
      const response = await app.request(`/v1/files/${name}`, { method: 'DELETE' })
      expect(response.status, name).toBe(200)
      await expect(lstat(join(driveDir, name))).rejects.toThrow()
    }
    expect(await readFile(join(driveDir, 'notes.txt'), 'utf8')).toBe('hello world')
    expect((await stat(join(driveDir, 'docs'))).isDirectory()).toBe(true)
    expect(await readFile(join(tempDir, 'outside.txt'), 'utf8')).toBe('secret')
  })

  test('a recursive delete removes embedded links as entries, never target trees', async () => {
    await mkdir(join(driveDir, 'bundle'))
    await writeFile(join(driveDir, 'bundle', 'a.txt'), 'a')
    await symlink('../docs', join(driveDir, 'bundle', 'to-docs'))
    await symlink(join(tempDir, 'outside.txt'), join(driveDir, 'bundle', 'to-outside'))

    const response = await action({ operation: 'delete', path: 'bundle', recursive: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    await expect(lstat(join(driveDir, 'bundle'))).rejects.toThrow()
    expect(await readFile(join(driveDir, 'docs', 'inner.txt'), 'utf8')).toBe('inner')
    expect(await readFile(join(tempDir, 'outside.txt'), 'utf8')).toBe('secret')
  })
})

describe('move and copy treat links as ordinary entries with verbatim targets', () => {
  test('moving a link moves the link itself — dangling links included', async () => {
    const moved = await action({ operation: 'move', source: 'link-file', destination: 'renamed' })
    expect(moved.status).toBe(200)
    expect(await readlink(join(driveDir, 'renamed'))).toBe('notes.txt')

    const dangled = await action({
      operation: 'move',
      source: 'link-dangling',
      destination: 'still-dangling',
    })
    expect(dangled.status).toBe(200)
    expect(await readlink(join(driveDir, 'still-dangling'))).toBe('missing.txt')
  })

  test('a link destination is a real collision: path_exists without overwrite', async () => {
    const refused = await action({
      operation: 'move',
      source: 'notes.txt',
      destination: 'link-dangling',
    })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'path_exists' })

    const replaced = await action({
      operation: 'move',
      source: 'notes.txt',
      destination: 'link-dangling',
      overwrite: true,
    })
    expect(replaced.status).toBe(200)
    expect((await lstat(join(driveDir, 'link-dangling'))).isSymbolicLink()).toBe(false)
    expect(await readFile(join(driveDir, 'link-dangling'), 'utf8')).toBe('hello world')
  })

  test('copying a single link reproduces it without requiring recursive', async () => {
    const copied = await action({ operation: 'copy', source: 'link-dir', destination: 'dir-copy' })
    expect(copied.status).toBe(200)
    expect(await copied.json()).toEqual({ ok: true, affectedEntries: 1 })
    expect(await readlink(join(driveDir, 'dir-copy'))).toBe('docs')
  })

  test('a recursive copy reproduces embedded links verbatim; relative targets may dangle at the destination', async () => {
    await mkdir(join(driveDir, 'tree', 'sub'), { recursive: true })
    await writeFile(join(driveDir, 'tree', 'real.txt'), 'real')
    await symlink('real.txt', join(driveDir, 'tree', 'sibling'))
    await symlink('../notes.txt', join(driveDir, 'tree', 'sub', 'up'))
    await symlink(join(tempDir, 'outside.txt'), join(driveDir, 'tree', 'out'))

    const copied = await action({
      operation: 'copy',
      source: 'tree',
      destination: 'docs/tree-copy',
      recursive: true,
    })
    expect(copied.status).toBe(200)
    expect(await readlink(join(driveDir, 'docs', 'tree-copy', 'sibling'))).toBe('real.txt')
    expect(await readlink(join(driveDir, 'docs', 'tree-copy', 'sub', 'up'))).toBe('../notes.txt')
    expect(await readlink(join(driveDir, 'docs', 'tree-copy', 'out'))).toBe(
      join(tempDir, 'outside.txt'),
    )
    // '../notes.txt' now resolves to docs/notes.txt, which does not exist —
    // reinterpreted at the destination, legal to dangle.
    const reinterpreted = await app.request('/v1/files/docs/tree-copy/sub/up')
    expect(reinterpreted.status).toBe(409)
  })
})
