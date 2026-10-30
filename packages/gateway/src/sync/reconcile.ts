/**
 * Sync registry authority (spec file-attribution L11). `mount-store.ts` is the
 * SOLE owner of the drive's share/device registry (`sync-mounts.json` +
 * `sync-mirror-devices.json`); Syncthing's own config is a downstream
 * PROJECTION of it, never a second source of truth. On gateway start this
 * reconciler pushes the store into Syncthing config so any drift — a folder that
 * survived a mount removal, a mirror folder whose devices were all revoked, a
 * mirror device that vanished from config across a restore — is corrected with
 * the store winning. Slice 18's translator resolves actors from the store map,
 * never by parsing Syncthing config, so config and translator always agree.
 *
 * Scope: mirror state only. Share folders, devices, types, and membership belong
 * exclusively to `share-converger.ts`; boot reconcile must preserve them until
 * the first desired snapshot arrives and re-converges them.
 */
import { MIRROR_FOLDER_ID, MIRROR_FOLDER_KNOBS } from '@repo/contract'

import { writeMirrorDevices, readMirrorDevices, type MirrorDeviceRecord } from './mount-store'
import { type SyncthingConfigCoordinator, type SyncthingConfig } from './syncthing-client'

export interface SyncStoreSnapshot {
  mirrorDevices: MirrorDeviceRecord[]
  /** Absolute drive root — the mirror folder's path when reconcile must recreate it. */
  driveRoot: string
}

/** Pure store→config projection (store wins). Mutates `config` in place. */
export function projectStoreIntoSyncthingConfig(
  config: SyncthingConfig,
  store: SyncStoreSnapshot,
): void {
  const hasMirror = store.mirrorDevices.length > 0
  const folders = Array.isArray(config.folders) ? config.folders : []
  config.folders = hasMirror ? folders : folders.filter(folder => folder.id !== MIRROR_FOLDER_ID)
  if (hasMirror) projectMirror(config, store)
}

function projectMirror(config: SyncthingConfig, store: SyncStoreSnapshot): void {
  // Devices: add any registered mirror device missing from config; never remove
  // (a share-peer device has no store record and must survive).
  const devices = Array.isArray(config.devices) ? config.devices : []
  const known = new Set(devices.map(device => device.deviceID))
  const added = store.mirrorDevices
    .filter(device => !known.has(device.syncthingDeviceId))
    .map(device => ({
      deviceID: device.syncthingDeviceId,
      name: device.deviceName ?? device.machineId,
      // The mirror dials IN through the tunnel; the VM announces nothing (L24).
      addresses: ['dynamic'],
    }))
  config.devices = [...devices, ...added]

  // Mirror folder: exactly the registered devices as members, store knobs, and a
  // path preserved from any surviving folder (a real realpath) or the drive root.
  const folders = Array.isArray(config.folders) ? config.folders : []
  const existing = folders.find(folder => folder.id === MIRROR_FOLDER_ID)
  config.folders = [
    ...folders.filter(folder => folder.id !== MIRROR_FOLDER_ID),
    {
      ...existing,
      id: MIRROR_FOLDER_ID,
      label: existing?.label ?? 'Workspace drive',
      path: existing?.path ?? store.driveRoot,
      type: MIRROR_FOLDER_KNOBS.type,
      devices: store.mirrorDevices.map(device => ({ deviceID: device.syncthingDeviceId })),
      fsWatcherEnabled: MIRROR_FOLDER_KNOBS.fsWatcherEnabled,
      fsWatcherDelayS: MIRROR_FOLDER_KNOBS.fsWatcherDelayS,
      ignorePerms: MIRROR_FOLDER_KNOBS.ignorePerms,
      maxConflicts: MIRROR_FOLDER_KNOBS.maxConflicts,
    },
  ]
}

/** Boot-reconcile Syncthing config from the authoritative mount store over REST. */
export async function reconcileSyncthingFromStore(
  store: { stateDir: string; driveRoot: string },
  coordinator: SyncthingConfigCoordinator,
): Promise<void> {
  const mirrorDevices = await readMirrorDevices(store.stateDir)
  await coordinator.reconcile(config => {
    projectStoreIntoSyncthingConfig(config, {
      mirrorDevices,
      driveRoot: store.driveRoot,
    })
    return config
  })
}

export async function reconcileMirrorMachineAccess(
  store: { stateDir: string; driveRoot: string },
  machineIds: readonly string[],
  coordinator: SyncthingConfigCoordinator,
  accepts: { removeMirrorMachine(machineId: string): void },
): Promise<void> {
  const allowed = new Set(machineIds)
  const registered = await readMirrorDevices(store.stateDir)
  if (registered.every(device => allowed.has(device.machineId))) return
  let retained: MirrorDeviceRecord[] = []
  await coordinator.reconcile(
    async config => {
      const devices = await readMirrorDevices(store.stateDir)
      const removed = devices.filter(device => !allowed.has(device.machineId))
      retained = devices.filter(device => allowed.has(device.machineId))
      for (const device of removed) accepts.removeMirrorMachine(device.machineId)
      projectRemovedMirrorDevices(config, removed, {
        mirrorDevices: retained,
        driveRoot: store.driveRoot,
      })
      return config
    },
    { afterWrite: () => writeMirrorDevices(store.stateDir, retained) },
  )
}

export function projectRemovedMirrorDevices(
  config: SyncthingConfig,
  removed: MirrorDeviceRecord[],
  store: SyncStoreSnapshot,
): void {
  projectStoreIntoSyncthingConfig(config, store)
  const removedPeers = new Set(removed.map(device => device.syncthingDeviceId))
  // A peer still referenced by a share or another mirror remains a configured device.
  const retainedPeers = new Set(
    (config.folders ?? []).flatMap(folder => (folder.devices ?? []).map(device => device.deviceID)),
  )
  config.devices = (config.devices ?? []).filter(
    device => !removedPeers.has(device.deviceID) || retainedPeers.has(device.deviceID),
  )
}
