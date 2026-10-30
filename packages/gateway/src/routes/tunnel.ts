import { connect, type Socket } from 'node:net'

import { Hono } from 'hono'

import { TUNNEL_TOKEN_HEADER, extractBearerToken } from '@repo/contract'
import {
  DEFAULT_MAX_BUFFERED_BYTES,
  createBoundedSocketWriter,
  decodeTunnelFrame,
  encodeTunnelFrame,
  type BoundedSocketWriter,
} from '@repo/sync-tunnel'

import { createDigestGrantRegistry } from '../auth/digest-grants'

type ServerWebSocket = Bun.ServerWebSocket<TunnelSocketData>

interface TunnelAcceptConfig {
  acceptId: string
  machineId?: string
  targetHost: string
  targetPort: number
  tokenDigest: string
  expiresAt: number
}

export interface TunnelSocketData {
  kind: 'tunnel'
  config: TunnelAcceptConfig
  socket?: Socket
  socketWriter?: BoundedSocketWriter
  limitLogged?: boolean
}

export interface TunnelAcceptRegistry {
  replace(
    desired: Array<{
      acceptId: string
      targetPort: number
      tokenDigest: string
      expiresAt: number
    }>,
  ): { changed: number }
  registerMirror(config: {
    machineId: string
    acceptId: string
    tokenDigest: string
    expiresAt: number
  }): void
  removeMirrorMachine(machineId: string): void
  get(acceptId: string): TunnelAcceptConfig | undefined
  authorize(acceptId: string, token: string): Promise<boolean>
}

export function createTunnelAcceptRegistry(
  options: { now?: () => number } = {},
): TunnelAcceptRegistry {
  const now = options.now ?? Date.now
  const railAccepts = createDigestGrantRegistry<TunnelAcceptConfig>({ now })
  const mirrorAccepts = createDigestGrantRegistry<TunnelAcceptConfig>({ now })
  const railAcceptIds = new Set<string>()
  return {
    replace(desired) {
      let changed = 0
      const desiredIds = new Set(desired.map(config => config.acceptId))
      for (const acceptId of railAcceptIds) {
        if (desiredIds.has(acceptId)) continue
        railAccepts.delete(acceptId)
        railAcceptIds.delete(acceptId)
        changed += 1
      }
      for (const config of desired) {
        const next = { ...config, targetHost: '127.0.0.1' }
        const existing = railAccepts.get(config.acceptId)?.payload
        if (
          existing?.targetPort === next.targetPort &&
          existing.tokenDigest === next.tokenDigest &&
          existing.expiresAt === next.expiresAt
        ) {
          continue
        }
        railAccepts.put(config.acceptId, {
          tokenDigest: next.tokenDigest,
          expiresAt: next.expiresAt,
          payload: next,
        })
        railAcceptIds.add(config.acceptId)
        changed += 1
      }
      return { changed }
    },
    registerMirror(config) {
      mirrorAccepts.put(config.acceptId, {
        tokenDigest: config.tokenDigest,
        expiresAt: config.expiresAt,
        payload: {
          ...config,
          targetHost: '127.0.0.1',
          targetPort: 22_000,
        },
      })
    },
    removeMirrorMachine(machineId) {
      mirrorAccepts.deleteWhere(config => config.machineId === machineId)
    },
    get(acceptId) {
      if (railAcceptIds.has(acceptId)) {
        const railAccept = railAccepts.get(acceptId)
        if (railAccept !== undefined) return railAccept.payload
        railAcceptIds.delete(acceptId)
        return undefined
      }
      return mirrorAccepts.get(acceptId)?.payload
    },
    async authorize(acceptId, token) {
      const config = this.get(acceptId)
      if (config === undefined) return false
      const owner = railAcceptIds.has(acceptId) ? railAccepts : mirrorAccepts
      return await owner.authorize(acceptId, token)
    },
  }
}

export function createMirrorTunnelRoutes(options: {
  accepts: TunnelAcceptRegistry
  getVmToken: () => Promise<string | null>
}): Hono {
  const app = new Hono()
  app.post('/mirror-accept', async c => {
    if (!(await authenticateVm(c.req.raw, options.getVmToken))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const body = await readJson(c.req.raw)
    if (!isMirrorAcceptRequest(body)) return c.json({ error: 'invalid_request' }, 400)
    options.accepts.registerMirror(body)
    return c.json({
      ok: true,
      acceptId: body.acceptId,
      urlPath: `/v1/tunnel/accept/${body.acceptId}`,
      expiresAt: body.expiresAt,
    })
  })
  return app
}

export async function handleTunnelUpgrade(
  request: Request,
  server: Bun.Server<TunnelSocketData>,
  accepts: TunnelAcceptRegistry,
): Promise<Response | null | undefined> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/v1\/tunnel\/accept\/([^/]+)$/)
  if (match === null) return null
  const config = accepts.get(match[1]!)
  if (config === undefined) return Response.json({ error: 'not_found' }, { status: 404 })
  const token = request.headers.get(TUNNEL_TOKEN_HEADER)
  if (token === null || !(await accepts.authorize(config.acceptId, token))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const upgraded = server.upgrade(request, { data: { kind: 'tunnel', config } })
  return upgraded ? undefined : new Response('upgrade failed', { status: 400 })
}

export function tunnelWebSocketHandlers(
  options: {
    connect?: typeof connect
    maxQueuedBytes?: number
    log?: (fields: Record<string, unknown>) => void
  } = {},
): Bun.WebSocketHandler<TunnelSocketData> {
  return {
    open(ws) {
      const socket = createTcpSocket(ws, ws.data.config, options.connect ?? connect, limit =>
        logLimit(ws, 'tcp_to_websocket', limit, DEFAULT_MAX_BUFFERED_BYTES),
      )
      ws.data.socket = socket
      ws.data.socketWriter = createBoundedSocketWriter(
        socket,
        options.maxQueuedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      )
    },
    message(ws, message) {
      const frame = decodeTunnelFrame(toBytes(message))
      if (frame.type === 'data') {
        if (ws.data.socketWriter?.write(frame.payload) === false) {
          const maxBytes = options.maxQueuedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
          logLimit(
            ws,
            'websocket_to_tcp',
            frame.payload.byteLength > maxBytes ? 'frame_bytes' : 'queued_bytes',
            maxBytes,
          )
          ws.close(1013, 'backpressure')
        }
        return
      }
      if (frame.type === 'ping') {
        const encoded = encodeTunnelFrame({ type: 'pong', payload: frame.payload })
        if (ws.getBufferedAmount() + encoded.byteLength > DEFAULT_MAX_BUFFERED_BYTES) {
          logLimit(
            ws,
            'control_to_websocket',
            encoded.byteLength > DEFAULT_MAX_BUFFERED_BYTES ? 'frame_bytes' : 'queued_bytes',
            DEFAULT_MAX_BUFFERED_BYTES,
          )
          ws.close(1013, 'backpressure')
          return
        }
        const status = ws.send(toArrayBuffer(encoded))
        if (status === 0) ws.close()
        return
      }
      if (frame.type === 'close') ws.close()
    },
    drain(ws) {
      if (ws.data.socket?.destroyed === false) ws.data.socket.resume()
    },
    close(ws) {
      ws.data.socketWriter?.close()
      ws.data.socket?.destroy()
    },
    backpressureLimit: DEFAULT_MAX_BUFFERED_BYTES,
    closeOnBackpressureLimit: true,
  }

  function logLimit(
    ws: ServerWebSocket,
    direction: 'websocket_to_tcp' | 'tcp_to_websocket' | 'control_to_websocket',
    limit: 'frame_bytes' | 'queued_bytes',
    maxBytes: number,
  ): void {
    if (ws.data.limitLogged === true) return
    ws.data.limitLogged = true
    options.log?.({
      event: 'tunnel_buffer_limit_reached',
      acceptId: ws.data.config.acceptId,
      direction,
      limit,
      maxBytes,
      action: 'connection_closed',
    })
  }
}

function createTcpSocket(
  ws: ServerWebSocket,
  config: TunnelAcceptConfig,
  connectTcp: typeof connect,
  onBufferLimit: (limit: 'frame_bytes' | 'queued_bytes') => void,
): Socket {
  const upstream = connectTcp({ host: config.targetHost, port: config.targetPort })
  upstream.on('data', chunk => {
    const bytes =
      typeof chunk === 'string'
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const encoded = encodeTunnelFrame({ type: 'data', payload: bytes })
    if (ws.getBufferedAmount() + encoded.byteLength > DEFAULT_MAX_BUFFERED_BYTES) {
      onBufferLimit(
        encoded.byteLength > DEFAULT_MAX_BUFFERED_BYTES ? 'frame_bytes' : 'queued_bytes',
      )
      upstream.pause()
      ws.close(1013, 'backpressure')
      return
    }
    const status = ws.send(toArrayBuffer(encoded))
    if (status < 0) upstream.pause()
    if (status === 0) ws.close()
  })
  upstream.on('error', () => ws.close())
  upstream.on('close', () => ws.close())
  return upstream
}

async function authenticateVm(
  request: Request,
  getVmToken: () => Promise<string | null>,
): Promise<boolean> {
  const token = extractBearerToken(request.headers.get('authorization'))
  const vmToken = await getVmToken()
  return token !== null && vmToken !== null && token === vmToken
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function isMirrorAcceptRequest(value: unknown): value is {
  machineId: string
  acceptId: string
  tokenDigest: string
  expiresAt: number
} {
  if (typeof value !== 'object' || value === null) return false
  const body = value as Record<string, unknown>
  return (
    typeof body.acceptId === 'string' &&
    body.acceptId.startsWith('mirror-') &&
    typeof body.machineId === 'string' &&
    body.machineId.length > 0 &&
    typeof body.tokenDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(body.tokenDigest) &&
    typeof body.expiresAt === 'number' &&
    Number.isFinite(body.expiresAt)
  )
}

function toBytes(message: string | Buffer): Uint8Array {
  if (typeof message === 'string') return new TextEncoder().encode(message)
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
