import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createConnection, createServer, type Server } from 'node:net'

import { tunnelTokenDigest } from '@repo/contract'

import {
  decodeTunnelFrame,
  createBoundedSocketWriter,
  deriveTunnelToken,
  encodeTunnelFrame,
  sendTunnelBytes,
  startTcpTunnelBridge,
  tunnelHeaders,
  verifyTunnelTokenDigest,
  verifyTunnelToken,
} from './index'

const claims = {
  sourceWorkspaceId: 'workspace-a',
  targetWorkspaceId: 'workspace-b',
  direction: 'source-to-target' as const,
}

describe('sync tunnel tokens', () => {
  test('derives short-lived directional tokens without storing them', async () => {
    const token = await deriveTunnelToken({
      secret: 'secret-a',
      claims,
      nonce: 'abc123abc123abcd',
      expiresAt: 10_000,
      now: () => 1_000,
    })

    expect(token).toStartWith('duet_tt_')
    expect(await verifyTunnelToken({ secret: 'secret-a', claims, token, now: () => 9_999 })).toBe(
      true,
    )
    expect(await verifyTunnelToken({ secret: 'secret-a', claims, token, now: () => 10_000 })).toBe(
      false,
    )
    expect(
      await verifyTunnelToken({
        secret: 'secret-a',
        claims: { ...claims, direction: 'target-to-source' },
        token,
        now: () => 9_999,
      }),
    ).toBe(false)
    expect(
      await verifyTunnelToken({ secret: 'wrong-secret', claims, token, now: () => 9_999 }),
    ).toBe(false)
  })

  test('rejects non-canonical workspace ids before signing', async () => {
    await expect(
      deriveTunnelToken({
        secret: 'secret-a',
        claims: { ...claims, sourceWorkspaceId: 'workspace:a' },
      }),
    ).rejects.toThrow('Invalid tunnel token workspace id')
  })

  test('verifies a presented bearer from only its digest and explicit expiry', async () => {
    const token = await deriveTunnelToken({
      secret: 'secret-a',
      claims,
      nonce: 'abc123abc123abcd',
      expiresAt: 10_000,
    })
    const tokenDigest = await tunnelTokenDigest(token)

    expect(
      await verifyTunnelTokenDigest({
        token,
        tokenDigest,
        expiresAt: 10_000,
        now: () => 9_999,
      }),
    ).toBe(true)
    expect(
      await verifyTunnelTokenDigest({
        token,
        tokenDigest,
        expiresAt: 10_000,
        now: () => 10_000,
      }),
    ).toBe(false)
    expect(
      await verifyTunnelTokenDigest({
        token: `${token}wrong`,
        tokenDigest,
        expiresAt: 10_000,
        now: () => 9_999,
      }),
    ).toBe(false)
  })
})

describe('sync tunnel framing', () => {
  test('round-trips length-prefixed binary frames', () => {
    const payload = new Uint8Array([1, 2, 3, 255])
    const decoded = decodeTunnelFrame(encodeTunnelFrame({ type: 'data', payload }))

    expect(decoded.type).toBe('data')
    expect([...decoded.payload]).toEqual([1, 2, 3, 255])
  })

  test('caps sends while websocket backpressure is above the configured limit', async () => {
    const sent: Uint8Array[] = []
    await expect(
      sendTunnelBytes(
        {
          bufferedAmount: 10,
          send(data: Uint8Array) {
            sent.push(data)
          },
        },
        new Uint8Array([1]),
        { maxBufferedBytes: 6, timeoutMs: 5, pollMs: 1 },
      ),
    ).rejects.toThrow('Tunnel backpressure exceeded 6 bytes')
    expect(sent).toEqual([])
  })

  test('reserves room for the complete encoded frame before sending', async () => {
    const sent: Uint8Array[] = []
    await expect(
      sendTunnelBytes(
        {
          bufferedAmount: 5,
          send(data: Uint8Array) {
            sent.push(data)
          },
        },
        new Uint8Array([1]),
        { maxBufferedBytes: 10, timeoutMs: 5, pollMs: 1 },
      ),
    ).rejects.toThrow('Tunnel backpressure exceeded 10 bytes')
    expect(sent).toEqual([])
  })

  test('rejects one encoded frame larger than the websocket byte budget', async () => {
    const sent: Uint8Array[] = []
    await expect(
      sendTunnelBytes(
        {
          bufferedAmount: 0,
          send(data: Uint8Array) {
            sent.push(data)
          },
        },
        new Uint8Array([1]),
        { maxBufferedBytes: 5 },
      ),
    ).rejects.toThrow('Tunnel frame exceeds 5 bytes')
    expect(sent).toEqual([])
  })

  test('serializes concurrent frame reservations against one websocket budget', async () => {
    const sent: Uint8Array[] = []
    const websocket = {
      bufferedAmount: 0,
      send(data: Uint8Array) {
        sent.push(data)
        this.bufferedAmount += data.byteLength
      },
    }

    const first = sendTunnelBytes(websocket, new Uint8Array(5), {
      maxBufferedBytes: 10,
      timeoutMs: 5,
      pollMs: 1,
    })
    const second = sendTunnelBytes(websocket, new Uint8Array(5), {
      maxBufferedBytes: 10,
      timeoutMs: 5,
      pollMs: 1,
    })
    const secondExpectation = expect(second).rejects.toThrow('Tunnel send queue exceeded 10 bytes')

    await expect(first).resolves.toBeUndefined()
    await secondExpectation
    expect(sent).toHaveLength(1)
    expect(websocket.bufferedAmount).toBe(10)
  })

  test('aborts a pending backpressure wait when its bridge closes', async () => {
    const abort = new AbortController()
    const pending = sendTunnelBytes({ bufferedAmount: 10, send() {} }, new Uint8Array([1]), {
      maxBufferedBytes: 6,
      timeoutMs: 50,
      pollMs: 10,
      signal: abort.signal,
    })

    abort.abort()

    await expect(pending).rejects.toThrow('Tunnel send aborted')
  })

  test('does not send a frame after its bridge has already closed', async () => {
    const abort = new AbortController()
    const sent: Uint8Array[] = []
    abort.abort()

    await expect(
      sendTunnelBytes(
        {
          bufferedAmount: 0,
          send(data) {
            sent.push(data)
          },
        },
        new Uint8Array([1]),
        { signal: abort.signal },
      ),
    ).rejects.toThrow('Tunnel send aborted')
    expect(sent).toEqual([])
  })

  test('bounds and cleans up websocket-to-TCP writes while the socket is stalled', () => {
    const socket = new FakeWritableSocket([false, true])
    const writer = createBoundedSocketWriter(socket, 4)

    expect(writer.write(new TextEncoder().encode('one'))).toBe(true)
    expect(writer.write(new TextEncoder().encode('two'))).toBe(true)
    expect(writer.write(new TextEncoder().encode('overflow'))).toBe(false)
    expect(socket.writtenText()).toEqual(['one'])

    writer.close()
    socket.emit('drain')
    expect(socket.writtenText()).toEqual(['one'])
  })

  test('emits the tunnel auth header for WebSocket clients', async () => {
    const tunnelToken = await deriveTunnelToken({
      secret: 'secret-a',
      claims,
      nonce: 'abc123abc123abcd',
      expiresAt: 10_000,
    })
    expect(tunnelHeaders({ tunnelToken })).toEqual({
      'x-duet-tunnel-token': tunnelToken,
    })
  })

  test('bridges a local TCP socket through a WebSocket tunnel to the peer target port', async () => {
    const echoServer = await startTcpEchoServer()
    const token = await deriveTunnelToken({ secret: 'bridge-secret', claims })
    let tunnelServer: ReturnType<typeof Bun.serve> | undefined
    await usingTunnelServer({
      tokenSecret: 'bridge-secret',
      targetPort: addressPort(echoServer),
      start(server) {
        tunnelServer = server
      },
    })
    const localBridge = await startTcpTunnelBridge({
      listenPort: 0,
      tunnelUrl: `${tunnelServer!.url}accept`.replace('http:', 'ws:'),
      tunnelToken: token,
    })
    try {
      const echoed = await tcpRoundTrip(localBridge.port, 'syncthing-bytes')
      expect(echoed).toBe('syncthing-bytes')
    } finally {
      await localBridge.close()
      tunnelServer?.stop(true)
      await closeServer(echoServer)
    }
  })

  test('closes the local socket when the upstream rejects its tunnel credential', async () => {
    const echoServer = await startTcpEchoServer()
    let peerConnections = 0
    echoServer.on('connection', () => peerConnections++)
    let tunnelServer: ReturnType<typeof Bun.serve> | undefined
    let localBridge: Awaited<ReturnType<typeof startTcpTunnelBridge>> | undefined
    try {
      await usingTunnelServer({
        tokenSecret: 'bridge-secret',
        targetPort: addressPort(echoServer),
        start(server) {
          tunnelServer = server
        },
      })
      localBridge = await startTcpTunnelBridge({
        listenPort: 0,
        tunnelUrl: `${tunnelServer!.url}accept`.replace('http:', 'ws:'),
        tunnelToken: 'duet_tt_bad',
      })
      await expect(tcpSocketEnds(localBridge.port)).resolves.toBe(true)
      expect(peerConnections).toBe(0)
    } finally {
      await localBridge?.close()
      tunnelServer?.stop(true)
      await closeServer(echoServer)
    }
  })

  test('closes only the bridge socket when a malformed websocket frame arrives', async () => {
    let tunnelServer: ReturnType<typeof Bun.serve> | undefined
    tunnelServer = Bun.serve({
      port: 0,
      fetch(request, server) {
        return server.upgrade(request, { data: {} })
          ? undefined
          : new Response('upgrade failed', { status: 400 })
      },
      websocket: {
        open(ws) {
          ws.send(new Uint8Array([255, 0, 0, 0, 0]))
        },
        message() {},
      },
    })
    const token = await deriveTunnelToken({ secret: 'bridge-secret', claims })
    const localBridge = await startTcpTunnelBridge({
      listenPort: 0,
      tunnelUrl: `${tunnelServer.url}accept`.replace('http:', 'ws:'),
      tunnelToken: token,
    })
    try {
      await expect(tcpSocketEnds(localBridge.port)).resolves.toBe(true)
    } finally {
      await localBridge.close()
      tunnelServer.stop(true)
    }
  })

  test('caps queued TCP bytes before the websocket opens', async () => {
    const originalWebSocket = globalThis.WebSocket
    fakeSockets.length = 0
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    try {
      const limitEvents: unknown[] = []
      const localBridge = await startTcpTunnelBridge({
        listenPort: 0,
        tunnelUrl: 'ws://example.invalid/accept',
        tunnelToken: 'duet_tt_test',
        maxBufferedBytes: 5,
        onBufferLimit: event => limitEvents.push(event),
      })
      try {
        await expect(tcpWriteThenEnd(localBridge.port, 'too-large')).resolves.toBe(true)
        expect(fakeSockets.at(-1)?.closed).toBe(true)
        expect(limitEvents).toEqual([
          {
            direction: 'tcp_to_websocket',
            limit: 'frame_bytes',
            maxBytes: 5,
            action: 'connection_closed',
          },
        ])
      } finally {
        await localBridge.close()
      }
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
  })
})

async function usingTunnelServer(options: {
  tokenSecret: string
  targetPort: number
  start(server: ReturnType<typeof Bun.serve>): void
}): Promise<void> {
  const server = Bun.serve<{ socket?: import('node:net').Socket }>({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname !== '/accept') return new Response('not found', { status: 404 })
      const token = request.headers.get('x-duet-tunnel-token')
      if (
        token === null ||
        !(await verifyTunnelToken({
          secret: options.tokenSecret,
          claims,
          token,
          now: () => Date.now(),
        }))
      ) {
        return new Response('unauthorized', { status: 401 })
      }
      return server.upgrade(request, { data: {} })
        ? undefined
        : new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      open(ws) {
        const socket = createConnection({ host: '127.0.0.1', port: options.targetPort })
        ws.data.socket = socket
        socket.on('data', chunk => {
          const payload =
            typeof chunk === 'string'
              ? new TextEncoder().encode(chunk)
              : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          ws.send(
            toArrayBuffer(
              encodeTunnelFrame({
                type: 'data',
                payload,
              }),
            ),
          )
        })
        socket.on('close', () => ws.close())
        socket.on('error', () => ws.close())
      },
      message(ws, message) {
        const frame = decodeTunnelFrame(toBytes(message))
        if (frame.type === 'data') ws.data.socket?.write(frame.payload)
      },
      close(ws) {
        ws.data.socket?.end()
      },
    },
  })
  options.start(server)
}

async function startTcpEchoServer(): Promise<Server> {
  const server = createServer(socket => {
    socket.on('data', chunk => socket.write(chunk))
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return server
}

function tcpRoundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolveRoundTrip, rejectRoundTrip) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timeout = setTimeout(() => {
      socket.destroy()
      rejectRoundTrip(new Error('TCP bridge round trip timed out'))
    }, 5_000)
    socket.on('connect', () => socket.write(payload))
    socket.on('data', chunk => {
      clearTimeout(timeout)
      socket.end()
      resolveRoundTrip(chunk.toString('utf8'))
    })
    socket.on('error', error => {
      clearTimeout(timeout)
      rejectRoundTrip(error)
    })
  })
}

function tcpSocketEnds(port: number): Promise<boolean> {
  return new Promise((resolveEnd, rejectEnd) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timeout = setTimeout(() => {
      socket.destroy()
      rejectEnd(new Error('TCP bridge close timed out'))
    }, 5_000)
    socket.on('end', () => {
      clearTimeout(timeout)
      resolveEnd(true)
    })
    socket.on('close', () => {
      clearTimeout(timeout)
      resolveEnd(true)
    })
    socket.on('error', error => {
      clearTimeout(timeout)
      rejectEnd(error)
    })
  })
}

function tcpWriteThenEnd(port: number, payload: string): Promise<boolean> {
  return new Promise((resolveEnd, rejectEnd) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timeout = setTimeout(() => {
      socket.destroy()
      rejectEnd(new Error('TCP bridge write close timed out'))
    }, 5_000)
    socket.on('connect', () => socket.write(payload))
    socket.on('end', () => {
      clearTimeout(timeout)
      resolveEnd(true)
    })
    socket.on('close', () => {
      clearTimeout(timeout)
      resolveEnd(true)
    })
    socket.on('error', error => {
      clearTimeout(timeout)
      rejectEnd(error)
    })
  })
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  binaryType: WebSocket['binaryType'] = 'arraybuffer'
  bufferedAmount = 0
  closed = false
  readyState = FakeWebSocket.CONNECTING

  constructor() {
    super()
    fakeSockets.push(this)
  }

  send(): void {}

  close(): void {
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

const fakeSockets: FakeWebSocket[] = []

class FakeWritableSocket extends EventEmitter {
  private readonly writes: Uint8Array[] = []

  constructor(private readonly statuses: boolean[]) {
    super()
  }

  write(payload: Uint8Array): boolean {
    this.writes.push(payload)
    return this.statuses.shift() ?? true
  }

  writtenText(): string[] {
    return this.writes.map(value => new TextDecoder().decode(value))
  }
}

function addressPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('TCP echo server did not expose a port')
  return address.port
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolveClose => server.close(() => resolveClose()))
}

function toBytes(message: string | Buffer): Uint8Array {
  if (typeof message === 'string') return new TextEncoder().encode(message)
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
