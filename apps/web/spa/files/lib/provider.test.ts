import { describe, expect, test } from 'bun:test'

import { DuetApiClient, DuetApiError } from '../../api/client'
import { MockFileSystemProvider } from './mock-provider'
import { RestFileSystemProvider } from './rest-provider'

describe('file system provider behavior', () => {
  test('mock provider preserves empty folders and rolls conditional writes forward', async () => {
    const provider = new MockFileSystemProvider()
    expect((await provider.mkdir('/projects')).success).toBe(true)
    const first = await provider.write('/projects/brief.md', new TextEncoder().encode('first'))
    expect(first).toMatchObject({ success: true, data: { size: 5 } })
    if (!first.success) throw first.error

    const stale = await provider.write('/projects/brief.md', new TextEncoder().encode('stale'), {
      ifMatch: '"stale"',
    })
    expect(stale).toMatchObject({
      success: false,
      error: { message: 'precondition_failed', status: 412, code: 'precondition_failed' },
    })
    expect(
      new TextDecoder().decode(
        ((await provider.read('/projects/brief.md')) as { success: true; data: Uint8Array }).data,
      ),
    ).toBe('first')

    const second = await provider.write('/projects/brief.md', new TextEncoder().encode('second'), {
      ifMatch: first.data.etag,
    })
    expect(second).toMatchObject({ success: true, data: { size: 6 } })
    expect(await provider.list('/projects')).toMatchObject({
      success: true,
      data: {
        items: [{ name: 'brief.md', path: '/projects/brief.md', isDirectory: false, size: 6 }],
        nextCursor: null,
      },
    })
    expect(await provider.stat('/projects/brief.md')).toMatchObject({
      success: true,
      data: { entry: { name: 'brief.md', path: '/projects/brief.md', size: 6 } },
    })
  })

  test('mock stat changes ETag on a same-size write and keeps file metadata', async () => {
    const provider = new MockFileSystemProvider()
    provider.seed([{ path: '/report.md', data: 'first', contentType: 'text/markdown' }])

    const first = await provider.stat('/report.md')
    if (!first.success) throw first.error
    expect(first.data.entry).toMatchObject({
      name: 'report.md',
      path: '/report.md',
      isDirectory: false,
      size: 5,
    })
    expect(first.data.entry.modifiedAt).toBeInstanceOf(Date)
    expect(first.data.entry.modifiedAt?.getTime()).not.toBeNaN()

    const write = await provider.write('/report.md', new TextEncoder().encode('other'))
    if (!write.success) throw write.error
    const second = await provider.stat('/report.md')
    if (!second.success) throw second.error

    expect(second.data.entry).toMatchObject({
      name: 'report.md',
      path: '/report.md',
      isDirectory: false,
      size: 5,
    })
    expect(second.data.entry.modifiedAt).toBeInstanceOf(Date)
    expect(second.data.entry.modifiedAt?.getTime()).not.toBeNaN()
    expect(second.data.etag).toBe(write.data.etag)
    expect(second.data.etag).not.toBe(first.data.etag)
  })

  test('mock download URLs distinguish accepted opaque versions', () => {
    const provider = new MockFileSystemProvider()
    provider.seed([
      { path: '/image.png', data: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
    ])

    expect(provider.downloadUrl('/image.png', { version: '"mock/one"' })).toBe(
      'data:image/png;base64,AQID#v=%22mock%2Fone%22',
    )
    expect(provider.downloadUrl('/image.png', { version: 2 })).toBe(
      'data:image/png;base64,AQID#v=2',
    )
  })

  test('mock provider copies, moves, recursively deletes, and reports optimistic failures', async () => {
    const provider = new MockFileSystemProvider()
    provider.seed([{ path: '/projects/source/note.txt', data: 'note' }])
    expect(
      (await provider.copy('/projects/source', '/projects/copy', { recursive: true })).success,
    ).toBe(true)
    expect(
      new TextDecoder().decode(
        ((await provider.read('/projects/copy/note.txt')) as { success: true; data: Uint8Array })
          .data,
      ),
    ).toBe('note')
    expect((await provider.rename('/projects/copy/note.txt', '/projects/moved.txt')).success).toBe(
      true,
    )
    expect((await provider.delete('/projects/source')).success).toBe(false)
    expect((await provider.delete('/projects/source', { recursive: true })).success).toBe(true)

    provider.failNextOperation = 'move'
    expect(await provider.rename('/projects/moved.txt', '/projects/failed.txt')).toMatchObject({
      success: false,
      error: { message: 'move_failed' },
    })
    expect((await provider.read('/projects/moved.txt')).success).toBe(true)
  })

  test('REST provider tolerates symlink entries in listings as non-directory entries', async () => {
    const provider = new RestFileSystemProvider(
      'acme',
      new DuetApiClient(async () =>
        Response.json({
          items: [
            {
              name: 'current',
              path: 'releases/current',
              type: 'symlink',
              size: 11,
              mtime: '2026-07-11T08:30:00.000Z',
              target: 'releases/v2',
            },
            {
              name: 'v2',
              path: 'releases/v2',
              type: 'directory',
              size: 0,
              mtime: '2026-07-11T08:30:00.000Z',
            },
          ],
          nextCursor: null,
        }),
      ),
      undefined,
    )
    const listed = await provider.list('/releases')
    expect(listed).toMatchObject({
      success: true,
      data: {
        items: [
          { name: 'current', type: 'symlink', isDirectory: false, size: 11 },
          { name: 'v2', type: 'directory', isDirectory: true },
        ],
        nextCursor: null,
      },
    })
  })

  test('REST provider preserves directory continuation instead of truncating after fifty entries', async () => {
    const requests: string[] = []
    const provider = new RestFileSystemProvider(
      'acme',
      new DuetApiClient(async input => {
        const request = String(input)
        requests.push(request)
        const cursor = new URL(request, 'https://duet.test').searchParams.get('cursor')
        return Response.json(
          cursor === null
            ? {
                items: Array.from({ length: 50 }, (_, index) => ({
                  name: `file-${index}.md`,
                  path: `docs/file-${index}.md`,
                  type: 'file',
                  size: index,
                  mtime: '2026-07-11T08:30:00.000Z',
                })),
                nextCursor: 'page-two',
              }
            : {
                items: [
                  {
                    name: 'file-50.md',
                    path: 'docs/file-50.md',
                    type: 'file',
                    size: 50,
                    mtime: '2026-07-11T08:30:00.000Z',
                  },
                ],
                nextCursor: null,
              },
        )
      }),
      undefined,
    )

    const first = await provider.list('/docs')
    expect(first.success && first.data.nextCursor).toBe('page-two')
    expect(first.success && first.data.items.map(item => item.path)).toEqual(
      Array.from({ length: 50 }, (_, index) => `/docs/file-${index}.md`),
    )
    const second = await provider.list('/docs', { cursor: 'page-two' })
    expect(second).toMatchObject({
      success: true,
      data: { items: [{ path: '/docs/file-50.md' }], nextCursor: null },
    })
    expect(requests).toEqual([
      '/api/duet/ws/acme/files/docs?list=1',
      '/api/duet/ws/acme/files/docs?list=1&cursor=page-two',
    ])
  })

  test('REST provider preserves a stat 404 as the original Duet API error', async () => {
    const provider = new RestFileSystemProvider(
      'acme',
      new DuetApiClient(async () => Response.json({ error: 'not_found' }, { status: 404 })),
      undefined,
    )

    const result = await provider.stat('/missing.md')

    expect(result).toMatchObject({
      success: false,
      error: { name: 'DuetApiError', status: 404, code: 'not_found' },
    })
    if (result.success) throw new Error('Expected a missing stat to fail')
    expect(result.error).toBeInstanceOf(DuetApiError)
  })

  test('REST provider carries an opaque version into its percent-encoded download URL', () => {
    const provider = new RestFileSystemProvider(
      'acme',
      new DuetApiClient(async () => {
        throw new Error('unexpected request')
      }),
      undefined,
    )

    expect(provider.downloadUrl('/docs/report.md', { version: '"opaque/identity?one"' })).toBe(
      '/api/duet/ws/acme/files/docs/report.md?v=%22opaque%2Fidentity%3Fone%22',
    )
  })

  test('REST provider preserves range metadata, conditional writes, action errors, and the abort signal', async () => {
    const requests: Array<{
      path: string
      method: string
      headers: Headers
      body?: string
      signal?: AbortSignal | null
    }> = []
    const provider = new RestFileSystemProvider(
      'acme space',
      new DuetApiClient(async (input, init) => {
        const headers = new Headers(init?.headers)
        const body = init?.body === undefined ? undefined : await new Response(init.body).text()
        requests.push({
          path: String(input),
          method: init?.method ?? 'GET',
          headers,
          body,
          signal: init?.signal,
        })
        if (String(input).endsWith('?list=1')) {
          return Response.json({
            items: [
              {
                name: 'a b.md',
                path: 'docs/a b.md',
                type: 'file',
                size: 4,
                mtime: '2026-07-11T08:30:00.000Z',
              },
            ],
            nextCursor: null,
          })
        }
        if (String(input).endsWith('?stat=1')) {
          return Response.json({
            entry: {
              name: 'a b.md',
              path: 'docs/a b.md',
              type: 'file',
              size: 4,
              mtime: '2026-07-11T08:30:00.000Z',
            },
            etag: '"stat-v1"',
          })
        }
        if (init?.method === 'PUT') {
          return Response.json(
            { ok: true, etag: '"next"', size: 4 },
            { headers: { etag: '"next"' } },
          )
        }
        if (init?.method === 'POST') return Response.json({ ok: true, affectedEntries: 1 })
        return new Response(new Uint8Array([2, 3]), {
          status: 206,
          headers: {
            etag: '"v1"',
            'content-range': 'bytes 2-3/10',
            'content-type': 'application/octet-stream',
          },
        })
      }),
      undefined,
    )

    expect(await provider.list('/docs')).toMatchObject({
      success: true,
      data: { items: [{ path: '/docs/a b.md', size: 4 }], nextCursor: null },
    })
    expect(await provider.stat('/docs/a b.md')).toMatchObject({
      success: true,
      data: { entry: { path: '/docs/a b.md', size: 4 }, etag: '"stat-v1"' },
    })
    const range = await provider.readRange('/docs/a b.md', { start: 2, end: 3 })
    expect(range).toEqual({
      success: true,
      data: {
        data: new Uint8Array([2, 3]),
        etag: '"v1"',
        contentType: 'application/octet-stream',
        size: 10,
      },
    })
    const controller = new AbortController()
    const write = await provider.write('/docs/a b.md', new TextEncoder().encode('next'), {
      ifMatch: '"v1"',
      contentType: 'text/plain',
      signal: controller.signal,
    })
    expect(write).toEqual({ success: true, data: { etag: '"next"', size: 4 } })
    expect((await provider.rename('/docs/a b.md', '/docs/b.md')).success).toBe(true)

    expect(requests.map(request => [request.method, request.path])).toEqual([
      ['GET', '/api/duet/ws/acme%20space/files/docs?list=1'],
      ['GET', '/api/duet/ws/acme%20space/files/docs/a%20b.md?stat=1'],
      ['GET', '/api/duet/ws/acme%20space/files/docs/a%20b.md'],
      ['PUT', '/api/duet/ws/acme%20space/files/docs/a%20b.md'],
      ['POST', '/api/duet/ws/acme%20space/files/actions'],
    ])
    expect(requests[2]!.headers.get('range')).toBe('bytes=2-3')
    expect(requests[3]!.headers.get('if-match')).toBe('"v1"')
    expect(requests[3]!.body).toBe('next')
    expect(requests[3]!.signal).toBe(controller.signal)
    expect(JSON.parse(requests[4]!.body!)).toEqual({
      operation: 'move',
      source: 'docs/a b.md',
      destination: 'docs/b.md',
      overwrite: false,
    })

    const failing = new RestFileSystemProvider(
      'acme',
      new DuetApiClient(async () => Response.json({ error: 'path_exists' }, { status: 409 })),
      undefined,
    )
    expect(await failing.mkdir('/docs')).toMatchObject({
      success: false,
      error: { message: 'path_exists', status: 409 },
    })
  })
})
