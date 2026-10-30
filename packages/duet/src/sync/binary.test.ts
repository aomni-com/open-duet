import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { EXPECTED_SYNCTHING_VERSION } from '../../../vm-image/scripts/verify-image.js'
import {
  SYNCTHING_BINARIES,
  SYNCTHING_BIN_ENV,
  SYNCTHING_PIN,
  assertSyncthingMajor,
  resolveSyncthingBinary,
  verifySha256,
} from './binary.js'

const V2_VERSION = 'syncthing v2.1.2 "Hafnium Hornet" (go1.26.5 darwin-arm64)\n'

describe('syncthing binary pin', () => {
  test('the Mac pin equals the VM image pin (one version, both sides)', () => {
    expect(SYNCTHING_PIN.version).toBe(EXPECTED_SYNCTHING_VERSION)
  })

  test.each(['arm64', 'x64'])(
    'resolves and verifies the configured %s package before using it',
    async arch => {
      await withFixturePin(arch, async fixture => {
        const resolved = await resolveSyncthingBinary({
          platform: 'darwin',
          arch,
          env: {},
          resolvePackage: name => '/fixture/' + name + '/syncthing',
          readFileImpl: async () => fixture.bytes,
          runVersion: async () => V2_VERSION,
        })
        expect(resolved).toEqual({
          path: '/fixture/' + fixture.packageName + '/syncthing',
          version: 'v2.1.2',
          platformKey: 'darwin-' + arch,
        })
      })
    },
  )

  test('verifySha256 accepts matching bytes and rejects tampering', async () => {
    const bytes = Buffer.from('fake-syncthing-bytes')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await expect(verifySha256('/pkg/syncthing', sha256, async () => bytes)).resolves.toBeUndefined()
    await expect(
      verifySha256('/pkg/syncthing', sha256, async () => Buffer.from('tampered')),
    ).rejects.toThrow(/sha256 verification/)
  })

  test('tampered bundled bytes are rejected before the binary can execute', async () => {
    await withFixturePin('arm64', async () => {
      let executed = false
      await expect(
        resolveSyncthingBinary({
          platform: 'darwin',
          arch: 'arm64',
          env: {},
          resolvePackage: () => '/fixture/syncthing',
          readFileImpl: async () => Buffer.from('tampered'),
          runVersion: async () => {
            executed = true
            return V2_VERSION
          },
        }),
      ).rejects.toThrow(/sha256 verification/)
      expect(executed).toBe(false)
    })
  })

  test('the override path skips sha but still version-pins', async () => {
    const resolved = await resolveSyncthingBinary({
      platform: 'darwin',
      arch: 'arm64',
      env: { [SYNCTHING_BIN_ENV]: '/opt/syncthing' },
      readFileImpl: async () => {
        throw new Error('override must not read a bundled pin')
      },
      runVersion: async () => V2_VERSION,
    })
    expect(resolved.path).toBe('/opt/syncthing')
  })

  test('refuses an unexpected major', async () => {
    await expect(
      assertSyncthingMajor('/opt/syncthing', async () => 'syncthing v1.27.2 "..." (go1.21)'),
    ).rejects.toThrow(/pinned to the v2\.x line/)
    await expect(
      assertSyncthingMajor('/opt/syncthing', async () => 'syncthing v3.0.0 "..."'),
    ).rejects.toThrow(/Refusing to drive Syncthing v3/)
  })

  test('tolerates an opportunistic minor within the major', async () => {
    await expect(
      assertSyncthingMajor('/opt/syncthing', async () => 'syncthing v2.2.0 "..."'),
    ).resolves.toBe('v2.2.0')
  })

  test('rejects a non-darwin platform without an override', async () => {
    await expect(
      resolveSyncthingBinary({ platform: 'linux', arch: 'x64', env: {} }),
    ).rejects.toThrow(/macOS only/)
  })

  test('reports an unreadable version', async () => {
    await expect(
      assertSyncthingMajor('/opt/syncthing', async () => 'not syncthing at all'),
    ).rejects.toThrow(/Could not read a Syncthing version/)
  })
})

async function withFixturePin(
  arch: string,
  run: (fixture: { bytes: Buffer; packageName: string }) => Promise<void>,
): Promise<void> {
  const key = 'darwin-' + arch
  const original = SYNCTHING_BINARIES[key]
  const bytes = Buffer.from('controlled binary bytes for ' + arch)
  const packageName = 'fixture-syncthing-' + arch
  SYNCTHING_BINARIES[key] = {
    packageName,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    archiveSha256: 'unused',
  }
  try {
    await run({ bytes, packageName })
  } finally {
    SYNCTHING_BINARIES[key] = original!
  }
}
