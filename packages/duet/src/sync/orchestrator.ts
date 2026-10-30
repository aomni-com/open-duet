import {
  DEFAULT_MIRROR_IGNORE_PATTERNS,
  MIRROR_FOLDER_KNOBS,
  MIRROR_FOLDER_ID,
  MirrorRegisteredSchema,
  type MirrorRegistered,
} from '@repo/contract'

import type { ApiClient } from '../http.js'
import {
  setFolderIgnores,
  updateConfig,
  type SyncthingApi,
  type SyncthingConfig,
  type SyncthingDevice,
  type SyncthingFolder,
} from './syncthing-api.js'

// Registers the device + provisions the mirror ONLY through the slice-19 Duet
// API (spec file-attribution slice 21). The one transfer engine's orchestration
// is Duet-owned: this never calls the VM's Syncthing API (L14) — it POSTs
// /v1/ws/<slug>/mirror-devices, which binds the device, provisions the VM
// folder, and mints a tunnel. The LOCAL Syncthing config (the Mac folder +
// the VM peer device) is the only thing configured here, on the loopback API.

/**
 * macOS junk that must never travel upstream (MAP-SYNC Q7). Added ON TOP of the
 * shared mirror ignore set so the Mac folder ignores everything the VM folder
 * does (`.git`, `node_modules`, `.duet`, Syncthing internals) plus Finder/Spotlight
 * cruft. `._*` also covers AppleDouble sidecars on non-APFS volumes.
 */
export const MAC_LOCAL_IGNORE_PATTERNS = [
  '.DS_Store',
  '._*',
  '.Spotlight-V100',
  '.Trashes',
] as const

export function macMirrorIgnorePatterns(): string[] {
  return [...DEFAULT_MIRROR_IGNORE_PATTERNS, ...MAC_LOCAL_IGNORE_PATTERNS]
}

/** Register (or idempotently re-register) this device as a whole-drive mirror. */
export async function registerMirror(
  api: Pick<ApiClient, 'request'>,
  workspaceSlug: string,
  machineId: string,
  syncthingDeviceId: string,
): Promise<MirrorRegistered> {
  const response = await api.request(`/ws/${encodeURIComponent(workspaceSlug)}/mirror-devices`, {
    method: 'POST',
    json: { machineId, syncthingDeviceId },
  })
  return MirrorRegisteredSchema.parse(await response.json())
}

export interface LocalMirrorConfig {
  folderId: string
  /** The Mac's own device ID (must be in the folder's device list). */
  localDeviceId: string
  /** The VM's Syncthing device ID (the sole peer, star topology). */
  vmDeviceId: string
  /** Loopback bridge port the VM device is dialed at. */
  bridgePort: number
  /** Local directory selected for this workspace's mirror. */
  localDir: string
  ignorePatterns?: readonly string[]
  bridgeHost?: string
}

/**
 * Configure the local Syncthing to mirror `folderId` into `localDir`, sharing
 * it with the VM device dialed through the loopback bridge. Idempotent:
 * re-running updates the device address + folder knobs in place rather than
 * duplicating them (a reconnect on a new bridge port just refreshes the
 * address).
 */
export async function configureLocalMirror(
  st: SyncthingApi,
  config: LocalMirrorConfig,
): Promise<void> {
  const bridgeHost = config.bridgeHost ?? '127.0.0.1'
  const vmAddress = `tcp://${bridgeHost}:${config.bridgePort}`
  await updateConfig(st, syncthing => {
    upsertDevice(syncthing, config.vmDeviceId, vmAddress)
    upsertFolder(syncthing, config)
  })
  await setFolderIgnores(st, config.folderId, config.ignorePatterns ?? macMirrorIgnorePatterns())
}

function upsertDevice(config: SyncthingConfig, deviceId: string, address: string): void {
  const devices = (config.devices ??= [])
  const existing = devices.find(device => device.deviceID === deviceId)
  if (existing !== undefined) {
    existing.addresses = [address]
    existing.paused = false
    return
  }
  const device: SyncthingDevice = {
    deviceID: deviceId,
    name: 'duet-vm',
    addresses: [address],
    paused: false,
  }
  devices.push(device)
}

function upsertFolder(config: SyncthingConfig, input: LocalMirrorConfig): void {
  const folders = (config.folders ??= [])
  const devices = [{ deviceID: input.localDeviceId }, { deviceID: input.vmDeviceId }]
  const knobs = MIRROR_FOLDER_KNOBS
  const existing = folders.find(folder => folder.id === input.folderId)
  if (existing !== undefined) {
    existing.path = input.localDir
    existing.type = knobs.type
    existing.fsWatcherEnabled = knobs.fsWatcherEnabled
    existing.fsWatcherDelayS = knobs.fsWatcherDelayS
    existing.ignorePerms = knobs.ignorePerms
    existing.maxConflicts = knobs.maxConflicts
    existing.devices = devices
    return
  }
  const folder: SyncthingFolder = {
    id: input.folderId,
    label: input.folderId === MIRROR_FOLDER_ID ? 'Workspace drive' : input.folderId,
    path: input.localDir,
    type: knobs.type,
    fsWatcherEnabled: knobs.fsWatcherEnabled,
    fsWatcherDelayS: knobs.fsWatcherDelayS,
    ignorePerms: knobs.ignorePerms,
    maxConflicts: knobs.maxConflicts,
    devices,
  }
  folders.push(folder)
}
