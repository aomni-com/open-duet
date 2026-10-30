import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import { normalizeDriveUrlPath } from '@repo/contract'

import { createFilesRoutes, rawUrlPathname } from './files'

let rootDir: string
let driveDir: string
let videoPath: string
let app: Hono

function absoluteWirePath(path: string): string {
  return `%2F${path.slice(1).split('/').map(encodeURIComponent).join('/')}`
}

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'duet-absolute-path-'))
  driveDir = join(rootDir, 'custom live-drive')
  videoPath = join(driveDir, 'media', 'probe clip.mp4')
  await mkdir(join(driveDir, 'media'), { recursive: true })
  await mkdir(join(driveDir, '-old', 'media'), { recursive: true })
  await mkdir(join(driveDir, '.duet'), { recursive: true })
  await mkdir(`${driveDir}-old/media`, { recursive: true })
  await mkdir(join(rootDir, 'outside'), { recursive: true })
  await writeFile(videoPath, '0123456789')
  await writeFile(join(driveDir, '-old', 'media', 'probe.mp4'), 'prefix-boundary bait')
  await writeFile(`${driveDir}-old/media/probe.mp4`, 'sibling secret')
  await writeFile(join(driveDir, '.duet', 'secret'), 'secret')
  await writeFile(join(rootDir, 'outside', 'secret'), 'outside')
  await symlink(join(rootDir, 'outside'), join(driveDir, 'escape'))
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

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

describe('absolute workspace file path transport', () => {
  test('the selected wire path is outside the relative URL contract but serves under the live drive', async () => {
    const wirePath = absoluteWirePath(videoPath)
    const requestUrl = `http://gateway.test/v1/files/${wirePath}`
    const rawPathname = rawUrlPathname(requestUrl)
    const parserInput = rawPathname.slice('/v1/files/'.length)

    expect(rawPathname).toBe(`/v1/files/${wirePath}`)
    expect(parserInput).toBe(wirePath)
    expect(normalizeDriveUrlPath(parserInput)).toEqual({ ok: false, reason: 'decode_error' })

    const response = await app.request(requestUrl)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('0123456789')
  })

  test('relative and absolute reads return the same bytes and security metadata', async () => {
    const relative = await app.request('/v1/files/media/probe%20clip.mp4')
    const absolute = await app.request(`/v1/files/${absoluteWirePath(videoPath)}`)

    expect(relative.status).toBe(200)
    expect(absolute.status).toBe(200)
    expect(await absolute.text()).toBe(await relative.text())
    for (const header of [
      'content-type',
      'content-security-policy',
      'x-content-type-options',
      'etag',
    ]) {
      expect(absolute.headers.get(header), header).toBe(relative.headers.get(header))
    }
    expect(absolute.headers.get('content-type')).toBe('video/mp4')
    expect(absolute.headers.get('content-security-policy')).toBe('sandbox')
    expect(absolute.headers.get('x-content-type-options')).toBe('nosniff')
    expect(absolute.headers.get('etag')).not.toBeNull()

    const relativeStat = await app.request('/v1/files/media/probe%20clip.mp4?stat=1')
    const absoluteStat = await app.request(`/v1/files/${absoluteWirePath(videoPath)}?stat=1`)
    expect(absoluteStat.status).toBe(200)
    expect(await absoluteStat.json()).toEqual(await relativeStat.json())
  })

  test('the exact live drive root lists while an absolute video supports ranges', async () => {
    const listing = await app.request(`/v1/files/${absoluteWirePath(driveDir)}?list=1`)
    expect(listing.status).toBe(200)
    const listingBody = (await listing.json()) as {
      items: Array<{ name: string; type: string }>
    }
    expect(listingBody.items.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: '-old', type: 'directory' },
      { name: 'escape', type: 'symlink' },
      { name: 'media', type: 'directory' },
    ])

    const ranged = await app.request(`/v1/files/${absoluteWirePath(videoPath)}`, {
      headers: { range: 'bytes=2-5' },
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(ranged.headers.get('accept-ranges')).toBe('bytes')
    expect(await ranged.text()).toBe('2345')
  })

  test('outside, sibling-prefix, malformed, reserved, traversal, and symlink escapes are 404', async () => {
    const siblingPath = `${driveDir}-old/media/probe.mp4`
    const traversalPath = `${absoluteWirePath(driveDir)}/%2e%2e/outside/secret`
    const nulPath = `${absoluteWirePath(driveDir)}/safe/%00/secret`
    const reservedPath = `${absoluteWirePath(driveDir)}/.duet/secret`
    const symlinkEscapePath = `${absoluteWirePath(driveDir)}/escape/secret`

    for (const wirePath of [
      absoluteWirePath(join(rootDir, 'outside', 'secret')),
      absoluteWirePath(siblingPath),
      traversalPath,
      nulPath,
      reservedPath,
      symlinkEscapePath,
    ]) {
      const response = await app.request(`/v1/files/${wirePath}`)
      expect(response.status, wirePath).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }
  })

  test('absolute reads decode percent-bearing identities exactly once', async () => {
    await writeFile(join(driveDir, '100%.pdf'), 'literal percent')
    await writeFile(join(driveDir, 'a%2Fb'), 'encoded-looking separator')

    const percent = await app.request(`/v1/files/${absoluteWirePath(join(driveDir, '100%.pdf'))}`)
    const encodedSeparator = await app.request(
      `/v1/files/${absoluteWirePath(join(driveDir, 'a%2Fb'))}`,
    )

    expect(percent.status).toBe(200)
    expect(await percent.text()).toBe('literal percent')
    expect(encodedSeparator.status).toBe(200)
    expect(await encodedSeparator.text()).toBe('encoded-looking separator')
  })

  test('absolute paths do not widen PUT, DELETE, or JSON action bodies', async () => {
    const put = await app.request(`/v1/files/${absoluteWirePath(join(driveDir, 'new.txt'))}`, {
      method: 'PUT',
      body: 'no',
    })
    expect(put.status).toBe(404)

    const deleteResponse = await app.request(`/v1/files/${absoluteWirePath(videoPath)}`, {
      method: 'DELETE',
    })
    expect(deleteResponse.status).toBe(404)

    const action = await app.request('/v1/files/actions', {
      method: 'POST',
      body: JSON.stringify({
        operation: 'mkdir',
        path: join(driveDir, 'new-dir'),
        recursive: false,
      }),
    })
    expect(action.status).toBe(404)
  })
})
