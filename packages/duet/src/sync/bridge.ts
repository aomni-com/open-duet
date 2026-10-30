import type { MirrorTunnelGrant } from '@repo/contract'
import { startTcpTunnelBridge, type TcpTunnelBridge } from '@repo/sync-tunnel'

// Per-workspace TCP↔WS tunnel from the local dial-only Syncthing to the
// workspace gateway (spec file-attribution slice 21). It reuses
// `@repo/sync-tunnel`'s `startTcpTunnelBridge` — the ONE tunnel framing, VM↔VM
// and Mac↔VM alike — and adds the one thing the Mac side needs on top: L23
// re-minting. Tunnel tokens are short-TTL (~5 min); Syncthing keeps a
// long-lived BEP connection but redials on any drop, and every redial must
// carry a FRESH token. So this bridge never caches a token across the TTL: it
// re-mints and re-establishes on the SAME loopback port shortly before each
// grant expires. A reconnect through a stale token can never become a silent
// dead bridge — it surfaces as a re-mint (the counter ticks; a mint failure
// throws).

/** Re-mint this far before a grant's stated expiry so a dial never races the TTL. */
export const REMINT_SAFETY_MS = 60_000
/** Never schedule a re-mint sooner than this (guards a near-instant expiry). */
const MIN_REMINT_DELAY_MS = 1_000

export interface MirrorBridgeOptions {
  /** Mint a FRESH tunnel grant (calls the Duet mirror-register API, idempotent). */
  mintTunnel: () => Promise<MirrorTunnelGrant>
  listenHost?: string
  now?: () => number
  remintSafetyMs?: number
  /** Injected in tests; defaults to @repo/sync-tunnel's startTcpTunnelBridge. */
  startBridge?: typeof startTcpTunnelBridge
  /** Admission refusals stop this connection; temporary network failures still retry. */
  retryOnMintError?: (error: unknown) => boolean
  onRemint?: (grant: MirrorTunnelGrant) => void
  log?: (fields: Record<string, unknown>) => void
}

export interface MirrorBridge {
  host: string
  /** Stable loopback port; Syncthing's VM device address points here. */
  port: number
  remints(): number
  failure(): unknown
  close(): Promise<void>
}

/**
 * Start the loopback bridge. The first grant is minted here; the returned port
 * is stable for the bridge's life so the Syncthing device address never has to
 * change. A timer re-mints + rebuilds before each grant expires.
 */
export async function startMirrorBridge(options: MirrorBridgeOptions): Promise<MirrorBridge> {
  const host = options.listenHost ?? '127.0.0.1'
  const now = options.now ?? Date.now
  const remintSafetyMs = options.remintSafetyMs ?? REMINT_SAFETY_MS
  const startBridge = options.startBridge ?? startTcpTunnelBridge

  let terminalFailure: unknown
  let closed = false
  let remintCount = 0
  let bridge: TcpTunnelBridge | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let port = 0

  async function establish(): Promise<void> {
    const grant = await options.mintTunnel()
    if (closed) return
    const previous = bridge
    bridge = await startBridge({
      listenHost: host,
      // First establish binds an ephemeral port (0); every re-mint reuses it so
      // Syncthing's device address stays valid.
      listenPort: port === 0 ? 0 : port,
      tunnelUrl: grant.url,
      tunnelToken: grant.tunnelToken,
      onBufferLimit: event => options.log?.({ operation: 'tunnel_buffer_limit_reached', ...event }),
    })
    port = bridge.port
    if (previous !== null) await previous.close()
    options.onRemint?.(grant)
    scheduleRemint(grant)
  }

  function scheduleRemint(grant: MirrorTunnelGrant): void {
    if (timer !== null) clearTimeout(timer)
    const delay = Math.max(MIN_REMINT_DELAY_MS, grant.expiresAt - now() - remintSafetyMs)
    timer = setTimeout(() => {
      remintCount += 1
      options.log?.({ operation: 'tunnel_remint', count: remintCount })
      void establish().catch(async error => {
        options.log?.({
          operation: 'tunnel_remint_failed',
          error: error instanceof Error ? error.message : String(error),
        })
        if (options.retryOnMintError?.(error) === false) {
          terminalFailure = error
          await close()
          return
        }
        // Retry the re-mint on the safety cadence rather than dying silently.
        if (!closed) scheduleRemint({ ...grant, expiresAt: now() + remintSafetyMs * 2 })
      })
    }, delay)
    timer.unref?.()
  }

  async function close(): Promise<void> {
    closed = true
    if (timer !== null) clearTimeout(timer)
    const previous = bridge
    bridge = null
    if (previous !== null) await previous.close()
  }

  await establish()

  return {
    host,
    get port() {
      return port
    },
    remints: () => remintCount,
    failure: () => terminalFailure,
    close,
  }
}
