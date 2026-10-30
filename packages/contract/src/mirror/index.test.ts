import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_MIRROR_IGNORE_PATTERNS,
  MIRROR_FOLDER_ID,
  MIRROR_FOLDER_KNOBS,
  MirrorRegisterRequestSchema,
  MirrorRegisteredSchema,
  syncthingShortDeviceId,
} from './index'

const FULL_DEVICE_ID = 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'

describe('mirror ignore patterns (G1)', () => {
  test('excludes machine-local state but keeps env files (personal replica)', () => {
    expect(DEFAULT_MIRROR_IGNORE_PATTERNS).toContain('**/.git')
    expect(DEFAULT_MIRROR_IGNORE_PATTERNS).toContain('(?d)**/node_modules')
    expect(DEFAULT_MIRROR_IGNORE_PATTERNS).toContain('.duet')
    expect(DEFAULT_MIRROR_IGNORE_PATTERNS).not.toContain('.duet-anchor')
    expect(DEFAULT_MIRROR_IGNORE_PATTERNS).not.toContain('**/.duet-anchor')
    // A mirror syncs .env* — its secrets travel (as does the share default
    // since ledger #14; both now keep .env out of the ignore list).
    expect(DEFAULT_MIRROR_IGNORE_PATTERNS.some(pattern => pattern.includes('.env'))).toBe(false)
  })
})

describe('mirror folder knobs (K3/K5/K6/K7)', () => {
  test('fsWatcherDelayS is strictly positive (L22: <=0 disables the watcher)', () => {
    expect(MIRROR_FOLDER_KNOBS.fsWatcherDelayS).toBeGreaterThan(0)
  })

  test('keeps executable permissions on the shared bidirectional folder', () => {
    expect(MIRROR_FOLDER_KNOBS.ignorePerms).toBe(false)
    expect(MIRROR_FOLDER_KNOBS.type).toBe('sendreceive')
    expect(MIRROR_FOLDER_ID).toBe('workspace-drive')
  })
})

describe('Syncthing device id', () => {
  test('the short id slice 18 sees is the first 7 chars', () => {
    expect(syncthingShortDeviceId(FULL_DEVICE_ID)).toBe('K5MNBGJ')
  })

  test('the schema accepts a canonical id and rejects junk', () => {
    expect(
      MirrorRegisterRequestSchema.safeParse({
        machineId: 'machine_9',
        syncthingDeviceId: FULL_DEVICE_ID,
      }).success,
    ).toBe(true)
    expect(
      MirrorRegisterRequestSchema.safeParse({
        machineId: 'machine_9',
        syncthingDeviceId: 'not a device id!',
      }).success,
    ).toBe(false)
    expect(
      MirrorRegisterRequestSchema.safeParse({ machineId: 'machine_9', syncthingDeviceId: '' })
        .success,
    ).toBe(false)
  })
})

describe('mirror wire schemas', () => {
  test('register request requires a device id', () => {
    expect(
      MirrorRegisterRequestSchema.safeParse({
        machineId: 'machine_9',
        syncthingDeviceId: FULL_DEVICE_ID,
      }).success,
    ).toBe(true)
    expect(MirrorRegisterRequestSchema.safeParse({}).success).toBe(false)
  })

  test('registered response carries the folder, VM device id, and tunnel grant', () => {
    const parsed = MirrorRegisteredSchema.safeParse({
      machineId: 'machine_9',
      folderId: 'workspace-drive',
      vmSyncthingDeviceId: 'VMDEVICE-ID',
      tunnel: {
        url: 'wss://vm.exe.dev/v1/tunnel/accept/mirror-cred_9-abc',
        tunnelToken: 'tok',
        expiresAt: 1767290000000,
      },
    })
    expect(parsed.success).toBe(true)
  })
})
