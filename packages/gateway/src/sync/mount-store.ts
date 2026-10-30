import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { syncthingShortDeviceId } from '@repo/contract'

const SYNC_STATE_FILE = 'sync-mounts.json'
const MIRROR_DEVICE_STATE_FILE = 'sync-mirror-devices.json'

export interface SyncedMount {
  id: string
  shareId: string
  path: string
  mode: 'read' | 'write'
  role: 'origin' | 'recipient'
  ignorePatterns: string[]
}

/**
 * A whole-drive mirror device registered against this workspace VM (spec
 * file-attribution slice 19). The mount-store is the ONE path→share/device
 * registry (MAP ownership map): this half maps a Syncthing device ID to the
 * sync machine document id, so slice 18 resolves a `RemoteChangeDetected`
 * `modifiedBy` (the SHORT device ID) back to `mirror:<machineId>`.
 */
export interface MirrorDeviceRecord {
  /** The non-secret sync machine document id — the `mirror:<deviceId>` actor. */
  machineId: string
  /** The device's full Syncthing (BEP) device ID, bound at registration. */
  syncthingDeviceId: string
  deviceName?: string
  registeredAt: number
}

export async function readMounts(stateDir: string): Promise<SyncedMount[]> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, SYNC_STATE_FILE), 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed.flatMap(toSyncedMount) : []
  } catch {
    return []
  }
}

export async function writeMounts(stateDir: string, mounts: SyncedMount[]): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFile(join(stateDir, SYNC_STATE_FILE), `${JSON.stringify(mounts, null, 2)}\n`, {
    mode: 0o600,
  })
}

/**
 * Resolve a drive-relative path to every synced folder containing it, with
 * the remainder relative to the folder root ('' = the root itself). Recipient
 * mounts cannot nest, but one creator path can back several outgoing shares,
 * so outbound scan nudges must fan out to every matching Syncthing folder.
 */
export function syncMountsForDrivePath(
  mounts: SyncedMount[],
  path: string,
): Array<{ mount: SyncedMount; sub: string }> {
  return mounts.flatMap(mount => {
    if (path === mount.path) return [{ mount, sub: '' }]
    if (path.startsWith(`${mount.path}/`)) {
      return [{ mount, sub: path.slice(mount.path.length + 1) }]
    }
    return []
  })
}

export async function readMirrorDevices(stateDir: string): Promise<MirrorDeviceRecord[]> {
  try {
    const parsed = JSON.parse(
      await readFile(join(stateDir, MIRROR_DEVICE_STATE_FILE), 'utf8'),
    ) as unknown
    return Array.isArray(parsed) ? parsed.filter(isMirrorDeviceRecord) : []
  } catch {
    return []
  }
}

export async function writeMirrorDevices(
  stateDir: string,
  devices: MirrorDeviceRecord[],
): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFile(
    join(stateDir, MIRROR_DEVICE_STATE_FILE),
    `${JSON.stringify(devices, null, 2)}\n`,
    { mode: 0o600 },
  )
}

/**
 * Resolve a Syncthing SHORT device ID (the 7-char `modifiedBy` slice 18 sees on
 * the wire) to the mirror device's machine id — null when no registered
 * device matches. Short-ID collisions across a workspace's own devices are
 * astronomically unlikely, but a defensive tie (two full IDs sharing a prefix)
 * resolves to none rather than guessing an identity.
 */
export function mirrorMachineForShortDeviceId(
  devices: MirrorDeviceRecord[],
  shortId: string,
): string | null {
  const normalized = shortId.replace(/-/g, '').slice(0, 7).toUpperCase()
  if (normalized.length === 0) return null
  const matches = devices.filter(
    device => syncthingShortDeviceId(device.syncthingDeviceId) === normalized,
  )
  return matches.length === 1 ? matches[0]!.machineId : null
}

function isMirrorDeviceRecord(value: unknown): value is MirrorDeviceRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.machineId === 'string' &&
    typeof record.syncthingDeviceId === 'string' &&
    (record.deviceName === undefined || typeof record.deviceName === 'string') &&
    typeof record.registeredAt === 'number'
  )
}

function toSyncedMount(value: unknown): SyncedMount[] {
  if (typeof value !== 'object' || value === null) return []
  const mount = value as Record<string, unknown>
  if (
    !(
      typeof mount.id === 'string' &&
      typeof mount.shareId === 'string' &&
      typeof mount.path === 'string' &&
      (mount.mode === 'read' || mount.mode === 'write') &&
      (mount.role === undefined || mount.role === 'origin' || mount.role === 'recipient') &&
      Array.isArray(mount.ignorePatterns) &&
      mount.ignorePatterns.every(pattern => typeof pattern === 'string')
    )
  )
    return []
  return [
    {
      id: mount.id,
      shareId: mount.shareId,
      path: mount.path,
      mode: mount.mode,
      // Mounts written before read-mode sync semantics were all recipients.
      role: mount.role ?? 'recipient',
      ignorePatterns: mount.ignorePatterns,
    },
  ]
}
