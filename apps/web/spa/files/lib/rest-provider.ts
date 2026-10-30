import type { FileOperationRequest } from '@repo/contract'

import { duetApi, type DuetApiClient } from '../../api/client'
import { DriveUploadSessions } from '../../api/drive-upload-sessions'
import { VmUploadClient } from '../../api/vm-uploads'
import { normalizeBrowserFilePath } from './paths'
import {
  directoryEntryFromContract,
  type DirectoryPage,
  type DirectoryPageOptions,
  type FileStat,
  type IFileSystemProvider,
  type Result,
  type VersionedFile,
} from './types'

type WorkspaceFilesApi = Pick<
  DuetApiClient,
  | 'readWorkspaceFile'
  | 'writeWorkspaceFile'
  | 'listWorkspaceFiles'
  | 'statWorkspaceFile'
  | 'operateOnWorkspaceFiles'
  | 'workspaceFileDownloadUrl'
  | 'mintDriveUploadSession'
>

export class RestFileSystemProvider implements IFileSystemProvider {
  private readonly driveUploads: DriveUploadSessions

  constructor(
    private readonly workspaceSlug: string,
    private readonly api: WorkspaceFilesApi = duetApi,
    private readonly onError: ((error: Error) => void) | undefined,
    uploads: VmUploadClient = new VmUploadClient(),
  ) {
    this.driveUploads = new DriveUploadSessions({ workspaceSlug, api, uploads })
  }

  async read(path: string, options: { signal?: AbortSignal } = {}): Promise<Result<Uint8Array>> {
    const result = await this.readVersioned(path, options)
    return result.success ? { success: true, data: result.data.data } : result
  }

  async readVersioned(
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<VersionedFile>> {
    return await resultFromRequest(
      () => this.api.readWorkspaceFile(this.workspaceSlug, normalizeBrowserFilePath(path), options),
      this.onError,
    )
  }

  async readRange(
    path: string,
    range: { start: number; end: number },
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<VersionedFile>> {
    if (range.start < 0 || range.end < range.start) {
      return { success: false, error: new Error('Invalid byte range') }
    }
    return await resultFromRequest(
      () =>
        this.api.readWorkspaceFile(this.workspaceSlug, normalizeBrowserFilePath(path), {
          range,
          signal: options.signal,
        }),
      this.onError,
    )
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
    const normalizedPath = normalizeBrowserFilePath(path)
    if (options.mkdir) {
      const parent = normalizedPath.split('/').slice(0, -1).join('/')
      if (parent.length > 0) {
        const made = await this.mkdir(parent, { recursive: true, signal: options.signal })
        if (!made.success) return made
      }
    }
    return await resultFromRequest(async () => {
      const written = await this.api.writeWorkspaceFile(this.workspaceSlug, normalizedPath, data, {
        ifMatch: options.ifMatch,
        contentType: options.contentType,
        signal: options.signal,
      })
      return { etag: written.etag, size: written.size }
    }, this.onError)
  }

  /* The bytes go to the workspace VM, not through this API — see
     `DriveUploadSessions`, which owns the grant a folder's worth of files
     shares. */
  async upload(
    path: string,
    file: File,
    options: { onProgress?(percent: number): void; signal?: AbortSignal } = {},
  ): Promise<Result> {
    const normalizedPath = normalizeBrowserFilePath(path)
    // Normalization has already dropped the leading slash, so a file with no
    // separator left is one sitting in the drive root — prefix `''`.
    const separator = normalizedPath.lastIndexOf('/')
    const pathPrefix = separator < 0 ? '' : normalizedPath.slice(0, separator)
    const filename = normalizedPath.slice(separator + 1)
    return await resultFromRequest(async () => {
      const request = this.driveUploads.put(
        pathPrefix,
        filename,
        file,
        options.onProgress ?? (() => {}),
      )
      options.signal?.addEventListener('abort', () => request.abort(), { once: true })
      await request.done
    }, this.onError)
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean; signal?: AbortSignal } = {},
  ): Promise<Result> {
    return await this.action(
      {
        operation: 'mkdir',
        path: normalizeBrowserFilePath(path),
        recursive: options.recursive ?? false,
      },
      options.signal,
    )
  }

  async delete(
    path: string,
    options: { recursive?: boolean; signal?: AbortSignal } = {},
  ): Promise<Result> {
    return await this.action(
      {
        operation: 'delete',
        path: normalizeBrowserFilePath(path),
        recursive: options.recursive ?? false,
      },
      options.signal,
    )
  }

  async rename(
    source: string,
    destination: string,
    options: { overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<Result> {
    return await this.action(
      {
        operation: 'move',
        source: normalizeBrowserFilePath(source),
        destination: normalizeBrowserFilePath(destination),
        overwrite: options.overwrite ?? false,
      },
      options.signal,
    )
  }

  async copy(
    source: string,
    destination: string,
    options: { recursive?: boolean; overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<Result> {
    return await this.action(
      {
        operation: 'copy',
        source: normalizeBrowserFilePath(source),
        destination: normalizeBrowserFilePath(destination),
        recursive: options.recursive ?? false,
        overwrite: options.overwrite ?? false,
      },
      options.signal,
    )
  }

  async list(path: string, options: DirectoryPageOptions = {}): Promise<Result<DirectoryPage>> {
    return await resultFromRequest(async () => {
      const listed = await this.api.listWorkspaceFiles(
        this.workspaceSlug,
        normalizeBrowserFilePath(path, true),
        options,
      )
      return {
        items: listed.items.map(directoryEntryFromContract),
        nextCursor: listed.nextCursor,
      }
    }, this.onError)
  }

  async stat(path: string, options: { signal?: AbortSignal } = {}): Promise<Result<FileStat>> {
    return await resultFromRequest(async () => {
      const result = await this.api.statWorkspaceFile(
        this.workspaceSlug,
        normalizeBrowserFilePath(path),
        options.signal,
      )
      return { entry: directoryEntryFromContract(result.entry), etag: result.etag }
    }, this.onError)
  }

  downloadUrl(path: string, options: { version?: string | number } = {}): string {
    return this.api.workspaceFileDownloadUrl(
      this.workspaceSlug,
      normalizeBrowserFilePath(path),
      options,
    )
  }

  private async action(operation: FileOperationRequest, signal?: AbortSignal): Promise<Result> {
    return await resultFromRequest(async () => {
      await this.api.operateOnWorkspaceFiles(this.workspaceSlug, operation, signal)
    }, this.onError)
  }
}

async function resultFromRequest<T>(
  request: () => Promise<T>,
  onError?: (error: Error) => void,
): Promise<Result<T>> {
  try {
    return { success: true, data: await request() }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    onError?.(normalized)
    return { success: false, error: normalized }
  }
}
