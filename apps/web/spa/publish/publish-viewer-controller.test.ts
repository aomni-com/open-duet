import { describe, expect, test } from 'bun:test'

import type { ViewerDescriptor } from '@repo/contract'

import { PublicFileSystemError } from '../files/lib/public-provider'
import type {
  DirectoryEntry,
  DirectoryPage,
  DirectoryPageOptions,
  FileStat,
  IFileSystemProvider,
  Result,
} from '../files/lib/types'
import {
  PublishViewerController,
  publishViewerUrl,
  resolvePublishView,
  virtualPathFromPathname,
  type PublishHistoryPort,
  type PublishViewerState,
} from './publish-viewer-controller'

const FOLDER: ViewerDescriptor = {
  workspaceName: 'Acme',
  ownerName: 'Ada Lovelace',
  rootName: 'site',
  kind: 'folder',
}
const FILE: ViewerDescriptor = { ...FOLDER, kind: 'file', rootName: 'report.md' }

function dir(name: string, path: string): DirectoryEntry {
  return { name, path, type: 'directory', isDirectory: true, size: 0 }
}
function fileEntry(name: string, path: string, size = 128): DirectoryEntry {
  return { name, path, type: 'file', isDirectory: false, size }
}

const ok = <T>(data: T): Result<T> => ({ success: true, data })
const fail = (error: Error): Result<never> => ({ success: false, error })
const statResult = (entry: DirectoryEntry): Result<FileStat> => ok({ entry, etag: null })

/**
 * A hand-driven `IFileSystemProvider`: `list`/`stat` consult programmable maps,
 * and any path can be made to hang so a slow resolution can be resolved after a
 * newer navigation (the staleness probe). Only the three read verbs the viewer
 * uses are implemented; the mutators would never be reached in public mode.
 */
class FakeProvider implements IFileSystemProvider {
  lists = new Map<string, Result<DirectoryEntry[]>>()
  pages = new Map<string, Result<DirectoryPage>>()
  stats = new Map<string, Result<FileStat>>()
  private gates = new Map<string, () => void>()

  async list(path: string, options: DirectoryPageOptions = {}): Promise<Result<DirectoryPage>> {
    const page = this.pages.get(`${path}:${options.cursor ?? 'first'}`)
    if (page !== undefined) return page
    const result = await this.answer(
      path,
      this.lists.get(path) ?? fail(new PublicFileSystemError(404, 'not_found')),
      options.signal,
    )
    return result.success ? ok({ items: result.data, nextCursor: null }) : result
  }
  stat(path: string, options: { signal?: AbortSignal } = {}): Promise<Result<FileStat>> {
    return this.answer(
      path,
      this.stats.get(path) ?? fail(new PublicFileSystemError(404, 'not_found')),
      options.signal,
    )
  }

  /** Make the next resolution of `path` hang; returns a release fn. */
  hang(path: string): () => void {
    let release = () => {}
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    this.gates.set(path, () => {
      this.gates.delete(path)
      release()
    })
    // Store the promise so `answer` awaits it.
    this.pending.set(path, promise)
    return () => this.gates.get(path)?.()
  }
  private pending = new Map<string, Promise<void>>()

  private async answer<T>(
    path: string,
    result: Result<T>,
    signal?: AbortSignal,
  ): Promise<Result<T>> {
    const gate = this.pending.get(path)
    if (gate) {
      this.pending.delete(path)
      await gate
    }
    if (signal?.aborted) return fail(new DOMException('Aborted', 'AbortError'))
    return result
  }

  // Unused read verbs.
  read(): Promise<Result<Uint8Array>> {
    throw new Error('unused')
  }
  readVersioned(): Promise<Result<never>> {
    throw new Error('unused')
  }
  readRange(): Promise<Result<never>> {
    throw new Error('unused')
  }
  downloadUrl(path: string): string {
    return path
  }
  // Mutators — never reached in public mode.
  write(): Promise<Result<{ etag: string; size: number }>> {
    throw new Error('read-only')
  }
  upload(): Promise<Result> {
    throw new Error('read-only')
  }
  mkdir(): Promise<Result> {
    throw new Error('read-only')
  }
  delete(): Promise<Result> {
    throw new Error('read-only')
  }
  rename(): Promise<Result> {
    throw new Error('read-only')
  }
  copy(): Promise<Result> {
    throw new Error('read-only')
  }
}

class HistoryRecorder implements PublishHistoryPort {
  entries: Array<{ op: 'push' | 'replace'; url: string; virtualPath: string }> = []
  push(url: string, virtualPath: string): void {
    this.entries.push({ op: 'push', url, virtualPath })
  }
  replace(url: string, virtualPath: string): void {
    this.entries.push({ op: 'replace', url, virtualPath })
  }
  last() {
    return this.entries.at(-1)
  }
}

function makeController(descriptor: ViewerDescriptor, provider: FakeProvider) {
  const history = new HistoryRecorder()
  let state: PublishViewerState = { status: 'loading' }
  const controller = new PublishViewerController({
    descriptor,
    workspaceSlug: 'acme',
    publishSlug: 'site',
    provider,
    history,
    onChange: next => {
      state = next
    },
  })
  return { controller, history, provider, get: () => state }
}

// A microtask flush: the controller resolves on already-settled promises.
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('publishViewerUrl — encoding and root confinement', () => {
  test('root maps to the bare publish URL, nested paths are percent-encoded', () => {
    expect(publishViewerUrl('acme', 'site', '/')).toBe('/acme/site')
    expect(publishViewerUrl('acme', 'site', '/docs/guide.md')).toBe('/acme/site/docs/guide.md')
    expect(publishViewerUrl('acme', 'site', '/a b/π.md')).toBe('/acme/site/a%20b/%CF%80.md')
  })

  test('a path that tries to escape the root collapses to the publish root', () => {
    // `..` cannot survive normalization, so no URL ever addresses above the root.
    expect(publishViewerUrl('acme', 'site', '/../secret')).toBe('/acme/site')
  })
})

describe('virtualPathFromPathname — round-trip and confinement', () => {
  test('bare and internal-rewrite pathnames resolve to the same virtual path', () => {
    expect(virtualPathFromPathname('acme', 'site', '/acme/site')).toBe('/')
    expect(virtualPathFromPathname('acme', 'site', '/acme/site/a%20b/%CF%80.md')).toBe('/a b/π.md')
    expect(virtualPathFromPathname('acme', 'site', '/publish/acme/site/docs')).toBe('/docs')
  })

  test('a pathname outside this publish is not resolvable', () => {
    expect(virtualPathFromPathname('acme', 'site', '/other/pub/x')).toBeNull()
    expect(virtualPathFromPathname('acme', 'site', '/acme/site/../../etc')).toBeNull()
  })

  test('a workspace named "publish" resolves both grammars (no prefix ambiguity)', () => {
    expect(virtualPathFromPathname('publish', 'site', '/publish/site/docs')).toBe('/docs')
    expect(virtualPathFromPathname('publish', 'site', '/publish/publish/site/docs')).toBe('/docs')
    expect(virtualPathFromPathname('publish', 'site', '/publish/site')).toBe('/')
  })
})

describe('resolvePublishView — deep-link folder/file resolution', () => {
  test('folder root lists its children', async () => {
    const provider = new FakeProvider()
    provider.lists.set('/', ok([dir('docs', '/docs'), fileEntry('index.html', '/index.html')]))
    const state = await resolvePublishView(FOLDER, '/', provider)
    expect(state).toEqual({
      status: 'folder',
      path: '/',
      entries: [dir('docs', '/docs'), fileEntry('index.html', '/index.html')],
      nextCursor: null,
    })
  })

  test('a nested directory is stat-ed then listed', async () => {
    const provider = new FakeProvider()
    provider.stats.set('/docs', statResult(dir('docs', '/docs')))
    provider.lists.set('/docs', ok([fileEntry('guide.md', '/docs/guide.md')]))
    const state = await resolvePublishView(FOLDER, '/docs', provider)
    expect(state).toEqual({
      status: 'folder',
      path: '/docs',
      entries: [fileEntry('guide.md', '/docs/guide.md')],
      nextCursor: null,
    })
  })

  test('a nested file opens the file viewer with the stat entry', async () => {
    const provider = new FakeProvider()
    provider.stats.set('/docs/guide.md', statResult(fileEntry('guide.md', '/docs/guide.md', 512)))
    const state = await resolvePublishView(FOLDER, '/docs/guide.md', provider)
    expect(state).toEqual({
      status: 'file',
      path: '/docs/guide.md',
      entry: fileEntry('guide.md', '/docs/guide.md', 512),
    })
  })

  test('a single-file publish opens the file directly at its root', async () => {
    const provider = new FakeProvider()
    provider.stats.set('/', statResult(fileEntry('report.md', '/', 900)))
    const state = await resolvePublishView(FILE, '/', provider)
    expect(state).toEqual({ status: 'file', path: '/', entry: fileEntry('report.md', '/', 900) })
  })

  test('a single-file publish rejects any deeper path as not-found', async () => {
    const provider = new FakeProvider()
    const state = await resolvePublishView(FILE, '/anything', provider)
    expect(state).toEqual({ status: 'not-found', path: '/anything' })
  })

  test('a missing path is not-found; a transport failure is an error', async () => {
    const provider = new FakeProvider()
    provider.stats.set('/gone', fail(new PublicFileSystemError(404, 'not_found')))
    provider.stats.set('/broken', fail(new PublicFileSystemError(502, 'bad_gateway')))
    expect(await resolvePublishView(FOLDER, '/gone', provider)).toEqual({
      status: 'not-found',
      path: '/gone',
    })
    expect(await resolvePublishView(FOLDER, '/broken', provider)).toEqual({
      status: 'error',
      path: '/broken',
      message: 'bad_gateway',
    })
  })

  test('a traversal path never reaches the provider — it is not-found', async () => {
    const provider = new FakeProvider()
    const state = await resolvePublishView(FOLDER, '/../secret', provider)
    expect(state).toEqual({ status: 'not-found', path: '/../secret' })
  })
})

describe('PublishViewerController — navigation, history, retry', () => {
  test('load more appends a second public directory page only when requested', async () => {
    const provider = new FakeProvider()
    provider.pages.set(
      '/:first',
      ok({ items: [fileEntry('first.md', '/first.md')], nextCursor: 'page-two' }),
    )
    provider.pages.set(
      '/:page-two',
      ok({
        items: [fileEntry('first.md', '/first.md', 256), fileEntry('later.md', '/later.md')],
        nextCursor: null,
      }),
    )
    const { controller, get } = makeController(FOLDER, provider)
    controller.start('/')
    await flush()

    expect(get()).toMatchObject({
      status: 'folder',
      entries: [{ path: '/first.md' }],
      nextCursor: 'page-two',
    })
    await controller.loadMore()
    expect(get()).toMatchObject({
      status: 'folder',
      entries: [
        { path: '/first.md', size: 256 },
        { path: '/later.md', size: 128 },
      ],
      nextCursor: null,
      continuation: 'idle',
    })
  })
  test('start replaces the history entry and settles on the folder root', async () => {
    const provider = new FakeProvider()
    provider.lists.set('/', ok([dir('docs', '/docs')]))
    const { controller, history, get } = makeController(FOLDER, provider)

    controller.start('/')
    expect(history.last()).toEqual({ op: 'replace', url: '/acme/site', virtualPath: '/' })
    expect(get().status).toBe('loading')

    await flush()
    expect(get()).toEqual({
      status: 'folder',
      path: '/',
      entries: [dir('docs', '/docs')],
      nextCursor: null,
    })
  })

  test('navigate pushes a new history entry and opens the target', async () => {
    const provider = new FakeProvider()
    provider.lists.set('/', ok([dir('docs', '/docs')]))
    provider.stats.set('/docs/guide.md', statResult(fileEntry('guide.md', '/docs/guide.md')))
    const { controller, history, get } = makeController(FOLDER, provider)

    controller.start('/')
    await flush()
    controller.navigate('/docs/guide.md')
    expect(history.last()).toEqual({
      op: 'push',
      url: '/acme/site/docs/guide.md',
      virtualPath: '/docs/guide.md',
    })
    await flush()
    expect(get()).toEqual({
      status: 'file',
      path: '/docs/guide.md',
      entry: fileEntry('guide.md', '/docs/guide.md'),
    })
  })

  test('restore (Back/Forward) re-resolves without touching history', async () => {
    const provider = new FakeProvider()
    provider.lists.set('/', ok([dir('docs', '/docs')]))
    provider.stats.set('/docs', statResult(dir('docs', '/docs')))
    provider.lists.set('/docs', ok([fileEntry('a.md', '/docs/a.md')]))
    const { controller, history, get } = makeController(FOLDER, provider)

    controller.start('/')
    await flush()
    controller.navigate('/docs')
    await flush()
    const entriesBefore = history.entries.length

    // Back to the root.
    controller.restore('/')
    await flush()
    expect(history.entries.length).toBe(entriesBefore) // no push/replace on popstate
    expect(get()).toEqual({
      status: 'folder',
      path: '/',
      entries: [dir('docs', '/docs')],
      nextCursor: null,
    })

    // Forward to the folder again.
    controller.restore('/docs')
    await flush()
    expect(get()).toEqual({
      status: 'folder',
      path: '/docs',
      entries: [fileEntry('a.md', '/docs/a.md')],
      nextCursor: null,
    })
  })

  test('retry re-resolves the current path after a transient error', async () => {
    const provider = new FakeProvider()
    provider.lists.set('/', fail(new PublicFileSystemError(503, 'unavailable')))
    const { controller, history, get } = makeController(FOLDER, provider)

    controller.start('/')
    await flush()
    expect(get()).toEqual({ status: 'error', path: '/', message: 'unavailable' })

    // The transport recovers; retry earns the folder without a new history entry.
    const entriesBefore = history.entries.length
    provider.lists.set('/', ok([dir('docs', '/docs')]))
    controller.retry()
    await flush()
    expect(history.entries.length).toBe(entriesBefore)
    expect(get()).toEqual({
      status: 'folder',
      path: '/',
      entries: [dir('docs', '/docs')],
      nextCursor: null,
    })
  })

  test('a slow resolution for an abandoned path cannot clobber a newer view', async () => {
    const provider = new FakeProvider()
    provider.lists.set('/', ok([dir('slow', '/slow'), dir('fast', '/fast')]))
    provider.stats.set('/slow', statResult(dir('slow', '/slow')))
    provider.stats.set('/fast', statResult(dir('fast', '/fast')))
    provider.lists.set('/slow', ok([fileEntry('old.md', '/slow/old.md')]))
    provider.lists.set('/fast', ok([fileEntry('new.md', '/fast/new.md')]))
    const { controller, get } = makeController(FOLDER, provider)

    controller.start('/')
    await flush()

    // Navigate into /slow, whose resolution hangs mid-flight.
    const releaseSlow = provider.hang('/slow')
    controller.navigate('/slow')
    await flush()
    expect(get().status).toBe('loading')

    // Before it settles, navigate into /fast, which resolves immediately.
    controller.navigate('/fast')
    await flush()
    expect(get()).toEqual({
      status: 'folder',
      path: '/fast',
      entries: [fileEntry('new.md', '/fast/new.md')],
      nextCursor: null,
    })

    // Now let the abandoned /slow resolution complete — it must be dropped.
    releaseSlow()
    await flush()
    expect(get()).toEqual({
      status: 'folder',
      path: '/fast',
      entries: [fileEntry('new.md', '/fast/new.md')],
      nextCursor: null,
    })
  })

  test('a single-file publish never lists — it settles straight on the file', async () => {
    const provider = new FakeProvider()
    provider.stats.set('/', statResult(fileEntry('report.md', '/', 900)))
    const { controller, get } = makeController(FILE, provider)

    controller.start('/')
    await flush()
    expect(get()).toEqual({ status: 'file', path: '/', entry: fileEntry('report.md', '/', 900) })
  })
})
