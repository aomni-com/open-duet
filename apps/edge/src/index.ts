import {
  safeTransportCode,
  DUET_APP_ACCESS_COOKIE,
  DUET_APP_ACCESS_QUERY,
  convexUrlsFromDeployment,
  DUET_APP_SLUG_HEADER,
  EDGE_SECRET_HEADER,
  DUET_PUBLISH_ANCHOR_PATH_HEADER,
  DUET_PUBLISH_FREEZE_HEADER,
  DUET_PUBLISH_KIND_HEADER,
  DUET_PUBLISH_SLUG_HEADER,
  DUET_VIEWER_USER_ID_HEADER,
  DUET_VIEWER_DESCRIPTOR_HEADER,
  DUET_WORKSPACE_SLUG_HEADER,
  DUET_EDGE_HOST,
  DUET_STAGING_EDGE_HOST,
  EdgeResolveRequestSchema,
  EdgeAppDenialSchema,
  AppDomainHostnameSchema,
  EdgeAppHostIdentitySchema,
  EdgeResolveResultSchema,
  FORWARDED_HOST_HEADER,
  DUET_ORIGINAL_HOST_HEADER,
  classifyPublishRequest,
  isPublishExcludedDrivePath,
  requestBody,
  duplexFor,
  serializeViewerDescriptor,
  serializePublishFreezeHeader,
  type EdgeResolveRequest,
  type AppAccessGrantClaims,
  type EdgeResolveResult,
  type EdgeResolveResponse,
  type EdgeRoute,
  type FetchLike,
  type ViewerDescriptor,
  parseEdgeRoute,
  verifyAppAccessGrant,
} from '@repo/contract'

import { defaultViewerOrigin } from './config'
import { renderPausedPage } from './paused-page'

export interface EdgeAppOptions {
  convexSiteUrl?: string
  edgeSecret?: string
  fetch?: FetchLike
  resolveAttempts?: number
  resolveRetryDelayMs?: number
  appSseSegmentMs?: number
  now?: () => number
  // Typed per-environment apps/web origin the publish viewer (its page + its
  // `/_next/*` assets) is proxied to. Configured, never derived from the
  // inbound Host (R4): the default comes from config.ts keyed on the
  // deployment environment, and DUET_WEB_ORIGIN overrides it when set.
  viewerOrigin?: string
}

type ServingRoute = EdgeRoute & {
  customBinding?: Extract<EdgeResolveRequest, { kind: 'app' }>['customBinding']
}

type AppAccessViewer = Pick<AppAccessGrantClaims, 'userId' | 'appId'> & {
  credential: 'cookie' | 'grant'
}

type EdgeFetch = (request: Request) => Promise<Response>

const RESOLVE_TIMEOUT_MS = 30_000
const DEFAULT_RESOLVE_ATTEMPTS = 4
const DEFAULT_RESOLVE_RETRY_DELAY_MS = 250
const DEFAULT_APP_SSE_SEGMENT_MS = 4 * 60 * 1_000
const ROBOTS_TAG = 'noindex, nofollow'
const PUBLISH_CACHE_CONTROL = 'public, max-age=30, s-maxage=30'
const PUBLISH_EDGE_HOSTS = new Set([DUET_EDGE_HOST, DUET_STAGING_EDGE_HOST])
// apps/web static-asset prefixes that must reach the viewer origin BEFORE
// parsePublishRoute turns a ≥2-segment path into `<ws>/<pub>/…` (R1). `/_next/`
// carries framework + page chunks and images; `/__nextjs` is the dev overlay.
const VIEWER_ASSET_PREFIXES = ['/_next/', '/__nextjs', '/favicon.ico', '/manifest.json']

export function createEdgeApp(options: EdgeAppOptions = {}): { fetch: EdgeFetch } {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const convexSiteUrl =
    options.convexSiteUrl ?? convexUrlsFromDeployment(process.env.CONVEX_DEPLOYMENT ?? '').siteUrl
  const edgeSecret = options.edgeSecret ?? process.env.DUET_EDGE_INTERNAL_KEY
  const now = options.now ?? Date.now
  const viewerOrigin = options.viewerOrigin ?? process.env.DUET_WEB_ORIGIN ?? defaultViewerOrigin()
  if (!edgeSecret) throw new Error('DUET_EDGE_INTERNAL_KEY is required')

  return {
    fetch: async request => {
      // `/_next/*` (and other viewer asset prefixes) on a publish host must
      // relay to the viewer origin before parsePublishRoute can misparse them
      // as `<ws>/<pub>` (R1). This branch resolves nothing and carries no
      // publish/session credentials.
      const assetResponse = await tryViewerAsset({ fetchImpl, request, viewerOrigin })
      if (assetResponse !== null) return assetResponse

      let route: ServingRoute | null = parseEdgeRoute(request.url, request.headers.get('host'))
      if (route === null) {
        const hostname = AppDomainHostnameSchema.safeParse(
          request.headers.get('host')?.toLowerCase(),
        )
        if (!hostname.success) return rejectUnknownRoute()
        try {
          const identity = await resolveBackend({
            fetchImpl,
            convexSiteUrl,
            edgeSecret,
            resolveBody: { kind: 'app-host', hostname: hostname.data },
            parse: value => EdgeAppHostIdentitySchema.parse(value),
            attempts: options.resolveAttempts ?? DEFAULT_RESOLVE_ATTEMPTS,
            retryDelayMs: options.resolveRetryDelayMs ?? DEFAULT_RESOLVE_RETRY_DELAY_MS,
          })
          const url = new URL(request.url)
          route = {
            kind: 'app',
            host: hostname.data,
            workspaceSlug: identity.workspaceSlug,
            appSlug: identity.appSlug,
            upstreamPath: `${url.pathname}${url.search}`,
            customBinding: { hostname: hostname.data, appId: identity.appId },
          }
        } catch (error) {
          if (error instanceof ResolveRejectedError)
            return edgeJson({ error: error.responseError }, error.status)
          return edgeJson({ error: 'resolve_failed' }, 502)
        }
      }
      let accessRedirect: Response | null = null
      if (route.kind === 'app') {
        accessRedirect = await exchangeAppAccessGrant(request, route, edgeSecret, now())
        if (accessRedirect?.status === 403) return accessRedirect
      }
      if (
        route.kind === 'publish' &&
        isPublishExcludedDrivePath(pathnameFromUpstream(route.upstreamPath))
      ) {
        return edgeJson({ error: 'not_found' }, 404)
      }

      let resolved: EdgeResolveResult
      try {
        const viewer =
          route.kind === 'app'
            ? await viewerFromAppAccess(request, route, edgeSecret, now())
            : undefined
        resolved = await resolveBackend({
          fetchImpl,
          convexSiteUrl,
          edgeSecret,
          resolveBody: resolveRequest(route, viewer),
          parse: value => EdgeResolveResultSchema.parse(value),
          attempts: options.resolveAttempts ?? DEFAULT_RESOLVE_ATTEMPTS,
          retryDelayMs: options.resolveRetryDelayMs ?? DEFAULT_RESOLVE_RETRY_DELAY_MS,
        })
      } catch (error) {
        if (error instanceof ResolveRejectedError) {
          if (
            error.responseError === 'guest_private' &&
            route.kind === 'app' &&
            isBrowserDocument(request)
          ) {
            const destination = new URL(
              `/w/${encodeURIComponent(route.workspaceSlug)}/apps/${encodeURIComponent(route.appSlug)}/open`,
              viewerOrigin,
            )
            destination.search = new URLSearchParams({
              host: route.host,
              path: route.upstreamPath,
            }).toString()
            return new Response(null, {
              status: 302,
              headers: {
                location: destination.toString(),
                'cache-control': 'private, no-store',
                'x-robots-tag': ROBOTS_TAG,
                'referrer-policy': 'no-referrer',
              },
            })
          }
          return edgeJson(
            { error: error.responseError === 'guest_private' ? 'forbidden' : error.responseError },
            error.status,
          )
        }
        const detail = error instanceof Error ? error.message : String(error)
        return edgeJson({ error: 'resolve_failed', detail }, 502)
      }

      if ('paused' in resolved) return pausedPage(request, resolved.appName)
      if (accessRedirect !== null) return accessRedirect

      if (route.kind === 'publish') {
        if (resolved.publish === undefined)
          return edgeJson({ error: 'resolve_failed', detail: 'missing publish descriptor' }, 502)
        if (isPublishExcludedDrivePath(resolved.publish.anchorPath))
          return edgeJson({ error: 'not_found' }, 404)
      }

      try {
        if (route.kind === 'publish') {
          return await dispatchPublish({
            fetchImpl,
            request,
            route,
            resolved,
            convexSiteUrl,
            edgeSecret,
            viewerOrigin,
          })
        }
        return await proxyToGateway({
          fetchImpl,
          request,
          route,
          resolved,
          appSseSegmentMs: options.appSseSegmentMs ?? DEFAULT_APP_SSE_SEGMENT_MS,
        })
      } catch (error) {
        try {
          const transportCode = safeTransportCode(error)
          if (
            transportCode !== undefined &&
            !request.signal.aborted &&
            !request.headers.get('accept')?.includes('text/event-stream') &&
            !isWebSocketUpgrade(request)
          ) {
            console.error('edge_origin_connection_failed', {
              routeKind: route.kind,
              workspaceId: resolved.workspace.id,
              transportCode,
            })
          }
        } catch {
          // Diagnostic failure cannot replace the origin failure response.
        }
        const detail = error instanceof Error ? error.message : String(error)
        return edgeJson({ error: 'origin_unavailable', detail }, 502)
      }
    },
  }
}

export const edgeApp = createLazyEdgeApp()
export const fetch = (request: Request): Promise<Response> => edgeApp.fetch(request)
export default { fetch }

async function resolveBackend<T>({
  fetchImpl,
  convexSiteUrl,
  edgeSecret,
  resolveBody,
  parse,
  attempts,
  retryDelayMs,
}: {
  fetchImpl: FetchLike
  convexSiteUrl: string
  edgeSecret: string
  resolveBody: EdgeResolveRequest
  parse: (value: unknown) => T
  attempts: number
  retryDelayMs: number
}): Promise<T> {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(`${convexSiteUrl.replace(/\/+$/g, '')}/v1/edge/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [EDGE_SECRET_HEADER]: edgeSecret,
      },
      body: JSON.stringify(resolveBody),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    })
    if (response.status === 404 || response.status === 403) {
      const body = EdgeAppDenialSchema.safeParse(await response.json().catch(() => null))
      throw new ResolveRejectedError(
        response.status,
        response.status === 404
          ? 'not_found'
          : body.success && body.data.error === 'guest_private'
            ? 'guest_private'
            : 'forbidden',
      )
    }
    if (response.ok) {
      return parse(await response.json())
    }
    const text = await response.text()
    lastError = new Error(`resolve failed with HTTP ${response.status}: ${text}`)
    if (!isRetryableResolveStatus(response.status) || attempt === attempts) break
    await sleep(retryDelayMs * attempt)
  }
  throw lastError ?? new Error('resolve failed')
}

class ResolveRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly responseError: string,
  ) {
    super(`resolve rejected route with HTTP ${status}`)
  }
}

// Publish requests fork on the reserved selector: a bare/deep request (or any
// unrelated query) serves the viewer page from the apps/web origin with every
// caller credential stripped; `?raw`/`?list` reach the gateway with the
// workspace bearer + publish headers; both selectors at once is a contradiction.
// This is the single dispatch owner — the two request builders (`proxyToViewer`,
// `proxyToGateway`) each have exactly one publish caller here.
async function dispatchPublish({
  fetchImpl,
  request,
  route,
  resolved,
  convexSiteUrl,
  edgeSecret,
  viewerOrigin,
}: {
  fetchImpl: FetchLike
  request: Request
  route: Extract<EdgeRoute, { kind: 'publish' }>
  resolved: EdgeResolveResponse
  convexSiteUrl: string
  edgeSecret: string
  viewerOrigin: string | undefined
}): Promise<Response> {
  const mode = classifyPublishRequest(new URL(request.url))
  if (mode === 'invalid') return edgeJson({ error: 'invalid_selector' }, 400)
  if (mode === 'viewer') {
    return proxyToViewer({
      fetchImpl,
      request,
      viewerOrigin,
      targetPath: viewerPageTarget(route),
      cacheControl: PUBLISH_CACHE_CONTROL,
      // The resolve guarantees a descriptor (schema-required); forward it as the
      // viewer's public banner/root bootstrap. This is the ONLY x-duet-* header
      // the viewer origin receives — every caller-supplied one is stripped.
      viewerDescriptor: resolved.publish!.viewer,
    })
  }
  const response = await proxyToGateway({
    fetchImpl,
    request,
    route,
    resolved,
    completeBody: mode === 'zip',
  })
  // Served-path auditing records one successful public byte-serving request:
  // nested files for `?raw`, or the requested folder once for `?zip`. Viewer,
  // list, conditional, and failed responses never reach a report.
  if (mode === 'raw' || mode === 'zip') {
    await reportFirstServedPublishPath({
      fetchImpl,
      convexSiteUrl,
      edgeSecret,
      route,
      resolved,
      response,
      mode,
    })
  }
  return response
}

// The gateway rail, shared by app requests and publish `?raw`/`?list`: proxies
// to the resolved VM origin with the workspace gateway bearer, sets the routing
// headers, and drops any caller-forged viewer identity. Range and conditional
// headers pass through untouched (copied from the inbound request).
async function proxyToGateway({
  fetchImpl,
  request,
  route,
  resolved,
  appSseSegmentMs,
  completeBody = false,
}: {
  fetchImpl: FetchLike
  request: Request
  route: ServingRoute
  resolved: EdgeResolveResponse
  appSseSegmentMs?: number
  /**
   * Read the origin's body to its end before answering. The origin streams a
   * zip with no length and its 200 already committed, so a stream that breaks
   * mid-body would otherwise reach the client as a short, well-formed 200 — and
   * the CDN would cache that short body for everyone for the publish TTL.
   */
  completeBody?: boolean
}): Promise<Response> {
  const targetUrl = originUrl(resolved, route)
  const headers = new Headers(request.headers)
  if (route.kind === 'publish') {
    // Public data reads are anonymous: no caller-supplied Duet-internal header
    // (a forged x-duet-actor-context would poison read attribution) and no
    // cookie survives. The edge re-sets every header the gateway needs below.
    const duetHeaders = Array.from(headers.keys()).filter(name =>
      name.toLowerCase().startsWith('x-duet-'),
    )
    for (const name of duetHeaders) headers.delete(name)
    headers.delete('cookie')
  }
  const host = request.headers.get('host')
  if (host !== null) headers.set(FORWARDED_HOST_HEADER, host)
  // VM ingress rewrites standard proxy headers before the gateway sees them.
  if (route.kind === 'app') headers.set(DUET_ORIGINAL_HOST_HEADER, route.host)
  headers.set(DUET_WORKSPACE_SLUG_HEADER, route.workspaceSlug)
  if (route.kind === 'app') headers.set(DUET_APP_SLUG_HEADER, route.appSlug)
  if (route.kind === 'publish') {
    headers.set(DUET_PUBLISH_SLUG_HEADER, route.publishSlug)
    headers.set(DUET_PUBLISH_KIND_HEADER, resolved.publish!.kind)
    headers.set(DUET_PUBLISH_ANCHOR_PATH_HEADER, resolved.publish!.anchorPath)
    if (resolved.publish!.freeze !== undefined) {
      headers.set(
        DUET_PUBLISH_FREEZE_HEADER,
        serializePublishFreezeHeader({
          publishId: resolved.publish!.id,
          generation: resolved.publish!.freeze.generation,
        }),
      )
    }
  }
  headers.set('authorization', `Bearer ${resolved.origin.gatewayAuthToken}`)
  headers.delete(DUET_VIEWER_USER_ID_HEADER)
  const originCookie = withoutCookie(headers.get('cookie'), DUET_APP_ACCESS_COOKIE)
  if (originCookie === null) headers.delete('cookie')
  else headers.set('cookie', originCookie)
  headers.delete('host')

  const upstreamAbort = route.kind === 'app' ? new AbortController() : undefined
  const init: RequestInit = {
    method: request.method,
    headers,
    body: requestBody(request),
    signal:
      upstreamAbort === undefined
        ? request.signal
        : AbortSignal.any([request.signal, upstreamAbort.signal]),
    ...duplexFor(request),
  }
  if (isWebSocketUpgrade(request)) {
    init.headers = upgradeHeaders(headers, request)
  }
  const upstream = await fetchImpl(targetUrl, init)
  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')
  responseHeaders.delete('transfer-encoding')
  if (route.kind === 'app') {
    // App URLs are edited in place, including their scripts and stylesheets.
    // The edge owns freshness even when an existing app server advertises a TTL.
    responseHeaders.set('cache-control', 'private, no-store')
    responseHeaders.delete('cdn-cache-control')
    responseHeaders.delete('vercel-cdn-cache-control')
    responseHeaders.delete('expires')
    // The product runs the app re-fronted on our own origin inside an iframe.
    // An app's own frame-blocking headers would only break that viewer, never
    // protect the user, so drop them. These are header-only (a <meta> cannot
    // set frame-ancestors), so this is complete coverage.
    responseHeaders.delete('x-frame-options')
    responseHeaders.delete('content-security-policy')
  }
  if (
    route.kind !== 'app' ||
    route.customBinding === undefined ||
    resolved.visibility !== 'public' ||
    upstream.status >= 400
  ) {
    responseHeaders.set('x-robots-tag', ROBOTS_TAG)
  }
  if (route.kind === 'publish') responseHeaders.set('cache-control', PUBLISH_CACHE_CONTROL)
  if (completeBody && upstream.ok && upstream.body !== null) {
    const whole = await readWhole(upstream.body, MAX_COMPLETED_BODY_BYTES)
    if (whole.kind === 'failed') {
      return edgeJson({ error: 'origin_stream_failed' }, 502, {
        'cache-control': 'private, no-store',
      })
    }
    if (whole.kind === 'complete') {
      responseHeaders.set('content-length', String(whole.bytes.byteLength))
      return new Response(whole.bytes, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      })
    }
    // Too large to hold: hand over what was read and stream the rest, as before.
    return new Response(whole.stream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  }
  const body =
    route.kind === 'app' &&
    upstream.body !== null &&
    upstreamAbort !== undefined &&
    isEventStream(responseHeaders.get('content-type'))
      ? relayAppSseSegment(
          upstream.body,
          upstreamAbort,
          appSseSegmentMs ?? DEFAULT_APP_SSE_SEGMENT_MS,
        )
      : upstream.body
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

function isEventStream(contentType: string | null): boolean {
  return contentType !== null && /^text\/event-stream(?:;|$)/i.test(contentType.trim())
}

function relayAppSseSegment(
  upstream: ReadableStream<Uint8Array>,
  upstreamAbort: AbortController,
  segmentMs: number,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false

  const settle = (): boolean => {
    if (settled) return false
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    return true
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        if (!settle()) return
        controller.close()
        upstreamAbort.abort()
        void reader.cancel().catch(() => undefined)
      }, segmentMs)
    },
    async pull(controller) {
      try {
        const next = await reader.read()
        if (settled) return
        if (next.done) {
          settle()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        if (!settle()) return
        controller.error(error)
      }
    },
    async cancel(reason) {
      if (!settle()) return
      upstreamAbort.abort()
      await reader.cancel(reason).catch(() => undefined)
    },
  })
}

async function tryViewerAsset({
  fetchImpl,
  request,
  viewerOrigin,
}: {
  fetchImpl: FetchLike
  request: Request
  viewerOrigin: string | undefined
}): Promise<Response | null> {
  const host = (request.headers.get('host') ?? '').split(':')[0]!.toLowerCase()
  if (!PUBLISH_EDGE_HOSTS.has(host)) return null
  const url = new URL(request.url)
  if (!VIEWER_ASSET_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return null
  return proxyToViewer({
    fetchImpl,
    request,
    viewerOrigin,
    targetPath: `${url.pathname}${url.search}`,
  })
}

// Relays a request to the configured apps/web origin with every caller
// credential removed. Used by both the viewer page branch and the `/_next/*`
// asset relay; neither forwards a session, a gateway bearer, or any
// caller-supplied `x-duet-*` header.
async function proxyToViewer({
  fetchImpl,
  request,
  viewerOrigin,
  targetPath,
  cacheControl,
  viewerDescriptor,
}: {
  fetchImpl: FetchLike
  request: Request
  viewerOrigin: string | undefined
  targetPath: string
  cacheControl?: string
  viewerDescriptor?: ViewerDescriptor
}): Promise<Response> {
  if (viewerOrigin === undefined || viewerOrigin.trim().length === 0) {
    return edgeJson({ error: 'viewer_origin_unavailable' }, 502)
  }
  const target = new URL(targetPath, viewerOrigin)
  const headers = stripViewerCredentials(new Headers(request.headers))
  // Set AFTER the credential strip (which removes every caller `x-duet-*`), so
  // the edge's own validated descriptor is the only such header the viewer sees.
  // The `/_next/*` asset relay passes no descriptor.
  if (viewerDescriptor !== undefined) {
    headers.set(DUET_VIEWER_DESCRIPTOR_HEADER, serializeViewerDescriptor(viewerDescriptor))
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    body: requestBody(request),
    ...duplexFor(request),
  }
  const upstream = await fetchImpl(target.toString(), init)
  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')
  responseHeaders.delete('transfer-encoding')
  responseHeaders.set('x-robots-tag', ROBOTS_TAG)
  if (cacheControl !== undefined) responseHeaders.set('cache-control', cacheControl)
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

function stripViewerCredentials(headers: Headers): Headers {
  // Snapshot names before mutating; deleting during live iteration can skip keys.
  const duetHeaders = Array.from(headers.keys()).filter(name =>
    name.toLowerCase().startsWith('x-duet-'),
  )
  for (const name of duetHeaders) headers.delete(name)
  headers.delete('cookie')
  headers.delete('authorization')
  headers.delete('host')
  return headers
}

function viewerPageTarget(route: Extract<EdgeRoute, { kind: 'publish' }>): string {
  const upstream = new URL(route.upstreamPath, 'https://edge.local')
  const rest = upstream.pathname === '/' ? '' : upstream.pathname
  return `/publish/${route.workspaceSlug}/${route.publishSlug}${rest}${upstream.search}`
}

function resolveRequest(route: ServingRoute, viewer?: AppAccessViewer): EdgeResolveRequest {
  if (route.kind === 'app') {
    return EdgeResolveRequestSchema.parse({
      kind: 'app',
      host: route.host,
      workspaceSlug: route.workspaceSlug,
      appSlug: route.appSlug,
      viewerUserId: viewer?.userId,
      viewerAppId: viewer?.appId,
      viewerCredential: viewer?.credential,
      customBinding: route.customBinding,
    })
  }
  return EdgeResolveRequestSchema.parse({
    kind: 'publish',
    host: route.host,
    workspaceSlug: route.workspaceSlug,
    publishSlug: route.publishSlug,
  })
}

async function exchangeAppAccessGrant(
  request: Request,
  route: Extract<EdgeRoute, { kind: 'app' }>,
  edgeSecret: string,
  now: number,
): Promise<Response | null> {
  const url = new URL(request.url)
  const token = url.searchParams.get(DUET_APP_ACCESS_QUERY)
  if (token === null) return null
  const claims = await verifyAppAccessGrant(edgeSecret, token, now)
  if (
    claims === null ||
    claims.launchExpiresAt <= now ||
    claims.workspaceSlug !== route.workspaceSlug ||
    claims.appSlug !== route.appSlug
  ) {
    return edgeJson({ error: 'forbidden' }, 403)
  }
  url.searchParams.delete(DUET_APP_ACCESS_QUERY)
  const headers = new Headers({
    'cache-control': 'private, no-store',
    // This unique grant URL reaches the edge even when the clean document and
    // its assets were cached under an older policy. Clear only this app
    // origin's browser cache before the redirect; retain cookies and app storage.
    'clear-site-data': '"cache"',
    location: url.toString(),
    'referrer-policy': 'no-referrer',
    'x-robots-tag': ROBOTS_TAG,
  })
  const maxAge = Math.max(0, Math.ceil((claims.expiresAt - now) / 1_000))
  headers.append(
    'set-cookie',
    `${DUET_APP_ACCESS_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
  )
  return new Response(null, { status: 302, headers })
}

async function viewerFromAppAccess(
  request: Request,
  route: Extract<EdgeRoute, { kind: 'app' }>,
  edgeSecret: string,
  now: number,
): Promise<AppAccessViewer | undefined> {
  const queryGrant = new URL(request.url).searchParams.get(DUET_APP_ACCESS_QUERY)
  const token = queryGrant ?? readCookie(request.headers.get('cookie'), DUET_APP_ACCESS_COOKIE)
  if (token === null) return undefined
  const claims = await verifyAppAccessGrant(edgeSecret, token, now)
  if (
    claims === null ||
    claims.workspaceSlug !== route.workspaceSlug ||
    claims.appSlug !== route.appSlug
  ) {
    return undefined
  }
  return {
    userId: claims.userId,
    appId: claims.appId,
    credential: queryGrant === null ? 'cookie' : 'grant',
  }
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [candidate, ...value] = part.trim().split('=')
    if (candidate === name) return value.join('=') || null
  }
  return null
}

function withoutCookie(cookieHeader: string | null, name: string): string | null {
  const retained = (cookieHeader ?? '')
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0 && part.split('=', 1)[0] !== name)
  return retained.length === 0 ? null : retained.join('; ')
}

function originUrl(resolved: EdgeResolveResponse, route: EdgeRoute): string {
  const base = new URL(resolved.origin.httpsUrl)
  const prefix = resolved.origin.gatewayPathPrefix.replace(/\/+$/g, '')
  const upstream = new URL(route.upstreamPath, 'https://edge.local')
  base.pathname = `${prefix}${upstream.pathname}`
  base.search = upstream.search
  return base.toString()
}

async function reportFirstServedPublishPath({
  fetchImpl,
  convexSiteUrl,
  edgeSecret,
  route,
  resolved,
  response,
  mode,
}: {
  fetchImpl: FetchLike
  convexSiteUrl: string
  edgeSecret: string
  route: Extract<EdgeRoute, { kind: 'publish' }>
  resolved: EdgeResolveResponse
  response: Response
  mode: 'raw' | 'zip'
}): Promise<void> {
  if (resolved.publish?.kind !== 'folder' || response.status !== 200) return
  const nestedPath = pathnameFromUpstream(route.upstreamPath)
  if ((mode === 'raw' && nestedPath === '') || isPublishExcludedDrivePath(nestedPath)) return
  const servedPath = [resolved.publish.anchorPath, nestedPath].filter(Boolean).join('/')
  await fetchImpl(`${convexSiteUrl.replace(/\/+$/g, '')}/v1/edge/publishes/served`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [EDGE_SECRET_HEADER]: edgeSecret,
    },
    body: JSON.stringify({ publishId: resolved.publish.id, servedPath, kind: mode }),
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  }).catch(() => undefined)
}

function pathnameFromUpstream(upstreamPath: string): string {
  const pathname = new URL(upstreamPath, 'https://edge.local').pathname
  return pathname.replace(/^\/+/, '')
}

function upgradeHeaders(headers: Headers, request: Request): Headers {
  headers.set('upgrade', request.headers.get('upgrade') ?? 'websocket')
  headers.set('connection', request.headers.get('connection') ?? 'Upgrade')
  return headers
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

function isRetryableResolveStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function rejectUnknownRoute(): Response {
  return edgeJson({ error: 'misdirected_request' }, 421)
}

function edgeJson(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { 'x-robots-tag': ROBOTS_TAG, ...headers } })
}

/** Archives worth holding whole; past this a download keeps streaming. */
const MAX_COMPLETED_BODY_BYTES = 32 * 1024 * 1024

async function readWhole(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<
  | { kind: 'complete'; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'failed' }
  | { kind: 'streaming'; stream: ReadableStream<Uint8Array> }
> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>
    try {
      next = await reader.read()
    } catch {
      return { kind: 'failed' }
    }
    if (next.done) break
    chunks.push(next.value)
    total += next.value.byteLength
    if (total > maxBytes) {
      return {
        kind: 'streaming',
        stream: new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            try {
              for (;;) {
                const rest = await reader.read()
                if (rest.done) break
                controller.enqueue(rest.value)
              }
              controller.close()
            } catch (error) {
              controller.error(error)
            }
          },
          cancel: reason => reader.cancel(reason),
        }),
      }
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { kind: 'complete', bytes }
}

function pausedPage(request: Request, appName: string): Response {
  const spanish = request.headers.get('accept-language')?.toLowerCase().startsWith('es') ?? false
  return new Response(renderPausedPage(appName, spanish ? 'es-419' : 'en'), {
    status: 503,
    headers: {
      'cache-control': 'public, max-age=30, s-maxage=30',
      'content-type': 'text/html; charset=utf-8',
      vary: 'accept-language',
      'x-robots-tag': ROBOTS_TAG,
    },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createLazyEdgeApp(): { fetch: EdgeFetch } {
  let app: { fetch: EdgeFetch } | null = null
  return {
    fetch(request) {
      app ??= createEdgeApp()
      return app.fetch(request)
    },
  }
}

function isBrowserDocument(request: Request): boolean {
  if (request.method !== 'GET' || request.headers.has('x-requested-with')) return false
  const mode = request.headers.get('sec-fetch-mode')
  if (mode !== null && mode !== 'navigate') return false
  const destination = request.headers.get('sec-fetch-dest')
  return (
    destination === 'document' ||
    (destination === null &&
      /(?:^|[,; ]+)text\/html(?:[,; ]|$)/i.test(request.headers.get('accept') ?? ''))
  )
}
