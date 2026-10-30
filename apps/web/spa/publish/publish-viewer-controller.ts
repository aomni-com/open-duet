import type { ViewerDescriptor } from '@repo/contract'

import { encodeBrowserFilePath, normalizeBrowserFilePath } from '../files/lib/paths'
import { PublicFileSystemError } from '../files/lib/public-provider'
import type { DirectoryEntry, IFileSystemProvider } from '../files/lib/types'

/**
 * What the public viewer is showing right now. One discriminated union drives
 * the whole route: the controller resolves a virtual path into exactly one of
 * these and the React shell renders the matching surface. `loading` is the only
 * transient; every other state is a settled view a deep link can reproduce.
 */
export type PublishViewerState =
  | { status: 'loading' }
  | {
      status: 'folder'
      path: string
      entries: readonly DirectoryEntry[]
      nextCursor?: string | null
      continuation?: 'idle' | 'loading' | 'error'
    }
  | { status: 'file'; path: string; entry: DirectoryEntry }
  | { status: 'not-found'; path: string }
  | { status: 'error'; path: string; message: string }

/**
 * The user-facing publish URL for a virtual path. It is always rooted at the
 * publish's own `/<ws>/<pub>` and can never address a parent of it — the prefix
 * is fixed and `..`/`.`/`.duet` segments are stripped by `normalizeBrowserFilePath`,
 * which is what confines the breadcrumb to the publish root. Every path segment
 * is percent-encoded (spaces, Unicode) so the URL round-trips byte-for-byte.
 */
export function publishViewerUrl(
  workspaceSlug: string,
  publishSlug: string,
  virtualPath: string,
): string {
  const base = `/${workspaceSlug}/${publishSlug}`
  let normalized: string
  try {
    normalized = normalizeBrowserFilePath(virtualPath, true)
  } catch {
    return base
  }
  return normalized === '' ? base : `${base}/${encodeBrowserFilePath(normalized)}`
}

/**
 * The publish-root-relative virtual path a browser pathname points at, or
 * `null` when the pathname is not inside this publish. Accepts both the bare
 * public grammar and the internal `/publish/…` rewrite target. Returning `null`
 * for anything outside `/<ws>/<pub>` is the confinement guarantee: no URL above
 * the publish root ever resolves to a viewable path.
 */
export function virtualPathFromPathname(
  workspaceSlug: string,
  publishSlug: string,
  pathname: string,
): string | null {
  let segments: string[]
  try {
    segments = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  // User-facing links stay bare (`/<ws>/<pub>/…`), but a browser that reloaded
  // the edge's internal rewrite target can show `/publish/<ws>/<pub>/…`; tolerate
  // that prefix on the way in even though the URL builder never emits it. Prefer
  // the bare grammar so a workspace literally named `publish` still resolves
  // (stripping the prefix unconditionally would misread `/publish/<pub>/…`).
  const matchesRoot = (candidate: string[]) =>
    candidate[0] === workspaceSlug && candidate[1] === publishSlug
  const rest = matchesRoot(segments)
    ? segments
    : segments[0] === 'publish' && matchesRoot(segments.slice(1))
      ? segments.slice(1)
      : null
  if (rest === null) return null
  const tail = rest.slice(2)
  if (tail.length === 0) return '/'
  try {
    return `/${normalizeBrowserFilePath(tail.join('/'))}`
  } catch {
    return null
  }
}

/**
 * Resolve a virtual path against the provider into a settled view. This is the
 * deep-link resolver: it derives folder-vs-file from the provider's exact-path
 * stat, so a reloaded nested URL lands on the same surface without searching a
 * possibly incomplete parent directory or amending the descriptor.
 *
 * - A `kind: 'file'` publish is addressable only at its root; any deeper path is
 *   not-found, and the root opens the file viewer directly (no folder chrome).
 * - A `kind: 'folder'` publish lists the root; a nested path is `stat`-ed —
 *   directories are listed, everything else opens as a file.
 */
export async function resolvePublishView(
  descriptor: ViewerDescriptor,
  virtualPath: string,
  provider: IFileSystemProvider,
  signal?: AbortSignal,
): Promise<PublishViewerState> {
  let normalized: string
  try {
    normalized = normalizeBrowserFilePath(virtualPath, true)
  } catch {
    // `..`, `.`, `.duet`, or an empty segment can never name a published entry.
    return { status: 'not-found', path: virtualPath }
  }
  const isRoot = normalized === ''

  if (descriptor.kind === 'file') {
    if (!isRoot) return { status: 'not-found', path: virtualPath }
    const stat = await provider.stat('/', { signal })
    return stat.success
      ? { status: 'file', path: '/', entry: stat.data.entry }
      : mapFailure(stat.error, '/')
  }

  if (isRoot) {
    const list = await provider.list('/', { signal })
    return list.success
      ? {
          status: 'folder',
          path: '/',
          entries: list.data.items,
          nextCursor: list.data.nextCursor,
        }
      : mapFailure(list.error, '/')
  }

  const path = `/${normalized}`
  const stat = await provider.stat(path, { signal })
  if (!stat.success) return mapFailure(stat.error, path)
  if (stat.data.entry.isDirectory) {
    const list = await provider.list(path, { signal })
    return list.success
      ? {
          status: 'folder',
          path,
          entries: list.data.items,
          nextCursor: list.data.nextCursor,
        }
      : mapFailure(list.error, path)
  }
  return { status: 'file', path, entry: stat.data.entry }
}

function mapFailure(error: Error, path: string): PublishViewerState {
  if (error instanceof PublicFileSystemError && error.status === 404) {
    return { status: 'not-found', path }
  }
  return { status: 'error', path, message: error.message }
}

/** How a navigation touches the browser history stack. */
type HistoryMode = 'push' | 'replace' | 'none'

/**
 * The browser-history seam the controller drives. The React shell backs it with
 * `window.history`; tests back it with a recorder. The controller never touches
 * `window` directly, so its whole URL↔state contract is exercised without a DOM.
 */
export interface PublishHistoryPort {
  push(url: string, virtualPath: string): void
  replace(url: string, virtualPath: string): void
}

/**
 * Owns the URL↔virtual-path relationship for one public publish. It holds the
 * current `PublishViewerState`, pushes/replaces history on navigation, restores
 * on `popstate`, and — critically — tags every resolution with a monotonic
 * sequence so a slow in-flight list/read for an abandoned path can never
 * clobber the view a newer navigation already settled on.
 */
export class PublishViewerController {
  private readonly descriptor: ViewerDescriptor
  private readonly workspaceSlug: string
  private readonly publishSlug: string
  private readonly provider: IFileSystemProvider
  private readonly history: PublishHistoryPort
  private readonly onChange: (state: PublishViewerState) => void

  private _state: PublishViewerState = { status: 'loading' }
  private currentPath = '/'
  private seq = 0
  private inFlight?: AbortController

  constructor(options: {
    descriptor: ViewerDescriptor
    workspaceSlug: string
    publishSlug: string
    provider: IFileSystemProvider
    history: PublishHistoryPort
    onChange: (state: PublishViewerState) => void
  }) {
    this.descriptor = options.descriptor
    this.workspaceSlug = options.workspaceSlug
    this.publishSlug = options.publishSlug
    this.provider = options.provider
    this.history = options.history
    this.onChange = options.onChange
  }

  get state(): PublishViewerState {
    return this._state
  }

  /** Initial resolution on mount: pins the history entry, then resolves. */
  start(initialVirtualPath: string): void {
    this.run(initialVirtualPath, 'replace')
  }

  /** A folder card, breadcrumb, or opened document: push the URL, then resolve. */
  navigate(virtualPath: string): void {
    this.run(virtualPath, 'push')
  }

  /** A `popstate` (Back/Forward): the URL already changed, so only resolve. */
  restore(virtualPath: string): void {
    this.run(virtualPath, 'none')
  }

  /** Re-resolve the current path after a transient failure. */
  retry(): void {
    this.run(this.currentPath, 'none')
  }

  /** Fetch exactly one continuation page after a visitor asks for it. */
  async loadMore(): Promise<void> {
    const current = this._state
    if (current.status !== 'folder' || current.nextCursor == null) return
    const cursor = current.nextCursor
    const seq = ++this.seq
    this.inFlight?.abort()
    const abort = new AbortController()
    this.inFlight = abort
    this.emit({ ...current, continuation: 'loading' })

    const page = await this.provider.list(current.path, { cursor, signal: abort.signal })
    if (seq !== this.seq) return
    if (!page.success) {
      this.emit({ ...current, continuation: 'error' })
      return
    }
    const entries = new Map(current.entries.map(entry => [entry.path, entry]))
    for (const entry of page.data.items) entries.set(entry.path, entry)
    this.emit({
      ...current,
      entries: [...entries.values()],
      nextCursor: page.data.nextCursor,
      continuation: 'idle',
    })
  }

  private run(virtualPath: string, history: HistoryMode): void {
    this.currentPath = virtualPath
    const url = publishViewerUrl(this.workspaceSlug, this.publishSlug, virtualPath)
    if (history === 'push') this.history.push(url, virtualPath)
    else if (history === 'replace') this.history.replace(url, virtualPath)

    const seq = ++this.seq
    this.inFlight?.abort()
    const abort = new AbortController()
    this.inFlight = abort
    this.emit({ status: 'loading' })

    void resolvePublishView(this.descriptor, virtualPath, this.provider, abort.signal)
      .then(state => {
        if (seq === this.seq) this.emit(state)
      })
      .catch((error: unknown) => {
        if (seq !== this.seq) return
        this.emit({
          status: 'error',
          path: virtualPath,
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }

  private emit(state: PublishViewerState): void {
    this._state = state
    this.onChange(state)
  }
}
