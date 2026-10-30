import type { Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveAppFolder } from './app-folder'

export const DEFAULT_BUILD_ACTIVITY_HOT_WINDOW_MS = 30_000
export const DEFAULT_BUILD_ACTIVITY_MAX_ENTRIES = 200
export const DEFAULT_BUILD_ACTIVITY_MAX_FILES = 6

export type BuildActivityOptions = {
  driveDir: string
  anchorPath: string
  nowMs: number
  hotWindowMs: number
  maxEntries: number
  maxFiles: number
}

export type BuildActivity = {
  hot: boolean
  newestMtimeMs?: number
  recentFiles: readonly { path: string; mtimeMs: number }[]
  truncated: boolean
}

export async function probeBuildActivity(options: BuildActivityOptions): Promise<BuildActivity> {
  if (options.maxEntries < 1) return coldActivity()

  try {
    const folder = await resolveAppFolder(options.driveDir, options.anchorPath)
    return await scanFolder(folder.path, folder.info, options)
  } catch {
    return coldActivity()
  }
}

async function scanFolder(
  folderPath: string,
  rootInfo: Stats,
  options: BuildActivityOptions,
): Promise<BuildActivity> {
  // Future mtimes (extracted archives, copied artifacts, clock skew) must
  // never pin the window open: an observation only counts when it is not
  // ahead of the probe's clock.
  const observable = (mtimeMs: number) => mtimeMs <= options.nowMs
  let newestMtimeMs = observable(rootInfo.mtimeMs) ? rootInfo.mtimeMs : 0
  const recentFiles: { path: string; mtimeMs: number }[] = []
  const entries = (await readdir(folderPath)).sort(comparePaths)
  const pending = entries.map(name => ({ path: name, depth: 0 }))
  let observed = 1
  let index = 0

  while (index < pending.length && observed < options.maxEntries) {
    const entry = pending[index]
    index += 1
    if (entry === undefined) break
    const relativePath = entry.path
    const info = await lstat(join(folderPath, relativePath))
    observed += 1
    if (observable(info.mtimeMs)) newestMtimeMs = Math.max(newestMtimeMs, info.mtimeMs)
    if (
      info.isFile() &&
      observable(info.mtimeMs) &&
      isWithinHotWindow(info.mtimeMs, options) &&
      !isPrivatePath(relativePath)
    ) {
      recentFiles.push({ path: relativePath, mtimeMs: info.mtimeMs })
    }
    if (entry.depth === 0 && info.isDirectory()) {
      const children = (await readdir(join(folderPath, relativePath))).sort(comparePaths)
      pending.push(...children.map(name => ({ path: `${relativePath}/${name}`, depth: 1 })))
    }
  }

  recentFiles.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || comparePaths(left.path, right.path),
  )
  const truncated = index < pending.length || recentFiles.length > options.maxFiles

  return {
    hot: isWithinHotWindow(newestMtimeMs, options),
    newestMtimeMs,
    recentFiles: recentFiles.slice(0, Math.max(0, options.maxFiles)),
    truncated,
  }
}

function isWithinHotWindow(mtimeMs: number, options: BuildActivityOptions): boolean {
  return options.nowMs - mtimeMs <= options.hotWindowMs
}

function coldActivity(): BuildActivity {
  return { hot: false, recentFiles: [], truncated: false }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isPrivatePath(path: string): boolean {
  return path
    .split('/')
    .some(name => name === '.duet' || name === '.env' || name.startsWith('.env.'))
}
