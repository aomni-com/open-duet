import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MIRROR_FOLDER_ID } from '@repo/contract'

import { writeMirrorDevices } from './mount-store'
import { projectStoreIntoSyncthingConfig, reconcileSyncthingFromStore } from './reconcile'
import { createSyncthingConfigCoordinator, type SyncthingConfig } from './syncthing-client'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('mirror-only boot reconciliation', () => {
  test('preserves share folders and devices while removing an unowned mirror folder', () => {
    const config: SyncthingConfig = {
      devices: [{ deviceID: 'SHARE-PEER' }],
      folders: [
        {
          id: 'share-a',
          path: '/drive/share-a',
          type: 'receiveonly',
          devices: [{ deviceID: 'SHARE-PEER' }],
        },
        { id: MIRROR_FOLDER_ID, path: '/drive', devices: [] },
      ],
    }

    projectStoreIntoSyncthingConfig(config, { mirrorDevices: [], driveRoot: '/drive' })

    expect(config.devices).toEqual([{ deviceID: 'SHARE-PEER' }])
    expect(config.folders).toEqual([
      {
        id: 'share-a',
        path: '/drive/share-a',
        type: 'receiveonly',
        devices: [{ deviceID: 'SHARE-PEER' }],
      },
    ])
  })

  test('rebuilds mirror membership without changing share state', () => {
    const config: SyncthingConfig = {
      devices: [{ deviceID: 'SHARE-PEER' }],
      folders: [{ id: 'share-a', path: '/drive/share-a', devices: [{ deviceID: 'SHARE-PEER' }] }],
    }
    projectStoreIntoSyncthingConfig(config, {
      mirrorDevices: [
        {
          machineId: 'mirror-a',
          syncthingDeviceId: 'MIRROR-A',
          registeredAt: 1,
        },
      ],
      driveRoot: '/drive',
    })

    expect(config.devices).toContainEqual(
      expect.objectContaining({ deviceID: 'MIRROR-A', addresses: ['dynamic'] }),
    )
    expect(config.folders).toContainEqual(
      expect.objectContaining({
        id: MIRROR_FOLDER_ID,
        path: '/drive',
        devices: [{ deviceID: 'MIRROR-A' }],
      }),
    )
    expect(config.folders).toContainEqual(
      expect.objectContaining({ id: 'share-a', devices: [{ deviceID: 'SHARE-PEER' }] }),
    )
  })

  test('is idempotent when mirror projection already matches', () => {
    const store = {
      mirrorDevices: [
        {
          machineId: 'mirror-a',
          syncthingDeviceId: 'MIRROR-A',
          registeredAt: 1,
        },
      ],
      driveRoot: '/drive',
    }
    const config: SyncthingConfig = { devices: [], folders: [] }
    projectStoreIntoSyncthingConfig(config, store)
    expect(config.devices).toEqual([
      { deviceID: 'MIRROR-A', name: 'mirror-a', addresses: ['dynamic'] },
    ])
    expect(config.folders).toContainEqual(
      expect.objectContaining({
        id: MIRROR_FOLDER_ID,
        path: '/drive',
        devices: [{ deviceID: 'MIRROR-A' }],
      }),
    )
    const first = structuredClone(config)
    projectStoreIntoSyncthingConfig(config, store)
    expect(config).toEqual(first)
  })

  test('reads the mirror store and PUTs its projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-reconcile-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    await writeMirrorDevices(stateDir, [
      {
        machineId: 'mirror-a',
        syncthingDeviceId: 'MIRROR-A',
        registeredAt: 1,
      },
    ])
    let put: SyncthingConfig | undefined
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        put = JSON.parse(String(init.body)) as SyncthingConfig
        return Response.json({ ok: true })
      }
      return Response.json({
        devices: [{ deviceID: 'SHARE-PEER' }],
        folders: [{ id: 'share-a', path: '/drive/share-a' }],
      })
    }

    await reconcileSyncthingFromStore(
      { stateDir, driveRoot: '/drive' },
      createSyncthingConfigCoordinator(
        { stateDir, syncthingApiUrl: 'http://syncthing', syncthingApiKey: 'key' },
        fetchImpl,
      ),
    )

    expect(put?.folders).toContainEqual({ id: 'share-a', path: '/drive/share-a' })
    expect(put?.folders).toContainEqual(
      expect.objectContaining({
        id: MIRROR_FOLDER_ID,
        path: '/drive',
        devices: [{ deviceID: 'MIRROR-A' }],
      }),
    )
    expect(put?.devices).toEqual([
      { deviceID: 'SHARE-PEER' },
      { deviceID: 'MIRROR-A', name: 'mirror-a', addresses: ['dynamic'] },
    ])
  })
})
