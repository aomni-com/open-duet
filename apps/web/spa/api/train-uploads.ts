import {
  TrainUploadDeleteResponseSchema,
  TrainUploadEntrySchema,
  TrainUploadSessionSchema,
  TrainUploadsListResponseSchema,
  type TrainUploadEntry,
  type TrainUploadSession,
  type TrainUploadsListResponse,
} from '@repo/contract'

import { trainPath, trainScopeKey, type TrainScope } from './train-scope'
import {
  VmUploadClient,
  VmUploadError,
  type FetchLike,
  type UploadRequest,
  type XhrFactory,
} from './vm-uploads'

export class TrainUploadsClient {
  private readonly fetchImpl: FetchLike
  private readonly uploads: VmUploadClient
  private readonly sessionMints = new Map<string, () => Promise<TrainUploadSession>>()

  constructor(options: { fetch?: FetchLike; createXhr?: XhrFactory; now?: () => number } = {}) {
    // Wrapped, never stored bare: the browser's fetch is brand-checked on the
    // global object, so `this.fetchImpl(...)` on a bare reference hands it this
    // instance and throws "Illegal invocation" without reaching the network.
    const fetchImpl = options.fetch ?? fetch
    this.fetchImpl = (input, init) => fetchImpl(input, init)
    this.uploads = new VmUploadClient(options)
  }

  async list(
    workspaceSlug: string,
    scope: TrainScope,
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<TrainUploadsListResponse> {
    const params = new URLSearchParams()
    if (query.cursor !== undefined) params.set('cursor', query.cursor)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const suffix = params.size === 0 ? '' : `?${params}`
    return await this.request(
      `${uploadsPath(workspaceSlug, scope)}${suffix}`,
      TrainUploadsListResponseSchema,
      { signal },
    )
  }

  async remove(
    workspaceSlug: string,
    scope: TrainScope,
    filename: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      `${uploadsPath(workspaceSlug, scope)}/${encodeURIComponent(filename)}`,
      TrainUploadDeleteResponseSchema,
      { method: 'DELETE', signal },
    )
  }

  async addUrl(
    workspaceSlug: string,
    scope: TrainScope,
    url: string,
    signal?: AbortSignal,
  ): Promise<TrainUploadEntry> {
    return await this.request(`${uploadsPath(workspaceSlug, scope)}/url`, TrainUploadEntrySchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal,
    })
  }

  upload(
    workspaceSlug: string,
    scope: TrainScope,
    file: File,
    onProgress: (percent: number) => void,
  ): UploadRequest {
    return this.uploads.putFromSession(
      this.sessionMint(workspaceSlug, scope),
      file.name,
      file,
      onProgress,
    )
  }

  private sessionMint(workspaceSlug: string, scope: TrainScope): () => Promise<TrainUploadSession> {
    const key = JSON.stringify([workspaceSlug, ...trainScopeKey(scope)])
    let mint = this.sessionMints.get(key)
    if (mint === undefined) {
      mint = () =>
        this.request(`${uploadsPath(workspaceSlug, scope)}/session`, TrainUploadSessionSchema, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      this.sessionMints.set(key, mint)
    }
    return mint
  }

  private async request<T>(
    path: string,
    schema: { parse(value: unknown): T },
    init: RequestInit,
  ): Promise<T> {
    const response = await this.fetchImpl(path, { ...init, credentials: 'same-origin' })
    if (!response.ok) throw await responseError(response)
    try {
      return schema.parse(await response.json())
    } catch {
      throw new VmUploadError(502, 'invalid_response')
    }
  }
}

function uploadsPath(workspaceSlug: string, scope: TrainScope): string {
  return `${trainPath(workspaceSlug, scope)}/uploads`
}

async function responseError(response: Response): Promise<VmUploadError> {
  try {
    const payload = (await response.json()) as { error?: string; message?: string; detail?: string }
    return new VmUploadError(
      response.status,
      payload.error ?? 'request_failed',
      payload.message ?? payload.detail,
    )
  } catch {
    return new VmUploadError(response.status, 'request_failed')
  }
}
