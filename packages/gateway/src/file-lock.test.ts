import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withFileLock } from './file-lock'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('withFileLock', () => {
  test('a live owner keeps a long action exclusive beyond the stale threshold', async () => {
    const { path } = await makeLock()
    let releaseOwner!: () => void
    const ownerMayExit = new Promise<void>(resolve => {
      releaseOwner = resolve
    })
    let ownerStarted!: () => void
    const ownerDidStart = new Promise<void>(resolve => {
      ownerStarted = resolve
    })
    let active = 0
    let maximum = 0

    const owner = withFileLock(
      path,
      async () => {
        active += 1
        maximum = Math.max(maximum, active)
        ownerStarted()
        await ownerMayExit
        active -= 1
      },
      { staleMs: 2_000, retryMs: 5 },
    )
    await ownerDidStart
    await Bun.sleep(2_100)

    const contender = withFileLock(
      path,
      async () => {
        active += 1
        maximum = Math.max(maximum, active)
        active -= 1
      },
      { staleMs: 2_000, retryMs: 5 },
    )
    try {
      await Bun.sleep(20)
      expect(maximum).toBe(1)
    } finally {
      releaseOwner()
      await Promise.all([owner, contender])
    }

    expect(maximum).toBe(1)
  })

  test('reclaims an expired claim without deleting a successor', async () => {
    const { path } = await makeLock()
    await mkdir(path)
    await utimes(path, new Date(1), new Date(1))
    let active = 0
    let maximum = 0

    await Promise.all(
      [1, 2].map(async () => {
        await withFileLock(
          path,
          async () => {
            active += 1
            maximum = Math.max(maximum, active)
            await Bun.sleep(5)
            active -= 1
          },
          { staleMs: 2_000, retryMs: 1 },
        )
      }),
    )

    expect(maximum).toBe(1)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('times out instead of waiting forever on a current owner', async () => {
    const { path } = await makeLock()
    await mkdir(path)

    await expect(
      withFileLock(path, async () => undefined, {
        waitMs: 15,
        staleMs: 2_000,
        retryMs: 5,
      }),
    ).rejects.toThrow(/timed out acquiring file lock/i)
    expect(await readdir(path)).toEqual([])
  })
})

async function makeLock(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'duet-file-lock-'))
  roots.push(root)
  const path = join(root, 'owner.lock')
  return { root, path }
}
