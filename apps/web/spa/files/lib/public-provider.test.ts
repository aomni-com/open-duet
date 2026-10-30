import { describe, expect, test } from 'bun:test'

import type { ViewerDescriptor } from '@repo/contract'

import { PublicFileSystemProvider, PublicFileSystemReadOnlyError } from './public-provider'

const BASE = 'https://edge.duet.so/acme/site'

const FOLDER: ViewerDescriptor = {
  workspaceName: 'Acme',
  ownerName: 'Ada Lovelace',
  rootName: 'site',
  kind: 'folder',
}

const FILE: ViewerDescriptor = {
  workspaceName: 'Acme',
  ownerName: 'Ada Lovelace',
  rootName: 'report.md',
  kind: 'file',
}

// A PNG signature + payload so image bytes are unmistakably binary.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6])
const NOTE = new TextEncoder().encode('nested')
const REPORT = new TextEncoder().encode('# report')

type SeedEntry =
  | { kind: 'dir' }
  | { kind: 'file'; bytes: Uint8Array<ArrayBuffer>; contentType: string; hidden?: boolean }

// The seeded publish tree, keyed by publish-root-relative path. The stub below
// emulates the gateway's `?list`/`?raw` contract against it (dotfile filter,
// path projection, sort, ranges, typed 404/409), doubling as the workbench.
const FOLDER_TREE: Record<string, SeedEntry> = {
  '': { kind: 'dir' },
  'index.html': {
    kind: 'file',
    bytes: new TextEncoder().encode('<h1>hi</h1>'),
    contentType: 'text/plain; charset=utf-8',
  },
  'image.png': { kind: 'file', bytes: PNG, contentType: 'image/png' },
  'empty.txt': { kind: 'file', bytes: new Uint8Array(), contentType: 'text/plain; charset=utf-8' },
  '.env': {
    kind: 'file',
    bytes: new TextEncoder().encode('SECRET=1'),
    contentType: 'text/plain; charset=utf-8',
    hidden: true,
  },
  deep: { kind: 'dir' },
  'deep/note.md': { kind: 'file', bytes: NOTE, contentType: 'text/plain; charset=utf-8' },
  'a b': { kind: 'dir' },
  'a b/ünïcode.txt': {
    kind: 'file',
    bytes: new TextEncoder().encode('u'),
    contentType: 'text/plain; charset=utf-8',
  },
}

const FILE_TREE: Record<string, SeedEntry> = {
  '': { kind: 'file', bytes: REPORT, contentType: 'text/plain; charset=utf-8' },
}

type RecordedRequest = {
  url: string
  init: RequestInit
  credentials?: RequestCredentials
  headers: Headers
}

function makeGatewayFetch(
  tree: Record<string, SeedEntry>,
  kind: 'file' | 'folder',
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  // Browsers brand-check fetch on the global object; Bun does not. Enforcing
  // the browser's receiver rule here is what keeps a `this.fetchImpl(...)`
  // method call — which throws "Illegal invocation" before any request — from
  // passing this suite and failing in every browser.
  const fetchImpl = async function (
    this: unknown,
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    }
    const url = String(input)
    const headers = new Headers(init.headers)
    requests.push({ url, init, credentials: init.credentials, headers })

    const parsed = new URL(url)
    const isList = parsed.searchParams.has('list')
    const isRaw = parsed.searchParams.has('raw')
    // The provider must always send exactly one selector.
    if (isList === isRaw) return jsonResponse(400, { error: 'invalid_selector' })

    // Strip the base prefix to recover the publish-root-relative path.
    const prefix = new URL(BASE).pathname
    const relPath = decodeURIComponent(parsed.pathname.slice(prefix.length).replace(/^\/+/, ''))

    // File-kind publish: only the root maps to the file; nested is 404.
    if (kind === 'file' && relPath !== '') return jsonResponse(404, { error: 'not_found' })

    const entry = tree[relPath]
    if (entry === undefined || (entry.kind === 'file' && entry.hidden === true)) {
      return jsonResponse(404, { error: 'not_found' })
    }

    if (isList) {
      if (entry.kind !== 'dir') return jsonResponse(409, { error: 'not_directory' })
      return jsonResponse(200, { items: listChildren(tree, relPath), nextCursor: null })
    }
    // ?raw
    if (entry.kind !== 'file') return jsonResponse(409, { error: 'not_file' })
    return rawResponse(entry, headers.get('range'))
  } as unknown as typeof fetch
  return { fetch: fetchImpl, requests }
}

function listChildren(
  tree: Record<string, SeedEntry>,
  dir: string,
): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`
  const entries: Array<Record<string, unknown>> = []
  for (const [path, entry] of Object.entries(tree)) {
    if (path === '' || !path.startsWith(prefix)) continue
    const remainder = path.slice(prefix.length)
    if (remainder.length === 0 || remainder.includes('/')) continue
    if (entry.kind === 'file' && entry.hidden === true) continue // gateway dotfile filter
    if (remainder.startsWith('.')) continue
    entries.push({
      name: remainder,
      path,
      type: entry.kind === 'dir' ? 'directory' : 'file',
      size: entry.kind === 'dir' ? 0 : entry.bytes.byteLength,
      mtime: '2026-07-11T08:30:00.000Z',
    })
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return entries
}

function rawResponse(entry: Extract<SeedEntry, { kind: 'file' }>, range: string | null): Response {
  const size = entry.bytes.byteLength
  const baseHeaders = {
    etag: `"etag-${size}"`,
    'content-type': entry.contentType,
    'last-modified': 'Fri, 11 Jul 2026 08:30:00 GMT',
    'accept-ranges': 'bytes',
  }
  if (range === null) {
    return new Response(entry.bytes, {
      status: 200,
      headers: { ...baseHeaders, 'content-length': String(size) },
    })
  }
  const match = range.match(/^bytes=(\d+)-(\d+)$/)
  const start = match ? Number(match[1]) : 0
  const requestedEnd = match ? Number(match[2]) : size - 1
  if (size === 0 || start >= size) {
    return new Response(null, {
      status: 416,
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${size}` },
    })
  }
  const end = Math.min(requestedEnd, size - 1)
  return new Response(entry.bytes.slice(start, end + 1), {
    status: 206,
    headers: {
      ...baseHeaders,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    },
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function folderProvider() {
  const gateway = makeGatewayFetch(FOLDER_TREE, 'folder')
  return { provider: new PublicFileSystemProvider(FOLDER, BASE, gateway.fetch), gateway }
}

function fileProvider() {
  const gateway = makeGatewayFetch(FILE_TREE, 'file')
  return { provider: new PublicFileSystemProvider(FILE, BASE, gateway.fetch), gateway }
}

function unwrap<T>(result: { success: true; data: T } | { success: false; error: Error }): T {
  if (!result.success) throw result.error
  return result.data
}

function assertAnonymous(requests: RecordedRequest[]): void {
  for (const request of requests) {
    expect(request.credentials).toBe('omit')
    expect(request.headers.get('authorization')).toBeNull()
    expect(request.headers.get('cookie')).toBeNull()
    // Every request URL stays under the publish root (same-origin confinement).
    expect(request.url.startsWith(BASE)).toBe(true)
  }
}

describe('PublicFileSystemProvider', () => {
  test('folder root list projects gateway-provided entries into browser paths', async () => {
    const { provider, gateway } = folderProvider()
    const entries = unwrap(await provider.list('/'))
    expect(gateway.requests[0]!.url).toBe(`${BASE}?list`)
    expect(
      entries.items.map(e => ({ name: e.name, path: e.path, isDirectory: e.isDirectory })),
    ).toEqual([
      { name: 'a b', path: '/a b', isDirectory: true },
      { name: 'deep', path: '/deep', isDirectory: true },
      { name: 'empty.txt', path: '/empty.txt', isDirectory: false },
      { name: 'image.png', path: '/image.png', isDirectory: false },
      { name: 'index.html', path: '/index.html', isDirectory: false },
    ])
    expect(entries.items.map(e => e.name)).not.toContain('.env')
    assertAnonymous(gateway.requests)
  })

  test('nested folder list projects child paths under the publish root', async () => {
    const { provider, gateway } = folderProvider()
    const entries = unwrap(await provider.list('/deep'))
    expect(gateway.requests[0]!.url).toBe(`${BASE}/deep?list`)
    expect(entries).toMatchObject({
      items: [{ name: 'note.md', path: '/deep/note.md', size: 6 }],
      nextCursor: null,
    })
  })

  test('encodes spaces, unicode, and normalizes trailing slashes in the URL', async () => {
    const { provider, gateway } = folderProvider()
    unwrap(await provider.list('/a b/'))
    expect(gateway.requests[0]!.url).toBe(`${BASE}/a%20b?list`)
    unwrap(await provider.readVersioned('/a b/ünïcode.txt'))
    expect(gateway.requests[1]!.url).toBe(`${BASE}/a%20b/%C3%BCn%C3%AFcode.txt?raw`)
  })

  test('nested file read projects etag, content-type, and size', async () => {
    const { provider, gateway } = folderProvider()
    const file = unwrap(await provider.readVersioned('/deep/note.md'))
    expect(gateway.requests[0]!.url).toBe(`${BASE}/deep/note.md?raw`)
    expect(new TextDecoder().decode(file.data)).toBe('nested')
    expect(file).toMatchObject({
      etag: '"etag-6"',
      contentType: 'text/plain; charset=utf-8',
      size: 6,
    })
    // read() unwraps to the bytes only.
    expect(unwrap(await provider.read('/deep/note.md'))).toEqual(NOTE)
  })

  test('readRange sends a Range header, returns 206 bytes with the total size', async () => {
    const { provider, gateway } = folderProvider()
    const ranged = unwrap(await provider.readRange('/image.png', { start: 0, end: 3 }))
    expect(gateway.requests[0]!.headers.get('range')).toBe('bytes=0-3')
    expect(new Uint8Array(ranged.data)).toEqual(PNG.slice(0, 4))
    // size is the TOTAL file size from content-range, not the slice length.
    expect(ranged).toMatchObject({ contentType: 'image/png', size: PNG.length })
  })

  test('readRange rejects an inverted range before any fetch', async () => {
    const { provider, gateway } = folderProvider()
    const result = await provider.readRange('/image.png', { start: 5, end: 1 })
    expect(result.success).toBe(false)
    expect(gateway.requests).toHaveLength(0)
  })

  test('downloadUrl ignores versions and preserves the exact public raw URL without a request', () => {
    const { provider, gateway } = folderProvider()
    expect(provider.downloadUrl('/image.png', { version: '"private/etag?one"' })).toBe(
      `${BASE}/image.png?raw`,
    )
    const file = fileProvider()
    expect(file.provider.downloadUrl('/', { version: 42 })).toBe(`${BASE}?raw`)
    expect(gateway.requests).toHaveLength(0)
    expect(file.gateway.requests).toHaveLength(0)
  })

  test('single-file publish serves the anchor file at the root path', async () => {
    const { provider, gateway } = fileProvider()
    const file = unwrap(await provider.readVersioned('/'))
    expect(gateway.requests[0]!.url).toBe(`${BASE}?raw`)
    expect(new TextDecoder().decode(file.data)).toBe('# report')
    assertAnonymous(gateway.requests)
  })

  test('stat of a nested file probes the exact path instead of searching a paged parent', async () => {
    const { provider, gateway } = folderProvider()
    const stat = unwrap(await provider.stat('/deep/note.md'))
    const { entry } = stat
    expect(entry).toMatchObject({
      name: 'note.md',
      path: '/deep/note.md',
      isDirectory: false,
      size: 6,
    })
    expect(stat.etag).toBe('"etag-6"')
    expect(gateway.requests.map(r => r.url)).toEqual([
      `${BASE}/deep/note.md?list&limit=1`,
      `${BASE}/deep/note.md?raw`,
    ])
  })

  test('stat of the folder root is a synthetic directory entry with no fetch', async () => {
    const { provider, gateway } = folderProvider()
    const stat = unwrap(await provider.stat('/'))
    const { entry } = stat
    expect(entry).toMatchObject({ name: 'site', path: '/', isDirectory: true, size: 0 })
    expect(stat.etag).toBeNull()
    expect(gateway.requests).toHaveLength(0)
  })

  test('stat of a single-file root derives total size from a ranged raw probe', async () => {
    const { provider, gateway } = fileProvider()
    const stat = unwrap(await provider.stat('/'))
    const { entry } = stat
    // stat-from-range: a bytes=0-0 probe, total from content-range.
    expect(gateway.requests[0]!.headers.get('range')).toBe('bytes=0-0')
    expect(entry).toMatchObject({
      name: 'report.md',
      path: '/',
      isDirectory: false,
      size: REPORT.length,
    })
    expect(stat.etag).toBeNull()
  })

  test('stat of an empty single-file root reads total 0 from the 416 content-range', async () => {
    const gateway = makeGatewayFetch(
      { '': { kind: 'file', bytes: new Uint8Array(), contentType: 'text/plain; charset=utf-8' } },
      'file',
    )
    const provider = new PublicFileSystemProvider(FILE, BASE, gateway.fetch)
    const { entry, etag } = unwrap(await provider.stat('/'))
    expect(entry).toMatchObject({ isDirectory: false, size: 0 })
    expect(etag).toBeNull()
  })

  test('missing path maps 404 to a failed result carrying the status', async () => {
    const { provider } = folderProvider()
    const result = await provider.readVersioned('/nope.md')
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.error.message).toBe('not_found')
    expect((result.error as { status?: number }).status).toBe(404)
  })

  test('?list on a file and ?raw on a directory map 409 conflicts', async () => {
    const { provider } = folderProvider()
    const listFile = await provider.list('/index.html')
    expect(listFile.success).toBe(false)
    if (!listFile.success) expect((listFile.error as { status?: number }).status).toBe(409)
    const rawDir = await provider.readVersioned('/deep')
    expect(rawDir.success).toBe(false)
    if (!rawDir.success) expect((rawDir.error as { status?: number }).status).toBe(409)
  })

  test('client-side traversal is rejected before any fetch', async () => {
    const { provider, gateway } = folderProvider()
    for (const bad of ['/../secret', '/deep/../../etc', '/a/../../b']) {
      const result = await provider.list(bad)
      expect(result.success).toBe(false)
    }
    expect(gateway.requests).toHaveLength(0)
  })

  test('a read forwards its abort signal and preserves a fetch AbortError', async () => {
    const { provider, gateway } = folderProvider()
    const controller = new AbortController()
    await provider.readVersioned('/deep/note.md', { signal: controller.signal })
    expect(gateway.requests[0]!.init.signal).toBe(controller.signal)

    const aborted = new PublicFileSystemProvider(FOLDER, BASE, (async () => {
      throw new DOMException('Aborted', 'AbortError')
    }) as unknown as typeof fetch)
    const result = await aborted.readVersioned('/deep/note.md')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.name).toBe('AbortError')
  })

  test.each(['write', 'upload', 'mkdir', 'delete', 'rename', 'copy'] as const)(
    'mutation %s throws PublicFileSystemReadOnlyError with zero network calls',
    op => {
      const { provider, gateway } = folderProvider()
      const call = () => {
        if (op === 'write') return provider.write('/x', new Uint8Array())
        if (op === 'upload') return provider.upload('/x', new File(['hello'], 'x.txt'))
        if (op === 'mkdir') return provider.mkdir('/x')
        if (op === 'delete') return provider.delete('/x')
        if (op === 'rename') return provider.rename('/x', '/y')
        return provider.copy('/x', '/y')
      }
      expect(call).toThrow(PublicFileSystemReadOnlyError)
      expect(gateway.requests).toHaveLength(0)
    },
  )

  test('every fetch across a full workbench walk is anonymous', async () => {
    const { provider, gateway } = folderProvider()
    unwrap(await provider.list('/'))
    unwrap(await provider.list('/deep'))
    unwrap(await provider.readVersioned('/deep/note.md'))
    unwrap(await provider.readRange('/image.png', { start: 0, end: 3 }))
    unwrap(await provider.stat('/deep/note.md'))
    assertAnonymous(gateway.requests)
    expect(gateway.requests.length).toBeGreaterThan(4)
  })
})
