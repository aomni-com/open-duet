import type { SpaApi } from '../../context'
import { normalizeBrowserFilePath, parentBrowserFilePath } from './paths'
import type {
  DirectoryEntry,
  DirectoryPage,
  DirectoryPageOptions,
  FileStat,
  IFileSystemProvider,
  Result,
  VersionedFile,
} from './types'

type StoredFile = { data: Uint8Array; etag: string; contentType: string; modifiedAt: Date }

export class MockFileSystemProvider implements IFileSystemProvider {
  private readonly files = new Map<string, StoredFile>()
  private readonly directories = new Set([''])
  private version = 0
  failNextOperation: string | null = null
  /* Held operations, one gate per kind. A real drive answers over the network,
     so a fixture that always resolves on the next microtask cannot show what
     the surface does *while* an answer is outstanding — which is the whole
     difference between a cold folder and a cached one being revalidated. */
  private readonly gates = new Map<
    'write' | 'list',
    { promise: Promise<void>; release: () => void }
  >()

  pauseNext(operation: 'write' | 'list'): void {
    if (this.gates.has(operation)) return
    let release!: () => void
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    this.gates.set(operation, { promise, release })
  }

  completePaused(operation: 'write' | 'list'): void {
    this.gates.get(operation)?.release()
  }

  private async passGate(operation: 'write' | 'list'): Promise<void> {
    const gate = this.gates.get(operation)
    if (gate === undefined) return
    await gate.promise
    if (this.gates.get(operation) === gate) this.gates.delete(operation)
  }

  seed(
    files: Array<{ path: string; data: Uint8Array | string; contentType?: string }>,
    directories: string[] = [],
  ): void {
    for (const directory of directories) this.seedDirectory(directory)
    for (const file of files) {
      const path = normalizeBrowserFilePath(file.path)
      this.seedDirectory(parentBrowserFilePath(path))
      const data = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data
      this.files.set(path, {
        data: new Uint8Array(data),
        etag: this.nextEtag(),
        contentType: file.contentType ?? 'application/octet-stream',
        modifiedAt: new Date('2026-07-11T08:30:00.000Z'),
      })
    }
  }

  async read(path: string, options?: { signal?: AbortSignal }): Promise<Result<Uint8Array>> {
    const result = await this.readVersioned(path, options)
    return result.success ? { success: true, data: result.data.data } : result
  }

  async readVersioned(
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<Result<VersionedFile>> {
    const failed = this.guard('read', options?.signal)
    if (failed) return failed
    const stored = this.files.get(normalizeBrowserFilePath(path))
    if (stored === undefined) return failure('not_found')
    return {
      success: true,
      data: {
        data: new Uint8Array(stored.data),
        etag: stored.etag,
        contentType: stored.contentType,
        size: stored.data.byteLength,
      },
    }
  }

  async readRange(
    path: string,
    range: { start: number; end: number },
    options?: { signal?: AbortSignal },
  ): Promise<Result<VersionedFile>> {
    const read = await this.readVersioned(path, options)
    if (!read.success) return read
    if (range.start < 0 || range.end < range.start || range.start >= read.data.size) {
      return failure('range_not_satisfiable')
    }
    return {
      success: true,
      data: {
        ...read.data,
        data: read.data.data.slice(range.start, Math.min(range.end + 1, read.data.size)),
      },
    }
  }

  async write(
    path: string,
    data: Uint8Array,
    options: {
      mkdir?: boolean
      ifMatch?: string
      contentType?: string
      signal?: AbortSignal
    } = {},
  ): Promise<Result<{ etag: string; size: number }>> {
    await this.passGate('write')
    const failed = this.guard('write', options.signal)
    if (failed) return failed
    const normalized = normalizeBrowserFilePath(path)
    const parent = normalizeBrowserFilePath(parentBrowserFilePath(normalized), true)
    if (!this.directories.has(parent)) {
      if (!options.mkdir) return failure('parent_not_found')
      this.seedDirectory(parent)
    }
    const existing = this.files.get(normalized)
    if (options.ifMatch !== undefined && existing?.etag !== options.ifMatch) {
      return failure('precondition_failed')
    }
    const stored = {
      data: new Uint8Array(data),
      etag: this.nextEtag(),
      contentType: options.contentType ?? existing?.contentType ?? 'application/octet-stream',
      modifiedAt: new Date('2026-07-11T08:30:00.000Z'),
    }
    this.files.set(normalized, stored)
    return { success: true, data: { etag: stored.etag, size: stored.data.byteLength } }
  }

  // Fixture files are small by construction, so the mock is allowed the read
  // the real provider must never do; it reports the progress a caller draws.
  async upload(
    path: string,
    file: File,
    options: { onProgress?(percent: number): void; signal?: AbortSignal } = {},
  ): Promise<Result> {
    const written = await this.write(path, new Uint8Array(await file.arrayBuffer()), {
      mkdir: true,
      contentType: file.type || undefined,
      signal: options.signal,
    })
    if (!written.success) return written
    options.onProgress?.(100)
    return success()
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean; signal?: AbortSignal } = {},
  ): Promise<Result> {
    const failed = this.guard('mkdir', options.signal)
    if (failed) return failed
    const normalized = normalizeBrowserFilePath(path)
    if (this.files.has(normalized)) return failure('path_exists')
    const parent = normalizeBrowserFilePath(parentBrowserFilePath(normalized), true)
    if (!this.directories.has(parent) && !options.recursive) return failure('parent_not_found')
    this.seedDirectory(normalized)
    return success()
  }

  async delete(
    path: string,
    options: { recursive?: boolean; signal?: AbortSignal } = {},
  ): Promise<Result> {
    const failed = this.guard('delete', options.signal)
    if (failed) return failed
    const normalized = normalizeBrowserFilePath(path)
    if (this.files.delete(normalized)) return success()
    if (!this.directories.has(normalized)) return failure('not_found')
    const prefix = `${normalized}/`
    const hasChildren =
      [...this.files.keys()].some(value => value.startsWith(prefix)) ||
      [...this.directories].some(value => value !== normalized && value.startsWith(prefix))
    if (hasChildren && !options.recursive) return failure('directory_not_empty')
    this.removeEntries(normalized)
    return success()
  }

  async rename(
    source: string,
    destination: string,
    options: { overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<Result> {
    const failed = this.guard('move', options.signal)
    if (failed) return failed
    const copied = this.copyEntries(source, destination, options.overwrite ?? false)
    if (!copied.success) return copied
    this.removeEntries(normalizeBrowserFilePath(source))
    return success()
  }

  async copy(
    source: string,
    destination: string,
    options: { recursive?: boolean; overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<Result> {
    const failed = this.guard('copy', options.signal)
    if (failed) return failed
    const normalized = normalizeBrowserFilePath(source)
    if (this.directories.has(normalized) && !options.recursive) return failure('recursive_required')
    return this.copyEntries(source, destination, options.overwrite ?? false)
  }

  async list(path: string, options: DirectoryPageOptions = {}): Promise<Result<DirectoryPage>> {
    await this.passGate('list')
    const failed = this.guard('list', options.signal)
    if (failed) return failed
    const normalized = normalizeBrowserFilePath(path, true)
    if (!this.directories.has(normalized)) return failure('not_found')
    const prefix = normalized.length === 0 ? '' : `${normalized}/`
    const entries: DirectoryEntry[] = []
    for (const directory of this.directories) {
      if (directory === '' || directory === normalized || !directory.startsWith(prefix)) continue
      const remainder = directory.slice(prefix.length)
      if (remainder.includes('/')) continue
      entries.push({
        name: remainder,
        path: `/${directory}`,
        type: 'directory',
        isDirectory: true,
        size: 0,
      })
    }
    for (const [filePath, stored] of this.files) {
      if (!filePath.startsWith(prefix)) continue
      const remainder = filePath.slice(prefix.length)
      if (remainder.includes('/')) continue
      entries.push({
        name: remainder,
        path: `/${filePath}`,
        type: 'file',
        isDirectory: false,
        size: stored.data.byteLength,
        modifiedAt: stored.modifiedAt,
      })
    }
    entries.sort(
      (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
    )
    const start = options.cursor === undefined ? 0 : Number(options.cursor)
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)))
    const items = entries.slice(start, start + limit)
    return {
      success: true,
      data: {
        items,
        nextCursor: start + items.length < entries.length ? String(start + items.length) : null,
      },
    }
  }

  async stat(path: string, options: { signal?: AbortSignal } = {}): Promise<Result<FileStat>> {
    const failed = this.guard('stat', options.signal)
    if (failed) return failed
    const normalized = normalizeBrowserFilePath(path)
    const stored = this.files.get(normalized)
    if (stored !== undefined) {
      return {
        success: true,
        data: {
          entry: {
            name: normalized.split('/').at(-1)!,
            path: `/${normalized}`,
            type: 'file',
            isDirectory: false,
            size: stored.data.byteLength,
            modifiedAt: stored.modifiedAt,
          },
          etag: stored.etag,
        },
      }
    }
    if (this.directories.has(normalized)) {
      return {
        success: true,
        data: {
          entry: {
            name: normalized.split('/').at(-1)!,
            path: `/${normalized}`,
            type: 'directory',
            isDirectory: true,
            size: 0,
          },
          etag: null,
        },
      }
    }
    return failure('not_found')
  }

  downloadUrl(path: string, options: { version?: string | number } = {}): string {
    const file = this.files.get(normalizeBrowserFilePath(path))
    if (file === undefined) return '/playground/__missing-file__'
    const bytes = Array.from(file.data, byte => String.fromCharCode(byte)).join('')
    const url = `data:${file.contentType};base64,${btoa(bytes)}`
    return options.version === undefined
      ? url
      : `${url}#v=${encodeURIComponent(String(options.version))}`
  }

  private seedDirectory(path: string): void {
    const normalized = normalizeBrowserFilePath(path, true)
    let current = ''
    for (const part of normalized.split('/').filter(Boolean)) {
      current = current.length === 0 ? part : `${current}/${part}`
      this.directories.add(current)
    }
  }

  private copyEntries(source: string, destination: string, overwrite: boolean): Result {
    const from = normalizeBrowserFilePath(source)
    const to = normalizeBrowserFilePath(destination)
    if (to === from || to.startsWith(`${from}/`)) return failure('invalid_destination')
    const sourceFile = this.files.get(from)
    const sourceDirectory = this.directories.has(from)
    if (sourceFile === undefined && !sourceDirectory) return failure('not_found')
    const destinationFile = this.files.has(to)
    const destinationDirectory = this.directories.has(to)
    if ((destinationFile || destinationDirectory) && !overwrite) return failure('path_exists')
    if ((destinationFile || destinationDirectory) && (sourceDirectory || destinationDirectory)) {
      return failure('directory_overwrite_not_supported')
    }
    const parent = normalizeBrowserFilePath(parentBrowserFilePath(to), true)
    if (!this.directories.has(parent)) return failure('parent_not_found')
    if (sourceFile !== undefined) {
      this.files.set(to, {
        ...sourceFile,
        data: new Uint8Array(sourceFile.data),
        etag: this.nextEtag(),
      })
      return success()
    }
    this.directories.add(to)
    for (const directory of this.directories) {
      if (directory.startsWith(`${from}/`))
        this.directories.add(`${to}${directory.slice(from.length)}`)
    }
    for (const [path, stored] of this.files) {
      if (path.startsWith(`${from}/`)) {
        this.files.set(`${to}${path.slice(from.length)}`, {
          ...stored,
          data: new Uint8Array(stored.data),
          etag: this.nextEtag(),
        })
      }
    }
    return success()
  }

  private removeEntries(path: string): void {
    const prefix = `${path}/`
    this.files.delete(path)
    for (const value of this.files.keys()) if (value.startsWith(prefix)) this.files.delete(value)
    for (const value of this.directories) {
      if (value === path || value.startsWith(prefix)) this.directories.delete(value)
    }
  }

  private guard(operation: string, signal?: AbortSignal): { success: false; error: Error } | null {
    if (signal?.aborted) return { success: false, error: new Error('aborted') }
    if (this.failNextOperation === operation) {
      this.failNextOperation = null
      return { success: false, error: new Error(`${operation}_failed`) }
    }
    return null
  }

  private nextEtag(): string {
    this.version += 1
    return `"mock-${this.version}"`
  }
}

function success(): Result {
  return { success: true, data: undefined }
}

function failure<T = void>(message: string): Result<T> {
  const error = new Error(message)
  if (message === 'not_found') Object.assign(error, { status: 404 })
  if (message === 'precondition_failed') {
    Object.assign(error, { status: 412, code: 'precondition_failed' })
  }
  return { success: false, error }
}

/**
 * The stat half of the API client, answered by a mock provider.
 *
 * The session file viewer stats in the wire dialect through the client, so a
 * fixture that stands in for the drive needs the same seam. A fixture never
 * names a VM-absolute file; anything it asks for is a drive path.
 */
export function mockFileStatApi(
  provider: Pick<IFileSystemProvider, 'stat'>,
): Pick<SpaApi, 'statWorkspaceFile'> {
  return {
    async statWorkspaceFile(_workspaceSlug, path, signal) {
      const result = await provider.stat(`/${path}`, { signal })
      if (!result.success) throw result.error
      const { entry, etag } = result.data
      return {
        entry: {
          name: entry.name,
          path: normalizeBrowserFilePath(entry.path),
          type: entry.type,
          size: entry.size ?? 0,
          mtime: (entry.modifiedAt ?? new Date(0)).toISOString(),
          ...(entry.target === undefined ? {} : { target: entry.target }),
        },
        etag,
      }
    },
  }
}
