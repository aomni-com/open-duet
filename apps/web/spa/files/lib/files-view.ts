import { queryOptions, type QueryClient, type QueryKey } from '@tanstack/react-query'

import { duetQueryKeys } from '../../api/query-keys'
import { normalizeBrowserFilePath, parentBrowserFilePath } from './paths'
import type { DirectoryEntry, DirectoryPage, IFileSystemProvider } from './types'

export type DirectoryPages = {
  first: DirectoryPage
  continuations: readonly DirectoryPage[]
}

type ListedFilesView = {
  requestedPath: string
  folderPath: string
  entries: readonly DirectoryEntry[]
  pages: DirectoryPages
  continuation: 'idle' | 'loading' | 'error'
}

export type FilesView =
  | {
      status: 'folder'
      requestedPath: string
      folderPath: string
      entries: readonly DirectoryEntry[]
      pages: DirectoryPages
      continuation: 'idle' | 'loading' | 'error'
    }
  | {
      status: 'file'
      requestedPath: string
      folderPath: string
      entries: readonly DirectoryEntry[]
      pages: DirectoryPages
      continuation: 'idle' | 'loading' | 'error'
      previewed: DirectoryEntry
    }
  | { status: 'not-found'; requestedPath: string; parentPath: string }
  | { status: 'error'; requestedPath: string; error: Error }

/** A warm file refresh may repair a deleted preview; cold missing URLs stay not-found. */
export function deletedPreviewRepairPath(
  previous: FilesView | null,
  next: FilesView,
): string | null {
  return previous?.status === 'file' &&
    next.status === 'not-found' &&
    previous.requestedPath === next.requestedPath
    ? previous.folderPath
    : null
}

/**
 * Whether the server said anything at all.
 *
 * The one fact that separates the two kinds of failure this module has to tell
 * apart: a status means an answer arrived — 404, 401, 500 are all the server
 * speaking about this path — and no status means the browser could not ask.
 * Every provider normalizes to that, so nothing here has to know which client
 * it is talking to.
 */
function isServerAnswer(error: Error): error is Error & { status: unknown } {
  return 'status' in error
}

/** Keep resolution independent of the concrete API client while preserving HTTP semantics. */
export function isNotFoundError(error: Error): boolean {
  return isServerAnswer(error) && error.status === 404
}

/**
 * One cache entry per folder, so walking the drive re-reads nothing you already
 * looked at.
 *
 * `staleTime: 0` on purpose. The drive is written by agents while the reader is
 * standing in it, so every arrival still asks — it just asks *behind* the folder
 * it already has instead of in front of a skeleton. The cache is what you see;
 * the request is what corrects it. Anything longer would show a folder that is
 * quietly wrong and never say so.
 *
 * Stale suppression is the cache's, not the caller's: a listing that returns
 * after the reader has walked on lands on its own key and is simply not the one
 * being rendered.
 */
export function filesViewQueryOptions(
  provider: IFileSystemProvider,
  workspaceSlug: string,
  path: string | null,
  options: {
    notFoundRetry?: { attempts: number; delayMs: number }
    queryClient?: QueryClient
  } = {},
) {
  const queryKey = duetQueryKeys.workspaces.files.view(workspaceSlug, path)
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }) => {
      const view = await resolveFilesView(provider, path, { signal, ...options })
      /* A failure nobody answered is not an answer about this folder — it is
         the absence of one, which is what a browser with no network produces.
         Thrown rather than returned as data, so the listing this reader
         already has stays on screen (and stays in the persisted cache)
         instead of being overwritten by an error card about a folder nothing
         has actually said anything about. */
      if (view.status === 'error' && !isServerAnswer(view.error)) throw view.error
      const previous = options.queryClient?.getQueryData<FilesView>(queryKey)
      return await revalidateLoadedFilesView(provider, previous, view, signal)
    },
    staleTime: 0,
  })
}

/** Stateless by design: callers own stale suppression, while `folderPath` scopes folder work. */
export async function resolveFilesView(
  provider: IFileSystemProvider,
  path: string | null,
  options: {
    signal?: AbortSignal
    notFoundRetry?: { attempts: number; delayMs: number }
  } = {},
): Promise<FilesView> {
  if (path === null) {
    return { status: 'not-found', requestedPath: '/', parentPath: '/' }
  }
  if (!path.startsWith('/')) {
    return { status: 'not-found', requestedPath: path, parentPath: '/' }
  }

  let requestedPath: string
  try {
    const normalized = normalizeBrowserFilePath(path, true)
    requestedPath = normalized.length === 0 ? '/' : `/${normalized}`
  } catch {
    return { status: 'not-found', requestedPath: path, parentPath: '/' }
  }

  const attempts = Math.max(1, Math.floor(options.notFoundRetry?.attempts ?? 1))
  let result: FilesView
  for (let attempt = 1; ; attempt += 1) {
    result = await resolveCanonicalFilesView(provider, requestedPath, options.signal)
    if (result.status !== 'not-found' || attempt >= attempts || options.signal?.aborted) {
      return result
    }
    await waitForRetry(options.notFoundRetry?.delayMs ?? 0, options.signal)
  }
}

async function resolveCanonicalFilesView(
  provider: IFileSystemProvider,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<FilesView> {
  if (requestedPath === '/') {
    const listed = await provider.list('/', { signal })
    return listed.success ? listedFolder('/', '/', listed.data) : mapFailure(listed.error, '/', '/')
  }

  const stat = await provider.stat(requestedPath, { signal })
  const parentPath = parentBrowserFilePath(requestedPath)
  if (!stat.success) return mapFailure(stat.error, requestedPath, parentPath)
  if (!stat.data.entry.isDirectory) {
    const listed = await provider.list(parentPath, { signal })
    return listed.success
      ? {
          status: 'file',
          requestedPath,
          folderPath: parentPath,
          entries: listed.data.items,
          pages: { first: listed.data, continuations: [] },
          continuation: 'idle',
          previewed: stat.data.entry,
        }
      : mapFailure(listed.error, requestedPath, parentPath)
  }

  const listed = await provider.list(requestedPath, { signal })
  return listed.success
    ? listedFolder(requestedPath, requestedPath, listed.data)
    : mapFailure(listed.error, requestedPath, parentPath)
}

function listedFolder(requestedPath: string, folderPath: string, first: DirectoryPage): FilesView {
  return {
    status: 'folder',
    requestedPath,
    folderPath,
    entries: first.items,
    pages: { first, continuations: [] },
    continuation: 'idle',
  }
}

async function revalidateLoadedFilesView(
  provider: IFileSystemProvider,
  previous: FilesView | undefined,
  next: FilesView,
  signal?: AbortSignal,
): Promise<FilesView> {
  if (!isListedView(previous) || !isListedView(next)) return next
  if (previous.folderPath !== next.folderPath) return next
  if (previous.pages.continuations.length === 0) return next
  const continuations: DirectoryPage[] = []
  let cursor = next.pages.first.nextCursor
  for (let index = 0; index < previous.pages.continuations.length && cursor !== null; index++) {
    const page = await provider.list(next.folderPath, { cursor, signal })
    if (!page.success) throw page.error
    continuations.push(page.data)
    cursor = page.data.nextCursor
  }
  return withDirectoryPages(next, { first: next.pages.first, continuations })
}

export async function loadNextFilesViewPage({
  queryClient,
  queryKey,
  provider,
  signal,
}: {
  queryClient: QueryClient
  queryKey: QueryKey
  provider: IFileSystemProvider
  signal?: AbortSignal
}): Promise<FilesView> {
  const current = queryClient.getQueryData<FilesView>(queryKey)
  if (!isListedView(current)) throw new Error('Directory is not loaded')
  const cursor = nextDirectoryCursor(current.pages)
  if (cursor === null) return current
  queryClient.setQueryData(queryKey, { ...current, continuation: 'loading' })
  const page = await provider.list(current.folderPath, { cursor, signal })
  if (!page.success) {
    queryClient.setQueryData(queryKey, { ...current, continuation: 'error' })
    throw page.error
  }
  const next = {
    ...withDirectoryPages(current, {
      first: current.pages.first,
      continuations: [...current.pages.continuations, page.data],
    }),
    continuation: 'idle' as const,
  }
  queryClient.setQueryData(queryKey, next)
  return next
}

export function nextFilesViewCursor(view: FilesView | undefined): string | null {
  return isListedView(view) ? nextDirectoryCursor(view.pages) : null
}

function nextDirectoryCursor(pages: DirectoryPages): string | null {
  return (pages.continuations.at(-1) ?? pages.first).nextCursor
}

function isListedView(view: FilesView | undefined): view is FilesView & ListedFilesView {
  return view?.status === 'folder' || view?.status === 'file'
}

function withDirectoryPages<T extends FilesView & ListedFilesView>(
  view: T,
  pages: DirectoryPages,
): T {
  const byPath = new Map<string, DirectoryEntry>()
  for (const page of [pages.first, ...pages.continuations]) {
    for (const entry of page.items) byPath.set(entry.path, entry)
  }
  return { ...view, entries: [...byPath.values()], pages }
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) return
  await new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, delayMs)
    signal?.addEventListener('abort', done, { once: true })
  })
}

function mapFailure(error: Error, requestedPath: string, parentPath: string): FilesView {
  return isNotFoundError(error)
    ? { status: 'not-found', requestedPath, parentPath }
    : { status: 'error', requestedPath, error }
}
