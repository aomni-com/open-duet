import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { SYNCTHING_BINARIES, SYNCTHING_PIN } from './binary.js'

// The versioned-release wiring is a firewall: the `@duetso/syncthing-<os>-<arch>`
// platform packages, the pin in binary.ts, and duet's optionalDependencies
// must move together (MAP-SYNC Q8/K10/V1). A one-sided bump fails here.

const PACKAGES_DIR = join(import.meta.dir, '..', '..', '..')
const DUET_PKG = join(import.meta.dir, '..', '..', 'package.json')

async function readPackageJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

describe('platform packages match the Syncthing pin', () => {
  const expectedVersion = SYNCTHING_PIN.version.replace(/^v/, '')

  for (const [key, pin] of Object.entries(SYNCTHING_BINARIES)) {
    const arch = key.slice('darwin-'.length)
    test(`${pin.packageName} is a darwin/${arch} package pinned to ${expectedVersion}`, async () => {
      const pkg = await readPackageJson(join(PACKAGES_DIR, `syncthing-${key}`, 'package.json'))
      expect(pkg.name).toBe(pin.packageName)
      expect(pkg.version).toBe(expectedVersion)
      expect(pkg.os).toEqual(['darwin'])
      expect(pkg.cpu).toEqual([arch])
      expect(pkg.license).toBe('MPL-2.0')
      // The binary is the only payload that matters — it must be in `files`.
      expect(pkg.files).toContain('bin/syncthing')
    })
  }

  test('duet publishes every platform package as an exact optional dependency', async () => {
    const duet = await readPackageJson(DUET_PKG)
    const optional = (duet.optionalDependencies ?? {}) as Record<string, string>
    for (const pin of Object.values(SYNCTHING_BINARIES)) {
      expect(optional[pin.packageName]).toBe(expectedVersion)
    }
  })
})
