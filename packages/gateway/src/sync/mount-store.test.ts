import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { syncthingShortDeviceId } from '@repo/contract'

import {
  mirrorMachineForShortDeviceId,
  readMounts,
  readMirrorDevices,
  writeMirrorDevices,
  type MirrorDeviceRecord,
} from './mount-store'

const FULL_DEVICE_ID = 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'

describe('mirrorMachineForShortDeviceId', () => {
  const devices: MirrorDeviceRecord[] = [
    { machineId: 'cred_9', syncthingDeviceId: FULL_DEVICE_ID, registeredAt: 1 },
  ]

  test('resolves the SHORT modifiedBy device ID (first 7 chars) to the machine identity', () => {
    // Slice 18 sees only the 7-char short ID on the wire.
    expect(syncthingShortDeviceId(FULL_DEVICE_ID)).toBe('K5MNBGJ')
    expect(mirrorMachineForShortDeviceId(devices, 'K5MNBGJ')).toBe('cred_9')
    expect(mirrorMachineForShortDeviceId(devices, 'k5mnbgj')).toBe('cred_9')
  })

  test('returns null for an unknown device and for an empty short id', () => {
    expect(mirrorMachineForShortDeviceId(devices, 'UNKNOWN')).toBeNull()
    expect(mirrorMachineForShortDeviceId(devices, '')).toBeNull()
  })

  test('refuses to guess when two devices share a short prefix', () => {
    const colliding: MirrorDeviceRecord[] = [
      { machineId: 'cred_a', syncthingDeviceId: `K5MNBGJ-AAAAAAA`, registeredAt: 1 },
      { machineId: 'cred_b', syncthingDeviceId: `K5MNBGJ-BBBBBBB`, registeredAt: 2 },
    ]
    expect(mirrorMachineForShortDeviceId(colliding, 'K5MNBGJ')).toBeNull()
  })
})

test('mirror device records round-trip through the state dir', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-mount-store-'))
  try {
    expect(await readMirrorDevices(stateDir)).toEqual([])
    const records: MirrorDeviceRecord[] = [
      {
        machineId: 'cred_9',
        syncthingDeviceId: FULL_DEVICE_ID,
        deviceName: 'MacBook Pro',
        registeredAt: 1767290000000,
      },
    ]
    await writeMirrorDevices(stateDir, records)
    expect(await readMirrorDevices(stateDir)).toEqual(records)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('legacy mount records without a role migrate to recipient', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-mount-store-'))
  try {
    await writeFile(
      join(stateDir, 'sync-mounts.json'),
      JSON.stringify([
        {
          id: 'share-old',
          shareId: 'share-old',
          path: 'shared',
          mode: 'read',
          ignorePatterns: [],
        },
      ]),
    )

    expect(await readMounts(stateDir)).toEqual([
      {
        id: 'share-old',
        shareId: 'share-old',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
