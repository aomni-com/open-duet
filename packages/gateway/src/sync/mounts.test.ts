import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeMounts } from './mount-store'
import { ensureReadMountsWritable } from './mounts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async path => {
      await chmod(join(path, 'drive', 'read'), 0o755).catch(() => undefined)
      await rm(path, { recursive: true, force: true })
    }),
  )
})

describe('read mount permission migration', () => {
  test('restores owner-write on an existing 0555 read mount without changing write mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-mount-migration-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const readDir = join(driveDir, 'read')
    const writeDir = join(driveDir, 'write')
    await mkdir(readDir, { recursive: true })
    await mkdir(writeDir)
    await chmod(readDir, 0o555)
    await chmod(writeDir, 0o700)
    await writeMounts(stateDir, [
      {
        id: 'read',
        shareId: 'read',
        path: 'read',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
      {
        id: 'write',
        shareId: 'write',
        path: 'write',
        mode: 'write',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])

    await ensureReadMountsWritable({ stateDir, driveDir })

    expect((await stat(readDir)).mode & 0o777).toBe(0o755)
    expect((await stat(writeDir)).mode & 0o777).toBe(0o700)
  })
})
