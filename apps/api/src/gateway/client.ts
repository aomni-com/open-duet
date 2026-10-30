import { type ConvexHttpClient } from 'convex/browser'

import {
  safeTransportCode,
  GatewayAgentRosterResponseSchema,
  type GatewayAgentRosterResponse,
  MarketplaceInspectionResponseSchema,
  type ListingOriginSnapshotWire,
  DUET_ACTOR_CONTEXT_HEADER,
  DUET_COLLECTION_SUBJECT_HEADER,
  DUET_TRAIN_SOURCE_URL_HEADER,
  ConnectedProviderStatusSchema,
  ConnectPollResponseSchema,
  ConnectStartRequestSchema,
  ConnectStartResponseSchema,
  DESKTOP_GRANT_TTL_MS,
  DESKTOP_SCREEN,
  DesktopPhaseSchema,
  DesktopSessionResponseSchema,
  DesktopUnavailableErrorSchema,
  DesktopStatusResponseSchema,
  FocusBrowserOwnerResultSchema,
  FileResourceSchema,
  type BrowserOwner,
  type DesktopSessionResponse,
  type DesktopStatusResponse,
  desktopEntryPath,
  desktopViewerPath,
  encodeActorContext,
  GatewayAppsReconcileRequestSchema,
  GatewayAnchorsReconcileRequestSchema,
  GatewayConvergeSubtreeResponseSchema,
  GatewaySessionDiscardReceiptSchema,
  GatewayPublishFreezeRequestSchema,
  GatewayPublishFreezeGcRequestSchema,
  GatewayPublishFreezeResponseSchema,
  hashApiKey,
  normalizeDrivePath,
  MarketplaceAgentPullFailureSchema,
  MarketplaceAgentPullSuccessSchema,
  scopeSetSatisfies,
  VmUploadGrantSchema,
  WorkspaceSkillsListingSchema,
  type WorkspaceSkillsListing,
  tunnelTokenDigest,
  TrainUploadSessionSchema,
  TrainUploadEntrySchema,
  TrainUploadsListResponseSchema,
  GatewayTrainRecordListResponseSchema,
  VmDesiredMarketplaceAgentsSchema,
  WORKSPACE_ARCHIVED_ERROR,
  WORKSPACE_PAUSED_ERROR,
  WORKSPACE_PROVISIONING_ERROR,
  WORKSPACE_UNHEALTHY_ERROR,
  type FetchLike,
  type FileActorContext,
  type FileResource,
  type ConnectedProviderId,
  type ConnectedProviderStatus,
  type ConnectPollResponse,
  type ConnectStartResponse,
  type GatewayAppConfig,
  type GatewayAnchor,
  type GatewayPublishFreezeGcRequest,
  type GatewayPublishFreezeRequest,
  type MirrorDevice,
  MAX_MIRROR_DEVICES_PER_WORKSPACE,
  type MirrorTunnelGrant,
  type MarketplaceAgentPullReport,
  type VmUploadGrant,
  type TrainUploadSession,
  type TrainUploadEntry,
  type CollectionPageQuery,
  type TrainUploadsListResponse,
  type GatewayTrainRecordListResponse,
  type TunnelTokenClaims,
  type VmDesiredMarketplaceAgents,
} from '@repo/contract'
import { deriveTunnelToken, TUNNEL_TOKEN_TTL_MS } from '@repo/sync-tunnel'

import { raceWithAbort } from '../abort'
import { resolveEdgeHost, resolveGatewayResolutionTtlMs } from '../config'
import { fnQuery, readResponseJson, type ApiContext } from '../shared'
import { withPublicAppUrls } from './app-configs'

export const FILES_REQUEST_HEADERS = [
  'range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'sec-fetch-dest',
  'content-type',
  'content-length',
] as const

export const MEMORY_REQUEST_HEADERS = ['content-type', 'content-length'] as const
export const TRAIN_REQUEST_HEADERS = ['content-type'] as const
const AGENT_REQUEST_HEADERS = ['content-type', 'content-length'] as const
// A live runner should acknowledge within one interactive request window. A
// cold runner may legitimately need minutes; its input is already durable and
// belongs to the retry drain rather than a serverless request lifetime.
//
// Sized to a fresh agent's first spawn, not to a warm one: measured on
// staging (2026-09-01), an agent's first turn hydrates in 11–14s while it
// creates its own memory database, and the previous 15s bound sat on that
// edge — every other such turn came back `queued`, held the composer for the
// whole window anyway, and then redelivered an input the gateway already had.
// A settled VM's turn acknowledges in ~3s and never sees this bound.
const AGENT_REQUEST_TIMEOUT_MS = 30_000

export function gatewayAgentEventsUrl(httpsUrl: string, sessionId: string, since: number): string {
  const gateway = new URL(httpsUrl)
  gateway.pathname = `/v1/agent/sessions/${encodeURIComponent(sessionId)}/events`
  gateway.searchParams.set('since', String(Math.max(0, Math.floor(since))))
  return gateway.toString()
}

export interface GatewayConnection {
  workspaceId: string
  workspaceSlug: string
  vmName: string
  httpsUrl: string
  vmToken: string
  onboardedAt?: number
}

export interface GatewayRefusal {
  refusal: 'paused' | 'provisioning' | 'unhealthy' | 'archived'
}

export type GatewayResolution = GatewayConnection | GatewayRefusal | null

export type GatewayRequestError =
  | 'not_found'
  | typeof WORKSPACE_PAUSED_ERROR
  | typeof WORKSPACE_PROVISIONING_ERROR
  | typeof WORKSPACE_UNHEALTHY_ERROR
  | typeof WORKSPACE_ARCHIVED_ERROR
  | 'desktop_unavailable'
  | 'mirror_device_limit'
  | 'gateway_failed'
  | 'invalid_response'

export class GatewayClient {
  private readonly gatewayResolutionCache = new Map<
    string,
    { connection: GatewayConnection; expiresAt: number }
  >()

  constructor(
    private readonly args: {
      convex: ConvexHttpClient
      internalKey: string
      edgeHost?: string
      fetchImpl: FetchLike
      now: () => number
      agentRequestTimeoutMs?: number
    },
  ) {}

  async internalAdminRequest(
    gateway: GatewayConnection | null,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (gateway === null) return Response.json({ error: 'not_found' }, { status: 404 })
    const url = new URL(gateway.httpsUrl)
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    const source = new URL(normalizedPath, 'https://internal')
    url.pathname = `/v1/internal-admin${source.pathname}`
    url.search = source.search
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${gateway.vmToken}`)
    return await this.args.fetchImpl(url.toString(), { ...init, headers })
  }

  async createTrainUploadSession(
    workspaceSlug: string,
    anchorId?: string,
  ): Promise<{ session: TrainUploadSession } | { response: Response }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) {
      return { response: Response.json({ error: 'not_found' }, { status: 404 }) }
    }
    if (isGatewayRefusal(gateway)) return { response: gatewayRefusalResponse(gateway) }
    const gatewayUrl = new URL(gateway.httpsUrl)
    gatewayUrl.pathname = gatewayTrainPath(anchorId, '/upload-token')
    gatewayUrl.search = ''
    const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.vmToken}`,
      },
    })
    if (!response.ok) {
      return {
        response: Response.json({ error: 'gateway_failed' }, { status: response.status }),
      }
    }
    const grant = (await readResponseJson(response)) as {
      uploadPath?: unknown
      uploadToken?: unknown
      expiresAt?: unknown
    } | null
    // Browsers use the portless set-public proxy URL: the gateway's upload
    // token is their only credential (preflights cannot carry the edge header).
    const parsed = TrainUploadSessionSchema.safeParse({
      vmBaseUrl: browserVmBaseUrl(gateway.httpsUrl),
      uploadPath: grant?.uploadPath,
      uploadToken: grant?.uploadToken,
      expiresAt: grant?.expiresAt,
    })
    if (!parsed.success) {
      return { response: Response.json({ error: 'gateway_failed' }, { status: 502 }) }
    }
    return { session: parsed.data }
  }

  async createDriveUploadGrant(
    workspaceSlug: string,
    prefix: string,
    actorContext: FileActorContext,
  ): Promise<{ grant: VmUploadGrant } | { response: Response }> {
    const minted = await this.mintDriveGrant(
      workspaceSlug,
      {
        kind: 'upload',
        pathPrefix: prefix,
      },
      actorContext,
    )
    if ('response' in minted) return minted
    if (!minted.gatewayResponse.ok) {
      return {
        response: Response.json(
          { error: 'gateway_failed' },
          { status: minted.gatewayResponse.status },
        ),
      }
    }
    const grant = (await readResponseJson(minted.gatewayResponse)) as {
      uploadPath?: unknown
      uploadToken?: unknown
      expiresAt?: unknown
    } | null
    const parsed = VmUploadGrantSchema.safeParse({
      vmBaseUrl: browserVmBaseUrl(minted.gateway.httpsUrl),
      uploadPath: grant?.uploadPath,
      uploadToken: grant?.uploadToken,
      expiresAt: grant?.expiresAt,
    })
    if (!parsed.success) {
      return { response: Response.json({ error: 'gateway_failed' }, { status: 502 }) }
    }
    return { grant: parsed.data }
  }

  async createDriveFileResource(
    workspaceSlug: string,
    path: string,
    actorContext: FileActorContext,
  ): Promise<{ resource: FileResource } | { response: Response }> {
    const minted = await this.mintDriveGrant(
      workspaceSlug,
      { kind: 'download', path },
      actorContext,
    )
    if ('response' in minted) return minted
    if (!minted.gatewayResponse.ok) {
      return {
        response: Response.json(
          { error: 'gateway_failed' },
          { status: minted.gatewayResponse.status },
        ),
      }
    }
    const grant = (await readResponseJson(minted.gatewayResponse)) as {
      downloadPath?: unknown
      expiresAt?: unknown
    } | null
    if (
      grant === null ||
      typeof grant.downloadPath !== 'string' ||
      !grant.downloadPath.startsWith('/v1/files/') ||
      typeof grant.expiresAt !== 'number' ||
      !Number.isFinite(grant.expiresAt)
    ) {
      return { response: Response.json({ error: 'gateway_failed' }, { status: 502 }) }
    }
    const uri = new URL(grant.downloadPath, browserVmBaseUrl(minted.gateway.httpsUrl))
    const metadata = await this.fetchGateway(workspaceSlug, uri.toString(), { method: 'HEAD' })
    if (!metadata.ok) {
      const error =
        metadata.status === 404
          ? 'not_found'
          : metadata.status === 409
            ? 'not_file'
            : 'gateway_failed'
      return { response: Response.json({ error }, { status: metadata.status }) }
    }
    const sizeHeader = metadata.headers.get('content-length')
    const parsed = FileResourceSchema.safeParse({
      uri: uri.toString(),
      name: path,
      mimeType: metadata.headers.get('content-type'),
      size: sizeHeader === null ? Number.NaN : Number(sizeHeader),
    })
    if (!parsed.success) {
      return { response: Response.json({ error: 'gateway_failed' }, { status: 502 }) }
    }
    return { resource: parsed.data }
  }

  private async mintDriveGrant(
    workspaceSlug: string,
    request: { kind: 'upload'; pathPrefix: string } | { kind: 'download'; path: string },
    actorContext: FileActorContext,
  ): Promise<{ gateway: GatewayConnection; gatewayResponse: Response } | { response: Response }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) {
      return { response: Response.json({ error: 'not_found' }, { status: 404 }) }
    }
    if (isGatewayRefusal(gateway)) return { response: gatewayRefusalResponse(gateway) }
    const gatewayUrl = new URL(gateway.httpsUrl)
    gatewayUrl.pathname = '/v1/drive-grants'
    gatewayUrl.search = ''
    const gatewayResponse = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
      method: 'POST',
      headers: gatewayRequestHeaders(
        new Headers({ 'content-type': 'application/json' }),
        gateway.vmToken,
        ['content-type'],
        actorContext,
      ),
      body: JSON.stringify(request),
    })
    return { gateway, gatewayResponse }
  }

  async putTrainUpload(
    workspaceSlug: string,
    filename: string,
    markdown: string,
    anchorId?: string,
    sourceUrl?: string,
    signal?: AbortSignal,
  ): Promise<{ file: TrainUploadEntry } | { response: Response }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) {
      return { response: Response.json({ error: 'not_found' }, { status: 404 }) }
    }
    if (isGatewayRefusal(gateway)) return { response: gatewayRefusalResponse(gateway) }
    const gatewayUrl = new URL(gateway.httpsUrl)
    gatewayUrl.pathname = gatewayTrainPath(anchorId, `/uploads/${encodeURIComponent(filename)}`)
    gatewayUrl.search = ''
    const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${gateway.vmToken}`,
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': String(Buffer.byteLength(markdown)),
        ...(sourceUrl === undefined ? {} : { [DUET_TRAIN_SOURCE_URL_HEADER]: sourceUrl }),
      },
      body: markdown,
      signal,
    })
    if (!response.ok) {
      return {
        response: new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: gatewayResponseHeaders(response.headers),
        }),
      }
    }
    const body = (await readResponseJson(response)) as { file?: unknown } | null
    const parsed = TrainUploadEntrySchema.safeParse(body?.file)
    if (!parsed.success) {
      return { response: Response.json({ error: 'gateway_failed' }, { status: 502 }) }
    }
    return { file: parsed.data }
  }

  /**
   * One bounded collection read proves the VM route is reachable before the
   * API spends a Firecrawl request. It deliberately does not inspect or drain
   * upload rows; the upload store remains authoritative for URL/file caps.
   */
  async probeTrainUploads(
    workspaceSlug: string,
    anchorId?: string,
  ): Promise<{ ok: true } | { response: Response }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) {
      return { response: Response.json({ error: 'not_found' }, { status: 404 }) }
    }
    if (isGatewayRefusal(gateway)) return { response: gatewayRefusalResponse(gateway) }
    const gatewayUrl = new URL(gateway.httpsUrl)
    gatewayUrl.pathname = gatewayTrainPath(anchorId, '/uploads')
    gatewayUrl.search = ''
    const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${gateway.vmToken}` },
    })
    if (response.ok) return { ok: true }
    return {
      response: new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: gatewayResponseHeaders(response.headers),
      }),
    }
  }

  async listTrainUploadsPage(
    workspaceSlug: string,
    query: CollectionPageQuery,
    anchorId?: string,
  ): Promise<{ page: TrainUploadsListResponse } | { response: Response }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) {
      return { response: Response.json({ error: 'not_found' }, { status: 404 }) }
    }
    if (isGatewayRefusal(gateway)) return { response: gatewayRefusalResponse(gateway) }
    const gatewayUrl = new URL(gateway.httpsUrl)
    gatewayUrl.pathname = gatewayTrainPath(anchorId, '/uploads')
    gatewayUrl.search = ''
    gatewayUrl.searchParams.set('limit', String(query.limit))
    if (query.cursor !== undefined) gatewayUrl.searchParams.set('cursor', query.cursor)
    const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${gateway.vmToken}` },
    })
    if (!response.ok) {
      return {
        response: new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: gatewayResponseHeaders(response.headers),
        }),
      }
    }
    const parsed = TrainUploadsListResponseSchema.safeParse(await readResponseJson(response))
    return parsed.success
      ? { page: parsed.data }
      : { response: Response.json({ error: 'gateway_failed' }, { status: 502 }) }
  }

  async listTrainRecordsPage(
    workspaceSlug: string,
    query: CollectionPageQuery,
    anchorId?: string,
  ): Promise<{ page: GatewayTrainRecordListResponse } | { response: Response }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) {
      return { response: Response.json({ error: 'not_found' }, { status: 404 }) }
    }
    if (isGatewayRefusal(gateway)) return { response: gatewayRefusalResponse(gateway) }
    const gatewayUrl = new URL(gateway.httpsUrl)
    gatewayUrl.pathname = gatewayTrainPath(anchorId, '/records')
    gatewayUrl.search = ''
    gatewayUrl.searchParams.set('limit', String(query.limit))
    if (query.cursor !== undefined) gatewayUrl.searchParams.set('cursor', query.cursor)
    const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${gateway.vmToken}` },
    })
    if (!response.ok) {
      return {
        response: new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: gatewayResponseHeaders(response.headers),
        }),
      }
    }
    const parsed = GatewayTrainRecordListResponseSchema.safeParse(await readResponseJson(response))
    return parsed.success
      ? { page: parsed.data }
      : { response: Response.json({ error: 'gateway_failed' }, { status: 502 }) }
  }

  async callAgent(
    c: ApiContext,
    workspaceSlug: string,
    request: {
      path: string
      method: 'POST' | 'DELETE'
      body: string
      allowPaused?: boolean
      passthroughStatuses?: readonly number[]
      failureOperation?: 'session_cwd' | 'agent_delete'
    },
  ): Promise<{ ok: true; body: unknown } | { response: Response }> {
    const gateway = await this.resolveGateway(workspaceSlug, request.allowPaused === true)
    if (gateway === null) return { response: c.json({ error: 'not_found' }, 404) }
    if (isGatewayRefusal(gateway)) {
      return { response: gatewayRefusalResponse(gateway) }
    }
    const base = new URL(gateway.httpsUrl)
    base.pathname = request.path
    base.search = ''
    const deadline = AbortSignal.timeout(
      this.args.agentRequestTimeoutMs ?? AGENT_REQUEST_TIMEOUT_MS,
    )
    let response: Response
    try {
      response = await raceWithAbort(
        this.fetchGateway(workspaceSlug, base.toString(), {
          method: request.method,
          headers: gatewayRequestHeaders(
            new Headers({
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(request.body)),
            }),
            gateway.vmToken,
            AGENT_REQUEST_HEADERS,
          ),
          body: request.body,
          signal: deadline,
        }),
        deadline,
      )
    } catch (error) {
      // Dispatch also serves the durable retry rail. Only commands whose caller
      // actually fails the requested operation opt into this diagnostic.
      if (request.failureOperation !== undefined && !c.req.raw.signal.aborted) {
        try {
          const code = safeTransportCode(error)
          if (code !== undefined) {
            console.error('[agent-dispatch] transport failed', {
              operation: request.failureOperation,
              workspaceId: gateway.workspaceId,
              code,
            })
          }
        } catch {
          // Diagnostics cannot change the request's failure response.
        }
      }
      return { response: c.json({ error: 'agent_gateway_unavailable' }, 502) }
    }
    if (!response.ok) {
      if (request.passthroughStatuses?.includes(response.status) === true) {
        return {
          response: new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
        }
      }
      const body = await readResponseJson(response)
      const error =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : 'agent_gateway_failed'
      console.error(
        `[agent-dispatch] ${workspaceSlug} ${request.path} -> HTTP ${response.status} ${error}`,
      )
      return { response: c.json({ error }, response.status === 409 ? 409 : 502) }
    }
    return { ok: true, body: await readResponseJson(response) }
  }

  async discardAgentSession(
    workspaceSlug: string,
    sessionId: string,
  ): Promise<{ ok: true; discarded: boolean } | { ok: false; error: GatewayRequestError }> {
    const gateway = await this.resolveGateway(workspaceSlug, true)
    if (gateway === null) return { ok: false, error: 'not_found' }
    if (isGatewayRefusal(gateway)) return { ok: false, error: gatewayRefusalError(gateway) }
    const url = new URL(gateway.httpsUrl)
    url.pathname = `/v1/agent/sessions/${encodeURIComponent(sessionId)}`
    url.search = ''
    let response: Response
    try {
      response = await this.fetchGateway(workspaceSlug, url.toString(), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${gateway.vmToken}` },
      })
    } catch {
      return { ok: false, error: 'gateway_failed' }
    }
    if (!response.ok) return { ok: false, error: 'gateway_failed' }
    const parsed = GatewaySessionDiscardReceiptSchema.safeParse(await readResponseJson(response))
    return parsed.success
      ? { ok: true, discarded: parsed.data.discarded }
      : { ok: false, error: 'invalid_response' }
  }

  async waitForAgentSessionActivity(
    workspaceSlug: string,
    sessionId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): Promise<'activity' | 'closed'> {
    try {
      const gateway = await this.resolveGateway(workspaceSlug)
      if (gateway === null || isGatewayRefusal(gateway)) return 'closed'
      const response = await this.fetchGateway(
        workspaceSlug,
        gatewayAgentEventsUrl(gateway.httpsUrl, sessionId, afterSeq),
        {
          method: 'GET',
          headers: { authorization: `Bearer ${gateway.vmToken}` },
          signal,
        },
      )
      if (!response.ok || response.body === null) {
        void response.body?.cancel().catch(() => undefined)
        return 'closed'
      }
      const reader = response.body.getReader()
      try {
        return (await reader.read()).done ? 'closed' : 'activity'
      } finally {
        void reader.cancel().catch(() => undefined)
      }
    } catch {
      if (signal.aborted) throw signal.reason
      return 'closed'
    }
  }

  /** Open the VM-authenticated hint stream without replaying public authorization. */
  async openAgentSessionHints(
    workspaceSlug: string,
    sessionId: string,
    afterSeq: number,
    signal: AbortSignal,
    // Measured on staging: a hint connect reaches the VM 1.3–2.2s after the
    // browser's stream opens (gateway resolution, then TLS through the VM
    // tunnel). A budget at the high end of that range lost hints on roughly
    // every other turn, and each loss costs a whole fallback interval. The
    // fallback poll races this wait, so a generous budget delays nothing.
    connectTimeoutMs = 10_000,
  ): Promise<Response | null> {
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new Error('gateway hint connect timeout')),
      connectTimeoutMs,
    )
    const connectSignal = AbortSignal.any([signal, deadline.signal])
    try {
      const gateway = await raceWithAbort(this.resolveGateway(workspaceSlug), connectSignal)
      if (gateway === null || isGatewayRefusal(gateway)) return null
      const response = await raceWithAbort(
        this.fetchGateway(
          workspaceSlug,
          gatewayAgentEventsUrl(gateway.httpsUrl, sessionId, afterSeq),
          {
            method: 'GET',
            headers: { authorization: `Bearer ${gateway.vmToken}` },
            signal: connectSignal,
          },
        ),
        connectSignal,
      )
      if (!response.ok || response.body === null) {
        void response.body?.cancel().catch(() => undefined)
        return null
      }
      return response
    } catch {
      return null
    } finally {
      // Once fetch resolves, headers have arrived. Clearing (rather than aborting)
      // detaches the connect deadline from the healthy long-lived response body.
      clearTimeout(timer)
    }
  }

  async pushAppsReconcile(
    workspaceSlug: string,
    workspaceId: string,
    options: { excludeSlug?: string; requiredReadySlugs?: string[] } = {},
  ): Promise<{ ok: true } | { ok: false; response: Response }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null)
      return { ok: false, response: Response.json({ error: 'not_found' }, { status: 404 }) }
    if (isGatewayRefusal(gateway)) {
      return { ok: false, response: gatewayRefusalResponse(gateway) }
    }
    const apps = (await this.args.convex.query(
      fnQuery('domains/apps/model:runConfigForWorkspace'),
      {
        internalKey: this.args.internalKey,
        workspaceId,
      },
    )) as GatewayAppConfig[]
    const payload = GatewayAppsReconcileRequestSchema.parse({
      apps: withPublicAppUrls(
        apps.filter(app => app.slug !== options.excludeSlug),
        {
          workspaceSlug,
          edgeHost: this.args.edgeHost ?? resolveEdgeHost(),
        },
      ),
      ...(options.requiredReadySlugs === undefined
        ? {}
        : { requiredReadySlugs: options.requiredReadySlugs }),
    })
    const gatewayUrl = new URL(gateway.httpsUrl)
    gatewayUrl.pathname = '/v1/apps/reconcile'
    gatewayUrl.search = ''
    const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${gateway.vmToken}`,
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const body = await readResponseJson(response)
      const reason =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : 'gateway_failed'
      return {
        ok: false,
        response: Response.json({ error: 'app_reconcile_failed', reason }, { status: 502 }),
      }
    }
    return { ok: true }
  }

  async pushAnchorsReconcile(
    workspaceSlug: string,
  ): Promise<{ ok: true } | { ok: false; response: Response }> {
    try {
      const gateway = await this.resolveGateway(workspaceSlug)
      if (gateway === null) return anchorReconcileFailure('not_found')
      if (isGatewayRefusal(gateway)) return anchorReconcileFailure(gatewayRefusalError(gateway))
      const anchors = (await this.args.convex.query(fnQuery('domains/anchors/model:listForVm'), {
        internalKey: this.args.internalKey,
        vmTokenHash: await hashApiKey(gateway.vmToken),
      })) as GatewayAnchor[]
      const payload = GatewayAnchorsReconcileRequestSchema.parse({ anchors })
      const gatewayUrl = new URL(gateway.httpsUrl)
      gatewayUrl.pathname = '/v1/anchors/reconcile'
      gatewayUrl.search = ''
      const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${gateway.vmToken}`,
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const body = await readResponseJson(response)
        const reason =
          typeof body === 'object' &&
          body !== null &&
          typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'gateway_failed'
        return anchorReconcileFailure(reason)
      }
      return { ok: true }
    } catch (error) {
      return anchorReconcileFailure(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Delete a folder and everything under it from the workspace drive.
   *
   * Best-effort by construction, and always the SECOND leg of a deletion whose
   * control-plane half already committed. The failure it can leave behind — a
   * plain folder with no rows pointing at it — is inert; the reverse order would
   * leave rows pointing at a folder that no longer exists, which is the residue
   * this whole rail exists to stop producing. Paused workspaces included: firing
   * an agent has to work while a workspace is paused, and the files route is not
   * what quiesce stops.
   */
  async deleteDriveFolder(
    workspaceSlug: string,
    path: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const gateway = await this.resolveGateway(workspaceSlug, true)
      if (gateway === null) return { ok: false, reason: 'not_found' }
      if (isGatewayRefusal(gateway)) return { ok: false, reason: gatewayRefusalError(gateway) }
      const gatewayUrl = new URL(gateway.httpsUrl)
      gatewayUrl.pathname = '/v1/files/actions'
      gatewayUrl.search = ''
      const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${gateway.vmToken}`,
        },
        body: JSON.stringify({ operation: 'delete', path, recursive: true }),
      })
      if (!response.ok) {
        const body = await readResponseJson(response)
        const reason =
          typeof body === 'object' &&
          body !== null &&
          typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'gateway_failed'
        return { ok: false, reason }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Ask the publisher's own gateway whether an agent folder is listable, and
   * for its catalog metadata. Read-only on the VM: it creates nothing, so a
   * refusal here leaves no publish and no listing behind — which is why this
   * runs BEFORE either is created.
   */
  async inspectListableAgent(
    workspaceSlug: string,
    agentPath: string,
  ): Promise<
    | { ok: true; entries: number; bytes: number; origin: ListingOriginSnapshotWire }
    | { ok: false; error: 'listing_too_large' | 'listing_source_invalid' | 'gateway_unavailable' }
  > {
    try {
      const gateway = await this.resolveGateway(workspaceSlug)
      if (gateway === null || isGatewayRefusal(gateway)) {
        return { ok: false, error: 'gateway_unavailable' }
      }
      const gatewayUrl = new URL(gateway.httpsUrl)
      gatewayUrl.pathname = '/v1/marketplace/inspect'
      gatewayUrl.search = ''
      const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${gateway.vmToken}`,
        },
        body: JSON.stringify({ agentPath }),
      })
      const body = await readResponseJson(response)
      const parsed = MarketplaceInspectionResponseSchema.safeParse(body)
      if (!parsed.success) return { ok: false, error: 'gateway_unavailable' }
      return parsed.data
    } catch {
      return { ok: false, error: 'gateway_unavailable' }
    }
  }

  async pushMarketplaceAgentsPull(
    workspaceSlug: string,
  ): Promise<
    | { ok: true; reports: MarketplaceAgentPullReport[] }
    | { ok: false; reports?: MarketplaceAgentPullReport[]; response: Response }
  > {
    try {
      const gateway = await this.resolveGateway(workspaceSlug)
      if (gateway === null || isGatewayRefusal(gateway)) return marketplacePullFailure()
      // The gateway's pull route validates every declared desired-state field —
      // the push carries the same projection the VM sync rail serves.
      const desired = await this.args.convex.query(
        fnQuery('domains/marketplace/model:desiredForVm'),
        {
          internalKey: this.args.internalKey,
          vmTokenHash: await hashApiKey(gateway.vmToken),
        },
      )
      if (desired === null) return marketplacePullFailure()
      const payload = VmDesiredMarketplaceAgentsSchema.parse(desired)
      const gatewayUrl = new URL(gateway.httpsUrl)
      gatewayUrl.pathname = '/v1/marketplace/pull'
      gatewayUrl.search = ''
      const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${gateway.vmToken}`,
        },
        body: JSON.stringify(payload),
      })
      const body = await readResponseJson(response)
      if (response.ok) {
        const parsed = MarketplaceAgentPullSuccessSchema.safeParse(body)
        return parsed.success && reportsCoverDesiredSubscriptions(parsed.data.reports, payload)
          ? parsed.data
          : marketplacePullFailure()
      }
      const parsed = MarketplaceAgentPullFailureSchema.safeParse(body)
      return parsed.success && reportsCoverDesiredSubscriptions(parsed.data.reports, payload)
        ? {
            ok: false,
            reports: parsed.data.reports,
            response: marketplacePullFailure().response,
          }
        : marketplacePullFailure()
    } catch {
      return marketplacePullFailure()
    }
  }

  async startProviderConnect(
    workspaceSlug: string,
    provider: ConnectedProviderId,
  ): Promise<ConnectStartResponse | Response> {
    const response = await this.connectedProviderRequest(workspaceSlug, '/connect', {
      method: 'POST',
      body: JSON.stringify(ConnectStartRequestSchema.parse({ provider })),
    })
    if (!response.ok) return response
    const parsed = ConnectStartResponseSchema.safeParse(await readResponseJson(response))
    return parsed.success ? parsed.data : connectedProviderInvalidResponse()
  }

  async pollProviderConnect(
    workspaceSlug: string,
    sessionId: string,
  ): Promise<ConnectPollResponse | Response> {
    const response = await this.connectedProviderRequest(
      workspaceSlug,
      `/connect/${encodeURIComponent(sessionId)}`,
      { method: 'GET' },
    )
    if (!response.ok) return response
    const parsed = ConnectPollResponseSchema.safeParse(await readResponseJson(response))
    return parsed.success ? parsed.data : connectedProviderInvalidResponse()
  }

  async disconnectProvider(
    workspaceSlug: string,
    provider: ConnectedProviderId,
  ): Promise<{ ok: true } | Response> {
    const response = await this.connectedProviderRequest(workspaceSlug, '/disconnect', {
      method: 'POST',
      body: JSON.stringify(ConnectStartRequestSchema.parse({ provider })),
    })
    if (!response.ok) return response
    return { ok: true }
  }

  async listConnectedProviders(
    workspaceSlug: string,
  ): Promise<ConnectedProviderStatus[] | Response> {
    const response = await this.connectedProviderRequest(workspaceSlug, '', { method: 'GET' })
    if (!response.ok) return response
    const parsed = ConnectedProviderStatusSchema.array().safeParse(await readResponseJson(response))
    return parsed.success ? parsed.data : connectedProviderInvalidResponse()
  }

  /**
   * What skills an agent would see if it ran in `cwd` (a drive-relative folder,
   * absent for the drive root). The VM owns the answer — skills are files that
   * change without telling the control plane — so this is read when someone
   * opens a picker rather than mirrored into the backend.
   */
  async listSkills(
    workspaceSlug: string,
    cwd: string | undefined,
  ): Promise<WorkspaceSkillsListing | Response> {
    const search = cwd === undefined || cwd.length === 0 ? '' : `?cwd=${encodeURIComponent(cwd)}`
    const response = await this.vmControlRequest(workspaceSlug, '/v1/skills', search, {
      method: 'GET',
    })
    if (!response.ok) return response
    const parsed = WorkspaceSkillsListingSchema.safeParse(await readResponseJson(response))
    return parsed.success
      ? parsed.data
      : Response.json({ error: 'skills_gateway_invalid_response' }, { status: 502 })
  }

  /**
   * The colleagues one session can address — its parent and its direct children
   * — as the gateway projected them into that agent's own prompt. `agentId`
   * names whose roster to read; absent is the drive root.
   *
   * The VM's status travels: a gateway that has not synced yet answers 503, and
   * an agent its roster does not carry answers 404. Neither may reach the
   * picker as an empty list.
   */
  async readAgentRoster(
    workspaceSlug: string,
    agentId: string | undefined,
  ): Promise<GatewayAgentRosterResponse | Response> {
    const search =
      agentId === undefined || agentId.length === 0 ? '' : `?agentId=${encodeURIComponent(agentId)}`
    const response = await this.vmControlRequest(workspaceSlug, '/v1/agents/roster', search, {
      method: 'GET',
    })
    if (!response.ok) return response
    const parsed = GatewayAgentRosterResponseSchema.safeParse(await readResponseJson(response))
    return parsed.success
      ? parsed.data
      : Response.json({ error: 'agent_roster_gateway_invalid_response' }, { status: 502 })
  }

  /** Completion is durable first; periodic sync recovers a failed refresh. */
  async refreshAgentRoster(workspaceSlug: string): Promise<void> {
    const response = await this.vmControlRequest(workspaceSlug, '/v1/agents/roster/refresh', '', {
      method: 'POST',
      // A sleeping or stalled VM must not hold the completion response open.
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) {
      console.error('[agent-roster] refresh failed', { workspaceSlug, status: response.status })
    }
  }

  /**
   * Hand the whole managed tree to the gateway in ONE request and let it decide,
   * per file, whether anything needs writing.
   *
   * Byte transport only: the roots come from the caller's already-scoped plan,
   * and this client neither filters, compares, nor deletes. Its predecessor
   * awaited one PUT per file inside a single serverless request, which made the
   * roster size a latent timeout.
   */
  async convergeOfficialHub(
    workspaceSlug: string,
    plan: {
      agents: readonly { path: string }[]
      files: readonly { path: string; bytes: Uint8Array }[]
    },
  ): Promise<
    { ok: true; written: string[]; deleted: string[] } | { ok: false; response: Response }
  > {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null || isGatewayRefusal(gateway)) {
      return {
        ok: false,
        response: Response.json({ error: WORKSPACE_PROVISIONING_ERROR }, { status: 202 }),
      }
    }
    const url = new URL(gateway.httpsUrl)
    url.pathname = '/v1/internal-admin/converge-subtree'
    url.search = ''
    const response = await this.fetchGateway(workspaceSlug, url.toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.vmToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        roots: plan.agents.map(agent => agent.path),
        files: plan.files.map(file => ({
          path: file.path,
          base64: Buffer.from(file.bytes).toString('base64'),
        })),
      }),
    })
    // The gateway's own status and body are the ONLY thing that distinguishes
    // "the VM is asleep" from "this request was too large" from "a path was
    // refused". Collapsing them into a bare 502 sends the operator to inspect a
    // healthy VM with nothing to go on, so both travel to the surface.
    if (!response.ok) return hubSyncFailure(response.status, await response.text())
    const body = GatewayConvergeSubtreeResponseSchema.safeParse(await readResponseJson(response))
    return body.success
      ? { ok: true, written: body.data.written, deleted: body.data.deleted }
      : hubSyncFailure(response.status, 'the gateway returned an unreadable converge result')
  }

  async detectPublishKind(
    c: ApiContext,
    workspaceSlug: string,
    workspaceId: string,
    path: string,
  ): Promise<{ kind: 'file' | 'folder' } | { response: Response }> {
    const encodedPath = encodeDrivePathForGateway(path)
    if (encodedPath === null) return { response: c.json({ error: 'invalid_request' }, 400) }
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) return { response: c.json({ error: 'not_found' }, 404) }
    if (isGatewayRefusal(gateway)) {
      return { response: gatewayRefusalResponse(gateway) }
    }
    const base = new URL(gateway.httpsUrl)
    base.pathname = `/v1/files/${encodedPath}`
    base.search = '?list=1'
    const listResponse = await this.fetchGateway(workspaceSlug, base.toString(), {
      headers: gatewayRequestHeaders(
        new Headers(),
        gateway.vmToken,
        FILES_REQUEST_HEADERS,
        undefined,
        `workspace:${workspaceId}`,
      ),
    })
    if (listResponse.status === 200) return { kind: 'folder' }
    base.search = ''
    const fileResponse = await this.fetchGateway(workspaceSlug, base.toString(), {
      headers: gatewayRequestHeaders(
        new Headers({ range: 'bytes=0-0' }),
        gateway.vmToken,
        FILES_REQUEST_HEADERS,
      ),
    })
    if (fileResponse.status === 200 || fileResponse.status === 206 || fileResponse.status === 416)
      return { kind: 'file' }
    return { response: c.json({ error: 'not_found' }, 404) }
  }

  async createPublishFreeze(
    workspaceSlug: string,
    request: GatewayPublishFreezeRequest,
  ): Promise<{ ok: true } | { response: Response }> {
    try {
      const gateway = await this.resolveGateway(workspaceSlug)
      if (gateway === null)
        return { response: Response.json({ error: 'not_found' }, { status: 404 }) }
      if (isGatewayRefusal(gateway)) return { response: gatewayRefusalResponse(gateway) }
      const gatewayUrl = new URL(gateway.httpsUrl)
      gatewayUrl.pathname = '/v1/publishes/freeze'
      gatewayUrl.search = ''
      const response = await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${gateway.vmToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(GatewayPublishFreezeRequestSchema.parse(request)),
      })
      if (!response.ok) {
        return {
          response: Response.json({ error: 'publish_snapshot_failed' }, { status: 502 }),
        }
      }
      const confirmed = GatewayPublishFreezeResponseSchema.safeParse(
        await readResponseJson(response),
      )
      if (confirmed.success) return { ok: true }
    } catch {
      // The caller maps every failed or malformed confirmation to the same
      // fail-closed control-plane response and never exposes paused metadata.
    }
    return {
      response: Response.json({ error: 'publish_snapshot_failed' }, { status: 502 }),
    }
  }

  async prunePublishFreezes(
    workspaceSlug: string,
    request: GatewayPublishFreezeGcRequest,
  ): Promise<void> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null || isGatewayRefusal(gateway)) return
    const gatewayUrl = new URL(gateway.httpsUrl)
    gatewayUrl.pathname = '/v1/publishes/freeze/gc'
    gatewayUrl.search = ''
    await this.fetchGateway(workspaceSlug, gatewayUrl.toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.vmToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(GatewayPublishFreezeGcRequestSchema.parse(request)),
      // GC follows the committed pause and is best-effort; it must not hold the
      // control-plane response behind an unhealthy VM.
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined)
  }

  async proxyRequest(
    c: ApiContext,
    options: {
      workspaceSlug: string
      requiredScope: string
      url: (httpsUrl: string) => string
      forwardedHeaders: readonly string[]
      actorContext?: FileActorContext
      body?: string
      /**
       * The caller declared the addressed path optional: the gateway's 404
       * becomes an empty 204, so a client asking after a file that may well
       * not exist receives an answer rather than an error. Only the gateway's
       * own answer is softened — a missing, provisioning, or paused workspace
       * still refuses the way it always has.
       */
      optionalPath?: boolean
    },
  ): Promise<Response> {
    const auth = c.get('auth')
    if (!scopeSetSatisfies(auth.scopes, options.requiredScope)) {
      return c.json({ error: 'insufficient_scope', scope: options.requiredScope }, 403)
    }
    const gateway = await this.resolveGateway(options.workspaceSlug)
    if (gateway === null) return c.json({ error: 'not_found' }, 404)
    if (isGatewayRefusal(gateway)) return gatewayRefusalResponse(gateway)

    const upstream = await this.fetchGateway(options.workspaceSlug, options.url(gateway.httpsUrl), {
      method: c.req.method,
      headers: gatewayRequestHeaders(
        c.req.raw.headers,
        gateway.vmToken,
        options.forwardedHeaders,
        options.actorContext,
        gateway.workspaceId,
      ),
      body:
        c.req.method === 'GET' || c.req.method === 'HEAD'
          ? undefined
          : (options.body ?? c.req.raw.body),
      duplex: 'half',
      signal: c.req.raw.signal,
    } as RequestInit & { duplex: 'half' })
    if (options.optionalPath === true && upstream.status === 404) {
      return new Response(null, { status: 204 })
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: gatewayResponseHeaders(upstream.headers),
    })
  }

  // --- Mirror device orchestration (spec file-attribution slice 19) --------
  // The Duet-owned wrapper around the gateway's Syncthing provisioning; never
  // the raw Syncthing API (L14). Each call resolves the workspace gateway and
  // proxies with the VM token, exactly like every other gateway call.

  async registerMirrorDevice(
    workspaceSlug: string,
    body: { machineId: string; syncthingDeviceId: string; deviceName?: string },
  ): Promise<{ folderId: string; vmSyncthingDeviceId: string } | { error: GatewayRequestError }> {
    const call = await this.gatewayJson(
      workspaceSlug,
      'POST',
      '/v1/sync/syncthing/mirror/devices',
      body,
    )
    if ('error' in call) return { error: call.error }
    if (!call.response.ok) {
      if (call.response.status === 409) {
        const body = (await readResponseJson(call.response)) as { error?: unknown } | null
        if (body?.error === 'mirror_device_limit') return { error: 'mirror_device_limit' }
      }
      return { error: 'gateway_failed' }
    }
    const parsed = (await readResponseJson(call.response)) as {
      folderId?: unknown
      vmSyncthingDeviceId?: unknown
    } | null
    if (
      parsed === null ||
      typeof parsed.folderId !== 'string' ||
      typeof parsed.vmSyncthingDeviceId !== 'string'
    ) {
      return { error: 'gateway_failed' }
    }
    return { folderId: parsed.folderId, vmSyncthingDeviceId: parsed.vmSyncthingDeviceId }
  }

  async listMirrorDevices(
    workspaceSlug: string,
  ): Promise<{ devices: MirrorDevice[] } | { error: GatewayRequestError }> {
    const call = await this.gatewayJson(workspaceSlug, 'GET', '/v1/sync/syncthing/mirror/devices')
    if ('error' in call) return { error: call.error }
    if (!call.response.ok) return { error: 'gateway_failed' }
    const parsed = (await readResponseJson(call.response)) as { devices?: unknown } | null
    if (
      parsed === null ||
      !Array.isArray(parsed.devices) ||
      parsed.devices.length > MAX_MIRROR_DEVICES_PER_WORKSPACE
    ) {
      return { error: 'gateway_failed' }
    }
    return { devices: parsed.devices as MirrorDevice[] }
  }

  // The explicit device-removal route: surfaces a gateway failure to the caller
  // (the cascade path uses detachMirrorDevice, which swallows).
  async removeMirrorDevice(
    workspaceSlug: string,
    machineId: string,
  ): Promise<{ ok: true } | { error: GatewayRequestError }> {
    const call = await this.gatewayJson(
      workspaceSlug,
      'DELETE',
      `/v1/sync/syncthing/mirror/devices/${encodeURIComponent(machineId)}`,
    )
    if ('error' in call) return { error: call.error }
    if (!call.response.ok) return { error: 'gateway_failed' }
    return { ok: true }
  }

  // Best-effort detach used by the revocation + membership-leave cascades. A
  // retired or unreachable VM leaves an inert stale device entry (a detached
  // device cannot mint a tunnel token, so it can never reconnect anyway); the
  // caller does not surface these failures.
  async detachMirrorDevice(workspaceSlug: string, machineId: string): Promise<void> {
    try {
      await this.gatewayJson(
        workspaceSlug,
        'DELETE',
        `/v1/sync/syncthing/mirror/devices/${encodeURIComponent(machineId)}`,
      )
    } catch {
      // swallowed — the cascade never fails a revoke/leave on a dead VM.
    }
  }

  async mintDesktopGrant(
    workspaceSlug: string,
    embedOrigin: string,
  ): Promise<DesktopSessionResponse | { error: GatewayRequestError }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) return { error: 'not_found' }
    if (isGatewayRefusal(gateway)) return { error: gatewayRefusalError(gateway) }

    const expiresAt = this.args.now() + DESKTOP_GRANT_TTL_MS
    const grantId = `desktop-${randomHex(12)}`
    const derivedToken = await deriveWorkspaceTunnelToken(gateway.workspaceId, expiresAt)
    // Tunnel tokens contain dots, while the desktop path uses one dot to
    // separate the grant id from its credential. Base64url preserves the
    // derived token as one path-safe segment without changing its entropy.
    const token = Buffer.from(derivedToken).toString('base64url')
    const grantUrl = new URL(gateway.httpsUrl)
    grantUrl.pathname = '/v1/desktop/grants'
    grantUrl.search = ''
    let registered: Response
    try {
      registered = await this.fetchGateway(workspaceSlug, grantUrl.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${gateway.vmToken}`,
        },
        body: JSON.stringify({
          grantId,
          tokenDigest: await tunnelTokenDigest(token),
          expiresAt,
          embedOrigin,
        }),
      })
    } catch {
      return { error: 'gateway_failed' }
    }
    if (!registered.ok) {
      if (
        registered.status === 503 &&
        DesktopUnavailableErrorSchema.safeParse(await readResponseJson(registered)).success
      ) {
        return { error: 'desktop_unavailable' }
      }
      return { error: 'gateway_failed' }
    }
    const registration = (await readResponseJson(registered)) as {
      entryPath?: unknown
      phase?: unknown
    } | null
    const phase = DesktopPhaseSchema.safeParse(registration?.phase)
    if (
      registration === null ||
      registration.entryPath !== desktopEntryPath(grantId) ||
      !phase.success
    ) {
      return { error: 'gateway_failed' }
    }

    // Desktop traffic permanently bypasses apps/edge: a fetch-style function
    // cannot carry the viewer's WebSocket upgrade. The registered gateway URL
    // is therefore the browser's direct exe.dev origin.
    const entryUrl = new URL(desktopViewerPath(grantId, token), gateway.httpsUrl).toString()
    return DesktopSessionResponseSchema.parse({
      entryUrl,
      expiresAt,
      phase: phase.data,
      screen: DESKTOP_SCREEN,
    })
  }

  async readDesktopStatus(
    workspaceSlug: string,
  ): Promise<DesktopStatusResponse | { error: GatewayRequestError }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) return { error: 'not_found' }
    if (isGatewayRefusal(gateway)) return { error: gatewayRefusalError(gateway) }

    const statusUrl = new URL(gateway.httpsUrl)
    statusUrl.pathname = '/v1/desktop/status'
    statusUrl.search = ''
    let response: Response
    try {
      response = await this.fetchGateway(workspaceSlug, statusUrl.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${gateway.vmToken}` },
      })
    } catch {
      return { error: 'gateway_failed' }
    }
    if (!response.ok) return { error: 'gateway_failed' }
    const status = DesktopStatusResponseSchema.safeParse(await readResponseJson(response))
    return status.success ? status.data : { error: 'gateway_failed' }
  }

  async focusDesktopOwner(
    workspaceSlug: string,
    owner: BrowserOwner,
    requestId: string,
  ): Promise<{ focused: boolean } | { error: GatewayRequestError }> {
    try {
      const result = await this.gatewayJson(
        workspaceSlug,
        'POST',
        '/v1/desktop/browser/windows/focus',
        { owner, requestId },
      )
      if ('error' in result) return result
      if (!result.response.ok) return { error: 'gateway_failed' }
      const parsed = FocusBrowserOwnerResultSchema.safeParse(
        await readResponseJson(result.response),
      )
      return parsed.success ? parsed.data : { error: 'gateway_failed' }
    } catch {
      return { error: 'gateway_failed' }
    }
  }

  // Mint a short-TTL tunnel grant the device presents on every (re)connect
  // (MAP-SYNC L23 — never cached). Registers an accept config that bridges the
  // dialed WS to the VM's loopback Syncthing (127.0.0.1:22000, L24 dial-only).
  async mintMirrorTunnel(
    workspaceSlug: string,
    machineId: string,
  ): Promise<MirrorTunnelGrant | { error: GatewayRequestError }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) return { error: 'not_found' }
    if (isGatewayRefusal(gateway)) return { error: gatewayRefusalError(gateway) }
    const expiresAt = this.args.now() + TUNNEL_TOKEN_TTL_MS
    const acceptId = `mirror-${machineId}-${randomHex(6)}`
    const tunnelToken = await deriveWorkspaceTunnelToken(gateway.workspaceId, expiresAt)
    const acceptUrl = new URL(gateway.httpsUrl)
    acceptUrl.pathname = '/v1/tunnel/mirror-accept'
    acceptUrl.search = ''
    const registered = await this.fetchGateway(workspaceSlug, acceptUrl.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${gateway.vmToken}`,
      },
      body: JSON.stringify({
        machineId,
        acceptId,
        tokenDigest: await tunnelTokenDigest(tunnelToken),
        expiresAt,
      }),
    })
    if (!registered.ok) return { error: 'gateway_failed' }
    const dialUrl = new URL(gateway.httpsUrl)
    dialUrl.protocol = 'wss:'
    dialUrl.pathname = `/v1/tunnel/accept/${acceptId}`
    dialUrl.search = ''
    return { url: dialUrl.toString(), tunnelToken, expiresAt }
  }

  private async gatewayJson(
    workspaceSlug: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ response: Response } | { error: GatewayRequestError }> {
    const gateway = await this.resolveGateway(workspaceSlug)
    if (gateway === null) return { error: 'not_found' }
    if (isGatewayRefusal(gateway)) return { error: gatewayRefusalError(gateway) }
    const url = new URL(gateway.httpsUrl)
    url.pathname = path
    url.search = ''
    const response = await this.fetchGateway(workspaceSlug, url.toString(), {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${gateway.vmToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { response }
  }

  // Every proxied request otherwise pays a Convex gatewayConnectionBySlug query.
  // Successful resolutions are cached for a short TTL (config.ts owns the knob); null,
  // paused refusals, and query failures are never cached, so provisioning and
  // resumed workspaces become visible on their first successful resolve.
  private async resolveGateway(
    workspaceSlug: string,
    allowPaused = false,
  ): Promise<GatewayResolution> {
    // Control-plane cleanup may reach a paused-but-live VM. Never let that resolution
    // populate the normal data-plane cache used by prompts and session reads.
    const cached = allowPaused ? undefined : this.gatewayResolutionCache.get(workspaceSlug)
    if (cached !== undefined && cached.expiresAt > this.args.now()) return cached.connection
    let gateway: GatewayResolution
    try {
      gateway = (await this.args.convex.query(
        fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
        {
          internalKey: this.args.internalKey,
          slug: workspaceSlug,
          ...(allowPaused ? { allowPaused: true } : {}),
        },
      )) as GatewayResolution
    } catch {
      return null
    }
    if (!allowPaused && gateway !== null && !isGatewayRefusal(gateway)) {
      this.gatewayResolutionCache.set(workspaceSlug, {
        connection: gateway,
        expiresAt: this.args.now() + resolveGatewayResolutionTtlMs(),
      })
    }
    return gateway
  }

  // Cached slug resolution bounds servicing-pause propagation: the API data
  // plane closes within 15 seconds. The edge publish cache adds an independent
  // 30-second bound; slice 11 owns that page. Connection failures and 5xxs
  // invalidate immediately so moved or re-registered VMs resolve on the next
  // request instead of waiting out the TTL.
  private async fetchGateway(
    workspaceSlug: string,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.args.fetchImpl(url, init)
    } catch (error) {
      this.gatewayResolutionCache.delete(workspaceSlug)
      throw error
    }
    if (response.status >= 500) this.gatewayResolutionCache.delete(workspaceSlug)
    return response
  }

  async backupCommand(
    workspaceSlug: string,
    backupId: string,
    attemptId: string,
    operation: 'start' | 'cancel',
  ): Promise<Response> {
    try {
      // A backup is recovery control, so resolve its admitted job directly and
      // never reuse/populate the ordinary traffic cache.
      const gateway = (await this.args.convex.query(
        fnQuery('domains/workspaces/provisioning:gatewayConnectionForBackup'),
        { internalKey: this.args.internalKey, backupId, attemptId },
      )) as GatewayConnection | null
      if (gateway === null) return workspaceVmUnavailableResponse()
      const url = new URL(gateway.httpsUrl)
      url.pathname = `/v1/backups/${encodeURIComponent(backupId)}${operation === 'start' ? '/start' : ''}`
      url.search = ''
      const response = await this.fetchGateway(workspaceSlug, url.toString(), {
        method: operation === 'start' ? 'POST' : 'DELETE',
        headers: { authorization: `Bearer ${gateway.vmToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId }),
        signal: AbortSignal.timeout(10_000),
      })
      return response.status === 503 || response.status === 504
        ? workspaceVmUnavailableResponse()
        : response
    } catch {
      return workspaceVmUnavailableResponse()
    }
  }

  private async connectedProviderRequest(
    workspaceSlug: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    return await this.vmControlRequest(workspaceSlug, `/v1/connected-providers${path}`, '', init)
  }

  /**
   * One request to a VM-local control route, carrying the VM token.
   *
   * The path and query are the caller's whole intent: the gateway's own base
   * URL never contributes either, so a resolution that happens to carry a
   * query cannot leak into the request. A VM that is asleep, paused, or
   * refusing is reported as such rather than as the route's own failure.
   */
  private async vmControlRequest(
    workspaceSlug: string,
    pathname: string,
    search: string,
    init: RequestInit,
    allowPaused = false,
  ): Promise<Response> {
    try {
      const gateway = await this.resolveGateway(workspaceSlug, allowPaused)
      if (gateway === null) return workspaceVmUnavailableResponse()
      if (isGatewayRefusal(gateway)) return gatewayRefusalResponse(gateway)
      const url = new URL(gateway.httpsUrl)
      url.pathname = pathname
      url.search = search
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${gateway.vmToken}`)
      if (init.body !== undefined) headers.set('content-type', 'application/json')
      const response = await this.fetchGateway(workspaceSlug, url.toString(), {
        ...init,
        headers,
      })
      return response.status === 503 || response.status === 504
        ? workspaceVmUnavailableResponse()
        : response
    } catch {
      return workspaceVmUnavailableResponse()
    }
  }
}

function isGatewayRefusal(resolution: GatewayResolution): resolution is GatewayRefusal {
  return resolution !== null && 'refusal' in resolution
}

const REFUSAL_ANSWERS = {
  paused: { error: WORKSPACE_PAUSED_ERROR, status: 402 },
  provisioning: { error: WORKSPACE_PROVISIONING_ERROR, status: 409 },
  unhealthy: { error: WORKSPACE_UNHEALTHY_ERROR, status: 503 },
  archived: { error: WORKSPACE_ARCHIVED_ERROR, status: 410 },
} as const

export function gatewayRefusalError(refusal: GatewayRefusal): GatewayRequestError {
  return refusalAnswer(refusal).error
}

export function gatewayRefusalResponse(refusal: GatewayRefusal): Response {
  const answer = refusalAnswer(refusal)
  return Response.json({ error: answer.error }, { status: answer.status })
}

function refusalAnswer(refusal: GatewayRefusal): { error: GatewayRequestError; status: number } {
  return REFUSAL_ANSWERS[refusal.refusal] ?? { error: 'gateway_failed', status: 502 }
}

function workspaceVmUnavailableResponse(): Response {
  return Response.json({ error: 'workspace_vm_unavailable' }, { status: 503 })
}

function connectedProviderInvalidResponse(): Response {
  return Response.json({ error: 'provider_gateway_invalid_response' }, { status: 502 })
}

function anchorReconcileFailure(reason: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: Response.json({ error: 'agent_reconcile_failed', reason }, { status: 502 }),
  }
}

function marketplacePullFailure(): { ok: false; response: Response } {
  return {
    ok: false,
    response: Response.json({ error: 'pull_failed' }, { status: 502 }),
  }
}

/**
 * The gateway URL for a files request, path and query carried verbatim so a
 * percent-encoded identity crosses untouched. `apiOnlyQuery` names the
 * parameters the API answers itself and the gateway must never see: it parses
 * its query strictly, so forwarding one would turn a valid request into a 400.
 */
export function gatewayFilesUrl(
  request: Request,
  apiOnlyQuery: readonly string[] = [],
): (httpsUrl: string) => string {
  const { pathname, search } = rawUrlPathAndSearch(request.url)
  const match = pathname.match(/^\/v1\/ws\/[^/]+\/files(?<rawFilePath>\/.*)?$/)
  const rawFilePath = match?.groups?.rawFilePath ?? ''
  const forwardedSearch = withoutQueryParams(search, apiOnlyQuery)
  return httpsUrl => {
    const gateway = new URL(httpsUrl)
    return `${gateway.protocol}//${gateway.host}/v1/files${rawFilePath}${forwardedSearch}`
  }
}

/* On the raw search string rather than through `URLSearchParams`, which would
   re-encode every other parameter on the way back out. */
function withoutQueryParams(search: string, names: readonly string[]): string {
  if (names.length === 0 || search.length === 0) return search
  const kept = search
    .slice(1)
    .split('&')
    .filter(pair => pair.length > 0 && !names.includes(pair.split('=', 1)[0] ?? ''))
  return kept.length === 0 ? '' : `?${kept.join('&')}`
}

export function gatewayMemoryUrl(request: Request): (httpsUrl: string) => string {
  const { pathname, search } = rawUrlPathAndSearch(request.url)
  const memoryPath = pathname.endsWith('/memories/search') ? '/v1/memory/search' : '/v1/memory'
  return httpsUrl => {
    const gateway = new URL(httpsUrl)
    return `${gateway.protocol}//${gateway.host}${memoryPath}${search}`
  }
}

export function gatewayTrainRecordsUrl(request: Request): (httpsUrl: string) => string {
  const { pathname, search } = rawUrlPathAndSearch(request.url)
  const match = pathname.match(/^\/v1\/ws\/[^/]+\/train\/records(?<recordPath>\/[^/?#]+)?$/)
  const recordPath = match?.groups?.recordPath ?? ''
  return httpsUrl => {
    const gateway = new URL(httpsUrl)
    return `${gateway.protocol}//${gateway.host}/v1/train/records${recordPath}${search}`
  }
}

/**
 * One archived source, or a memory's restage endpoint, under either scope.
 *
 * `relPath` is a path sequence, not a segment — an archive keeps a corpus's own
 * folder structure — so it goes through `encodePathSegments`.
 */
export function gatewayTrainRecordActionUrl(
  anchorId: string | undefined,
  recordSlug: string,
  action: { kind: 'restage' } | { kind: 'source'; relPath: string },
): (httpsUrl: string) => string {
  const slug = encodeURIComponent(recordSlug)
  const suffix =
    action.kind === 'restage'
      ? `/records/${slug}/restage`
      : `/records/${slug}/sources/${encodePathSegments(action.relPath)}`
  return httpsUrl => {
    const gateway = new URL(httpsUrl)
    return `${gateway.protocol}//${gateway.host}${gatewayTrainPath(anchorId, suffix)}`
  }
}

export function gatewayTrainMemoryCountsUrl(httpsUrl: string): string {
  const gateway = new URL(httpsUrl)
  gateway.pathname = '/v1/train/memory-counts'
  gateway.search = ''
  return gateway.toString()
}

export function gatewayTrainStartUrl(httpsUrl: string): string {
  const gateway = new URL(httpsUrl)
  gateway.pathname = '/v1/train'
  gateway.search = ''
  return gateway.toString()
}

export function gatewayAgentTrainStartUrl(anchorId: string): (httpsUrl: string) => string {
  return httpsUrl => {
    const gateway = new URL(httpsUrl)
    gateway.pathname = gatewayTrainPath(anchorId)
    gateway.search = ''
    return gateway.toString()
  }
}

export function gatewayAgentTrainRecordsUrl(
  request: Request,
  anchorId: string,
  recordSlug?: string,
): (httpsUrl: string) => string {
  const { search } = rawUrlPathAndSearch(request.url)
  const recordPath = recordSlug === undefined ? '' : `/${encodeURIComponent(recordSlug)}`
  return httpsUrl => {
    const gateway = new URL(httpsUrl)
    return `${gateway.protocol}//${gateway.host}${gatewayTrainPath(anchorId, `/records${recordPath}`)}${search}`
  }
}

export function gatewayAgentTrainUploadsUrl(
  request: Request,
  anchorId: string,
  filename?: string,
): (httpsUrl: string) => string {
  const { search } = rawUrlPathAndSearch(request.url)
  const uploadPath = filename === undefined ? '' : `/${encodeURIComponent(filename)}`
  return httpsUrl => {
    const gateway = new URL(httpsUrl)
    return `${gateway.protocol}//${gateway.host}${gatewayTrainPath(anchorId, `/uploads${uploadPath}`)}${search}`
  }
}

export function gatewayTrainUploadsUrl(request: Request): (httpsUrl: string) => string {
  const { pathname, search } = rawUrlPathAndSearch(request.url)
  const match = pathname.match(/^\/v1\/ws\/[^/]+\/train\/uploads(?<uploadPath>\/[^/?#]+)?$/)
  const uploadPath = match?.groups?.uploadPath ?? ''
  return httpsUrl => {
    const gateway = new URL(httpsUrl)
    return `${gateway.protocol}//${gateway.host}/v1/train/uploads${uploadPath}${search}`
  }
}

function gatewayTrainPath(anchorId: string | undefined, suffix = ''): string {
  const scopePath =
    anchorId === undefined ? '/v1/train' : `/v1/train/agents/${encodeURIComponent(anchorId)}`
  return `${scopePath}${suffix}`
}

function encodeDrivePathForGateway(path: string): string | null {
  const normalized = normalizeDrivePath(path)
  if (!normalized.ok) return null
  return encodePathSegments(normalized.relativePath)
}

/**
 * Encode a relative path for a gateway URL segment by segment.
 *
 * Encoding it whole would turn its separators into `%2F`, which no gateway
 * route matches — both drive paths and archived-source paths are sequences,
 * not single segments.
 */
function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function gatewayRequestHeaders(
  incoming: Headers,
  vmToken: string,
  forwardedHeaders: readonly string[],
  actorContext?: FileActorContext,
  collectionSubject?: string,
): Headers {
  const headers = new Headers()
  for (const name of forwardedHeaders) copyHeader(incoming, headers, name)
  // Actor identity is synthesized from authenticated state AFTER the copy
  // loop (MAP L4): a client-supplied value can never cross the trust
  // boundary, even if the header name ever leaks into a forwarded list.
  headers.delete(DUET_ACTOR_CONTEXT_HEADER)
  if (actorContext !== undefined) {
    headers.set(DUET_ACTOR_CONTEXT_HEADER, encodeActorContext(actorContext))
  }
  if (collectionSubject !== undefined) {
    headers.set(DUET_COLLECTION_SUBJECT_HEADER, collectionSubject)
  }
  headers.set('authorization', `Bearer ${vmToken}`)
  return headers
}

function gatewayResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers()
  for (const name of [
    'accept-ranges',
    'cache-control',
    'content-length',
    'content-range',
    'content-security-policy',
    'content-type',
    'etag',
    'last-modified',
    'x-content-type-options',
  ]) {
    copyHeader(upstream, headers, name)
  }
  return headers
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function deriveWorkspaceTunnelToken(workspaceId: string, expiresAt: number): Promise<string> {
  // Both desktop and mirror grants address the same workspace's own VM, so
  // source and target are deliberately identical in the shared tunnel claims.
  const claims: TunnelTokenClaims = {
    sourceWorkspaceId: workspaceId,
    targetWorkspaceId: workspaceId,
    direction: 'source-to-target',
  }
  return await deriveTunnelToken({ secret: randomHex(32), claims, expiresAt })
}

/**
 * A converge failure the operator can act on: the gateway's status plus a
 * bounded slice of whatever it said. The detail is truncated because a gateway
 * that rejects an oversized body may answer with an HTML error page, and the
 * admin surface renders this string.
 */
function hubSyncFailure(gatewayStatus: number, detail: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: Response.json(
      { error: 'hub_sync_failed', gatewayStatus, detail: detail.trim().slice(0, 300) },
      { status: 502 },
    ),
  }
}

function copyHeader(from: Headers, to: Headers, name: string): void {
  const value = from.get(name)
  if (value !== null) to.set(name, value)
}

function rawUrlPathAndSearch(url: string): { pathname: string; search: string } {
  const withoutScheme = url.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/[^/]*/, '')
  const pathAndRest = withoutScheme.length === 0 ? '/' : withoutScheme
  const hashStart = pathAndRest.indexOf('#')
  const withoutHash = hashStart === -1 ? pathAndRest : pathAndRest.slice(0, hashStart)
  const queryStart = withoutHash.indexOf('?')
  if (queryStart === -1) return { pathname: withoutHash, search: '' }
  return { pathname: withoutHash.slice(0, queryStart), search: withoutHash.slice(queryStart) }
}

function browserVmBaseUrl(httpsUrl: string): string {
  const vmBaseUrl = new URL(httpsUrl)
  vmBaseUrl.pathname = '/'
  vmBaseUrl.search = ''
  return vmBaseUrl.toString()
}

function reportsCoverDesiredSubscriptions(
  reports: MarketplaceAgentPullReport[],
  desired: VmDesiredMarketplaceAgents,
): boolean {
  const reportedIds = new Set(reports.map(report => report.subscriptionId))
  return (
    reports.length === desired.subscriptions.length &&
    reportedIds.size === desired.subscriptions.length &&
    desired.subscriptions.every(subscription => reportedIds.has(subscription.subscriptionId))
  )
}
