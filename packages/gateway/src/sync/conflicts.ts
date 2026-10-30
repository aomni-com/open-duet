import { readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { isPathInside } from '@repo/contract'

const CONFLICT_MARKER = '.sync-conflict-'

export async function listConflictFiles(root: string, driveDir: string): Promise<string[]> {
  const conflicts: string[] = []
  if (!isPathInside(driveDir, root)) return conflicts
  await walk(root, async path => {
    if (basename(path).includes(CONFLICT_MARKER)) conflicts.push(relativeDrivePath(path, driveDir))
  })
  return conflicts.sort((a, b) => a.localeCompare(b))
}

async function walk(path: string, visit: (path: string) => Promise<void>): Promise<void> {
  let entryStat
  try {
    entryStat = await stat(path)
  } catch {
    return
  }
  if (!entryStat.isDirectory()) {
    await visit(path)
    return
  }
  for (const entry of await readdir(path)) {
    await walk(join(path, entry), visit)
  }
}

function relativeDrivePath(path: string, driveDir: string): string {
  return resolve(path).slice(resolve(driveDir).length + 1)
}
