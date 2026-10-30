import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSeedArchive } from '@repo/seed-drive'

import { completePendingRestore, persistPendingRestore } from './archive'

const seedPackageEntry = fileURLToPath(import.meta.resolve('@repo/seed-drive'))
const seedContentDir = join(dirname(seedPackageEntry), '..', 'content')

test('the gateway restore rail reproduces every seed content byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-seed-restore-'))
  try {
    const driveDir = join(root, 'drive')
    const stateDir = join(root, '.duet')
    const archive = await buildSeedArchive()
    await persistPendingRestore(stateDir, {
      kind: 'birth-seed',
      url: 'http://backend/seed-archive',
      sha256: archive.sha256,
    })

    await completePendingRestore({
      driveDir,
      stateDir,
      fetch: async () =>
        new Response(archive.bytes.slice(), {
          headers: { 'content-type': 'application/x-tar' },
        }),
      getVmToken: () => 'vm-token',
      extraHeaders: {},
      runCommand: async () => ({ exitCode: 0 }),
    })

    expect(await readTree(driveDir)).toEqual(await readTree(seedContentDir))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function readTree(root: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}

  async function visit(relativeDir: string): Promise<void> {
    const entries = await readdir(join(root, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      const path = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files[path] = new Uint8Array(await readFile(join(root, path)))
    }
  }

  await visit('')
  return files
}
