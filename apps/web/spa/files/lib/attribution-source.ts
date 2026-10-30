import {
  FileHistoryResponseSchema,
  SeenByResponseSchema,
  type FileHistoryResponse,
  type SeenByResponse,
  type WorkspaceMember,
} from '@repo/contract'

import { duetApi, type DuetApiClient } from '../../api/client'
import { normalizeBrowserFilePath } from './paths'

// Attribution data seam for the Files SPA (slice 05). Same shape as the
// IFileSystemProvider split: one interface, a REST implementation for the
// product, a mock for the hermetic playground. Sources are honest — they
// throw on failure; isolation (degrading to "—") is presentation's job in
// attribution.tsx.

export type AttributionMember = WorkspaceMember

export interface IAttributionSource {
  seenBy(
    workspaceSlug: string,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<SeenByResponse>
  // One paginated page of a file's seq-ordered history (reads included by
  // default — a file's history is about attention, slice 02).
  fileHistory(
    workspaceSlug: string,
    path: string,
    options?: FileActivityPageOptions,
  ): Promise<FileHistoryResponse>
  // One paginated page of the workspace-wide feed (reads excluded by default
  // — a feed is about change).
  workspaceActivity(
    workspaceSlug: string,
    options?: FileActivityPageOptions,
  ): Promise<FileHistoryResponse>
  // userId → display-identity resolution rides the members list every
  // files:read holder can fetch.
  listMembers(
    workspaceSlug: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ items: AttributionMember[]; nextCursor: string | null }>
}

export type FileActivityPageOptions = {
  cursor?: string
  includeReads?: boolean
  order?: 'asc' | 'desc'
  path?: string
  scope?: 'exact' | 'subtree'
  signal?: AbortSignal
}

// The callable shape only — not `typeof fetch`, whose runtime-specific extras
// (Bun's `preconnect`) a wrapper cannot carry.
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class RestAttributionSource implements IAttributionSource {
  private readonly fetchImpl: FetchLike

  constructor(
    private readonly api: Pick<DuetApiClient, 'listWorkspaceMembers'> = duetApi,
    fetchImpl: FetchLike = fetch,
  ) {
    // Wrapped, never stored bare — the same seam DuetApiClient uses. The
    // browser's fetch is brand-checked on the global object, so calling a bare
    // reference as `this.fetchImpl(...)` hands it this instance as `this` and
    // throws "Illegal invocation" without ever reaching the network.
    this.fetchImpl = (input, init) => fetchImpl(input, init)
  }

  async seenBy(
    workspaceSlug: string,
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SeenByResponse> {
    const params = new URLSearchParams({ path: normalizeBrowserFilePath(path) })
    const payload = await this.requestJson(
      `${fileActivityPath(workspaceSlug)}/seen-by?${params.toString()}`,
      options.signal,
    )
    return SeenByResponseSchema.parse(payload)
  }

  async fileHistory(
    workspaceSlug: string,
    path: string,
    options: FileActivityPageOptions = {},
  ): Promise<FileHistoryResponse> {
    const params = new URLSearchParams({ path: normalizeBrowserFilePath(path) })
    applyPageParams(params, options)
    // Per-file history is the bare file-activity path (endpoint catalog id
    // `file-activity.history`); only seen-by, latest-writers, feed, and events
    // are sub-paths.
    const payload = await this.requestJson(
      `${fileActivityPath(workspaceSlug)}?${params.toString()}`,
      options.signal,
    )
    return FileHistoryResponseSchema.parse(payload)
  }

  async workspaceActivity(
    workspaceSlug: string,
    options: FileActivityPageOptions = {},
  ): Promise<FileHistoryResponse> {
    const params = new URLSearchParams()
    applyPageParams(params, options)
    if (options.order !== undefined) params.set('order', options.order)
    if (options.path !== undefined) params.set('path', normalizeBrowserFilePath(options.path))
    if (options.scope !== undefined) params.set('scope', options.scope)
    const query = params.toString()
    const payload = await this.requestJson(
      `${fileActivityPath(workspaceSlug)}/feed${query.length > 0 ? `?${query}` : ''}`,
      options.signal,
    )
    return FileHistoryResponseSchema.parse(payload)
  }

  async listMembers(
    workspaceSlug: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ items: AttributionMember[]; nextCursor: string | null }> {
    return await this.api.listWorkspaceMembers(workspaceSlug, {
      limit: 100,
      signal: options.signal,
    })
  }

  private async requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(path, { credentials: 'same-origin', signal })
    if (!response.ok) throw new Error(`attribution_request_failed:${response.status}`)
    return await response.json()
  }
}

function fileActivityPath(workspaceSlug: string): string {
  return `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/file-activity`
}

// cursor + reads are the symmetric slice-06 page params; an unset reads flag
// leaves each surface on its own server default (history keeps reads, feed
// drops them).
function applyPageParams(params: URLSearchParams, options: FileActivityPageOptions): void {
  if (options.cursor !== undefined) params.set('cursor', options.cursor)
  if (options.includeReads !== undefined) params.set('reads', options.includeReads ? '1' : '0')
}
