import { Buffer } from 'node:buffer'

import {
  BROWSER_SESSION_ROTATE_BEFORE_MS,
  BrowserSessionCredentialSchema,
  type BrowserSessionCredential,
} from '@repo/contract'

import { clearPendingShareCookie } from '../auth/pending-share'
import { reportRequestFailure } from './request-failure'

const SESSION_COOKIE = 'duet_session'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const BLOCKED_REQUEST_HEADERS = new Set([
  'authorization',
  'cf-connecting-ip',
  'connection',
  'cookie',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
  'x-real-ip',
])
const BLOCKED_RESPONSE_HEADERS = new Set([
  'cdn-cache-control',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'surrogate-control',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'vercel-cdn-cache-control',
])

export interface BrowserSessionService {
  mint(): Promise<BrowserSessionCredential>
  // Null when a concurrent request already rotated `previousToken`: the
  // browser is receiving that replacement and the previous credential stays
  // valid meanwhile, so the caller carries on with it and sets no cookie.
  rotate(previousToken: string): Promise<BrowserSessionCredential | null>
  revoke(token: string): Promise<void>
}

export class BrowserSessionAuthenticationError extends Error {
  override readonly name = 'BrowserSessionAuthenticationError'
}

export interface DuetProxyOptions {
  apiOrigin: string
  browserSessions: BrowserSessionService
  fetch?: (request: Request) => Promise<Response>
  now?: () => number
}

export function createDuetProxy(options: DuetProxyOptions) {
  const apiOrigin = options.apiOrigin.replace(/\/+$/, '')
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now

  return {
    async exchange(request: Request): Promise<Response> {
      const csrfFailure = validateUnsafeRequest(request)
      if (csrfFailure !== null) return privateNoStore(csrfFailure)
      const current = readSessionCookie(request.headers.get('cookie'))
      try {
        const session =
          current === null
            ? await options.browserSessions.mint()
            : await options.browserSessions.rotate(current.token)
        return privateNoStore(
          withSessionCookie(new Response(null, { status: 204 }), session, now()),
        )
      } catch (error) {
        if (!(error instanceof BrowserSessionAuthenticationError)) {
          reportRequestFailure(request, 'session_exchange_failed', error)
        }
        return privateNoStore(sessionExchangeFailure(error, current !== null))
      }
    },

    async logout(request: Request): Promise<Response> {
      const csrfFailure = validateUnsafeRequest(request)
      if (csrfFailure !== null) return privateNoStore(csrfFailure)
      const current = readSessionCookie(request.headers.get('cookie'))
      if (current !== null) {
        try {
          await options.browserSessions.revoke(current.token)
        } catch (error) {
          if (!(error instanceof BrowserSessionAuthenticationError)) {
            reportRequestFailure(request, 'session_revoke_failed', error)
          }
          const response = Response.json({ error: 'session_revoke_failed' }, { status: 502 })
          response.headers.append('set-cookie', clearSessionCookie())
          return privateNoStore(response)
        }
      }
      const response = new Response(null, { status: 204 })
      response.headers.append('set-cookie', clearSessionCookie())
      return privateNoStore(response)
    },

    async proxy(
      request: Request,
      path: string[] = decodeProxyRequestPath(request.url) ?? [],
    ): Promise<Response> {
      const csrfFailure = validateUnsafeRequest(request)
      if (csrfFailure !== null) return privateNoStore(csrfFailure)
      if (path.length === 0 || path.some(segment => segment === '.' || segment === '..')) {
        return privateNoStore(Response.json({ error: 'invalid_proxy_path' }, { status: 400 }))
      }

      const current = readSessionCookie(request.headers.get('cookie'))
      let session: BrowserSessionCredential
      let setCookie = false
      const requestNow = now()
      if (current === null) {
        try {
          session = await options.browserSessions.mint()
          setCookie = true
        } catch (error) {
          if (!(error instanceof BrowserSessionAuthenticationError)) {
            reportRequestFailure(request, 'session_exchange_failed', error)
          }
          return privateNoStore(sessionExchangeFailure(error, false))
        }
      } else if (current.expiresAt <= requestNow + BROWSER_SESSION_ROTATE_BEFORE_MS) {
        try {
          const rotated = await options.browserSessions.rotate(current.token)
          session = rotated ?? current
          setCookie = rotated !== null
        } catch (error) {
          if (!(error instanceof BrowserSessionAuthenticationError)) {
            reportRequestFailure(request, 'session_rotation_failed', error)
          }
          if (
            current.expiresAt <= requestNow ||
            error instanceof BrowserSessionAuthenticationError
          ) {
            return privateNoStore(sessionExchangeFailure(error, true))
          }
          session = current
        }
      } else {
        session = current
      }

      const requestUrl = new URL(request.url)
      const upstreamUrl = new URL(
        `/v1/${path.map(segment => encodeURIComponent(segment)).join('/')}${requestUrl.search}`,
        apiOrigin,
      )
      const headers = proxyRequestHeaders(request.headers, session.token)
      const init: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers,
        signal: request.signal,
        cache: 'no-store',
        redirect: 'manual',
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body
        init.duplex = 'half'
      }

      let upstream: Response
      try {
        upstream = await fetchImpl(new Request(upstreamUrl, init))
      } catch (error) {
        if (request.signal.aborted) throw error
        reportRequestFailure(request, 'upstream_unavailable', error)
        return privateNoStore(
          withSessionCookie(
            Response.json({ error: 'upstream_unavailable' }, { status: 502 }),
            setCookie ? session : null,
            now(),
          ),
        )
      }
      const response = new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: proxyResponseHeaders(upstream.headers, upstream.body !== null),
      })
      if (upstream.ok && consumesPendingShare(request.method, path)) {
        response.headers.append('set-cookie', clearPendingShareCookie())
      }
      const impersonation = await officialHubImpersonationCredential(request.method, path, response)
      const responseWithSession = withSessionCookie(
        response,
        impersonation ?? (setCookie ? session : null),
        now(),
      )
      return preservesWorkspaceFileCacheControl(request.method, path, response.headers)
        ? responseWithSession
        : privateNoStore(responseWithSession)
    },
  }
}

function decodeProxyRequestPath(url: string): string[] | null {
  const withoutScheme = url.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/[^/]*/, '')
  const queryStart = withoutScheme.search(/[?#]/)
  const pathname = queryStart === -1 ? withoutScheme : withoutScheme.slice(0, queryStart)
  const prefix = '/api/duet/'
  if (!pathname.startsWith(prefix)) return null
  const rawPath = pathname.slice(prefix.length)
  if (rawPath.length === 0) return null

  try {
    return rawPath.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    return null
  }
}

async function officialHubImpersonationCredential(
  method: string,
  path: string[],
  response: Response,
): Promise<BrowserSessionCredential | null> {
  if (
    !response.ok ||
    method !== 'POST' ||
    path.length !== 3 ||
    path[0] !== 'internal-admin' ||
    path[1] !== 'official-hub' ||
    path[2] !== 'access'
  )
    return null
  try {
    return BrowserSessionCredentialSchema.parse(await response.clone().json())
  } catch {
    return null
  }
}

function preservesWorkspaceFileCacheControl(
  method: string,
  path: string[],
  headers: Headers,
): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    path.length >= 4 &&
    path[0] === 'ws' &&
    path[2] === 'files' &&
    headers.has('cache-control')
  )
}

function consumesPendingShare(method: string, path: string[]): boolean {
  return (
    method === 'POST' &&
    path.length === 3 &&
    path[0] === 'share-requests' &&
    (path[2] === 'accept' || path[2] === 'decline')
  )
}

export function validateUnsafeRequest(request: Request): Response | null {
  if (SAFE_METHODS.has(request.method)) return null
  const requestOrigin = new URL(request.url).origin
  if (request.headers.get('origin') !== requestOrigin) {
    return privateNoStore(Response.json({ error: 'cross_origin_request' }, { status: 403 }))
  }
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite !== null && fetchSite !== 'same-origin') {
    return privateNoStore(Response.json({ error: 'cross_site_request' }, { status: 403 }))
  }
  return null
}

function proxyRequestHeaders(source: Headers, token: string): Headers {
  const connectionHeaders = commaSeparatedHeaderNames(source.get('connection'))
  const headers = new Headers()
  for (const [name, value] of source) {
    if (
      BLOCKED_REQUEST_HEADERS.has(name) ||
      name.startsWith('x-forwarded-') ||
      connectionHeaders.has(name)
    )
      continue
    headers.append(name, value)
  }
  headers.set('authorization', `Bearer ${token}`)
  headers.set('accept-encoding', 'identity')
  return headers
}

function proxyResponseHeaders(source: Headers, hasFetchedBody: boolean): Headers {
  const connectionHeaders = commaSeparatedHeaderNames(source.get('connection'))
  const fetchedBodyWasDecoded = hasFetchedBody && source.has('content-encoding')
  const headers = new Headers()
  for (const [name, value] of source) {
    if (
      BLOCKED_RESPONSE_HEADERS.has(name) ||
      connectionHeaders.has(name) ||
      (fetchedBodyWasDecoded && (name === 'content-encoding' || name === 'content-length'))
    )
      continue
    headers.append(name, value)
  }
  return headers
}

function commaSeparatedHeaderNames(value: string | null): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map(name => name.trim().toLowerCase())
      .filter(Boolean),
  )
}

function readSessionCookie(cookieHeader: string | null): BrowserSessionCredential | null {
  const value = (cookieHeader ?? '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1)
  if (value === undefined || value.length === 0) return null
  try {
    return BrowserSessionCredentialSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    )
  } catch {
    return null
  }
}

function withSessionCookie(
  response: Response,
  session: BrowserSessionCredential | null,
  now: number,
): Response {
  if (session === null) return response
  response.headers.append('set-cookie', serializeSessionCookie(session, now))
  return response
}

function serializeSessionCookie(session: BrowserSessionCredential, now: number): string {
  const value = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')
  const maxAge = Math.max(0, Math.ceil((session.expiresAt - now) / 1000))
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

function unauthorizedResponse(clearCookie: boolean): Response {
  const response = Response.json({ error: 'unauthorized' }, { status: 401 })
  if (clearCookie) {
    response.headers.append('set-cookie', clearSessionCookie())
  }
  return response
}

function sessionExchangeFailure(error: unknown, clearCookie: boolean): Response {
  if (error instanceof BrowserSessionAuthenticationError) {
    return unauthorizedResponse(clearCookie)
  }
  return Response.json({ error: 'session_exchange_failed' }, { status: 502 })
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

function privateNoStore(response: Response): Response {
  response.headers.set('cache-control', 'private, no-store')
  return response
}
