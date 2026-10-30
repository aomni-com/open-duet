import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lutimes, mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeBuildActivity, type BuildActivityOptions } from './build-activity'

const NOW_MS = 2_000_000_000_000

describe('probeBuildActivity', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  test('a recently created empty app folder is hot from its root mtime', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'empty-app')
    await mkdir(appDir)
    await setMtime(appDir, NOW_MS - 1_000)

    expect(await probe(appDir, root)).toEqual({
      hot: true,
      newestMtimeMs: NOW_MS - 1_000,
      recentFiles: [],
      truncated: false,
    })
  })

  test('an edited file one directory below the app root is recent activity', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'nested-app')
    const sourceDir = join(appDir, 'src')
    const sourceFile = join(sourceDir, 'index.ts')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(sourceFile, 'export {}')
    await setMtime(sourceFile, NOW_MS - 2_000)
    await setMtime(sourceDir, NOW_MS - 60_000)
    await setMtime(appDir, NOW_MS - 60_000)

    expect(await probe(appDir, root)).toEqual({
      hot: true,
      newestMtimeMs: NOW_MS - 2_000,
      recentFiles: [{ path: 'src/index.ts', mtimeMs: NOW_MS - 2_000 }],
      truncated: false,
    })
  })

  test('an old file is omitted when only the app folder root is hot', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'root-hot-app')
    const oldFile = join(appDir, 'old.ts')
    await mkdir(appDir)
    await writeFile(oldFile, 'export {}')
    await setMtime(oldFile, NOW_MS - 60_000)
    await setMtime(appDir, NOW_MS - 1_000)

    expect(await probe(appDir, root)).toEqual({
      hot: true,
      newestMtimeMs: NOW_MS - 1_000,
      recentFiles: [],
      truncated: false,
    })
  })

  test('files two directories below the app root are ignored', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'deep-app')
    const nestedDir = join(appDir, 'src', 'generated')
    const deepFile = join(nestedDir, 'client.ts')
    await mkdir(nestedDir, { recursive: true })
    await writeFile(deepFile, 'export {}')
    await setMtime(deepFile, NOW_MS - 1_000)
    await setMtime(nestedDir, NOW_MS - 60_000)
    await setMtime(join(appDir, 'src'), NOW_MS - 60_000)
    await setMtime(appDir, NOW_MS - 60_000)

    expect(await probe(appDir, root)).toEqual({
      hot: false,
      newestMtimeMs: NOW_MS - 60_000,
      recentFiles: [],
      truncated: false,
    })
  })

  test('.env and .duet entries count toward hotness but are excluded from recent files', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'private-app')
    const duetDir = join(appDir, '.duet')
    await mkdir(duetDir, { recursive: true })
    await writeFile(join(appDir, '.env'), 'TOKEN=secret')
    await writeFile(join(appDir, '.env.local'), 'TOKEN=secret')
    await writeFile(join(duetDir, 'state.json'), '{}')
    await setMtime(join(appDir, '.env'), NOW_MS - 3_000)
    await setMtime(join(appDir, '.env.local'), NOW_MS - 2_000)
    await setMtime(join(duetDir, 'state.json'), NOW_MS - 1_000)
    await setMtime(duetDir, NOW_MS - 60_000)
    await setMtime(appDir, NOW_MS - 60_000)

    expect(await probe(appDir, root)).toEqual({
      hot: true,
      newestMtimeMs: NOW_MS - 1_000,
      recentFiles: [],
      truncated: false,
    })
  })

  test('a symlinked directory is observed but never traversed', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'linked-app')
    const outsideDir = join(root, 'outside')
    const linkPath = join(appDir, 'linked')
    await mkdir(appDir)
    await mkdir(outsideDir)
    await writeFile(join(outsideDir, 'recent.ts'), 'export {}')
    await symlink(outsideDir, linkPath, 'dir')
    await setMtime(join(outsideDir, 'recent.ts'), NOW_MS - 1_000)
    await setMtime(outsideDir, NOW_MS - 60_000)
    await setMtime(appDir, NOW_MS - 60_000)
    await setLinkMtime(linkPath, NOW_MS - 60_000)

    expect(await probe(appDir, root)).toEqual({
      hot: false,
      newestMtimeMs: NOW_MS - 60_000,
      recentFiles: [],
      truncated: false,
    })
  })

  test('an anchor path escaping the drive is cold and empty', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const driveDir = join(root, 'drive')
    const outsideDir = join(root, 'outside')
    await mkdir(driveDir)
    await mkdir(outsideDir)

    expect(
      await probeBuildActivity({
        driveDir,
        anchorPath: '../outside',
        nowMs: NOW_MS,
        hotWindowMs: 30_000,
        maxEntries: 200,
        maxFiles: 6,
      }),
    ).toEqual({ hot: false, recentFiles: [], truncated: false })
  })

  test('an absent app folder is cold and empty', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))

    expect(
      await probeBuildActivity({
        driveDir: root,
        anchorPath: 'missing-app',
        nowMs: NOW_MS,
        hotWindowMs: 30_000,
        maxEntries: 200,
        maxFiles: 6,
      }),
    ).toEqual({ hot: false, recentFiles: [], truncated: false })
  })

  test('a future mtime never pins the folder hot or lists the file', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'future-app')
    const artifact = join(appDir, 'artifact.txt')
    await mkdir(appDir)
    await writeFile(artifact, 'x')
    await setMtime(artifact, NOW_MS + 60 * 60 * 1000)
    await setMtime(appDir, NOW_MS - 600_000)

    expect(await probe(appDir, root)).toEqual({
      hot: false,
      newestMtimeMs: NOW_MS - 600_000,
      recentFiles: [],
      truncated: false,
    })
  })

  test('an I/O error during the scan degrades the whole observation to cold and empty', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'unreadable-app')
    const lockedDir = join(appDir, 'locked')
    await mkdir(lockedDir, { recursive: true })
    await writeFile(join(lockedDir, 'file.ts'), 'export {}')
    await chmod(lockedDir, 0)

    try {
      expect(await probe(appDir, root)).toEqual({ hot: false, recentFiles: [], truncated: false })
    } finally {
      await chmod(lockedDir, 0o700)
    }
  })

  test('the observation cap is deterministic and files sort newest-first with a path tiebreak', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'capped-app')
    await mkdir(appDir)
    for (const name of ['z.ts', 'c.ts', 'b.ts', 'a.ts']) {
      await writeFile(join(appDir, name), name)
    }
    await setMtime(join(appDir, 'a.ts'), NOW_MS - 1_000)
    await setMtime(join(appDir, 'b.ts'), NOW_MS - 1_000)
    await setMtime(join(appDir, 'c.ts'), NOW_MS - 2_000)
    await setMtime(join(appDir, 'z.ts'), NOW_MS)
    await setMtime(appDir, NOW_MS - 60_000)

    expect(await probe(appDir, root, { maxEntries: 4 })).toEqual({
      hot: true,
      newestMtimeMs: NOW_MS - 1_000,
      recentFiles: [
        { path: 'a.ts', mtimeMs: NOW_MS - 1_000 },
        { path: 'b.ts', mtimeMs: NOW_MS - 1_000 },
        { path: 'c.ts', mtimeMs: NOW_MS - 2_000 },
      ],
      truncated: true,
    })
  })

  test('the display cap returns the newest file values and marks truncation', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'display-capped-app')
    await mkdir(appDir)
    for (const name of ['old.ts', 'middle.ts', 'new.ts']) {
      await writeFile(join(appDir, name), name)
    }
    await setMtime(join(appDir, 'old.ts'), NOW_MS - 3_000)
    await setMtime(join(appDir, 'middle.ts'), NOW_MS - 2_000)
    await setMtime(join(appDir, 'new.ts'), NOW_MS - 1_000)
    await setMtime(appDir, NOW_MS - 60_000)

    expect(await probe(appDir, root, { maxFiles: 2 })).toEqual({
      hot: true,
      newestMtimeMs: NOW_MS - 1_000,
      recentFiles: [
        { path: 'new.ts', mtimeMs: NOW_MS - 1_000 },
        { path: 'middle.ts', mtimeMs: NOW_MS - 2_000 },
      ],
      truncated: true,
    })
  })

  test('nested file observations stop at the entry budget before reaching the next child', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-build-activity-'))
    const appDir = join(root, 'nested-capped-app')
    const modulesDir = join(appDir, 'node_modules')
    await mkdir(modulesDir, { recursive: true })
    for (const name of ['a.js', 'b.js', 'c.js']) {
      await writeFile(join(modulesDir, name), name)
      await setMtime(join(modulesDir, name), NOW_MS - 1_000)
    }
    await setMtime(modulesDir, NOW_MS - 60_000)
    await setMtime(appDir, NOW_MS - 60_000)

    // Root and directory consume two entries, leaving room for two files.
    expect(await probe(appDir, root, { maxEntries: 4, maxFiles: 3 })).toEqual({
      hot: true,
      newestMtimeMs: NOW_MS - 1_000,
      recentFiles: [
        { path: 'node_modules/a.js', mtimeMs: NOW_MS - 1_000 },
        { path: 'node_modules/b.js', mtimeMs: NOW_MS - 1_000 },
      ],
      truncated: true,
    })
  })
})

async function probe(
  appDir: string,
  driveDir: string,
  overrides: Partial<BuildActivityOptions> = {},
) {
  return await probeBuildActivity({
    driveDir,
    anchorPath: appDir.slice(driveDir.length + 1),
    nowMs: NOW_MS,
    hotWindowMs: 30_000,
    maxEntries: 200,
    maxFiles: 6,
    ...overrides,
  })
}

async function setMtime(path: string, mtimeMs: number): Promise<void> {
  const date = new Date(mtimeMs)
  await utimes(path, date, date)
}

async function setLinkMtime(path: string, mtimeMs: number): Promise<void> {
  const date = new Date(mtimeMs)
  await lutimes(path, date, date)
}
