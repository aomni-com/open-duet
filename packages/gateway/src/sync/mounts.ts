import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { isPathInside } from '@repo/contract'

import { readMounts } from './mount-store'

/** One-time/idempotent migration from the removed read-mount 0555 policy. */
export async function ensureReadMountsWritable(options: {
  stateDir: string
  driveDir: string
}): Promise<void> {
  const mounts = await readMounts(options.stateDir)
  for (const mount of mounts) {
    if (mount.mode !== 'read') continue
    const mountDir = await safeDriveDirectory(options.driveDir, mount.path)
    if (mountDir === null) continue
    const info = await lstat(mountDir)
    if ((info.mode & 0o200) === 0) await chmod(mountDir, info.mode | 0o200)
  }
}

export async function safeDriveDirectory(
  driveDir: string,
  relativePath: string,
): Promise<string | null> {
  await mkdir(driveDir, { recursive: true })
  const root = await realpath(driveDir)
  let current = root
  for (const part of relativePath.split('/').filter(Boolean)) {
    const next = join(current, part)
    try {
      const info = await lstat(next)
      if (info.isSymbolicLink() || !info.isDirectory()) return null
    } catch (error) {
      if (!isNotFoundError(error)) throw error
      await mkdir(next)
    }
    const resolved = await realpath(next)
    if (!isPathInside(root, resolved)) return null
    current = resolved
  }
  return current
}

export async function assertSafeDirectory(driveDir: string, path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null)
  if (info === null || info.isSymbolicLink() || !info.isDirectory()) return false
  const root = await realpath(driveDir)
  const resolved = await realpath(path)
  return isPathInside(root, resolved)
}

export async function writeNoFollowFile(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      mode,
    )
  } catch (error) {
    if (isUnsafeFinalComponentError(error)) throw new Error('Invalid mount path: symlink escape')
    throw error
  }
  try {
    await handle.writeFile(contents)
  } finally {
    await handle.close()
  }
}

/**
 * Write a Syncthing folder's `.stignore` — the one owner of the on-disk shape
 * (one pattern per line, trailing newline, mode 0o644, no-follow). Every share
 * mount and the whole-drive mirror folder go through here.
 */
export async function writeStignore(folderDir: string, patterns: readonly string[]): Promise<void> {
  await writeNoFollowFile(join(folderDir, '.stignore'), `${patterns.join('\n')}\n`, 0o644)
}

function isUnsafeFinalComponentError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ['ELOOP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
  )
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
