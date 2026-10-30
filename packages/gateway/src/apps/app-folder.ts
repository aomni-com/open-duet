import type { Stats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import { isPathInside, normalizeDrivePath } from '@repo/contract'

type ResolvedAppFolder = {
  path: string
  info: Stats
}

export async function resolveAppFolder(
  driveDir: string,
  anchorPath: string,
): Promise<ResolvedAppFolder> {
  const normalized = normalizeDrivePath(anchorPath)
  if (!normalized.ok) throw new Error(`Invalid app anchor path: ${normalized.reason}`)
  const path = resolve(driveDir, normalized.relativePath)
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Invalid app anchor path')
  const root = await realpath(driveDir)
  const resolved = await realpath(path)
  if (!isPathInside(root, resolved)) throw new Error('Invalid app anchor path')
  return { path: resolved, info }
}
