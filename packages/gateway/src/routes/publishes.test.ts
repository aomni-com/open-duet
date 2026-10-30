import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import {
  DUET_PUBLISH_ANCHOR_PATH_HEADER,
  DUET_PUBLISH_FREEZE_HEADER,
  DUET_PUBLISH_KIND_HEADER,
  serializePublishFreezeHeader,
} from '@repo/contract'

import { createFrozenPublishSnapshot } from '../publishes/frozen-snapshot'
import { createPublishesControlRoutes, createPublishesRoutes } from './publishes'

let tempDir: string
let driveDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'duet-publishes-'))
  driveDir = join(tempDir, 'drive')
  await mkdir(driveDir, { recursive: true })
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function mountApp(): Hono {
  const app = new Hono()
  app.route(
    '/public/publish',
    createPublishesRoutes({
      driveDir,
      stateDir: join(tempDir, '.duet'),
    }),
  )
  return app
}

function mountControlApp(): Hono {
  const app = new Hono()
  app.route(
    '/v1/publishes',
    createPublishesControlRoutes({
      driveDir,
      stateDir: join(tempDir, '.duet'),
    }),
  )
  return app
}

// PNG signature + a bit of payload so image bytes are unmistakably binary.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6])

async function seedSite(): Promise<void> {
  const site = join(driveDir, 'site')
  await mkdir(join(site, 'deep'), { recursive: true })
  await writeFile(join(site, 'index.html'), '<h1>hi</h1>')
  await writeFile(join(site, 'icon.svg'), '<svg><script>1</script></svg>')
  await writeFile(join(site, 'style.css'), 'body{}')
  await writeFile(join(site, 'data.json'), '{"a":1}')
  await writeFile(join(site, 'notes.md'), '# notes')
  await writeFile(join(site, 'empty.txt'), '')
  await writeFile(join(site, 'blob.bin'), PNG_BYTES)
  await writeFile(join(site, 'image.png'), PNG_BYTES)
  await writeFile(join(site, 'deep', 'note.md'), 'nested')
  await writeFile(join(site, '.env'), 'SECRET=1')
  await writeFile(join(site, '.notes'), 'hidden')
  await symlink('deep', join(site, 'linkdir'))
}

function folderHeaders(): Record<string, string> {
  return {
    [DUET_PUBLISH_KIND_HEADER]: 'folder',
    [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'site',
  }
}

function frozenFolderHeaders(generation = 'gen-1'): Record<string, string> {
  return {
    ...folderHeaders(),
    [DUET_PUBLISH_FREEZE_HEADER]: serializePublishFreezeHeader({
      publishId: 'publish-1',
      generation,
    }),
  }
}

test('?raw serves a text-like file as text/plain source (svg included), never rendered', async () => {
  await seedSite()
  const app = mountApp()

  const svg = await app.request('http://x/public/publish/icon.svg?raw', {
    headers: folderHeaders(),
  })
  expect(svg.status).toBe(200)
  expect(svg.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(await svg.text()).toBe('<svg><script>1</script></svg>')

  const html = await app.request('http://x/public/publish/index.html?raw', {
    headers: folderHeaders(),
  })
  expect(html.status).toBe(200)
  expect(html.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(await html.text()).toBe('<h1>hi</h1>')
})

test('?raw keeps real media types and byte ranges; unknown binary stays octet-stream', async () => {
  await seedSite()
  const app = mountApp()

  const png = await app.request('http://x/public/publish/image.png?raw', {
    headers: { ...folderHeaders(), range: 'bytes=0-3' },
  })
  expect(png.status).toBe(206)
  expect(png.headers.get('content-type')).toBe('image/png')
  expect(png.headers.get('content-range')).toBe(`bytes 0-3/${PNG_BYTES.length}`)
  expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG_BYTES.slice(0, 4))

  const full = await app.request('http://x/public/publish/image.png?raw', {
    headers: folderHeaders(),
  })
  expect(full.status).toBe(200)
  expect(full.headers.get('etag')).not.toBeNull()
  expect(full.headers.get('content-security-policy')).toBe('sandbox')
  expect(full.headers.get('x-content-type-options')).toBe('nosniff')

  const blob = await app.request('http://x/public/publish/blob.bin?raw', {
    headers: folderHeaders(),
  })
  expect(blob.status).toBe(200)
  expect(blob.headers.get('content-type')).toBe('application/octet-stream')
})

test('?raw on an empty file returns 200 with zero-length text/plain', async () => {
  await seedSite()
  const app = mountApp()
  const res = await app.request('http://x/public/publish/empty.txt?raw', {
    headers: folderHeaders(),
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(res.headers.get('content-length')).toBe('0')
  expect(await res.text()).toBe('')
})

test('?list returns sorted publish-root-projected entries; dotfiles listed, floor excluded', async () => {
  await seedSite()
  const app = mountApp()
  const res = await app.request('http://x/public/publish?list', { headers: folderHeaders() })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    items: Array<{ name: string; path: string; type: string }>
  }
  const names = body.items.map(e => e.name)
  expect(names).toEqual([
    '.notes',
    'blob.bin',
    'data.json',
    'deep',
    'empty.txt',
    'icon.svg',
    'image.png',
    'index.html',
    'linkdir',
    'notes.md',
    'style.css',
  ])
  // The serving floor never appears in a public listing; ordinary dotfiles do
  // (hiding them is the viewer's presentation default, not a serving policy).
  expect(names).not.toContain('.env')
  // Paths are projected into the publish-root namespace (no `site/` prefix).
  expect(body.items.find(e => e.name === 'index.html')?.path).toBe('index.html')
  expect(body.items.find(e => e.name === 'deep')?.path).toBe('deep')
  // A directory symlink is listed as its own symlink entry, never followed.
  expect(body.items.find(e => e.name === 'linkdir')?.type).toBe('symlink')
})

test('?list on a nested directory projects child paths under the publish root', async () => {
  await seedSite()
  const app = mountApp()
  const res = await app.request('http://x/public/publish/deep?list', { headers: folderHeaders() })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { items: Array<{ name: string; path: string }> }
  expect(body.items.map(e => ({ name: e.name, path: e.path }))).toEqual([
    { name: 'note.md', path: 'deep/note.md' },
  ])
})

test('folder publishes preserve literal percent filenames as identities distinct from nested paths', async () => {
  await seedSite()
  const site = join(driveDir, 'site')
  await writeFile(join(site, '100%.txt'), 'literal percent')
  await writeFile(join(site, 'a%2Fb'), 'encoded-looking name')
  await mkdir(join(site, 'a'), { recursive: true })
  await writeFile(join(site, 'a', 'b'), 'nested path')
  const app = mountApp()

  for (const [url, body] of [
    ['http://x/public/publish/100%25.txt?raw', 'literal percent'],
    ['http://x/public/publish/a%252Fb?raw', 'encoded-looking name'],
    ['http://x/public/publish/a/b?raw', 'nested path'],
  ] as const) {
    const response = await app.request(url, { headers: folderHeaders() })
    expect(response.status, url).toBe(200)
    expect(await response.text(), url).toBe(body)
  }

  const listing = await app.request('http://x/public/publish?list', { headers: folderHeaders() })
  expect(listing.status).toBe(200)
  const listed = (await listing.json()) as {
    items: Array<{ name: string; path: string; type: string }>
  }
  expect(listed.items.map(({ name, path, type }) => ({ name, path, type }))).toEqual(
    expect.arrayContaining([
      { name: '100%.txt', path: '100%.txt', type: 'file' },
      { name: 'a%2Fb', path: 'a%2Fb', type: 'file' },
      { name: 'a', path: 'a', type: 'directory' },
    ]),
  )
})

test('file publish headers treat percent-looking paths as logical identity', async () => {
  const docs = join(driveDir, 'docs')
  await mkdir(docs, { recursive: true })
  await writeFile(join(docs, 'a%2Fb.md'), 'literal header path')
  await mkdir(join(docs, 'a'), { recursive: true })
  await writeFile(join(docs, 'a', 'b.md'), 'nested header path')
  const app = mountApp()

  const response = await app.request('http://x/public/publish?raw', {
    headers: {
      [DUET_PUBLISH_KIND_HEADER]: 'file',
      [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'docs/a%2Fb.md',
    },
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('literal header path')
})

test('selectors are mutually exclusive and mandatory', async () => {
  await seedSite()
  const app = mountApp()

  const both = await app.request('http://x/public/publish/index.html?raw&list', {
    headers: folderHeaders(),
  })
  expect(both.status).toBe(400)
  expect(await both.json()).toEqual({ error: 'invalid_selector' })

  const none = await app.request('http://x/public/publish/index.html', {
    headers: folderHeaders(),
  })
  expect(none.status).toBe(400)
  expect(await none.json()).toEqual({ error: 'invalid_selector' })
})

test('?list on a file and ?raw on a directory are typed failures', async () => {
  await seedSite()
  const app = mountApp()

  const listFile = await app.request('http://x/public/publish/index.html?list', {
    headers: folderHeaders(),
  })
  expect(listFile.status).toBe(409)

  const rawDir = await app.request('http://x/public/publish/deep?raw', { headers: folderHeaders() })
  expect(rawDir.status).toBe(409)
})

test('directory symlinks are not followed for a ?list', async () => {
  await seedSite()
  const app = mountApp()
  const res = await app.request('http://x/public/publish/linkdir?list', {
    headers: folderHeaders(),
  })
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: 'path_is_symlink' })
})

test('.env* is rejected on ?raw as defense-in-depth beneath the dotfile filter', async () => {
  await seedSite()
  const app = mountApp()
  const env = await app.request('http://x/public/publish/.env?raw', { headers: folderHeaders() })
  expect(env.status).toBe(404)
})

test('traversal, encoded traversal, absolute paths, and missing paths are rejected', async () => {
  await seedSite()
  await writeFile(join(driveDir, 'site', 'safe%2F..%2Fsecret'), 'must not serve')
  await writeFile(join(driveDir, 'site', 'safe%5C..%5Csecret'), 'must not serve')
  const app = mountApp()

  const dotdot = await app.request('http://x/public/publish/../secret?raw', {
    headers: folderHeaders(),
  })
  expect(dotdot.status).toBe(404)

  const encoded = await app.request('http://x/public/publish/%2e%2e/secret?raw', {
    headers: folderHeaders(),
  })
  expect(encoded.status).toBe(404)

  for (const url of [
    'http://x/public/publish/safe%2F..%2Fsecret?raw',
    'http://x/public/publish/safe%5C..%5Csecret?raw',
  ]) {
    const encodedSeparator = await app.request(url, { headers: folderHeaders() })
    expect(encodedSeparator.status, url).toBe(404)
  }

  const missing = await app.request('http://x/public/publish/nope.md?raw', {
    headers: folderHeaders(),
  })
  expect(missing.status).toBe(404)
})

test('a file-kind publish serves the anchor file and refuses nested paths and ?list', async () => {
  const docs = join(driveDir, 'docs')
  await mkdir(docs, { recursive: true })
  await writeFile(join(docs, 'report.md'), '# report')
  const app = mountApp()
  const fileHeaders = {
    [DUET_PUBLISH_KIND_HEADER]: 'file',
    [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'docs/report.md',
  }

  const raw = await app.request('http://x/public/publish?raw', { headers: fileHeaders })
  expect(raw.status).toBe(200)
  expect(raw.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(await raw.text()).toBe('# report')

  const list = await app.request('http://x/public/publish?list', { headers: fileHeaders })
  expect(list.status).toBe(409)

  const nested = await app.request('http://x/public/publish/other.md?raw', { headers: fileHeaders })
  expect(nested.status).toBe(404)
})

test('ordinary dotfiles serve on ?raw; the floor (.git, node_modules, .duet-anchor) stays 404', async () => {
  await seedSite()
  const site = join(driveDir, 'site')
  await mkdir(join(site, '.git'), { recursive: true })
  await writeFile(join(site, '.git', 'config'), '[core]')
  await mkdir(join(site, '.agents', 'skills'), { recursive: true })
  await writeFile(join(site, '.agents', 'skills', 'SKILL.md'), '# skill')
  await mkdir(join(site, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(site, 'node_modules', 'pkg', 'index.js'), 'x')
  await writeFile(join(site, '.duet-anchor'), 'duet-anchor:v1:a:b\n')
  const app = mountApp()

  const notes = await app.request('http://x/public/publish/.notes?raw', {
    headers: folderHeaders(),
  })
  expect(notes.status).toBe(200)
  expect(await notes.text()).toBe('hidden')
  const skill = await app.request('http://x/public/publish/.agents/skills/SKILL.md?raw', {
    headers: folderHeaders(),
  })
  expect(skill.status).toBe(200)
  expect(await skill.text()).toBe('# skill')

  for (const url of [
    'http://x/public/publish/.git/config?raw',
    'http://x/public/publish/.git?list',
    'http://x/public/publish/node_modules/pkg/index.js?raw',
    'http://x/public/publish/.duet-anchor?raw',
  ]) {
    const response = await app.request(url, { headers: folderHeaders() })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  }
})

test('a file symlink cannot escape the anchor subtree or unhide dotfiles', async () => {
  await seedSite()
  const site = join(driveDir, 'site')
  await writeFile(join(driveDir, 'outside.txt'), 'workspace secret')
  await symlink(join('..', 'outside.txt'), join(site, 'escape.txt'))
  await symlink('.env', join(site, 'config.txt'))
  const app = mountApp()
  for (const url of [
    'http://x/public/publish/escape.txt?raw',
    'http://x/public/publish/config.txt?raw',
  ]) {
    const response = await app.request(url, { headers: folderHeaders() })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  }
  // In-anchor, visible-target read-through keeps working.
  await symlink('notes.md', join(site, 'alias.txt'))
  const ok = await app.request('http://x/public/publish/alias.txt?raw', {
    headers: folderHeaders(),
  })
  expect(ok.status).toBe(200)
  expect(await ok.text()).toBe('# notes')
})

test('handler-level traversal probes are 404s from the handler, not route misses', async () => {
  await seedSite()
  await writeFile(join(driveDir, 'secret.txt'), 'no')
  const app = mountApp()
  // Double-encoded traversal survives framework URL normalization and reaches
  // the handler; the drive-path normalizer decodes and rejects it.
  const doubleEncoded = await app.request('http://x/public/publish/%252e%252e/secret.txt?raw', {
    headers: folderHeaders(),
  })
  expect(doubleEncoded.status).toBe(404)
  expect(await doubleEncoded.json()).toEqual({ error: 'not_found' })
  const hostileAnchor = await app.request('http://x/public/publish/index.html?raw', {
    headers: {
      [DUET_PUBLISH_KIND_HEADER]: 'folder',
      [DUET_PUBLISH_ANCHOR_PATH_HEADER]: '../secret',
    },
  })
  expect(hostileAnchor.status).toBe(404)
  expect(await hostileAnchor.json()).toEqual({ error: 'not_found' })
})

test('an intermediate directory symlink cannot leak files outside the anchor', async () => {
  await seedSite()
  const site = join(driveDir, 'site')
  await mkdir(join(driveDir, 'private', 'inner'), { recursive: true })
  await writeFile(join(driveDir, 'private', 'secret.txt'), 'WORKSPACE SECRET')
  await writeFile(join(driveDir, 'private', 'inner', 'deep.txt'), 'deeper secret')
  // A directory symlink inside the published folder pointing outside the anchor.
  await symlink(join('..', 'private'), join(site, 'assets'))
  const app = mountApp()

  // A regular file reached through the intermediate directory symlink.
  const raw = await app.request('http://x/public/publish/assets/secret.txt?raw', {
    headers: folderHeaders(),
  })
  expect(raw.status).toBe(404)
  expect(await raw.json()).toEqual({ error: 'not_found' })

  // A directory listing reached through the intermediate directory symlink.
  const list = await app.request('http://x/public/publish/assets/inner?list', {
    headers: folderHeaders(),
  })
  expect(list.status).toBe(404)
})

test('?zip archives the served subtree: dotfiles in, floor and symlinks out', async () => {
  await seedSite()
  const site = join(driveDir, 'site')
  await mkdir(join(site, '.agents', 'skills'), { recursive: true })
  await writeFile(join(site, '.agents', 'skills', 'SKILL.md'), '# skill')
  await mkdir(join(site, '.git'), { recursive: true })
  await writeFile(join(site, '.git', 'config'), '[core]')
  const app = mountApp()
  const res = await app.request('http://x/public/publish?zip', { headers: folderHeaders() })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/zip')
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="site.zip"')
  expect(res.headers.get('etag')).not.toBeNull()

  const { unzipSync } = await import('fflate')
  const entries = unzipSync(new Uint8Array(await res.arrayBuffer()))
  expect(Object.keys(entries).sort()).toEqual([
    '.agents/skills/SKILL.md',
    '.notes',
    'blob.bin',
    'data.json',
    'deep/note.md',
    'empty.txt',
    'icon.svg',
    'image.png',
    'index.html',
    'notes.md',
    'style.css',
  ])
  expect(new TextDecoder().decode(entries['.agents/skills/SKILL.md'])).toBe('# skill')
  expect(new TextDecoder().decode(entries['deep/note.md'])).toBe('nested')
  expect(new Uint8Array(entries['image.png']!)).toEqual(PNG_BYTES)
})

test('?zip etag is stable, honors if-none-match with 304, and moves when content changes', async () => {
  await seedSite()
  const app = mountApp()
  const first = await app.request('http://x/public/publish?zip', { headers: folderHeaders() })
  const etag = first.headers.get('etag')!
  await first.arrayBuffer()
  const second = await app.request('http://x/public/publish?zip', { headers: folderHeaders() })
  expect(second.headers.get('etag')).toBe(etag)
  await second.arrayBuffer()

  const unchanged = await app.request('http://x/public/publish?zip', {
    headers: { ...folderHeaders(), 'if-none-match': etag },
  })
  expect(unchanged.status).toBe(304)
  expect(await unchanged.text()).toBe('')

  await writeFile(join(driveDir, 'site', 'notes.md'), '# notes v2 with more bytes')
  const changed = await app.request('http://x/public/publish?zip', {
    headers: { ...folderHeaders(), 'if-none-match': etag },
  })
  expect(changed.status).toBe(200)
  expect(changed.headers.get('etag')).not.toBe(etag)
  await changed.arrayBuffer()
})

test('frozen raw, list, zip, and ETag survive live edits and a gateway restart; unpause is live', async () => {
  await seedSite()
  const stateDir = join(tempDir, '.duet')
  await createFrozenPublishSnapshot({
    stateDir,
    driveDir,
    publishId: 'publish-1',
    generation: 'gen-1',
    anchorPath: 'site',
    kind: 'folder',
  })
  const before = mountApp()
  const frozenRaw = await before.request('http://x/public/publish/notes.md?raw', {
    headers: frozenFolderHeaders(),
  })
  const frozenList = await before.request('http://x/public/publish/deep?list', {
    headers: frozenFolderHeaders(),
  })
  const frozenZip = await before.request('http://x/public/publish?zip', {
    headers: frozenFolderHeaders(),
  })
  const liveZipAtPause = await before.request('http://x/public/publish?zip', {
    headers: folderHeaders(),
  })
  const frozenEtag = frozenZip.headers.get('etag')
  expect(await frozenRaw.text()).toBe('# notes')
  expect(await frozenList.json()).toEqual({
    items: [expect.objectContaining({ name: 'note.md', path: 'deep/note.md', type: 'file' })],
    nextCursor: null,
  })
  const { unzipSync } = await import('fflate')
  expect(Object.keys(unzipSync(new Uint8Array(await frozenZip.arrayBuffer()))).sort()).toEqual(
    Object.keys(unzipSync(new Uint8Array(await liveZipAtPause.arrayBuffer()))).sort(),
  )

  await writeFile(join(driveDir, 'site', 'notes.md'), '# live edit')
  await writeFile(join(driveDir, 'site', 'deep', 'new.md'), 'new live file')
  const restarted = mountApp()
  const afterRestart = await restarted.request('http://x/public/publish/notes.md?raw', {
    headers: frozenFolderHeaders(),
  })
  const unchangedZip = await restarted.request('http://x/public/publish?zip', {
    headers: { ...frozenFolderHeaders(), 'if-none-match': frozenEtag! },
  })
  expect(await afterRestart.text()).toBe('# notes')
  expect(unchangedZip.status).toBe(304)

  const live = await restarted.request('http://x/public/publish/notes.md?raw', {
    headers: folderHeaders(),
  })
  expect(await live.text()).toBe('# live edit')
})

test('the authenticated freeze control route confirms only after the snapshot is readable', async () => {
  await seedSite()
  const response = await mountControlApp().request('http://x/v1/publishes/freeze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publishId: 'publish-1',
      generation: 'gen-control',
      anchorPath: 'site',
      kind: 'folder',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  const frozen = await mountApp().request('http://x/public/publish/notes.md?raw', {
    headers: frozenFolderHeaders('gen-control'),
  })
  expect(await frozen.text()).toBe('# notes')
})

test('a paused publish fails closed when its shadow is missing or corrupt', async () => {
  await seedSite()
  const missing = await mountApp().request('http://x/public/publish/notes.md?raw', {
    headers: frozenFolderHeaders('missing'),
  })
  expect(missing.status).toBe(503)
  expect(await missing.json()).toEqual({ error: 'publish_snapshot_unavailable' })

  await createFrozenPublishSnapshot({
    stateDir: join(tempDir, '.duet'),
    driveDir,
    publishId: 'publish-1',
    generation: 'corrupt',
    anchorPath: 'site',
    kind: 'folder',
  })
  await writeFile(
    join(tempDir, '.duet', 'publish-snapshots', 'publish-1', 'corrupt', 'manifest.json'),
    '{broken',
  )
  const corrupt = await mountApp().request('http://x/public/publish/notes.md?raw', {
    headers: frozenFolderHeaders('corrupt'),
  })
  expect(corrupt.status).toBe(503)
  expect(await corrupt.json()).toEqual({ error: 'publish_snapshot_unavailable' })
})

test('a replacement generation serves its own newer snapshot without mutating the old one', async () => {
  await seedSite()
  const stateDir = join(tempDir, '.duet')
  await createFrozenPublishSnapshot({
    stateDir,
    driveDir,
    publishId: 'publish-1',
    generation: 'gen-1',
    anchorPath: 'site',
    kind: 'folder',
  })
  await writeFile(join(driveDir, 'site', 'notes.md'), '# generation two')
  await createFrozenPublishSnapshot({
    stateDir,
    driveDir,
    publishId: 'publish-1',
    generation: 'gen-2',
    anchorPath: 'site',
    kind: 'folder',
  })

  const app = mountApp()
  const first = await app.request('http://x/public/publish/notes.md?raw', {
    headers: frozenFolderHeaders('gen-1'),
  })
  const second = await app.request('http://x/public/publish/notes.md?raw', {
    headers: frozenFolderHeaders('gen-2'),
  })
  expect(await first.text()).toBe('# notes')
  expect(await second.text()).toBe('# generation two')
})

test('a frozen file publish serves its durable file while the live file changes', async () => {
  const reports = join(driveDir, 'reports')
  await mkdir(reports, { recursive: true })
  await writeFile(join(reports, 'q2.md'), '# frozen report')
  await createFrozenPublishSnapshot({
    stateDir: join(tempDir, '.duet'),
    driveDir,
    publishId: 'publish-file',
    generation: 'gen-file',
    anchorPath: 'reports/q2.md',
    kind: 'file',
  })
  await writeFile(join(reports, 'q2.md'), '# live report')

  const response = await mountApp().request('http://x/public/publish?raw', {
    headers: {
      [DUET_PUBLISH_KIND_HEADER]: 'file',
      [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'reports/q2.md',
      [DUET_PUBLISH_FREEZE_HEADER]: serializePublishFreezeHeader({
        publishId: 'publish-file',
        generation: 'gen-file',
      }),
    },
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('# frozen report')
})

test('?zip of a nested folder archives only that subtree; conflicts stay typed', async () => {
  await seedSite()
  const app = mountApp()
  const res = await app.request('http://x/public/publish/deep?zip', { headers: folderHeaders() })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="deep.zip"')
  const { unzipSync } = await import('fflate')
  expect(Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())))).toEqual(['note.md'])

  const onFile = await app.request('http://x/public/publish/index.html?zip', {
    headers: folderHeaders(),
  })
  expect(onFile.status).toBe(409)

  const withRaw = await app.request('http://x/public/publish?zip&raw', { headers: folderHeaders() })
  expect(withRaw.status).toBe(400)
  expect(await withRaw.json()).toEqual({ error: 'invalid_selector' })

  const onLink = await app.request('http://x/public/publish/linkdir?zip', {
    headers: folderHeaders(),
  })
  expect(onLink.status).toBe(409)
  expect(await onLink.json()).toEqual({ error: 'path_is_symlink' })
})

// The marketplace's source-URL grammar rests entirely on this: the nested path
// is joined BELOW the publish anchor. A listing publishes the agent's own
// anchor, so the archive is at the publish root and the URL carries no agent
// segment; the official hub publishes the parent folder, so its URL does. Get
// these two confused and every subscriber fetches a 404.
test('publish anchor placement decides whether the agent name is in the URL', async () => {
  const agentsDir = join(driveDir, 'agents', 'sec-triage')
  await mkdir(join(agentsDir, '.agents', 'skills', 'triage'), { recursive: true })
  await writeFile(join(agentsDir, 'AGENTS.md'), '# Sec Triage\n\nTriages alerts.')
  await writeFile(join(agentsDir, 'CHANGELOG.md'), '# Initial release')
  await writeFile(join(agentsDir, '.agents', 'skills', 'triage', 'SKILL.md'), '# triage')
  const app = mountApp()
  const headers = (anchorPath: string) => ({
    [DUET_PUBLISH_KIND_HEADER]: 'folder',
    [DUET_PUBLISH_ANCHOR_PATH_HEADER]: anchorPath,
  })
  const { unzipSync } = await import('fflate')
  const expected = ['.agents/skills/triage/SKILL.md', 'AGENTS.md', 'CHANGELOG.md']

  // A listing: anchor IS the agent folder, so the agent tree is at the root.
  const atRoot = await app.request('http://x/public/publish?zip', {
    headers: headers('agents/sec-triage'),
  })
  expect(atRoot.status).toBe(200)
  expect(Object.keys(unzipSync(new Uint8Array(await atRoot.arrayBuffer()))).sort()).toEqual(
    expected,
  )

  // …and appending the agent name to that same publish addresses
  // `agents/sec-triage/sec-triage`, which does not exist.
  const doubled = await app.request('http://x/public/publish/sec-triage?zip', {
    headers: headers('agents/sec-triage'),
  })
  expect(doubled.status).toBe(404)

  // The official hub: anchor is the parent, so the agent needs its segment.
  const viaParent = await app.request('http://x/public/publish/sec-triage?zip', {
    headers: headers('agents'),
  })
  expect(viaParent.status).toBe(200)
  expect(Object.keys(unzipSync(new Uint8Array(await viaParent.arrayBuffer()))).sort()).toEqual(
    expected,
  )
})

test('a listing publish root serves a stable etag and honours if-none-match', async () => {
  // Conditional GET is the whole efficiency story of the pull rail; if the root
  // etag were unstable every subscriber would re-download the tree every hour.
  const agentsDir = join(driveDir, 'agents', 'sec-triage')
  await mkdir(agentsDir, { recursive: true })
  await writeFile(join(agentsDir, 'AGENTS.md'), '# Sec Triage')
  const app = mountApp()
  const headers = {
    [DUET_PUBLISH_KIND_HEADER]: 'folder',
    [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'agents/sec-triage',
  }
  const first = await app.request('http://x/public/publish?zip', { headers })
  const etag = first.headers.get('etag')
  expect(etag).not.toBeNull()
  const second = await app.request('http://x/public/publish?zip', { headers })
  expect(second.headers.get('etag')).toBe(etag)
  const conditional = await app.request('http://x/public/publish?zip', {
    headers: { ...headers, 'if-none-match': etag! },
  })
  expect(conditional.status).toBe(304)

  await writeFile(join(agentsDir, 'AGENTS.md'), '# Sec Triage, revised')
  const changed = await app.request('http://x/public/publish?zip', { headers })
  expect(changed.headers.get('etag')).not.toBe(etag)
})

test('?zip survives filesystem mtimes outside the ZIP 1980-2099 range', async () => {
  await seedSite()
  const { utimes } = await import('node:fs/promises')
  const epoch = new Date(0)
  await utimes(join(driveDir, 'site', 'notes.md'), epoch, epoch)
  const app = mountApp()
  const res = await app.request('http://x/public/publish?zip', { headers: folderHeaders() })
  expect(res.status).toBe(200)
  const { unzipSync } = await import('fflate')
  const entries = unzipSync(new Uint8Array(await res.arrayBuffer()))
  expect(new TextDecoder().decode(entries['notes.md'])).toBe('# notes')
})
