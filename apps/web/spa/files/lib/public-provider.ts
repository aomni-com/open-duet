import { FileListResponseSchema, type ViewerDescriptor } from '@repo/contract'

import { encodeBrowserFilePath, fileName, normalizeBrowserFilePath } from './paths'
import {
  directoryEntryFromContract,
  type DirectoryPage,
  type DirectoryPageOptions,
  type DirectoryEntry,
  type FileStat,
  type IFileSystemProvider,
  type Result,
  type VersionedFile,
} from './types'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Thrown by every mutator before any request is issued. A publish is a
 * read-only public viewer: `write`/`mkdir`/`delete`/`rename`/`copy` have no
 * anonymous verb and must never reach the network.
 */
export class PublicFileSystemReadOnlyError extends Error {
  override readonly name = 'PublicFileSystemReadOnlyError'

  constructor(readonly operation: string) {
    super(`Publish is read-only; ${operation} is not permitted`)
  }
}

/**
 * A failed anonymous fetch, carrying the HTTP status so callers can map the
 * public gateway's typed failures (404 not-found, 409 selector conflict) the
 * same way `DuetApiError` exposes them for the authenticated path.
 */
export class PublicFileSystemError extends Error {
  override readonly name = 'PublicFileSystemError'

  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

/**
 * Read-only, same-origin, anonymous `IFileSystemProvider` for a public publish.
 * It talks only to the publish's own edge origin through the public data
 * contract — `?list` (directory JSON) and `?raw` (file bytes) — never importing
 * the authenticated REST client. Every fetch is `credentials: 'omit'` and sets
 * no `authorization`/`cookie` header, so no ambient credential can ride along.
 *
 * Paths are virtual, rooted at the publish root ('/'). For a `kind: 'file'`
 * publish the root path maps to the single file itself.
 */
export class PublicFileSystemProvider implements IFileSystemProvider {
  private readonly base: string
  private readonly fetchImpl: FetchLike

  constructor(
    private readonly descriptor: ViewerDescriptor,
    basePublishUrl: string,
    fetchImpl: FetchLike = fetch,
  ) {
    // Base is the publish root URL (e.g. `https://edge.duet.so/<ws>/<pub>`);
    // strip trailing slashes so `${base}/${segment}` and bare `${base}` compose
    // cleanly at the root.
    this.base = basePublishUrl.replace(/\/+$/, '')
    // Wrapped, never stored bare — the same seam DuetApiClient uses. The
    // browser's fetch is brand-checked on the global object, so calling a bare
    // reference as `this.fetchImpl(...)` hands it this instance as `this` and
    // throws "Illegal invocation" without ever reaching the network.
    this.fetchImpl = (input, init) => fetchImpl(input, init)
  }

  async read(path: string, options: { signal?: AbortSignal } = {}): Promise<Result<Uint8Array>> {
    const result = await this.readVersioned(path, options)
    return result.success ? { success: true, data: result.data.data } : result
  }

  async readVersioned(
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<VersionedFile>> {
    return await this.rawRead(path, undefined, options.signal)
  }

  async readRange(
    path: string,
    range: { start: number; end: number },
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<VersionedFile>> {
    if (range.start < 0 || range.end < range.start) {
      return { success: false, error: new Error('Invalid byte range') }
    }
    return await this.rawRead(path, range, options.signal)
  }

  async list(path: string, options: DirectoryPageOptions = {}): Promise<Result<DirectoryPage>> {
    return await guarded(async () => {
      const response = await this.request(
        this.url(path, 'list', { cursor: options.cursor, limit: options.limit }),
        {},
        options.signal,
      )
      const parsed = FileListResponseSchema.safeParse(await response.json())
      if (!parsed.success) throw new PublicFileSystemError(502, 'invalid_response')
      return {
        items: parsed.data.items.map(directoryEntryFromContract),
        nextCursor: parsed.data.nextCursor,
      }
    })
  }

  async stat(path: string, options: { signal?: AbortSignal } = {}): Promise<Result<FileStat>> {
    return await guarded(async () => {
      if (normalizeBrowserFilePath(path, true) === '') {
        return { entry: await this.statRoot(options.signal), etag: null }
      }
      const normalized = normalizeBrowserFilePath(path)
      const browserPath = `/${normalized}`
      const directoryProbe = await this.fetch(
        this.url(browserPath, 'list', { limit: 1 }),
        {},
        options.signal,
      )
      if (directoryProbe.ok) {
        return {
          entry: {
            name: fileName(browserPath),
            path: browserPath,
            type: 'directory',
            isDirectory: true,
            size: 0,
          },
          etag: null,
        }
      }
      if (directoryProbe.status !== 409) throw await publicFetchError(directoryProbe)

      const fileProbe = await this.fetch(
        this.url(browserPath, 'raw'),
        { headers: { range: 'bytes=0-0' } },
        options.signal,
      )
      const size = totalSizeFromProbe(fileProbe)
      if (size === null) throw await publicFetchError(fileProbe)
      const modifiedAt = parseLastModified(fileProbe.headers.get('last-modified'))
      return {
        entry: {
          name: fileName(browserPath),
          path: browserPath,
          type: 'file',
          isDirectory: false,
          size,
          ...(modifiedAt === undefined ? {} : { modifiedAt }),
        },
        etag: fileProbe.headers.get('etag'),
      }
    })
  }

  downloadUrl(path: string, options: { version?: string | number } = {}): string {
    // Public raw URLs are version-invariant; consuming the option keeps the
    // concrete provider substitutable without turning it into a live source.
    void options
    return this.url(path, 'raw')
  }

  /** The public `?zip` archive URL for a folder's visible subtree. */
  archiveUrl(path: string): string {
    return this.url(path, 'zip')
  }

  // Mutators: every one throws before any fetch. A publish exposes no anonymous
  // write verb, so these can never touch the network. Signatures mirror the
  // interface so callers type-check; the arguments are never read.
  write(
    _path: string,
    _data: Uint8Array,
    _options?: { mkdir?: boolean; ifMatch?: string; contentType?: string; signal?: AbortSignal },
  ): Promise<Result<{ etag: string; size: number }>> {
    throw new PublicFileSystemReadOnlyError('write')
  }

  upload(
    _path: string,
    _file: File,
    _options?: { onProgress?(percent: number): void; signal?: AbortSignal },
  ): Promise<Result> {
    throw new PublicFileSystemReadOnlyError('upload')
  }

  mkdir(_path: string, _options?: { recursive?: boolean; signal?: AbortSignal }): Promise<Result> {
    throw new PublicFileSystemReadOnlyError('mkdir')
  }

  delete(_path: string, _options?: { recursive?: boolean; signal?: AbortSignal }): Promise<Result> {
    throw new PublicFileSystemReadOnlyError('delete')
  }

  rename(
    _source: string,
    _destination: string,
    _options?: { overwrite?: boolean; signal?: AbortSignal },
  ): Promise<Result> {
    throw new PublicFileSystemReadOnlyError('rename')
  }

  copy(
    _source: string,
    _destination: string,
    _options?: { recursive?: boolean; overwrite?: boolean; signal?: AbortSignal },
  ): Promise<Result> {
    throw new PublicFileSystemReadOnlyError('copy')
  }

  private async rawRead(
    path: string,
    range: { start: number; end: number } | undefined,
    signal?: AbortSignal,
  ): Promise<Result<VersionedFile>> {
    return await guarded(async () => {
      const headers =
        range === undefined ? undefined : { range: `bytes=${range.start}-${range.end}` }
      const response = await this.request(this.url(path, 'raw'), { headers }, signal)
      const data = new Uint8Array(await response.arrayBuffer())
      return versionedFileFromResponse(response, data)
    })
  }

  private async statRoot(signal?: AbortSignal): Promise<DirectoryEntry> {
    if (this.descriptor.kind === 'folder') {
      // The publish root of a folder is a directory; no fetch needed.
      return {
        name: this.descriptor.rootName,
        path: '/',
        type: 'directory',
        isDirectory: true,
        size: 0,
      }
    }
    // A single-file root has no parent listing to read its size from (a file
    // publish refuses `?list`). A ranged `?raw` probe yields the exact total
    // from `content-range` for any file type without downloading its bytes —
    // the source the PreviewPane office ceiling needs.
    const response = await this.fetch(
      this.url('/', 'raw'),
      { headers: { range: 'bytes=0-0' } },
      signal,
    )
    const size = totalSizeFromProbe(response)
    if (size === null) throw await publicFetchError(response)
    const modifiedAt = parseLastModified(response.headers.get('last-modified'))
    return {
      name: this.descriptor.rootName,
      path: '/',
      type: 'file',
      isDirectory: false,
      size,
      ...(modifiedAt === undefined ? {} : { modifiedAt }),
    }
  }

  private url(
    path: string,
    selector: 'list' | 'raw' | 'zip',
    page: { cursor?: string; limit?: number } = {},
  ): string {
    // Virtual, publish-root-relative. `normalizeBrowserFilePath` rejects `..`,
    // `.`, and `.duet` client-side (defense-in-depth over the gateway), and
    // `encodeBrowserFilePath` percent-encodes each segment (spaces, Unicode).
    const normalized = normalizeBrowserFilePath(path, true)
    const encoded = normalized === '' ? '' : encodeBrowserFilePath(normalized)
    const target = encoded === '' ? this.base : `${this.base}/${encoded}`
    const pageQuery = new URLSearchParams()
    if (page.cursor !== undefined) pageQuery.set('cursor', page.cursor)
    if (page.limit !== undefined) pageQuery.set('limit', String(page.limit))
    const continuation = pageQuery.toString()
    return `${target}?${selector}${continuation === '' ? '' : `&${continuation}`}`
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetch(url, init, signal)
    // 416 is the only non-ok status the range probe expects; content reads never
    // ask for it, so every non-ok here is a real failure.
    if (!response.ok) throw await publicFetchError(response)
    return response
  }

  private async fetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    // The single choke point for anonymity: `credentials: 'omit'` on every
    // fetch and never an `authorization`/`cookie` header.
    return await this.fetchImpl(url, { ...init, credentials: 'omit', signal })
  }
}

async function guarded<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

function versionedFileFromResponse(response: Response, data: Uint8Array): VersionedFile {
  // On a 206, `content-range: bytes s-e/total` carries the full file size; a
  // full read carries none and the body length is the size. Mirrors the
  // authenticated `DuetApiClient.readWorkspaceFile` projection.
  const totalSize = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]
  return {
    data,
    etag: response.headers.get('etag'),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    size: totalSize === undefined ? data.byteLength : Number(totalSize),
  }
}

// Total file size from a `bytes=0-0` probe: a 206 reports `bytes 0-0/N`, and a
// 416 (empty file, or start past EOF) reports `bytes */N`. Returns null when the
// response is neither, so the caller can surface the real failure.
function totalSizeFromProbe(response: Response): number | null {
  if (response.status === 206 || response.status === 416) {
    const total = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]
    if (total !== undefined) return Number(total)
  }
  if (response.status === 200) {
    const length = response.headers.get('content-length')
    if (length !== null) return Number(length)
  }
  return null
}

function parseLastModified(value: string | null): Date | undefined {
  if (value === null) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

async function publicFetchError(response: Response): Promise<PublicFileSystemError> {
  let code = response.status === 404 ? 'not_found' : 'request_failed'
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (typeof payload.error === 'string') code = payload.error
  } catch {
    // Status stays the stable signal when an intermediary returns non-JSON.
  }
  return new PublicFileSystemError(response.status, code)
}
