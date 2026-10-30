import { describe, expect, test } from 'bun:test'

import { SyncBridgeRegistry, type SyncBridgeStarter } from './bridge-registry'

describe('share bridge registry', () => {
  test('refreshes token credentials without redialing and prunes absent bridges', async () => {
    const starts: Array<{ token: () => string; closed: boolean }> = []
    const starter: SyncBridgeStarter = async request => {
      const row = { token: request.tunnelTokenProvider, closed: false }
      starts.push(row)
      return {
        host: '127.0.0.1',
        port: 23_001 + starts.length,
        close: async () => {
          row.closed = true
        },
      }
    }
    const registry = new SyncBridgeRegistry({ start: starter })

    const first = await registry.reconcile([
      {
        id: 'share-a:out:accept-a',
        listenPort: 0,
        peerUrl: 'wss://peer.example/v1/tunnel/accept/accept-a',
        tunnelToken: 'token-a',
      },
    ])
    expect(first.changed).toBe(1)
    expect(starts).toHaveLength(1)
    expect(starts[0]!.token()).toBe('token-a')

    const refreshed = await registry.reconcile([
      {
        id: 'share-a:out:accept-a',
        listenPort: 0,
        peerUrl: 'wss://peer.example/v1/tunnel/accept/accept-a',
        tunnelToken: 'token-b',
      },
    ])
    expect(refreshed.changed).toBe(1)
    expect(starts).toHaveLength(1)
    expect(starts[0]!.token()).toBe('token-b')

    expect((await registry.reconcile([])).changed).toBe(1)
    expect(starts[0]!.closed).toBe(true)
  })

  test('reapplying identical bridge identity and topology is a no-op', async () => {
    let starts = 0
    const registry = new SyncBridgeRegistry({
      start: async () => {
        starts += 1
        return { host: '127.0.0.1', port: 23_000, close: async () => undefined }
      },
    })
    const desired = [
      {
        id: 'share-a:out:accept-a',
        listenPort: 0,
        peerUrl: 'wss://peer.example/v1/tunnel/accept/accept-a',
        tunnelToken: 'token-a',
      },
    ]

    expect((await registry.reconcile(desired)).changed).toBe(1)
    expect((await registry.reconcile(desired)).changed).toBe(0)
    expect(starts).toBe(1)
  })

  test('attributes a client-side tunnel buffer limit to its bridge', async () => {
    const logs: Array<Record<string, unknown>> = []
    const registry = new SyncBridgeRegistry({
      start: async request => {
        request.onBufferLimit?.({
          direction: 'tcp_to_websocket',
          limit: 'queued_bytes',
          maxBytes: 1024,
          action: 'connection_closed',
        })
        return { host: '127.0.0.1', port: 23_000, close: async () => undefined }
      },
      log: fields => logs.push(fields),
    })

    await registry.replace('share-a:out:accept-a', {
      listenPort: 0,
      peerUrl: 'wss://peer.example/v1/tunnel/accept/accept-a',
      tunnelToken: 'token-a',
    })

    expect(logs).toEqual([
      {
        event: 'tunnel_buffer_limit_reached',
        bridgeId: 'share-a:out:accept-a',
        direction: 'tcp_to_websocket',
        limit: 'queued_bytes',
        maxBytes: 1024,
        action: 'connection_closed',
      },
    ])
  })
})
