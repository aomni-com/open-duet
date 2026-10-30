import type { FileEntry } from '@repo/contract'

export type Result<T = void> = { success: true; data: T } | { success: false; error: Error }

type DirectoryEntryBase = {
  name: string
  path: string
  size?: number
  modifiedAt?: Date
  /**
   * Where a symlink points, verbatim from the listing. Absent on ordinary files
   * and folders.
   *
   * The drive shows a symlink as itself rather than resolving it: following one
   * would let a link out of the workspace read as a folder of it, and dropping
   * it would hide a real entry the agent can see. Neither is honest, so the row
   * stays opaque and says where it points.
   */
  target?: string
}

export type DirectoryEntry =
  | (DirectoryEntryBase & { type: 'directory'; isDirectory: true })
  | (DirectoryEntryBase & { type: Exclude<FileEntry['type'], 'directory'>; isDirectory: false })

export type VersionedFile = {
  data: Uint8Array
  etag: string | null
  contentType: string
  size: number
}

export type FileStat = {
  entry: DirectoryEntry
  etag: string | null
}

export type DirectoryPage = {
  items: readonly DirectoryEntry[]
  nextCursor: string | null
}

export type DirectoryPageOptions = {
  cursor?: string
  limit?: number
  signal?: AbortSignal
}

export interface IFileSystemProvider {
  read(path: string, options?: { signal?: AbortSignal }): Promise<Result<Uint8Array>>
  readVersioned(path: string, options?: { signal?: AbortSignal }): Promise<Result<VersionedFile>>
  readRange(
    path: string,
    range: { start: number; end: number },
    options?: { signal?: AbortSignal },
  ): Promise<Result<VersionedFile>>
  write(
    path: string,
    data: Uint8Array,
    options?: { mkdir?: boolean; ifMatch?: string; contentType?: string; signal?: AbortSignal },
  ): Promise<Result<{ etag: string; size: number }>>
  /**
   * Put a file the user picked at `path`, without ever holding its bytes.
   *
   * Separate from `write` because the two cannot share a transport. `write`
   * takes bytes that are already in memory — an edited document, a new empty
   * file — and a picked file may be gigabytes, where materializing it is what
   * kills the tab. So this takes the `File` and hands it to something that can
   * stream it, and reports how far along it is on the way.
   */
  upload(
    path: string,
    file: File,
    options?: { onProgress?(percent: number): void; signal?: AbortSignal },
  ): Promise<Result>
  mkdir(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<Result>
  delete(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<Result>
  rename(
    source: string,
    destination: string,
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ): Promise<Result>
  copy(
    source: string,
    destination: string,
    options?: { recursive?: boolean; overwrite?: boolean; signal?: AbortSignal },
  ): Promise<Result>
  list(path: string, options?: DirectoryPageOptions): Promise<Result<DirectoryPage>>
  stat(path: string, options?: { signal?: AbortSignal }): Promise<Result<FileStat>>
  downloadUrl(path: string, options?: { version?: string | number }): string
}

export function directoryEntryFromContract(entry: FileEntry): DirectoryEntry {
  const projected = {
    name: entry.name,
    path: `/${entry.path}`,
    size: entry.size,
    modifiedAt: new Date(entry.mtime),
    ...(entry.target === undefined ? {} : { target: entry.target }),
  }
  return entry.type === 'directory'
    ? { ...projected, type: 'directory', isDirectory: true }
    : { ...projected, type: entry.type, isDirectory: false }
}
