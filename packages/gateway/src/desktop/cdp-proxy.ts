import { randomBytes, randomUUID } from 'node:crypto'

import { DESKTOP_GRANT_TTL_MS, tunnelTokenDigest } from '@repo/contract'

import { createDigestGrantRegistry } from '../auth/digest-grants'
import type { DesktopBrowserManager } from './browser-manager'

type BatchTabCreator = Pick<DesktopBrowserManager, 'createBatchTab'> &
  Partial<
    Pick<
      DesktopBrowserManager,
      | 'attributePopup'
      | 'removeBatchTarget'
      | 'openBatchLease'
      | 'closeBatchLease'
      | 'touchBatchLease'
    >
  >

export interface DesktopCdpUpstreamSocket {
  readyState: number
  bufferedAmount: number
  onopen: (() => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: (() => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(message: string): void
  close(code?: number, reason?: string): void
}

export interface DesktopCdpSocketData {
  kind: 'desktop-cdp'
  upstreamUrl: string
  batchId: string
  manager: BatchTabCreator
  upstream?: DesktopCdpUpstreamSocket
  pending: string[]
  pendingBytes: number
  operation: Promise<void>
  closed: boolean
}

const CDP_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const CDP_MAX_PENDING_BYTES = 1024 * 1024

const CDP_GRANT_PREFIX = '/v1/desktop/browser/cdp/'

export function createCdpGrantRegistry(options: {
  now: () => number
  createGrantId?: () => string
  createToken?: () => string
  gatewayOrigin?: string
}) {
  const grants = createDigestGrantRegistry<{
    batchId: string
    browserGeneration: string
  }>({ now: options.now })
  const createGrantId = options.createGrantId ?? randomUUID
  const createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'))
  const gatewayOrigin = options.gatewayOrigin ?? 'ws://127.0.0.1:3000'

  return {
    async mint(payload: { batchId: string; browserGeneration: string }): Promise<{
      webSocketDebuggerUrl: string
      expiresAt: number
    }> {
      const grantId = createGrantId()
      const token = createToken()
      const expiresAt = options.now() + DESKTOP_GRANT_TTL_MS
      grants.put(grantId, {
        tokenDigest: await tunnelTokenDigest(token),
        expiresAt,
        payload,
      })
      return {
        webSocketDebuggerUrl: `${gatewayOrigin}${CDP_GRANT_PREFIX}${encodeURIComponent(grantId)}.${token}`,
        expiresAt,
      }
    },
    async consume(path: string): Promise<{
      batchId: string
      browserGeneration: string
    } | null> {
      const credential = cdpCredentialForPath(path)
      if (credential === null) return null
      if (!(await grants.authorize(credential.grantId, credential.token))) return null
      const grant = grants.get(credential.grantId)
      grants.delete(credential.grantId)
      return grant?.payload ?? null
    },
  }
}

function cdpCredentialForPath(path: string): { grantId: string; token: string } | null {
  if (!path.startsWith(CDP_GRANT_PREFIX)) return null
  const credential = path.slice(CDP_GRANT_PREFIX.length)
  if (credential.includes('/')) return null
  const separator = credential.lastIndexOf('.')
  if (separator <= 0) return null
  try {
    const grantId = decodeURIComponent(credential.slice(0, separator))
    const token = credential.slice(separator + 1)
    if (
      grantId.length === 0 ||
      grantId.includes('/') ||
      grantId.includes('..') ||
      !/^[A-Za-z0-9_-]+$/.test(token)
    ) {
      return null
    }
    return { grantId, token }
  } catch {
    return null
  }
}

export type CdpClientMessageResult =
  | { kind: 'forward'; message: string }
  | { kind: 'reply'; message: string }

export async function processCdpClientMessage(
  message: string,
  batchId: string,
  manager: BatchTabCreator,
): Promise<CdpClientMessageResult> {
  const command = parseCommand(message)
  if (command === null) return { kind: 'forward', message }

  if (command.method === 'Target.createBrowserContext') {
    return {
      kind: 'reply',
      message: JSON.stringify({
        id: command.id,
        ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
        error: {
          code: -32000,
          message: 'Duet uses one shared default browser context',
        },
      }),
    }
  }
  if (command.method !== 'Target.createTarget') return { kind: 'forward', message }

  const url =
    isRecord(command.params) && typeof command.params.url === 'string'
      ? command.params.url
      : 'about:blank'
  try {
    const created = await manager.createBatchTab(batchId, url)
    return {
      kind: 'reply',
      message: JSON.stringify({
        id: command.id,
        ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
        result: { targetId: created.targetId },
      }),
    }
  } catch (error) {
    return {
      kind: 'reply',
      message: JSON.stringify({
        id: command.id,
        ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Duet could not create the tab',
        },
      }),
    }
  }
}

export function desktopCdpWebSocketHandlers(
  options: {
    connect?: (url: string) => DesktopCdpUpstreamSocket
  } = {},
): Bun.WebSocketHandler<DesktopCdpSocketData> {
  const connect =
    options.connect ?? (url => new WebSocket(url) as unknown as DesktopCdpUpstreamSocket)
  return {
    open(ws) {
      ws.data.operation = ws.data.operation.then(() =>
        ws.data.manager.openBatchLease?.(ws.data.batchId),
      )
      const upstream = connect(ws.data.upstreamUrl)
      ws.data.upstream = upstream
      upstream.onopen = () => {
        for (const message of ws.data.pending) upstream.send(message)
        ws.data.pending = []
        ws.data.pendingBytes = 0
      }
      upstream.onmessage = event => {
        if (ws.getBufferedAmount() > CDP_MAX_BUFFERED_BYTES) {
          finishCdpRelay(ws, 1013, 'CDP client too slow', true)
          return
        }
        if (typeof event.data !== 'string') {
          finishCdpRelay(ws, 1003, 'unsupported Chrome CDP frame', true)
          return
        }
        void observeCdpBrowserMessage(event.data, ws.data.batchId, ws.data.manager).catch(
          () => undefined,
        )
        ws.send(event.data)
      }
      upstream.onerror = () => finishCdpRelay(ws, 1011, 'Chrome CDP error', true)
      upstream.onclose = event =>
        finishCdpRelay(ws, event.code === 1006 ? 1011 : event.code, event.reason, true)
    },
    message(ws, frame) {
      if (typeof frame !== 'string') {
        finishCdpRelay(ws, 1003, 'CDP requires text frames', true)
        return
      }
      ws.data.operation = ws.data.operation
        .then(async () => {
          if (ws.data.closed) return
          ws.data.manager.touchBatchLease?.(ws.data.batchId)
          const result = await processCdpClientMessage(frame, ws.data.batchId, ws.data.manager)
          if (result.kind === 'reply') {
            ws.send(result.message)
            return
          }
          sendOrQueueUpstream(ws, result.message)
        })
        .catch(() => finishCdpRelay(ws, 1011, 'CDP proxy failed', true))
    },
    close(ws, code, reason) {
      finishCdpRelay(ws, code, reason, false)
    },
  }
}

export async function observeCdpBrowserMessage(
  message: string,
  batchId: string,
  manager: BatchTabCreator,
): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(message) as unknown
  } catch {
    return
  }
  if (!isRecord(parsed) || !isRecord(parsed.params)) return
  if (parsed.method === 'Target.targetDestroyed') {
    if (typeof parsed.params.targetId === 'string') {
      await manager.removeBatchTarget?.(batchId, parsed.params.targetId)
    }
    return
  }
  if (parsed.method === 'Target.targetCreated' && manager.attributePopup !== undefined) {
    const target = parsed.params.targetInfo
    if (
      isRecord(target) &&
      target.type === 'page' &&
      typeof target.targetId === 'string' &&
      typeof target.openerId === 'string'
    ) {
      await manager.attributePopup(batchId, target.targetId, target.openerId)
    }
  }
}

function sendOrQueueUpstream(ws: Bun.ServerWebSocket<DesktopCdpSocketData>, message: string): void {
  const upstream = ws.data.upstream
  if (upstream === undefined) return
  if (upstream.bufferedAmount > CDP_MAX_BUFFERED_BYTES) {
    finishCdpRelay(ws, 1013, 'Chrome CDP too slow', true)
    return
  }
  if (upstream.readyState === WebSocket.OPEN) {
    upstream.send(message)
    return
  }
  const bytes = Buffer.byteLength(message)
  if (ws.data.pendingBytes + bytes > CDP_MAX_PENDING_BYTES) {
    finishCdpRelay(ws, 1013, 'Chrome CDP unavailable', true)
    return
  }
  ws.data.pending.push(message)
  ws.data.pendingBytes += bytes
}

function finishCdpRelay(
  ws: Bun.ServerWebSocket<DesktopCdpSocketData>,
  code: number,
  reason: string,
  closeDownstream: boolean,
): void {
  if (ws.data.closed) return
  ws.data.closed = true
  ws.data.pending = []
  ws.data.pendingBytes = 0
  const safeCode = code >= 1000 && code !== 1005 && code !== 1006 ? code : 1011
  ws.data.upstream?.close(safeCode, reason.slice(0, 123))
  ws.data.operation = ws.data.operation
    .then(() => ws.data.manager.closeBatchLease?.(ws.data.batchId))
    .then(
      () => undefined,
      () => undefined,
    )
  if (closeDownstream) ws.close(safeCode, reason.slice(0, 123))
}

export async function handleDesktopCdpUpgrade(
  request: Request,
  server: Bun.Server<DesktopCdpSocketData>,
  options: {
    grants: {
      consume(path: string): Promise<{
        batchId: string
        browserGeneration: string
      } | null>
    }
    discoverUpstream(): Promise<string>
    manager: BatchTabCreator
  },
): Promise<Response | null | undefined> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return null
  const path = new URL(request.url).pathname
  if (!path.startsWith(CDP_GRANT_PREFIX)) return null
  const payload = await options.grants.consume(path)
  if (payload === null) return Response.json({ error: 'unauthorized' }, { status: 401 })
  let upstreamUrl: string
  try {
    upstreamUrl = await options.discoverUpstream()
  } catch {
    return Response.json({ error: 'browser_unavailable' }, { status: 503 })
  }
  if (browserGenerationForWebSocket(upstreamUrl) !== payload.browserGeneration) {
    return Response.json({ error: 'browser_generation_changed' }, { status: 409 })
  }
  const upgraded = server.upgrade(request, {
    data: {
      kind: 'desktop-cdp',
      upstreamUrl,
      batchId: payload.batchId,
      manager: options.manager,
      pending: [],
      pendingBytes: 0,
      operation: Promise.resolve(),
      closed: false,
    },
  })
  return upgraded ? undefined : new Response('upgrade failed', { status: 400 })
}

function browserGenerationForWebSocket(url: string): string | null {
  try {
    const parsed = new URL(url)
    const prefix = '/devtools/browser/'
    return parsed.pathname.startsWith(prefix) && parsed.pathname.length > prefix.length
      ? decodeURIComponent(parsed.pathname.slice(prefix.length))
      : null
  } catch {
    return null
  }
}

function parseCommand(value: string): {
  id: number
  method: string
  params?: unknown
  sessionId?: string
} | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      !isRecord(parsed) ||
      typeof parsed.id !== 'number' ||
      !Number.isSafeInteger(parsed.id) ||
      typeof parsed.method !== 'string' ||
      (parsed.sessionId !== undefined && typeof parsed.sessionId !== 'string')
    ) {
      return null
    }
    return {
      id: parsed.id,
      method: parsed.method,
      ...(parsed.params === undefined ? {} : { params: parsed.params }),
      ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
