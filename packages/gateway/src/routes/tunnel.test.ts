import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import { DEFAULT_MAX_BUFFERED_BYTES, decodeTunnelFrame, encodeTunnelFrame } from '@repo/sync-tunnel'

import { tunnelWebSocketHandlers, type TunnelSocketData } from './tunnel'

test('pauses TCP reads while the tunnel websocket is backpressured and resumes in order', () => {
  const socket = new FakeSocket()
  const ws = new FakeServerWebSocket([-1, 3])
  const handlers = tunnelWebSocketHandlers({ connect: () => socket as never })
  handlers.open?.(ws as never)

  socket.emit('data', Buffer.from('one'))
  expect(socket.pauseCalls).toBe(1)
  expect(sentPayloads(ws)).toEqual(['one'])

  handlers.drain?.(ws as never)
  expect(socket.resumeCalls).toBe(1)
  socket.emit('data', Buffer.from('two'))
  expect(sentPayloads(ws)).toEqual(['one', 'two'])
})

test('queues websocket frames behind TCP backpressure and flushes them in order on drain', () => {
  const socket = new FakeSocket([false, true])
  const ws = new FakeServerWebSocket([])
  const handlers = tunnelWebSocketHandlers({ connect: () => socket as never, maxQueuedBytes: 16 })
  handlers.open?.(ws as never)

  handlers.message?.(ws as never, dataFrame('one'))
  handlers.message?.(ws as never, dataFrame('two'))
  expect(socket.writtenText()).toEqual(['one'])

  socket.emit('drain')
  expect(socket.writtenText()).toEqual(['one', 'two'])
})

test('closes a tunnel whose websocket input exceeds the bounded TCP queue', () => {
  const socket = new FakeSocket([false])
  const ws = new FakeServerWebSocket([])
  const logs: Array<Record<string, unknown>> = []
  const handlers = tunnelWebSocketHandlers({
    connect: () => socket as never,
    maxQueuedBytes: 4,
    log: fields => logs.push(fields),
  })
  handlers.open?.(ws as never)

  handlers.message?.(ws as never, dataFrame('one'))
  handlers.message?.(ws as never, dataFrame('two'))
  handlers.message?.(ws as never, dataFrame('xx'))

  expect(ws.closeCalls).toBe(1)
  handlers.close?.(ws as never, 1013, 'backpressure')
  expect(socket.destroyed).toBe(true)
  socket.emit('drain')
  expect(socket.writtenText()).toEqual(['one'])
  expect(logs).toEqual([
    {
      event: 'tunnel_buffer_limit_reached',
      acceptId: 'accept-1',
      direction: 'websocket_to_tcp',
      limit: 'queued_bytes',
      maxBytes: 4,
      action: 'connection_closed',
    },
  ])
})

test('logs and closes before outgoing tunnel data exceeds the websocket byte budget', () => {
  const socket = new FakeSocket()
  const ws = new FakeServerWebSocket([], DEFAULT_MAX_BUFFERED_BYTES - 1)
  const logs: Array<Record<string, unknown>> = []
  const handlers = tunnelWebSocketHandlers({
    connect: () => socket as never,
    log: fields => logs.push(fields),
  })
  handlers.open?.(ws as never)

  socket.emit('data', Buffer.from('overflow'))

  expect(ws.sent).toEqual([])
  expect(ws.closeCalls).toBe(1)
  expect(logs).toEqual([
    {
      event: 'tunnel_buffer_limit_reached',
      acceptId: 'accept-1',
      direction: 'tcp_to_websocket',
      limit: 'queued_bytes',
      maxBytes: DEFAULT_MAX_BUFFERED_BYTES,
      action: 'connection_closed',
    },
  ])
})

class FakeSocket extends EventEmitter {
  pauseCalls = 0
  resumeCalls = 0
  destroyed = false
  private readonly writes: Uint8Array[] = []

  constructor(private readonly writeStatuses: boolean[] = []) {
    super()
  }

  write(data: Uint8Array): boolean {
    this.writes.push(data)
    return this.writeStatuses.shift() ?? true
  }

  pause(): this {
    this.pauseCalls += 1
    return this
  }

  resume(): this {
    this.resumeCalls += 1
    return this
  }

  end(): this {
    return this
  }

  destroy(): this {
    this.destroyed = true
    return this
  }

  writtenText(): string[] {
    return this.writes.map(value => new TextDecoder().decode(value))
  }
}

class FakeServerWebSocket {
  readonly data: TunnelSocketData = {
    kind: 'tunnel',
    config: {
      acceptId: 'accept-1',
      targetHost: '127.0.0.1',
      targetPort: 22_000,
      tokenDigest: 'digest',
      expiresAt: 1,
    },
  }
  readonly sent: Uint8Array[] = []
  closeCalls = 0

  constructor(
    private readonly statuses: number[],
    private readonly bufferedAmount = 0,
  ) {}

  getBufferedAmount(): number {
    return this.bufferedAmount
  }

  send(data: ArrayBuffer): number {
    this.sent.push(new Uint8Array(data))
    return this.statuses.shift() ?? data.byteLength
  }

  close(): void {
    this.closeCalls += 1
  }
}

function sentPayloads(ws: FakeServerWebSocket): string[] {
  return ws.sent.map(bytes => new TextDecoder().decode(decodeTunnelFrame(bytes).payload))
}

function dataFrame(value: string): Buffer<ArrayBuffer> {
  const bytes = encodeTunnelFrame({ type: 'data', payload: new TextEncoder().encode(value) })
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return Buffer.from(buffer)
}
