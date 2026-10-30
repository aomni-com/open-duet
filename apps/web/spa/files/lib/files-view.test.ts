import { describe, expect, test } from 'bun:test'

import { createDuetQueryClient } from '../../api/query-client'
import {
  deletedPreviewRepairPath,
  filesViewQueryOptions,
  loadNextFilesViewPage,
  nextFilesViewCursor,
  resolveFilesView,
  type FilesView,
} from './files-view'
import { MockFileSystemProvider } from './mock-provider'
import type { DirectoryEntry, DirectoryPage, DirectoryPageOptions, FileStat, Result } from './types'

const ok = <T>(data: T): Result<T> => ({ success: true, data })
const fail = (error: Error): Result<never> => ({ success: false, error })
const statResult = (entry: DirectoryEntry, etag: string | null = null): Result<FileStat> =>
  ok({ entry, etag })
const httpError = (status: number, message = `http_${status}`): Error =>
  Object.assign(new Error(message), { status })
const fileEntry = (name: string, path: string): DirectoryEntry => ({
  name,
  path,
  type: 'file',
  isDirectory: false,
  size: 1,
})

class ProgrammableFileSystemProvider extends MockFileSystemProvider {
  readonly calls: Array<{ operation: 'list' | 'stat'; path: string; signal?: AbortSignal }> = []
  readonly lists = new Map<string, Result<DirectoryEntry[]>>()
  readonly pageLists = new Map<string, Result<DirectoryPage>>()
  readonly stats = new Map<string, Result<FileStat>>()
  readonly statSequences = new Map<string, Array<Result<FileStat>>>()

  override async list(
    path: string,
    options: DirectoryPageOptions = {},
  ): Promise<Result<DirectoryPage>> {
    this.calls.push({ operation: 'list', path, signal: options.signal })
    const paged = this.pageLists.get(`${path}:${options.cursor ?? 'first'}`)
    if (paged !== undefined) return paged
    const programmed = this.lists.get(path)
    if (programmed === undefined) return super.list(path, options)
    return programmed.success ? ok({ items: programmed.data, nextCursor: null }) : programmed
  }

  override async stat(
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<FileStat>> {
    this.calls.push({ operation: 'stat', path, signal: options.signal })
    const sequence = this.statSequences.get(path)
    if (sequence?.length) return sequence.shift()!
    return this.stats.get(path) ?? super.stat(path, options)
  }
}

describe('resolveFilesView', () => {
  test('an explicit continuation adds the fifty-first directory entry to the cached folder', async () => {
    const provider = new ProgrammableFileSystemProvider()
    const firstItems = Array.from({ length: 50 }, (_, index) =>
      fileEntry(`file-${index}.md`, `/file-${index}.md`),
    )
    provider.pageLists.set('/:first', ok({ items: firstItems, nextCursor: 'page-two' }))
    provider.pageLists.set(
      '/:page-two',
      ok({ items: [fileEntry('file-50.md', '/file-50.md')], nextCursor: null }),
    )
    const queryClient = createDuetQueryClient()
    const options = filesViewQueryOptions(provider, 'acme', '/', { queryClient })

    await queryClient.fetchQuery(options)
    await loadNextFilesViewPage({
      queryClient,
      queryKey: options.queryKey,
      provider,
    })

    const view = queryClient.getQueryData<FilesView>(options.queryKey)
    expect(view?.status === 'folder' && view.entries.map(entry => entry.path)).toEqual([
      ...firstItems.map(entry => entry.path),
      '/file-50.md',
    ])
    expect(view?.status === 'folder' && view.pages.continuations).toEqual([
      { items: [fileEntry('file-50.md', '/file-50.md')], nextCursor: null },
    ])
    expect(nextFilesViewCursor(view)).toBeNull()
    expect(
      (await loadNextFilesViewPage({ queryClient, queryKey: options.queryKey, provider })) === view,
    ).toBe(true)
    expect(provider.calls).toEqual([
      { operation: 'list', path: '/', signal: expect.any(AbortSignal) },
      { operation: 'list', path: '/', signal: undefined },
    ])
  })

  test('a refresh revalidates every explicitly loaded page without loading unseen pages', async () => {
    const provider = new ProgrammableFileSystemProvider()
    provider.pageLists.set(
      '/:first',
      ok({ items: [fileEntry('first.md', '/first.md')], nextCursor: 'page-two' }),
    )
    provider.pageLists.set(
      '/:page-two',
      ok({ items: [fileEntry('later.md', '/later.md')], nextCursor: null }),
    )
    const queryClient = createDuetQueryClient()
    const options = filesViewQueryOptions(provider, 'acme', '/', { queryClient })
    await queryClient.fetchQuery(options)
    await loadNextFilesViewPage({
      queryClient,
      queryKey: options.queryKey,
      provider,
    })

    provider.pageLists.set(
      '/:first',
      ok({
        items: [{ ...fileEntry('first.md', '/first.md'), size: 9 }],
        nextCursor: 'page-two',
      }),
    )
    provider.pageLists.set(
      '/:page-two',
      ok({ items: [{ ...fileEntry('later.md', '/later.md'), size: 7 }], nextCursor: null }),
    )
    await queryClient.invalidateQueries({ queryKey: options.queryKey })
    await queryClient.fetchQuery(options)

    const view = queryClient.getQueryData<FilesView>(options.queryKey)
    expect(view?.status === 'folder' && view.entries).toMatchObject([
      { path: '/first.md', size: 9 },
      { path: '/later.md', size: 7 },
    ])
  })

  test('a failed continuation keeps loaded rows and can be retried from the same cursor', async () => {
    const provider = new ProgrammableFileSystemProvider()
    provider.pageLists.set(
      '/:first',
      ok({ items: [fileEntry('first.md', '/first.md')], nextCursor: 'page-two' }),
    )
    provider.pageLists.set('/:page-two', fail(new Error('offline')))
    const queryClient = createDuetQueryClient()
    const options = filesViewQueryOptions(provider, 'acme', '/', { queryClient })
    await queryClient.fetchQuery(options)

    await expect(
      loadNextFilesViewPage({
        queryClient,
        queryKey: options.queryKey,
        provider,
      }),
    ).rejects.toThrow('offline')
    expect(queryClient.getQueryData<FilesView>(options.queryKey)).toMatchObject({
      status: 'folder',
      entries: [{ path: '/first.md' }],
      continuation: 'error',
    })

    provider.pageLists.set(
      '/:page-two',
      ok({ items: [fileEntry('later.md', '/later.md')], nextCursor: null }),
    )
    await loadNextFilesViewPage({
      queryClient,
      queryKey: options.queryKey,
      provider,
    })
    expect(queryClient.getQueryData<FilesView>(options.queryKey)).toMatchObject({
      entries: [{ path: '/first.md' }, { path: '/later.md' }],
      continuation: 'idle',
    })
  })
  test('root lists its entries without trying to stat the root', async () => {
    const provider = new ProgrammableFileSystemProvider()
    provider.seed([{ path: '/welcome.md', data: 'hello' }], ['/projects'])

    const view = await resolveFilesView(provider, '/')

    expect(view).toMatchObject({
      status: 'folder',
      requestedPath: '/',
      folderPath: '/',
      entries: [
        { name: 'projects', path: '/projects', isDirectory: true },
        { name: 'welcome.md', path: '/welcome.md', isDirectory: false },
      ],
    })
    expect(provider.calls).toEqual([{ operation: 'list', path: '/', signal: undefined }])
  })

  test('a directory is stat-ed before its own entries are listed', async () => {
    const provider = new ProgrammableFileSystemProvider()
    provider.seed([{ path: '/projects/brief.md', data: 'brief' }])

    const view = await resolveFilesView(provider, '/projects')

    expect(view).toMatchObject({
      status: 'folder',
      requestedPath: '/projects',
      folderPath: '/projects',
      entries: [{ name: 'brief.md', path: '/projects/brief.md', isDirectory: false }],
    })
    expect(provider.calls.map(({ operation, path }) => [operation, path])).toEqual([
      ['stat', '/projects'],
      ['list', '/projects'],
    ])
  })

  test('a file keeps the requested path while listing its parent folder and selecting its preview', async () => {
    const provider = new ProgrammableFileSystemProvider()
    provider.seed([
      { path: '/projects/brief.md', data: 'brief' },
      { path: '/projects/notes.md', data: 'notes' },
    ])

    const view = await resolveFilesView(provider, '/projects/brief.md')

    expect(view).toMatchObject({
      status: 'file',
      requestedPath: '/projects/brief.md',
      folderPath: '/projects',
      entries: [
        { name: 'brief.md', path: '/projects/brief.md' },
        { name: 'notes.md', path: '/projects/notes.md' },
      ],
      previewed: { name: 'brief.md', path: '/projects/brief.md', isDirectory: false },
    })
    expect(provider.calls.map(({ operation, path }) => [operation, path])).toEqual([
      ['stat', '/projects/brief.md'],
      ['list', '/projects'],
    ])
  })

  test('an explicitly addressed dotfile resolves even when hidden files would be omitted from rows', async () => {
    const provider = new ProgrammableFileSystemProvider()
    provider.seed([{ path: '/.env', data: 'SECRET=value' }])

    const view = await resolveFilesView(provider, '/.env')

    expect(view).toMatchObject({
      status: 'file',
      requestedPath: '/.env',
      folderPath: '/',
      previewed: { name: '.env', path: '/.env' },
    })
  })

  test('reserved, malformed, and null paths settle as not-found without provider access', async () => {
    const cases: Array<{
      path: string | null
      requestedPath: string
      parentPath: string
    }> = [
      { path: '/.duet/config.json', requestedPath: '/.duet/config.json', parentPath: '/' },
      { path: '/docs/../secret', requestedPath: '/docs/../secret', parentPath: '/' },
      { path: 'docs/brief.md', requestedPath: 'docs/brief.md', parentPath: '/' },
      { path: '', requestedPath: '', parentPath: '/' },
      { path: '/docs/has\0nul', requestedPath: '/docs/has\0nul', parentPath: '/' },
      { path: null, requestedPath: '/', parentPath: '/' },
    ]

    for (const fixture of cases) {
      const provider = new ProgrammableFileSystemProvider()
      expect(await resolveFilesView(provider, fixture.path)).toEqual({
        status: 'not-found',
        requestedPath: fixture.requestedPath,
        parentPath: fixture.parentPath,
      })
      expect(provider.calls).toEqual([])
    }
  })

  test('a structural 404 from stat resolves to not-found at the requested path parent', async () => {
    const provider = new ProgrammableFileSystemProvider()
    provider.stats.set('/projects/missing.md', fail(httpError(404, 'not_found')))

    const view = await resolveFilesView(provider, '/projects/missing.md')

    expect(view).toEqual({
      status: 'not-found',
      requestedPath: '/projects/missing.md',
      parentPath: '/projects',
    })
  })

  test('a structural 404 while listing a resolved directory also points recovery at its parent', async () => {
    const provider = new ProgrammableFileSystemProvider()
    provider.stats.set(
      '/projects/archive',
      statResult({
        name: 'archive',
        path: '/projects/archive',
        type: 'directory',
        isDirectory: true,
      }),
    )
    provider.lists.set('/projects/archive', fail(httpError(404, 'not_found')))

    const view = await resolveFilesView(provider, '/projects/archive')

    expect(view).toEqual({
      status: 'not-found',
      requestedPath: '/projects/archive',
      parentPath: '/projects',
    })
  })

  test('a bounded accepted-mount retry waits through a transient stat 404', async () => {
    const provider = new ProgrammableFileSystemProvider()
    provider.statSequences.set('/Shared/project', [
      fail(httpError(404, 'not_found')),
      statResult({
        name: 'project',
        path: '/Shared/project',
        type: 'directory',
        isDirectory: true,
      }),
    ])
    provider.lists.set(
      '/Shared/project',
      ok([
        {
          name: 'brief.md',
          path: '/Shared/project/brief.md',
          type: 'file',
          isDirectory: false,
        },
      ]),
    )

    const view = await resolveFilesView(provider, '/Shared/project', {
      notFoundRetry: { attempts: 2, delayMs: 0 },
    })

    expect(view).toMatchObject({
      status: 'folder',
      requestedPath: '/Shared/project',
      folderPath: '/Shared/project',
      entries: [{ name: 'brief.md', path: '/Shared/project/brief.md' }],
    })
    expect(provider.calls.map(({ operation, path }) => [operation, path])).toEqual([
      ['stat', '/Shared/project'],
      ['stat', '/Shared/project'],
      ['list', '/Shared/project'],
    ])
  })

  test('non-404 provider failures stay errors and preserve their original instances', async () => {
    for (const status of [401, 403, 409, 500, 503]) {
      const provider = new ProgrammableFileSystemProvider()
      const error = httpError(status)
      provider.stats.set('/projects/private', fail(error))

      const view = await resolveFilesView(provider, '/projects/private')

      expect(view).toEqual({
        status: 'error',
        requestedPath: '/projects/private',
        error,
      })
      if (view.status !== 'error') throw new Error(`Expected an error view for HTTP ${status}`)
      expect(view.error).toBe(error)
    }
  })

  test('an error message alone cannot impersonate an HTTP 404', async () => {
    const provider = new ProgrammableFileSystemProvider()
    const error = new Error('not_found')
    provider.stats.set('/projects/missing.md', fail(error))

    const view = await resolveFilesView(provider, '/projects/missing.md')

    expect(view).toEqual({
      status: 'error',
      requestedPath: '/projects/missing.md',
      error,
    })
  })

  test('a folder already listed survives a network that stops answering', async () => {
    const provider = new ProgrammableFileSystemProvider()
    const entries: DirectoryEntry[] = [
      { name: 'brief.md', path: '/projects/brief.md', type: 'file', isDirectory: false },
    ]
    provider.lists.set('/projects', ok(entries))
    provider.stats.set(
      '/projects',
      statResult({ name: 'projects', path: '/projects', type: 'directory', isDirectory: true }),
    )
    const client = createDuetQueryClient()
    const options = filesViewQueryOptions(provider, 'acme', '/projects')
    expect(await client.fetchQuery(options)).toMatchObject({ status: 'folder', entries })

    /* No HTTP status on this one: the browser could not ask at all. The answer
       the reader already has must outlive that, rather than being replaced by
       an error card for a folder nothing has said anything about. */
    provider.lists.set('/projects', fail(new TypeError('Failed to fetch')))
    provider.stats.set('/projects', fail(new TypeError('Failed to fetch')))
    await client.refetchQueries({ queryKey: options.queryKey })

    expect(client.getQueryData(options.queryKey)).toMatchObject({ status: 'folder', entries })
  })

  test('the mock provider gives missing paths the structural 404 used by the real API', async () => {
    const provider = new MockFileSystemProvider()

    expect(await resolveFilesView(provider, '/projects/missing.md')).toEqual({
      status: 'not-found',
      requestedPath: '/projects/missing.md',
      parentPath: '/projects',
    })
  })

  test('the same abort signal is forwarded to stat and list', async () => {
    const provider = new ProgrammableFileSystemProvider()
    provider.seed([{ path: '/projects/brief.md', data: 'brief' }])
    const controller = new AbortController()

    await resolveFilesView(provider, '/projects', { signal: controller.signal })

    expect(provider.calls).toEqual([
      { operation: 'stat', path: '/projects', signal: controller.signal },
      { operation: 'list', path: '/projects', signal: controller.signal },
    ])
  })
})

describe('deletedPreviewRepairPath', () => {
  const fileView: FilesView = {
    status: 'file',
    requestedPath: '/projects/brief.md',
    folderPath: '/projects',
    entries: [],
    pages: { first: { items: [], nextCursor: null }, continuations: [] },
    continuation: 'idle',
    previewed: {
      name: 'brief.md',
      path: '/projects/brief.md',
      type: 'file',
      isDirectory: false,
      size: 5,
    },
  }

  test('repairs only a same-file refresh that settles as not-found', () => {
    expect(
      deletedPreviewRepairPath(fileView, {
        status: 'not-found',
        requestedPath: '/projects/brief.md',
        parentPath: '/projects',
      }),
    ).toBe('/projects')
    expect(
      deletedPreviewRepairPath(null, {
        status: 'not-found',
        requestedPath: '/projects/brief.md',
        parentPath: '/projects',
      }),
    ).toBeNull()
    expect(
      deletedPreviewRepairPath(fileView, {
        status: 'not-found',
        requestedPath: '/projects/other.md',
        parentPath: '/projects',
      }),
    ).toBeNull()
    expect(
      deletedPreviewRepairPath(fileView, {
        status: 'error',
        requestedPath: '/projects/brief.md',
        error: new Error('offline'),
      }),
    ).toBeNull()
  })
})
