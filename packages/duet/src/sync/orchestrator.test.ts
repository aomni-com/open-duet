import { describe, expect, test } from 'bun:test'

import { DEFAULT_MIRROR_IGNORE_PATTERNS, MIRROR_FOLDER_ID } from '@repo/contract'

import {
  MAC_LOCAL_IGNORE_PATTERNS,
  configureLocalMirror,
  macMirrorIgnorePatterns,
  registerMirror,
} from './orchestrator.js'
import type { SyncthingApi, SyncthingConfig } from './syncthing-api.js'

const FULL_VM_DEVICE = 'VMDEVIC-EIDVMDE-VICEIDV-MDEVICE-IDVMDEV-ICEIDVM-DEVICEI-DVMDEVA'
const LOCAL_DEVICE = 'EL4T4B7-ICAB7HN-ASJ6537-I2CDQBP-ZCRKIQ5-75K55V3-BYNLTMJ-NC3PXQW'

describe('registerMirror', () => {
  test('POSTs to the Duet mirror-devices route and parses the grant', async () => {
    const calls: Array<{ path: string; json: unknown }> = []
    const api = {
      request: async (path: string, opts: { json?: unknown } = {}) => {
        calls.push({ path, json: opts.json })
        return new Response(
          JSON.stringify({
            machineId: 'machine_mac',
            folderId: MIRROR_FOLDER_ID,
            vmSyncthingDeviceId: FULL_VM_DEVICE,
            tunnel: {
              url: 'wss://vm.exe.dev/accept',
              tunnelToken: 'tt',
              expiresAt: 1,
            },
          }),
        )
      },
    }
    const registered = await registerMirror(api, 'acme', 'machine_mac', LOCAL_DEVICE)
    expect(calls[0]!.path).toBe('/ws/acme/mirror-devices')
    expect(calls[0]!.json).toEqual({ machineId: 'machine_mac', syncthingDeviceId: LOCAL_DEVICE })
    expect(registered.folderId).toBe(MIRROR_FOLDER_ID)
    expect(registered.vmSyncthingDeviceId).toBe(FULL_VM_DEVICE)
  })
})

describe('configureLocalMirror', () => {
  function fakeSyncthing(initial: SyncthingConfig = {}): {
    api: SyncthingApi
    config: () => SyncthingConfig
    ignores: () => string[] | null
  } {
    let stored: SyncthingConfig = initial
    let ignores: string[] | null = null
    const api: SyncthingApi = {
      base: 'http://127.0.0.1:8384',
      apiKey: 'k',
      fetch: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/rest/config') && (init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify(stored))
        }
        if (url.endsWith('/rest/config') && init?.method === 'PUT') {
          stored = JSON.parse(String(init!.body)) as SyncthingConfig
          return new Response('{}')
        }
        if (url.includes('/rest/db/ignores')) {
          ignores = (JSON.parse(String(init!.body)) as { ignore: string[] }).ignore
          return new Response('{}')
        }
        throw new Error(`unexpected ${url}`)
      },
    }
    return { api, config: () => stored, ignores: () => ignores }
  }

  const base = {
    folderId: MIRROR_FOLDER_ID,
    localDeviceId: LOCAL_DEVICE,
    vmDeviceId: FULL_VM_DEVICE,
    localDir: '/Users/me/duet/acme',
  }

  test('upserts the VM peer device and the mirror folder with pinned knobs', async () => {
    const st = fakeSyncthing()
    await configureLocalMirror(st.api, { ...base, bridgePort: 45001 })
    const config = st.config()
    expect(config.devices).toHaveLength(1)
    expect(config.devices![0]!.deviceID).toBe(FULL_VM_DEVICE)
    expect(config.devices![0]!.addresses).toEqual(['tcp://127.0.0.1:45001'])
    expect(config.folders).toHaveLength(1)
    const folder = config.folders![0]!
    expect(folder.id).toBe(MIRROR_FOLDER_ID)
    expect(folder.path).toBe('/Users/me/duet/acme')
    expect(folder.type).toBe('sendreceive')
    expect(folder.fsWatcherDelayS).toBe(1)
    expect(folder.ignorePerms).toBe(false)
    expect(folder.maxConflicts).toBe(10)
    expect(folder.devices).toEqual([{ deviceID: LOCAL_DEVICE }, { deviceID: FULL_VM_DEVICE }])
  })

  test('sets an ignore set = shared mirror ignores + macOS junk (Q7)', async () => {
    const st = fakeSyncthing()
    await configureLocalMirror(st.api, { ...base, bridgePort: 45001 })
    const ignores = st.ignores()
    expect(ignores).not.toBeNull()
    for (const pattern of DEFAULT_MIRROR_IGNORE_PATTERNS) expect(ignores).toContain(pattern)
    for (const pattern of MAC_LOCAL_IGNORE_PATTERNS) expect(ignores).toContain(pattern)
    expect(macMirrorIgnorePatterns()).toEqual(ignores!)
  })

  test('is idempotent: re-running on a new bridge port updates in place, no duplicates', async () => {
    const st = fakeSyncthing()
    await configureLocalMirror(st.api, { ...base, bridgePort: 45001 })
    await configureLocalMirror(st.api, { ...base, bridgePort: 45999 })
    const config = st.config()
    expect(config.devices).toHaveLength(1)
    expect(config.folders).toHaveLength(1)
    expect(config.devices![0]!.addresses).toEqual(['tcp://127.0.0.1:45999'])
  })
})
