import { createServer, type Server, type Socket } from 'node:net'

import {
  TUNNEL_TOKEN_HEADER,
  TunnelTokenClaimsSchema,
  type TunnelTokenClaims,
  formatTunnelTokenParts,
  parseTunnelTokenParts,
  signTunnelToken,
  tunnelTokenDigest,
} from '@repo/contract'

export const TUNNEL_TOKEN_TTL_MS = 5 * 60 * 1000
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024
export const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 5_000

export type TunnelFrame =
  | { type: 'data'; payload: Uint8Array }
  | { type: 'ping'; payload: Uint8Array }
  | { type: 'pong'; payload: Uint8Array }
  | { type: 'close'; payload: Uint8Array }

export interface TunnelTokenInput {
  secret: string
  claims: TunnelTokenClaims
  nonce?: string
  expiresAt?: number
  now?: () => number
}

export interface VerifyTunnelTokenInput {
  secret: string
  claims: TunnelTokenClaims
  token: string
  now?: () => number
}

export interface VerifyTunnelTokenDigestInput {
  token: string
  tokenDigest: string
  expiresAt: number
  now?: () => number
}

export interface SendFrameOptions {
  maxBufferedBytes?: number
  timeoutMs?: number
  pollMs?: number
  signal?: AbortSignal
}

export interface TunnelWebSocketHeaders {
  tunnelToken: string
}

export interface TcpTunnelBridgeConfig {
  listenHost?: string
  listenPort: number
  tunnelUrl: string
  tunnelToken: string
  tunnelTokenProvider?: () => string
  maxBufferedBytes?: number
  backpressureTimeoutMs?: number
  onBufferLimit?: (event: TunnelBufferLimitEvent) => void
}

export interface TunnelBufferLimitEvent {
  direction: 'tcp_to_websocket' | 'websocket_to_tcp' | 'control_to_websocket'
  limit: 'frame_bytes' | 'queued_bytes' | 'backpressure_timeout'
  maxBytes: number
  action: 'connection_closed'
}

export interface TcpTunnelBridge {
  host: string
  port: number
  close(): Promise<void>
}

export interface BoundedSocketWriter {
  write(payload: Uint8Array): boolean
  close(): void
}

export interface DrainableSocket {
  write(payload: Uint8Array): boolean
  on(event: 'drain', listener: () => void): unknown
  off(event: 'drain', listener: () => void): unknown
}

const FRAME_HEADER_BYTES = 5

class TunnelBufferLimitError extends Error {
  constructor(
    readonly limit: TunnelBufferLimitEvent['limit'],
    readonly maxBytes: number,
    message: string,
  ) {
    super(message)
    this.name = 'TunnelBufferLimitError'
  }
}
const FRAME_TYPES = {
  data: 1,
  ping: 2,
  pong: 3,
  close: 4,
} as const

const MAX_QUEUED_BRIDGE_BYTES = DEFAULT_MAX_BUFFERED_BYTES
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const TUNNEL_SEND_STATES = new WeakMap<object, { tail: Promise<void>; queuedBytes: number }>()

const FRAME_NAMES = new Map<number, TunnelFrame['type']>([
  [FRAME_TYPES.data, 'data'],
  [FRAME_TYPES.ping, 'ping'],
  [FRAME_TYPES.pong, 'pong'],
  [FRAME_TYPES.close, 'close'],
])

export async function deriveTunnelToken(input: TunnelTokenInput): Promise<string> {
  const now = input.now ?? Date.now
  const expiresAt = input.expiresAt ?? now() + TUNNEL_TOKEN_TTL_MS
  const nonce = input.nonce ?? randomHex(16)
  const claims = validateTunnelTokenClaims(input.claims)
  const signature = await signTunnelToken(input.secret, claims, expiresAt, nonce)
  return formatTunnelTokenParts({ expiresAt, nonce, signature })
}

export async function verifyTunnelToken(input: VerifyTunnelTokenInput): Promise<boolean> {
  const parts = parseTunnelTokenParts(input.token)
  if (parts === null) return false
  const now = input.now ?? Date.now
  if (parts.expiresAt <= now()) return false
  const claims = safeTunnelTokenClaims(input.claims)
  if (claims === null) return false
  const expected = await signTunnelToken(input.secret, claims, parts.expiresAt, parts.nonce)
  return timingSafeEqualHex(parts.signature, expected)
}

export async function verifyTunnelTokenDigest(
  input: VerifyTunnelTokenDigestInput,
): Promise<boolean> {
  const now = input.now ?? Date.now
  if (input.expiresAt <= now()) return false
  return timingSafeEqualHex(await tunnelTokenDigest(input.token), input.tokenDigest)
}

export function encodeTunnelFrame(frame: TunnelFrame): Uint8Array {
  const payload = frame.payload
  const encoded = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength)
  encoded[0] = FRAME_TYPES[frame.type]
  new DataView(encoded.buffer, encoded.byteOffset + 1, 4).setUint32(0, payload.byteLength)
  encoded.set(payload, FRAME_HEADER_BYTES)
  return encoded
}

export function decodeTunnelFrame(input: ArrayBuffer | Uint8Array): TunnelFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < FRAME_HEADER_BYTES)
    throw new Error('Tunnel frame is shorter than the header')
  const type = FRAME_NAMES.get(bytes[0]!)
  if (type === undefined) throw new Error('Unknown tunnel frame type')
  const length = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0)
  if (bytes.byteLength !== FRAME_HEADER_BYTES + length)
    throw new Error('Tunnel frame length mismatch')
  return { type, payload: bytes.slice(FRAME_HEADER_BYTES) }
}

export async function sendTunnelFrame(
  ws: { bufferedAmount: number; send(data: Uint8Array): unknown },
  frame: TunnelFrame,
  options: SendFrameOptions = {},
): Promise<void> {
  const encoded = encodeTunnelFrame(frame)
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
  if (encoded.byteLength > maxBufferedBytes) {
    throw new TunnelBufferLimitError(
      'frame_bytes',
      maxBufferedBytes,
      `Tunnel frame exceeds ${maxBufferedBytes} bytes`,
    )
  }
  const state = TUNNEL_SEND_STATES.get(ws) ?? { tail: Promise.resolve(), queuedBytes: 0 }
  if (state.queuedBytes + encoded.byteLength > maxBufferedBytes) {
    throw new TunnelBufferLimitError(
      'queued_bytes',
      maxBufferedBytes,
      `Tunnel send queue exceeded ${maxBufferedBytes} bytes`,
    )
  }
  state.queuedBytes += encoded.byteLength
  const operation = state.tail.then(async () => {
    await waitForBackpressure(ws, encoded.byteLength, options)
    ws.send(encoded)
  })
  const tracked = operation.finally(() => {
    state.queuedBytes -= encoded.byteLength
  })
  // A failed send belongs to its caller. The recovered tail keeps later calls serialized
  // without permanently poisoning this WebSocket's queue; bridge teardown aborts them.
  state.tail = tracked.catch(() => undefined)
  TUNNEL_SEND_STATES.set(ws, state)
  await tracked
}

export async function sendTunnelBytes(
  ws: { bufferedAmount: number; send(data: Uint8Array): unknown },
  payload: Uint8Array,
  options: SendFrameOptions = {},
): Promise<void> {
  await sendTunnelFrame(ws, { type: 'data', payload }, options)
}

export function tunnelHeaders<const T extends TunnelWebSocketHeaders>(
  input: T,
): Record<string, string> {
  return {
    [TUNNEL_TOKEN_HEADER]: input.tunnelToken,
  }
}

export async function startTcpTunnelBridge(
  config: TcpTunnelBridgeConfig,
): Promise<TcpTunnelBridge> {
  const host = config.listenHost ?? '127.0.0.1'
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    connectSocketToTunnel(socket, config)
  })
  await listen(server, config.listenPort, host)
  return {
    host,
    port: serverPort(server),
    async close() {
      for (const socket of sockets) socket.destroy()
      await closeServer(server)
    },
  }
}

export function createBoundedSocketWriter(
  socket: DrainableSocket,
  maxQueuedBytes = DEFAULT_MAX_BUFFERED_BYTES,
): BoundedSocketWriter {
  type QueueNode = { payload: Uint8Array; next: QueueNode | null }
  let head: QueueNode | null = null
  let tail: QueueNode | null = null
  let queuedBytes = 0
  let blocked = false
  let closed = false

  const flush = () => {
    if (closed) return
    blocked = false
    while (head !== null) {
      const { payload } = head
      head = head.next
      if (head === null) tail = null
      queuedBytes -= payload.byteLength
      if (!socket.write(payload)) {
        blocked = true
        return
      }
    }
  }
  socket.on('drain', flush)

  return {
    write(payload) {
      if (closed || payload.byteLength > maxQueuedBytes) return false
      if (!blocked) {
        if (!socket.write(payload)) blocked = true
        return true
      }
      if (queuedBytes + payload.byteLength > maxQueuedBytes) return false
      const node: QueueNode = { payload, next: null }
      if (tail === null) head = node
      else tail.next = node
      tail = node
      queuedBytes += payload.byteLength
      return true
    },
    close() {
      if (closed) return
      closed = true
      socket.off('drain', flush)
      head = null
      tail = null
      queuedBytes = 0
    },
  }
}

async function waitForBackpressure(
  ws: { bufferedAmount: number },
  frameBytes: number,
  options: SendFrameOptions,
): Promise<void> {
  throwIfAborted(options.signal)
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_BACKPRESSURE_TIMEOUT_MS
  const pollMs = options.pollMs ?? 10
  const deadline = Date.now() + timeoutMs
  while (ws.bufferedAmount + frameBytes > maxBufferedBytes) {
    throwIfAborted(options.signal)
    if (Date.now() >= deadline) {
      throw new TunnelBufferLimitError(
        'backpressure_timeout',
        maxBufferedBytes,
        `Tunnel backpressure exceeded ${maxBufferedBytes} bytes`,
      )
    }
    await sleep(pollMs, options.signal)
  }
  throwIfAborted(options.signal)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('Tunnel send aborted')
}

function connectSocketToTunnel(socket: Socket, config: TcpTunnelBridgeConfig): void {
  const BunWebSocket = WebSocket as BunWebSocketConstructor
  const ws = new BunWebSocket(config.tunnelUrl, {
    headers: tunnelHeaders({
      tunnelToken: config.tunnelTokenProvider?.() ?? config.tunnelToken,
    }),
  })
  // One stable sender identity owns every data and control-frame reservation for this bridge.
  // Re-wrapping the same WebSocket per call would split the serialized byte budget.
  const sender = webSocketSender(ws)
  let opened = false
  let flushing = false
  let queuedBytes = 0
  let limitReported = false
  const sendQueue: Uint8Array[] = []
  const abort = new AbortController()
  const socketWriter = createBoundedSocketWriter(
    socket,
    config.maxBufferedBytes ?? MAX_QUEUED_BRIDGE_BYTES,
  )
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('open', () => {
    opened = true
    void flushSendQueue()
  })
  ws.addEventListener('message', event => {
    try {
      const frame = decodeTunnelFrame(toBytes(event.data))
      if (frame.type === 'data') {
        if (!socketWriter.write(frame.payload)) {
          reportLimit(
            'websocket_to_tcp',
            frame.payload.byteLength > (config.maxBufferedBytes ?? MAX_QUEUED_BRIDGE_BYTES)
              ? 'frame_bytes'
              : 'queued_bytes',
          )
          closeBridge()
        }
        return
      }
      if (frame.type === 'ping') {
        void sendTunnelFrame(
          sender,
          { type: 'pong', payload: frame.payload },
          {
            maxBufferedBytes: config.maxBufferedBytes,
            timeoutMs: config.backpressureTimeoutMs,
            signal: abort.signal,
          },
        ).catch(error => {
          reportSendLimit(error, 'control_to_websocket')
          closeBridge()
        })
        return
      }
      if (frame.type === 'close') closeBridge()
    } catch {
      closeBridge()
    }
  })
  ws.addEventListener('close', () => {
    closeSocket()
  })
  ws.addEventListener('error', () => {
    closeSocket()
  })
  socket.on('data', chunk => {
    const payload =
      typeof chunk === 'string'
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (!enqueueSend(payload)) {
      reportLimit(
        'tcp_to_websocket',
        payload.byteLength + FRAME_HEADER_BYTES >
          (config.maxBufferedBytes ?? MAX_QUEUED_BRIDGE_BYTES)
          ? 'frame_bytes'
          : 'queued_bytes',
      )
      closeBridge()
    }
  })
  socket.once('close', () => {
    abort.abort()
    socketWriter.close()
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
  })
  socket.once('error', () => {
    closeBridge()
  })

  function enqueueSend(payload: Uint8Array): boolean {
    const maxQueuedBytes = config.maxBufferedBytes ?? MAX_QUEUED_BRIDGE_BYTES
    const nextQueuedBytes = queuedBytes + payload.byteLength + FRAME_HEADER_BYTES
    if (nextQueuedBytes > maxQueuedBytes) return false
    sendQueue.push(payload)
    queuedBytes = nextQueuedBytes
    socket.pause()
    void flushSendQueue()
    return true
  }

  async function flushSendQueue(): Promise<void> {
    if (flushing || !opened) return
    flushing = true
    try {
      while (sendQueue.length > 0) {
        const payload = sendQueue.shift()!
        queuedBytes -= payload.byteLength + FRAME_HEADER_BYTES
        await sendBridgeBytes(sender, payload, config, abort.signal)
      }
      if (!socket.destroyed) socket.resume()
    } catch (error) {
      reportSendLimit(error)
      closeBridge()
    } finally {
      flushing = false
    }
  }

  function closeSocket(): void {
    abort.abort()
    socketWriter.close()
    socket.destroy()
  }

  function closeBridge(): void {
    closeSocket()
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
  }

  function reportSendLimit(
    error: unknown,
    direction: TunnelBufferLimitEvent['direction'] = 'tcp_to_websocket',
  ): void {
    if (error instanceof TunnelBufferLimitError) {
      reportLimit(direction, error.limit, error.maxBytes)
    }
  }

  function reportLimit(
    direction: TunnelBufferLimitEvent['direction'],
    limit: TunnelBufferLimitEvent['limit'],
    maxBytes = config.maxBufferedBytes ?? MAX_QUEUED_BRIDGE_BYTES,
  ): void {
    if (limitReported) return
    limitReported = true
    try {
      config.onBufferLimit?.({ direction, limit, maxBytes, action: 'connection_closed' })
    } catch {
      // Observability must not prevent the connection from closing at its safety ceiling.
    }
  }
}

async function sendBridgeBytes(
  sender: { bufferedAmount: number; send(data: Uint8Array): unknown },
  payload: Uint8Array,
  config: TcpTunnelBridgeConfig,
  signal: AbortSignal,
): Promise<void> {
  await sendTunnelBytes(sender, payload, {
    maxBufferedBytes: config.maxBufferedBytes,
    timeoutMs: config.backpressureTimeoutMs,
    signal,
  })
}

function webSocketSender(ws: WebSocket): {
  bufferedAmount: number
  send(data: Uint8Array): unknown
} {
  return {
    get bufferedAmount() {
      return ws.bufferedAmount
    },
    send(data) {
      return ws.send(toArrayBuffer(data))
    },
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, resolveListen)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolveClose => server.close(() => resolveClose()))
}

function serverPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('TCP tunnel bridge did not expose a port')
  return address.port
}

function toBytes(message: string | ArrayBuffer | Blob | Buffer): Uint8Array {
  if (typeof message === 'string') return new TextEncoder().encode(message)
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  if (message instanceof Uint8Array)
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
  throw new Error('Unsupported tunnel WebSocket message')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function validateTunnelTokenClaims(claims: TunnelTokenClaims): TunnelTokenClaims {
  const parsed = TunnelTokenClaimsSchema.parse(claims)
  if (
    !WORKSPACE_ID_PATTERN.test(parsed.sourceWorkspaceId) ||
    !WORKSPACE_ID_PATTERN.test(parsed.targetWorkspaceId)
  ) {
    throw new Error('Invalid tunnel token workspace id')
  }
  return parsed
}

function safeTunnelTokenClaims(claims: TunnelTokenClaims): TunnelTokenClaims | null {
  try {
    return validateTunnelTokenClaims(claims)
  } catch {
    return null
  }
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return diff === 0
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return hex(buffer)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new Error('Tunnel send aborted'))
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new Error('Tunnel send aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface BunWebSocketConstructor {
  new (url: string | URL, options?: { headers?: RequestInit['headers'] }): WebSocket
}
