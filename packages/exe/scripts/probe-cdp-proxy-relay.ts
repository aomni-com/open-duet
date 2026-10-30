/**
 * Disposable Slice 00 relay. This proves the CDP transport contract without
 * becoming the gateway's production implementation.
 */

export interface ProbeCdpRelayOptions {
  upstreamUrl: string
  createTarget: (params: Record<string, unknown> | undefined) => Promise<string>
  onMethod?: (method: string) => void
  maxBufferedBytes?: number
  maxPendingBytes?: number
}

export interface ProbeCdpRelay {
  readonly url: string
  stop(closeActiveConnections?: boolean): void
}

interface RelaySocketData {
  upstream?: WebSocket
  pending: string[]
  pendingBytes: number
  closed: boolean
}

interface CdpCommand {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024

export function createProbeCdpRelay(options: ProbeCdpRelayOptions): ProbeCdpRelay {
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
  let server: Bun.Server<RelaySocketData>
  server = Bun.serve<RelaySocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, bunServer) {
      if (
        bunServer.upgrade(request, {
          data: { pending: [], pendingBytes: 0, closed: false },
        })
      ) {
        return
      }
      return new Response('upgrade required', { status: 426 })
    },
    websocket: {
      open(downstream) {
        const upstream = new WebSocket(options.upstreamUrl)
        downstream.data.upstream = upstream
        upstream.addEventListener('open', () => {
          for (const frame of downstream.data.pending) upstream.send(frame)
          downstream.data.pending = []
          downstream.data.pendingBytes = 0
        })
        upstream.addEventListener('message', event => {
          if (downstream.getBufferedAmount() > maxBufferedBytes) {
            finish(downstream, 1013, 'downstream too slow', true)
            return
          }
          if (typeof event.data !== 'string') {
            finish(downstream, 1003, 'non-text upstream CDP frame', true)
            return
          }
          downstream.send(event.data)
        })
        upstream.addEventListener('error', () => finish(downstream, 1011, 'upstream failed', true))
        upstream.addEventListener('close', event => {
          finish(downstream, safeCloseCode(event.code), event.reason, true)
        })
      },
      message(downstream, frame) {
        if (typeof frame !== 'string') {
          finish(downstream, 1003, 'non-text downstream CDP frame', true)
          return
        }
        const command = parseCommand(frame)
        if (command?.method === 'Target.createTarget') {
          options.onMethod?.(command.method)
          void options.createTarget(command.params).then(
            targetId => {
              if (downstream.data.closed) return
              downstream.send(
                JSON.stringify({
                  id: command.id,
                  result: { targetId },
                  ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
                }),
              )
            },
            error => {
              if (downstream.data.closed) return
              downstream.send(
                JSON.stringify({
                  id: command.id,
                  error: {
                    code: -32000,
                    message: error instanceof Error ? error.message : String(error),
                  },
                  ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
                }),
              )
            },
          )
          return
        }
        if (command !== undefined) options.onMethod?.(command.method)
        forward(downstream, frame, maxBufferedBytes, maxPendingBytes)
      },
      close(downstream, code, reason) {
        finish(downstream, safeCloseCode(code), reason, false)
      },
    },
  })

  return {
    url: `ws://127.0.0.1:${server.port}/devtools/browser/probe-relay`,
    stop(closeActiveConnections) {
      server.stop(closeActiveConnections)
    },
  }
}

function parseCommand(frame: string): CdpCommand | undefined {
  try {
    const value = JSON.parse(frame) as unknown
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Record<string, unknown>).id !== 'number' ||
      typeof (value as Record<string, unknown>).method !== 'string'
    ) {
      return undefined
    }
    const command = value as Record<string, unknown>
    return {
      id: command.id as number,
      method: command.method as string,
      ...(isRecord(command.params) ? { params: command.params } : {}),
      ...(typeof command.sessionId === 'string' ? { sessionId: command.sessionId } : {}),
    }
  } catch {
    return undefined
  }
}

function forward(
  downstream: Bun.ServerWebSocket<RelaySocketData>,
  frame: string,
  maxBufferedBytes: number,
  maxPendingBytes: number,
): void {
  const upstream = downstream.data.upstream
  if (upstream === undefined) return
  if (upstream.bufferedAmount > maxBufferedBytes) {
    finish(downstream, 1013, 'upstream too slow', true)
    return
  }
  if (upstream.readyState === WebSocket.OPEN) {
    upstream.send(frame)
    return
  }
  const bytes = Buffer.byteLength(frame)
  if (downstream.data.pendingBytes + bytes > maxPendingBytes) {
    finish(downstream, 1013, 'upstream unavailable', true)
    return
  }
  downstream.data.pending.push(frame)
  downstream.data.pendingBytes += bytes
}

function finish(
  downstream: Bun.ServerWebSocket<RelaySocketData>,
  code: number,
  reason: string,
  closeDownstream: boolean,
): void {
  if (downstream.data.closed) return
  downstream.data.closed = true
  downstream.data.pending = []
  downstream.data.pendingBytes = 0
  downstream.data.upstream?.close(code, reason.slice(0, 123))
  if (closeDownstream) downstream.close(code, reason.slice(0, 123))
}

function safeCloseCode(code: number): number {
  return code >= 1000 && code !== 1005 && code !== 1006 ? code : 1011
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
