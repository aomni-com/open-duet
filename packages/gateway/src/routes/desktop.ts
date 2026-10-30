import { lstat, readFile } from 'node:fs/promises'

import { Hono, type Context, type Next } from 'hono'

import {
  DesktopGrantRegistrationRequestSchema,
  FocusBrowserOwnerRequestSchema,
  DESKTOP_LOOPBACK_PORT,
  browserOwnerKey,
  desktopCredentialPathForRequest,
  desktopEntryPath,
  type DesktopPhase,
  type DesktopSessionRequest,
} from '@repo/contract'

import { createDigestGrantRegistry } from '../auth/digest-grants'
import type { BrowserBatchService } from '../desktop/browser-batches'
import type { DesktopBrowserManager } from '../desktop/browser-manager'
import type { BrowserExtensionBridge } from '../desktop/extension-bridge'
import type { DesktopLifecycle } from '../desktop/supervisor'

export interface KasmCredential {
  username: string
  password: string
}

export interface DesktopIngressOptions {
  now?: () => number
  grantCapacity?: number
  fetch?: (request: Request) => Promise<Response>
  readKasmCredential: () => Promise<KasmCredential>
  lifecycle: DesktopLifecycle
  browserBatches?: Pick<BrowserBatchService, 'start'>
  browserExtension?: Pick<BrowserExtensionBridge, 'connected' | 'request' | 'extensionId'>
  browserManager?: Pick<DesktopBrowserManager, 'inventory'> &
    Partial<Pick<DesktopBrowserManager, 'activities' | 'focusOwner'>>
  browserExtensionCrxPath?: string
}

export interface DesktopIngress {
  routes: Hono<{ Variables: DesktopRouteVariables }>
  grants: {
    put(
      id: string,
      grant: {
        tokenDigest: string
        expiresAt: number
        payload: DesktopSessionRequest
      },
    ): { ok: true } | { ok: false; error: 'capacity' }
    authorize(id: string, token: string): Promise<boolean>
  }
  authorizePath(path: string): Promise<DesktopSessionRequest | null>
  viewerCount(): number
  attachViewer(): () => void
  readKasmCredential(): Promise<KasmCredential>
}

export interface DesktopSocketData {
  kind: 'desktop'
  upstreamUrl: string
  authorization: string
  protocols: string[]
  ingress: DesktopIngress
  upstream?: DesktopUpstreamSocket
  detachViewer?: () => void
  pending: Array<string | ArrayBuffer>
  pendingBytes: number
  closed: boolean
}

export interface DesktopUpstreamSocket {
  readyState: number
  bufferedAmount: number
  binaryType: BinaryType
  onopen: (() => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: (() => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(message: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
}

const DESKTOP_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const DESKTOP_MAX_PENDING_BYTES = 1024 * 1024
// The public ceiling permits one principal to mint 1,200 grants during their
// two-minute lifetime. This leaves multi-principal headroom while bounding a
// runaway issuer, and insertion never evicts a still-live viewer capability.
const DESKTOP_GRANT_REGISTRY_CAPACITY = 4_096

interface DesktopRouteVariables {
  desktopGrant: DesktopSessionRequest
}

export async function readKasmCredentialFile(path: string): Promise<KasmCredential> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('invalid type')
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (
      typeof parsed.username !== 'string' ||
      parsed.username.length === 0 ||
      typeof parsed.password !== 'string' ||
      parsed.password.length === 0
    ) {
      throw new Error('invalid shape')
    }
    return { username: parsed.username, password: parsed.password }
  } catch {
    throw new Error('Kasm credential file is missing or invalid')
  }
}

export function desktopWebSocketHandlers(
  options: {
    connect?: (url: string, options: Bun.WebSocketOptions) => DesktopUpstreamSocket
  } = {},
): Bun.WebSocketHandler<DesktopSocketData> {
  const connect =
    options.connect ??
    ((url, connectOptions) =>
      new WebSocket(url, connectOptions as never) as unknown as DesktopUpstreamSocket)
  return {
    open(ws) {
      const data = ws.data
      data.detachViewer = data.ingress.attachViewer()
      const upstream = connect(data.upstreamUrl, {
        protocols: data.protocols,
        headers: {
          authorization: data.authorization,
          origin: webSocketHttpOrigin(data.upstreamUrl),
        },
        perMessageDeflate: false,
      })
      data.upstream = upstream
      upstream.binaryType = 'arraybuffer'
      upstream.onopen = () => {
        for (const message of data.pending) upstream.send(message)
        data.pending = []
        data.pendingBytes = 0
      }
      upstream.onmessage = event => {
        if (ws.getBufferedAmount() > DESKTOP_MAX_BUFFERED_BYTES) {
          finishDesktopRelay(ws, 1013, 'desktop viewer too slow', true)
          return
        }
        const message = event.data
        if (typeof message === 'string' || message instanceof ArrayBuffer) ws.send(message)
        else if (ArrayBuffer.isView(message)) ws.send(toArrayBuffer(message))
        else finishDesktopRelay(ws, 1003, 'unsupported upstream frame', true)
      }
      upstream.onerror = () => finishDesktopRelay(ws, 1011, 'desktop upstream error', true)
      upstream.onclose = event =>
        finishDesktopRelay(ws, event.code === 1006 ? 1011 : event.code, event.reason, true)
    },
    message(ws, message) {
      const upstream = ws.data.upstream
      if (upstream === undefined) return
      if (upstream.bufferedAmount > DESKTOP_MAX_BUFFERED_BYTES) {
        finishDesktopRelay(ws, 1013, 'desktop upstream too slow', true)
        return
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(toRelayFrame(message))
        return
      }
      const messageBytes =
        typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength
      if (ws.data.pendingBytes + messageBytes > DESKTOP_MAX_PENDING_BYTES) {
        finishDesktopRelay(ws, 1013, 'desktop upstream unavailable', true)
        return
      }
      ws.data.pending.push(toRelayFrame(message))
      ws.data.pendingBytes += messageBytes
    },
    close(ws, code, reason) {
      finishDesktopRelay(ws, code, reason, false)
    },
  }
}

function webSocketHttpOrigin(url: string): string {
  const origin = new URL(url)
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:'
  return origin.origin
}

function toRelayFrame(message: string | Buffer): string | ArrayBuffer {
  if (typeof message === 'string') return message
  return message.buffer.slice(
    message.byteOffset,
    message.byteOffset + message.byteLength,
  ) as ArrayBuffer
}

function toArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

function finishDesktopRelay(
  ws: Bun.ServerWebSocket<DesktopSocketData>,
  code: number,
  reason: string,
  closeDownstream: boolean,
): void {
  const data = ws.data
  if (data.closed) return
  data.closed = true
  data.detachViewer?.()
  data.detachViewer = undefined
  data.pending = []
  data.pendingBytes = 0
  const safeCode = code >= 1000 && code !== 1005 && code !== 1006 ? code : 1011
  data.upstream?.close(safeCode, reason.slice(0, 123))
  if (closeDownstream) ws.close(safeCode, reason.slice(0, 123))
}

export function createDesktopIngress(options: DesktopIngressOptions): DesktopIngress {
  const now = options.now ?? Date.now
  const request = options.fetch ?? fetch
  const grants = createDigestGrantRegistry<DesktopSessionRequest>({
    now,
    capacity: options.grantCapacity ?? DESKTOP_GRANT_REGISTRY_CAPACITY,
  })
  const routes = new Hono<{ Variables: DesktopRouteVariables }>()
  const focusRequests = new Map<string, { ownerKey: string; result: Promise<boolean> }>()

  routes.post('/grants', async c => {
    const body = DesktopGrantRegistrationRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    let phase: DesktopPhase
    try {
      phase = await options.lifecycle.ensureStarted()
    } catch {
      return c.json({ error: 'desktop_start_failed' }, 503)
    }
    const put = grants.put(body.data.grantId, {
      tokenDigest: body.data.tokenDigest,
      expiresAt: body.data.expiresAt,
      payload: { embedOrigin: body.data.embedOrigin },
    })
    if (!put.ok) return c.json({ error: 'desktop_unavailable' }, 503, { 'retry-after': '1' })
    return c.json({
      entryPath: desktopEntryPath(body.data.grantId),
      phase,
    })
  })

  routes.get('/status', c =>
    c.json({
      phase: options.lifecycle.phase(),
      viewers: options.lifecycle.viewerCount(),
      owners: options.browserManager?.activities?.() ?? [],
    }),
  )

  routes.get('/browser-extension/update.xml', c => {
    const extensionId = options.browserExtension?.extensionId
    if (extensionId === undefined || extensionId === null) {
      return c.json({ error: 'browser_extension_unavailable' }, 503)
    }
    return c.body(
      `<?xml version="1.0"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${extensionId}"><updatecheck codebase="http://127.0.0.1:3000/v1/desktop/browser-extension/extension.crx" version="1.0.0"/></app></gupdate>`,
      200,
      { 'content-type': 'application/xml' },
    )
  })

  routes.get('/browser-extension/extension.crx', async c => {
    const path = options.browserExtensionCrxPath ?? '/opt/duet/browser-extension/extension.crx'
    try {
      return c.body(await readFile(path), 200, {
        'content-type': 'application/x-chrome-extension',
      })
    } catch {
      return c.json({ error: 'browser_extension_unavailable' }, 503)
    }
  })

  routes.get('/browser-extension/status', async c => {
    if (options.browserExtension?.connected() !== true) {
      return c.json({ connected: false }, 503)
    }
    try {
      const snapshot = await options.browserExtension.request({ command: 'snapshot' })
      return c.json({ connected: true, snapshot })
    } catch {
      return c.json({ connected: false }, 503)
    }
  })

  routes.get('/browser/windows/inventory', c => {
    if (options.browserManager === undefined) return c.json({ error: 'browser_unavailable' }, 503)
    return c.json(options.browserManager.inventory())
  })

  routes.post('/browser/windows/focus', async c => {
    const focusOwner = options.browserManager?.focusOwner
    if (focusOwner === undefined) return c.json({ error: 'browser_unavailable' }, 503)
    const body = FocusBrowserOwnerRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const ownerKey = browserOwnerKey(body.data.owner)
    const prior = focusRequests.get(body.data.requestId)
    if (prior !== undefined && prior.ownerKey !== ownerKey) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const result = prior?.result ?? Promise.resolve().then(() => focusOwner(body.data.owner))
    if (prior === undefined) {
      focusRequests.set(body.data.requestId, { ownerKey, result })
      if (focusRequests.size > 256) {
        const oldest = focusRequests.keys().next().value
        if (oldest !== undefined) focusRequests.delete(oldest)
      }
    }
    try {
      return c.json({ focused: await result })
    } catch {
      return c.json({ focused: false })
    }
  })

  routes.post('/browser/batches', async c => {
    const body = await readJson(c.req.raw)
    if (!isBrowserSessionRequest(body)) return c.json({ error: 'invalid_request' }, 400)
    if (options.browserBatches === undefined) return c.json({ error: 'browser_unavailable' }, 503)
    try {
      return c.json(await options.browserBatches.start(body.sessionId))
    } catch (error) {
      if (hasErrorCode(error, 'browser_session_not_found')) {
        return c.json({ error: 'browser_session_not_found' }, 404)
      }
      if (hasErrorCode(error, 'browser_owner_unavailable')) {
        return c.json({ error: 'browser_owner_unavailable', retryable: true }, 503)
      }
      if (
        hasErrorCode(error, 'browser_capacity') &&
        error.retryable === true &&
        typeof error.retryAfterMs === 'number'
      ) {
        return c.json(
          {
            error: 'browser_capacity',
            retryable: true,
            retryAfterMs: error.retryAfterMs,
          },
          429,
        )
      }
      return c.json({ error: 'browser_unavailable' }, 503)
    }
  })

  routes.use('/:credential', admitProxyRequest)
  routes.use('/:credential/*', admitProxyRequest)
  routes.all('/:credential', proxyRequest)
  routes.all('/:credential/*', proxyRequest)

  return {
    routes,
    grants,
    async authorizePath(path: string): Promise<DesktopSessionRequest | null> {
      const credential = desktopCredentialPathForRequest(path)
      if (credential === null) return null
      return (await grants.authorizeGrant(credential.grantId, credential.token))?.payload ?? null
    },
    viewerCount(): number {
      return options.lifecycle.viewerCount()
    },
    attachViewer(): () => void {
      return options.lifecycle.viewerAttached()
    },
    readKasmCredential: options.readKasmCredential,
  }

  async function admitProxyRequest(c: Context<{ Variables: DesktopRouteVariables }>, next: Next) {
    const credential = desktopCredentialPathForRequest(new URL(c.req.url).pathname)
    if (credential === null) return c.json({ error: 'not_found' }, 404)
    const grant = await grants.authorizeGrant(credential.grantId, credential.token)
    if (grant === undefined) return c.json({ error: 'unauthorized' }, 401)
    c.set('desktopGrant', grant.payload)
    await next()
  }

  async function proxyRequest(c: Context<{ Variables: DesktopRouteVariables }>) {
    const incoming = new URL(c.req.url)
    const credential = desktopCredentialPathForRequest(incoming.pathname)
    if (credential === null) return c.json({ error: 'not_found' }, 404)
    const grant = c.get('desktopGrant')
    const localCredential = await options.readKasmCredential()
    const upstreamUrl = new URL(credential.tail, `http://127.0.0.1:${DESKTOP_LOOPBACK_PORT}`)
    upstreamUrl.search = incoming.search
    const headers = proxyRequestHeaders(c.req.raw.headers)
    headers.set(
      'authorization',
      `Basic ${Buffer.from(`${localCredential.username}:${localCredential.password}`).toString('base64')}`,
    )
    const method = c.req.method
    const response = await request(
      new Request(upstreamUrl, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : c.req.raw.body,
        signal: c.req.raw.signal,
      }),
    )
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: proxyResponseHeaders(response.headers, grant.embedOrigin),
    })
  }
}

function hasErrorCode(
  error: unknown,
  code: string,
): error is Error & { code: string; retryable?: unknown; retryAfterMs?: unknown } {
  return error instanceof Error && (error as Error & { code?: unknown }).code === code
}

function isBrowserSessionRequest(value: unknown): value is { sessionId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
    (value as { sessionId: string }).sessionId.trim().length > 0
  )
}

export async function handleDesktopUpgrade(
  request: Request,
  server: Bun.Server<DesktopSocketData>,
  ingress: DesktopIngress,
): Promise<Response | null | undefined> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return null
  const url = new URL(request.url)
  const credential = desktopCredentialPathForRequest(url.pathname)
  if (credential === null) return null
  if ((await ingress.authorizePath(url.pathname)) === null) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const localCredential = await ingress.readKasmCredential()
  const protocols = (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map(protocol => protocol.trim())
    .filter(protocol => protocol.length > 0)
  const upstream = new URL(credential.tail, `ws://127.0.0.1:${DESKTOP_LOOPBACK_PORT}`)
  upstream.search = url.search
  const upgraded = server.upgrade(request, {
    data: {
      kind: 'desktop',
      upstreamUrl: upstream.toString(),
      authorization: `Basic ${Buffer.from(`${localCredential.username}:${localCredential.password}`).toString('base64')}`,
      protocols,
      ingress,
      pending: [],
      pendingBytes: 0,
      closed: false,
    },
    ...(protocols[0] === undefined ? {} : { headers: { 'sec-websocket-protocol': protocols[0] } }),
  })
  return upgraded ? undefined : new Response('upgrade failed', { status: 400 })
}

const REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'range',
  'user-agent',
])

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function proxyRequestHeaders(incoming: Headers): Headers {
  const outgoing = new Headers()
  for (const [name, value] of incoming) {
    if (REQUEST_HEADERS.has(name.toLowerCase())) outgoing.set(name, value)
  }
  return outgoing
}

function proxyResponseHeaders(incoming: Headers, embedOrigin: string): Headers {
  const outgoing = new Headers()
  for (const [name, value] of incoming) {
    const normalized = name.toLowerCase()
    if (
      !HOP_BY_HOP_HEADERS.has(normalized) &&
      normalized !== 'content-encoding' &&
      normalized !== 'content-security-policy' &&
      normalized !== 'x-frame-options'
    ) {
      outgoing.append(name, value)
    }
  }
  outgoing.set('content-security-policy', `frame-ancestors ${embedOrigin}`)
  outgoing.set('cache-control', 'private, no-store')
  outgoing.set('referrer-policy', 'no-referrer')
  return outgoing
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}
