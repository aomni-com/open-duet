import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface SyncthingClientOptions {
  stateDir: string
  syncthingApiUrl?: string
  syncthingApiKey?: string
}

const DEFAULT_SYNCTHING_API_URL = 'http://127.0.0.1:8384'
const SYNCTHING_READY_ATTEMPTS = 40
const SYNCTHING_READY_POLL_MS = 250

export interface SyncthingReconcileOptions {
  waitForReady?: boolean
  // Durable registry commits share the same queue and follow successful projection.
  afterWrite?: () => Promise<void>
}

export interface SyncthingConfigCoordinator {
  exclusive<T>(operation: () => Promise<T>): Promise<T>
  reconcile(
    project: (current: SyncthingConfig) => SyncthingConfig | Promise<SyncthingConfig>,
    options?: SyncthingReconcileOptions,
  ): Promise<boolean>
}

export function createSyncthingConfigCoordinator(
  options: SyncthingClientOptions,
  fetchImpl: FetchLike,
  sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
): SyncthingConfigCoordinator {
  let tail = Promise.resolve()
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = tail.then(operation)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  return {
    exclusive,
    reconcile(project, reconcileOptions) {
      return exclusive(async () => {
        const current = reconcileOptions?.waitForReady
          ? await readSyncthingConfigWhenReady(options, fetchImpl, sleep)
          : await readSyncthingConfig(options, fetchImpl)
        const before = JSON.stringify(current)
        const next = await project(current)
        const changed = before !== JSON.stringify(next)
        if (changed) await writeSyncthingConfig(options, fetchImpl, next)
        await reconcileOptions?.afterWrite?.()
        return changed
      })
    },
  }
}

async function readSyncthingConfigWhenReady(
  options: SyncthingClientOptions,
  fetchImpl: FetchLike,
  sleep: (milliseconds: number) => Promise<unknown>,
): Promise<SyncthingConfig> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readSyncthingConfig(options, fetchImpl)
    } catch (error) {
      if (attempt + 1 >= SYNCTHING_READY_ATTEMPTS || !isRetryableSyncthingReadinessError(error)) {
        throw error
      }
      await sleep(SYNCTHING_READY_POLL_MS)
    }
  }
}

function isRetryableSyncthingReadinessError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const status = error.message.match(/HTTP (\d{3})/)?.[1]
  return status === undefined || ['502', '503', '504'].includes(status)
}

export async function readSyncthingConfig(
  options: SyncthingClientOptions,
  fetchImpl: FetchLike,
): Promise<SyncthingConfig> {
  const { base, headers } = await syncthingConnection(options)
  const response = await fetchImpl(`${base}/rest/config`, { headers })
  if (!response.ok) throw new Error(`Syncthing config read failed with HTTP ${response.status}`)
  return (await response.json()) as SyncthingConfig
}

export async function writeSyncthingConfig(
  options: SyncthingClientOptions,
  fetchImpl: FetchLike,
  config: SyncthingConfig,
): Promise<void> {
  const { base, headers } = await syncthingConnection(options)
  const saved = await fetchImpl(`${base}/rest/config`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(config),
  })
  if (!saved.ok) throw new Error(`Syncthing config write failed with HTTP ${saved.status}`)
}

export async function syncthingConnection(options: SyncthingClientOptions): Promise<{
  base: string
  headers: Record<string, string>
}> {
  const apiKey = options.syncthingApiKey ?? (await readSyncthingApiKey(options.stateDir))
  if (apiKey === null) throw new Error('Syncthing REST API is not configured')
  return {
    base: (options.syncthingApiUrl ?? DEFAULT_SYNCTHING_API_URL).replace(/\/+$/g, ''),
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
  }
}

export function disableSyncthingDiscovery(config: SyncthingConfig): void {
  config.options = {
    ...(typeof config.options === 'object' && config.options !== null ? config.options : {}),
    globalAnnounceEnabled: false,
    localAnnounceEnabled: false,
    relaysEnabled: false,
  }
}

// Loopback address the VM's Syncthing listens on and is dialed at through the
// tunnel bridge (star topology; MAP-SYNC L14 — never a public address).
export const SYNCTHING_LOOPBACK_LISTEN_ADDRESS = 'tcp://127.0.0.1:22000'
export const SYNCTHING_LOOPBACK_GUI_ADDRESS = '127.0.0.1:8384'

/**
 * The full instance isolation set (MAP-SYNC V2, research/syncthing-operations.md
 * §B). vm-image's ExecStartPre writes this before Syncthing's first listen so
 * the L20 first-boot unhardened window never exists; the gateway boot-reconciles
 * the same options via REST as the semantic owner (idempotent). Superset of
 * `disableSyncthingDiscovery`: also disables NAT, crash + usage reporting, and
 * auto-upgrade, and pins the listener + GUI to loopback.
 */
export function applyHardenedSyncthingOptions(config: SyncthingConfig): void {
  config.options = {
    ...(typeof config.options === 'object' && config.options !== null ? config.options : {}),
    globalAnnounceEnabled: false,
    localAnnounceEnabled: false,
    relaysEnabled: false,
    natEnabled: false,
    crashReportingEnabled: false,
    // -1 = usage reporting declined (never the undecided 0, which nags + phones).
    urAccepted: -1,
    // 0 + the STNOUPGRADE env pin the version; the release is SHA-pinned in the
    // image (V1), so the binary must never self-replace.
    autoUpgradeIntervalH: 0,
    listenAddresses: [SYNCTHING_LOOPBACK_LISTEN_ADDRESS],
  }
  config.gui = {
    ...(typeof config.gui === 'object' && config.gui !== null ? config.gui : {}),
    address: SYNCTHING_LOOPBACK_GUI_ADDRESS,
  }
}

/** Boot-reconcile the hardened options onto a live Syncthing via REST. */
export async function reconcileSyncthingHardening(
  options: SyncthingClientOptions,
  fetchImpl: FetchLike,
  coordinator = createSyncthingConfigCoordinator(options, fetchImpl),
): Promise<void> {
  await coordinator.reconcile(config => {
    applyHardenedSyncthingOptions(config)
    return config
  })
}

/** The VM's own Syncthing (BEP) device ID — the peer a mirror device adds. */
export async function readSyncthingDeviceId(
  options: SyncthingClientOptions,
  fetchImpl: FetchLike,
): Promise<string> {
  const { base, headers } = await syncthingConnection(options)
  const response = await fetchImpl(`${base}/rest/system/status`, { headers })
  if (!response.ok) throw new Error(`Syncthing status read failed with HTTP ${response.status}`)
  const status = (await response.json()) as { myID?: unknown }
  if (typeof status.myID !== 'string' || status.myID.length === 0) {
    throw new Error('Syncthing did not report a device ID')
  }
  return status.myID
}

async function readSyncthingApiKey(stateDir: string): Promise<string | null> {
  try {
    const config = await readFile(join(stateDir, 'syncthing', 'config.xml'), 'utf8')
    return config.match(/<apikey>([^<]+)<\/apikey>/)?.[1]?.trim() || null
  } catch {
    return null
  }
}

export interface SyncthingDevice {
  deviceID: string
  name?: string
  addresses?: string[]
}

export interface SyncthingFolder {
  id: string
  paused?: boolean
  label?: string
  path: string
  type?: string
  devices?: Array<{ deviceID: string }>
  rescanIntervalS?: number
  fsWatcherEnabled?: boolean
  fsWatcherDelayS?: number
  ignorePerms?: boolean
  maxConflicts?: number
}

export interface SyncthingConfig {
  devices?: SyncthingDevice[]
  folders?: SyncthingFolder[]
  options?: Record<string, unknown>
  gui?: Record<string, unknown>
}
