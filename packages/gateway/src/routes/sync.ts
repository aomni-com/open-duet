import { resolve } from 'node:path'

import { Hono } from 'hono'

import {
  DEFAULT_MIRROR_IGNORE_PATTERNS,
  MAX_MIRROR_DEVICES_PER_WORKSPACE,
  MIRROR_FOLDER_ID,
  assertPathOutsideDriveRoot,
  normalizeDrivePath,
} from '@repo/contract'

import { listConflictFiles } from '../sync/conflicts'
import {
  readMirrorDevices,
  readMounts,
  writeMirrorDevices,
  type MirrorDeviceRecord,
} from '../sync/mount-store'
import { safeDriveDirectory, writeStignore } from '../sync/mounts'
import { projectRemovedMirrorDevices, projectStoreIntoSyncthingConfig } from '../sync/reconcile'
import {
  applyHardenedSyncthingOptions,
  createSyncthingConfigCoordinator,
  readSyncthingDeviceId,
  syncthingConnection,
  type FetchLike,
  type SyncthingConfigCoordinator,
} from '../sync/syncthing-client'
import type { TunnelAcceptRegistry } from './tunnel'

export interface SyncRoutesOptions {
  tunnelAccepts: TunnelAcceptRegistry
  driveDir: string
  stateDir: string
  syncthingApiUrl?: string
  syncthingApiKey?: string
  fetch?: FetchLike
  now?: () => number
  configCoordinator?: SyncthingConfigCoordinator
}

export function createSyncRoutes(options: SyncRoutesOptions): Hono {
  assertPathOutsideDriveRoot(options.stateDir, options.driveDir)
  const app = new Hono()
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const configCoordinator =
    options.configCoordinator ?? createSyncthingConfigCoordinator(options, fetchImpl)

  app.get('/mounts', async c => c.json({ mounts: await readMounts(options.stateDir) }))

  app.get('/conflicts', async c => {
    const rawPath = c.req.query('path') ?? ''
    const normalized = normalizeDrivePath(rawPath, { allowRoot: true })
    if (!normalized.ok) return c.json({ error: 'invalid_request' }, 400)
    const root = resolve(options.driveDir, normalized.relativePath)
    const conflicts = await listConflictFiles(root, options.driveDir)
    return c.json({ conflicts })
  })

  app.get('/syncthing/device-id', async c => {
    const { base, headers } = await syncthingConnection(options)
    const response = await fetchImpl(`${base}/rest/system/status`, { headers })
    if (!response.ok) return c.json({ error: 'syncthing_unavailable' }, 502)
    const status = (await response.json()) as { myID?: unknown }
    if (typeof status.myID !== 'string' || status.myID.length === 0) {
      return c.json({ error: 'syncthing_unavailable' }, 502)
    }
    return c.json({ deviceId: status.myID })
  })

  // --- Whole-drive mirror devices (spec file-attribution slice 19) ---------
  // A mirror device joins the ONE whole-drive folder (MIRROR_FOLDER_ID), rooted
  // at the drive, `sendreceive`, with the mirror `.stignore` (G1) and the mirror
  // knobs (K3/K5/K6/K7). The device-store binds the machine id to the
  // Syncthing device ID so slice 18 resolves `mirror:` actors.

  app.post('/syncthing/mirror/devices', async c => {
    const body = await readJson(c.req.raw)
    if (!isMirrorDeviceRequest(body)) return c.json({ error: 'invalid_request' }, 400)
    const devices = await readMirrorDevices(options.stateDir)
    const alreadyRegistered = devices.some(device => device.machineId === body.machineId)
    if (!alreadyRegistered && devices.length >= MAX_MIRROR_DEVICES_PER_WORKSPACE) {
      return c.json({ error: 'mirror_device_limit' }, 409)
    }
    // The whole-drive folder is rooted at the drive itself; write its .stignore
    // at the drive root (G1 exclusions) before the folder is announced.
    const driveRoot = await safeDriveDirectory(options.driveDir, '')
    if (driveRoot === null) return c.json({ error: 'invalid_request' }, 400)
    await writeStignore(driveRoot, DEFAULT_MIRROR_IGNORE_PATTERNS)
    let vmSyncthingDeviceId: string
    try {
      vmSyncthingDeviceId = await readSyncthingDeviceId(options, fetchImpl)
    } catch {
      return c.json({ error: 'syncthing_unavailable' }, 502)
    }
    let mirrorDevices: MirrorDeviceRecord[] = []
    let atLimit = false
    await configCoordinator.reconcile(
      async config => {
        const current = await readMirrorDevices(options.stateDir)
        if (
          !current.some(device => device.machineId === body.machineId) &&
          current.length >= MAX_MIRROR_DEVICES_PER_WORKSPACE
        ) {
          atLimit = true
          return config
        }
        const existing = current.find(device => device.machineId === body.machineId)
        mirrorDevices = [
          ...current.filter(device => device.machineId !== body.machineId),
          {
            machineId: body.machineId,
            syncthingDeviceId: body.syncthingDeviceId,
            ...(body.deviceName === undefined ? {} : { deviceName: body.deviceName }),
            registeredAt: existing?.registeredAt ?? now(),
          },
        ]
        applyHardenedSyncthingOptions(config)
        projectStoreIntoSyncthingConfig(config, { mirrorDevices, driveRoot })
        return config
      },
      {
        afterWrite: async () => {
          if (!atLimit) await writeMirrorDevices(options.stateDir, mirrorDevices)
        },
      },
    )
    if (atLimit) return c.json({ error: 'mirror_device_limit' }, 409)
    return c.json({ ok: true, folderId: MIRROR_FOLDER_ID, vmSyncthingDeviceId })
  })

  app.get('/syncthing/mirror/devices', async c => {
    const devices = await readMirrorDevices(options.stateDir)
    return c.json({
      devices: devices.map(device => ({
        machineId: device.machineId,
        ...(device.deviceName === undefined ? {} : { deviceName: device.deviceName }),
        syncthingDeviceId: device.syncthingDeviceId,
        registeredAt: device.registeredAt,
      })),
    })
  })

  app.delete('/syncthing/mirror/devices/:machineId', async c => {
    const machineId = c.req.param('machineId')
    options.tunnelAccepts.removeMirrorMachine(machineId)
    let retained: MirrorDeviceRecord[] = []
    await configCoordinator.reconcile(
      async config => {
        const devices = await readMirrorDevices(options.stateDir)
        const removed = devices.filter(device => device.machineId === machineId)
        retained = devices.filter(device => device.machineId !== machineId)
        projectRemovedMirrorDevices(config, removed, {
          mirrorDevices: retained,
          driveRoot: options.driveDir,
        })
        return config
      },
      { afterWrite: () => writeMirrorDevices(options.stateDir, retained) },
    )
    return c.json({ ok: true, machineId })
  })

  return app
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function isMirrorDeviceRequest(value: unknown): value is {
  machineId: string
  syncthingDeviceId: string
  deviceName?: string
} {
  if (typeof value !== 'object' || value === null) return false
  const body = value as Record<string, unknown>
  return (
    typeof body.machineId === 'string' &&
    body.machineId.length > 0 &&
    typeof body.syncthingDeviceId === 'string' &&
    body.syncthingDeviceId.length > 0 &&
    optionalString(body.deviceName)
  )
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}
