import {
  startTcpTunnelBridge,
  type TcpTunnelBridge,
  type TunnelBufferLimitEvent,
} from '@repo/sync-tunnel'

export interface SyncBridgeRequest {
  id?: string
  listenHost?: string
  listenPort: number
  peerUrl: string
  tunnelToken: string
}

export type SyncBridgeStarter = (request: {
  listenHost?: string
  listenPort: number
  tunnelUrl: string
  tunnelToken: string
  tunnelTokenProvider: () => string
  onBufferLimit?: (event: TunnelBufferLimitEvent) => void
}) => Promise<TcpTunnelBridge>

interface RegisteredBridge {
  bridge: TcpTunnelBridge
  peerUrl: string
  listenHost: string
  listenPort: number
  credential: { token: string }
}

export class SyncBridgeRegistry {
  private readonly bridges = new Map<string, RegisteredBridge>()
  private readonly start: SyncBridgeStarter
  private readonly log?: (fields: Record<string, unknown>) => void

  constructor(
    options: {
      start?: SyncBridgeStarter
      log?: (fields: Record<string, unknown>) => void
    } = {},
  ) {
    this.start = options.start ?? startTcpTunnelBridge
    this.log = options.log
  }

  async replace(bridgeId: string, request: SyncBridgeRequest): Promise<TcpTunnelBridge> {
    const existing = this.bridges.get(bridgeId)
    const credential = { token: request.tunnelToken }
    const bridge = await this.start({
      listenHost: request.listenHost ?? '127.0.0.1',
      listenPort: request.listenPort,
      tunnelUrl: request.peerUrl,
      tunnelToken: credential.token,
      tunnelTokenProvider: () => credential.token,
      onBufferLimit: event =>
        this.log?.({ event: 'tunnel_buffer_limit_reached', bridgeId, ...event }),
    })
    this.bridges.set(bridgeId, {
      bridge,
      peerUrl: request.peerUrl,
      listenHost: request.listenHost ?? '127.0.0.1',
      listenPort: request.listenPort,
      credential,
    })
    if (existing !== undefined) await existing.bridge.close()
    return bridge
  }

  async reconcile(
    desired: Array<
      Required<Pick<SyncBridgeRequest, 'id' | 'listenPort' | 'peerUrl' | 'tunnelToken'>>
    >,
  ): Promise<{ changed: number; addresses: Map<string, string>; errors: Map<string, string> }> {
    let changed = 0
    const errors = new Map<string, string>()
    const desiredIds = new Set(desired.map(request => request.id))
    for (const [id, registered] of this.bridges) {
      if (desiredIds.has(id)) continue
      // A failed close must not abort the rest of the pass — but the bridge
      // stays registered so the next reconcile can retry closing it;
      // deleting the entry would orphan the live listener and its port.
      let closed = true
      await registered.bridge.close().catch((error: unknown) => {
        closed = false
        errors.set(id, `close failed: ${String(error)}`)
      })
      if (!closed) continue
      this.bridges.delete(id)
      changed += 1
    }
    for (const request of desired) {
      const existing = this.bridges.get(request.id)
      const listenHost = '127.0.0.1'
      if (
        existing !== undefined &&
        existing.peerUrl === request.peerUrl &&
        existing.listenHost === listenHost &&
        existing.listenPort === request.listenPort
      ) {
        if (existing.credential.token !== request.tunnelToken) {
          existing.credential.token = request.tunnelToken
          changed += 1
        }
        continue
      }
      try {
        await this.replace(request.id, request)
        changed += 1
      } catch {
        errors.set(request.id, 'bridge_failed')
      }
    }
    return {
      changed,
      addresses: new Map(
        [...this.bridges].map(([id, registered]) => [
          id,
          `tcp://${registered.bridge.host}:${registered.bridge.port}`,
        ]),
      ),
      errors,
    }
  }

  async close(bridgeId: string): Promise<void> {
    const registered = this.bridges.get(bridgeId)
    if (registered === undefined) return
    await registered.bridge.close()
    this.bridges.delete(bridgeId)
  }
}
