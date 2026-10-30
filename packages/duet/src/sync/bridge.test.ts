import { describe, expect, test } from 'bun:test'
import { createConnection, createServer, type Server } from 'node:net'

import type { MirrorTunnelGrant } from '@repo/contract'
import {
  decodeTunnelFrame,
  deriveTunnelToken,
  encodeTunnelFrame,
  verifyTunnelToken,
} from '@repo/sync-tunnel'

import { startMirrorBridge } from './bridge.js'

const claims = {
  sourceWorkspaceId: 'mac-device',
  targetWorkspaceId: 'workspace-vm',
  direction: 'source-to-target' as const,
}

describe('mirror bridge re-minting (L23)', () => {
  test('never caches a token: each re-mint dials with a fresh grant on a stable port', async () => {
    let minted = 0
    const dialedTokens: string[] = []
    const dialedPorts: number[] = []
    const now = Date.now()
    const bridge = await startMirrorBridge({
      now: () => now,
      remintSafetyMs: 10,
      mintTunnel: async () => {
        minted += 1
        return {
          url: 'ws://loopback.invalid/accept',
          tunnelToken: `token-${minted}`,
          // Expiry just past the safety margin so scheduleRemint fires soon.
          expiresAt: now + 30,
        }
      },
      startBridge: async config => {
        dialedTokens.push(config.tunnelToken)
        dialedPorts.push(config.listenPort)
        return { host: '127.0.0.1', port: 45000, async close() {} }
      },
    })
    try {
      // Wait for at least one re-mint to fire.
      await waitUntil(() => bridge.remints() >= 1, 2000)
      expect(minted).toBeGreaterThanOrEqual(2)
      // Fresh token on the re-dial (never the cached first one).
      expect(dialedTokens[0]).toBe('token-1')
      expect(dialedTokens[1]).toBe('token-2')
      expect(dialedTokens[1]).not.toBe(dialedTokens[0])
      // First dial binds ephemeral (0); the re-dial reuses the resolved port.
      expect(dialedPorts[0]).toBe(0)
      expect(dialedPorts[1]).toBe(45000)
      expect(bridge.port).toBe(45000)
    } finally {
      await bridge.close()
    }
  })

  test('a terminal mint refusal closes the existing bridge and exposes the failure', async () => {
    let mints = 0
    let closes = 0
    const refusal = new Error('machine removed')
    const bridge = await startMirrorBridge({
      now: () => 0,
      remintSafetyMs: 10,
      retryOnMintError: () => false,
      mintTunnel: async () => {
        if (++mints > 1) throw refusal
        return { url: 'ws://loopback.invalid/accept', tunnelToken: 'first', expiresAt: 30 }
      },
      startBridge: async () => ({
        host: '127.0.0.1',
        port: 45000,
        async close() {
          closes += 1
        },
      }),
    })
    try {
      await waitUntil(() => mints === 2, 2_000)
      expect(closes).toBe(1)
      expect(bridge.failure()).toBe(refusal)
    } finally {
      await bridge.close()
    }
  })

  test('bridges real bytes through @repo/sync-tunnel to the peer', async () => {
    const echo = await startTcpEchoServer()
    const tunnelServer = startTunnelServer('bridge-secret', addressPort(echo))
    const mintTunnel = async (): Promise<MirrorTunnelGrant> => ({
      url: `${tunnelServer.url}accept`.replace('http:', 'ws:'),
      tunnelToken: await deriveTunnelToken({ secret: 'bridge-secret', claims }),
      expiresAt: Date.now() + 5 * 60_000,
    })
    const bridge = await startMirrorBridge({ mintTunnel })
    try {
      const echoed = await tcpRoundTrip(bridge.port, 'syncthing-bep-bytes')
      expect(echoed).toBe('syncthing-bep-bytes')
    } finally {
      await bridge.close()
      tunnelServer.stop(true)
      await closeServer(echo)
    }
  })
})

function startTunnelServer(secret: string, targetPort: number): ReturnType<typeof Bun.serve> {
  return Bun.serve<{ socket?: import('node:net').Socket }>({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname !== '/accept') return new Response('not found', { status: 404 })
      const token = request.headers.get('x-duet-tunnel-token')
      if (
        token === null ||
        !(await verifyTunnelToken({ secret, claims, token, now: () => Date.now() }))
      ) {
        return new Response('unauthorized', { status: 401 })
      }
      return server.upgrade(request, { data: {} }) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      open(ws) {
        const socket = createConnection({ host: '127.0.0.1', port: targetPort })
        ws.data.socket = socket
        socket.on('data', chunk =>
          ws.send(toArrayBuffer(encodeTunnelFrame({ type: 'data', payload: toBytes(chunk) }))),
        )
        socket.on('close', () => ws.close())
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
}

async function startTcpEchoServer(): Promise<Server> {
  const server = createServer(socket => socket.on('data', chunk => socket.write(chunk)))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

function tcpRoundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('round trip timed out'))
    }, 5_000)
    socket.on('connect', () => socket.write(payload))
    socket.on('data', chunk => {
      clearTimeout(timeout)
      socket.end()
      resolve(chunk.toString('utf8'))
    })
    socket.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error('condition not met before timeout')
}

function addressPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

function toBytes(message: string | Buffer): Uint8Array {
  if (typeof message === 'string') return new TextEncoder().encode(message)
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
