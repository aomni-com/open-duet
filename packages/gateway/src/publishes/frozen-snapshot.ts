import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  PublishSnapshotComponentSchema,
  isPublishExcludedDrivePath,
  normalizeDrivePath,
} from '@repo/contract'

import { collectPublishSubtree } from '../routes/publish-subtree'

const SNAPSHOT_DIR = 'publish-snapshots'
export const PUBLISH_SNAPSHOT_RETENTION_GRACE_MS = 5 * 60_000
// The edge caches publish resolutions for up to ~30s; a resumed or deleted
// publish's snapshot must outlive that staleness window, nothing more.
export const PUBLISH_SNAPSHOT_RESUME_GRACE_MS = 60_000

export interface FrozenPublishIdentity {
  stateDir: string
  publishId: string
  generation: string
  anchorPath: string
  kind: 'file' | 'folder'
}

export async function createFrozenPublishSnapshot(
  args: FrozenPublishIdentity & { driveDir: string },
): Promise<void> {
  const identity = validatedIdentity(args)
  if (isPublishExcludedDrivePath(identity.anchorPath)) throw new Error('invalid_publish_anchor')
  const source = resolve(args.driveDir, identity.anchorPath)
  const sourceInfo = await lstat(source)
  if (sourceInfo.isSymbolicLink()) throw new Error('publish_anchor_is_symlink')
  if (identity.kind === 'folder' ? !sourceInfo.isDirectory() : !sourceInfo.isFile())
    throw new Error('publish_kind_mismatch')

  const parent = snapshotParent(identity.stateDir, identity.publishId)
  const target = join(parent, identity.generation)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if ((await resolveFrozenPublishRoot(identity)) !== null) return
  const partial = join(parent, `.${identity.generation}.${randomUUID()}.partial`)
  const treeRoot = join(partial, 'tree')
  const snapshotAnchor = join(treeRoot, identity.anchorPath)
  try {
    await mkdir(dirname(snapshotAnchor), { recursive: true, mode: 0o700 })
    if (identity.kind === 'file') {
      await copyRegularFileNoFollow(source, snapshotAnchor)
    } else {
      await mkdir(snapshotAnchor, { recursive: true, mode: 0o700 })
      const collected = await collectPublishSubtree(source)
      if (!collected.ok) throw new Error(collected.error)
      for (const entry of collected.entries) {
        const destination = join(snapshotAnchor, entry.relativePath)
        if (entry.kind === 'directory') {
          await mkdir(destination, { recursive: true, mode: 0o700 })
        } else {
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
          await copyRegularFileNoFollow(entry.absolutePath, destination)
        }
      }
    }
    const manifest = await open(
      join(partial, 'manifest.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    try {
      await manifest.writeFile(
        `${JSON.stringify({
          publishId: identity.publishId,
          generation: identity.generation,
          anchorPath: identity.anchorPath,
          kind: identity.kind,
        })}\n`,
      )
      await manifest.sync()
    } finally {
      await manifest.close()
    }
    await fsyncTreeDirectories(partial)
    await rename(partial, target)
    await fsyncAncestors(parent, identity.stateDir)
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
}

export async function resolveFrozenPublishRoot(
  args: FrozenPublishIdentity,
): Promise<string | null> {
  const identity = validatedIdentity(args)
  const generationDir = join(
    snapshotParent(identity.stateDir, identity.publishId),
    identity.generation,
  )
  try {
    const manifest = JSON.parse(await readFile(join(generationDir, 'manifest.json'), 'utf8')) as {
      publishId?: unknown
      generation?: unknown
      anchorPath?: unknown
      kind?: unknown
    }
    if (
      manifest.publishId !== identity.publishId ||
      manifest.generation !== identity.generation ||
      manifest.anchorPath !== identity.anchorPath ||
      manifest.kind !== identity.kind
    )
      return null
    const treeRoot = join(generationDir, 'tree')
    const anchorInfo = await lstat(join(treeRoot, identity.anchorPath))
    if (anchorInfo.isSymbolicLink()) return null
    if (identity.kind === 'folder' ? !anchorInfo.isDirectory() : !anchorInfo.isFile()) return null
    return treeRoot
  } catch {
    return null
  }
}

export async function pruneFrozenPublishSnapshots(args: {
  stateDir: string
  publishId: string
  // Present ⇒ a new pause confirmed this generation and everything else GCs
  // behind the replacement grace. Absent ⇒ the publish resumed or was
  // deleted: nothing is referenced anymore, so every generation reaps once
  // it is older than the edge resolution cache's staleness bound.
  keepGeneration?: string
  now?: number
}): Promise<void> {
  PublishSnapshotComponentSchema.parse(args.publishId)
  if (args.keepGeneration !== undefined) {
    PublishSnapshotComponentSchema.parse(args.keepGeneration)
  }
  const graceMs =
    args.keepGeneration === undefined
      ? PUBLISH_SNAPSHOT_RESUME_GRACE_MS
      : PUBLISH_SNAPSHOT_RETENTION_GRACE_MS
  const parent = snapshotParent(args.stateDir, args.publishId)
  const now = args.now ?? Date.now()
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.map(async entry => {
      if (!entry.isDirectory() || entry.name === args.keepGeneration) return
      const path = join(parent, entry.name)
      const info = await stat(path).catch(() => null)
      if (info === null || now - info.mtimeMs < graceMs) return
      await rm(path, { recursive: true, force: true })
    }),
  )
}

function validatedIdentity(args: FrozenPublishIdentity): FrozenPublishIdentity {
  PublishSnapshotComponentSchema.parse(args.publishId)
  PublishSnapshotComponentSchema.parse(args.generation)
  const anchor = normalizeDrivePath(args.anchorPath)
  if (!anchor.ok) throw new Error('invalid_publish_anchor')
  return { ...args, anchorPath: anchor.relativePath }
}

function snapshotParent(stateDir: string, publishId: string): string {
  return join(stateDir, SNAPSHOT_DIR, publishId)
}

async function copyRegularFileNoFollow(source: string, destination: string): Promise<void> {
  const sourceFile = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await sourceFile.stat()
    if (!info.isFile()) throw new Error('publish_entry_changed')
    const destinationFile = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    try {
      const buffer = Buffer.allocUnsafe(64 * 1_024)
      let position = 0
      while (true) {
        const { bytesRead } = await sourceFile.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        let written = 0
        while (written < bytesRead) {
          const result = await destinationFile.write(
            buffer,
            written,
            bytesRead - written,
            position + written,
          )
          written += result.bytesWritten
        }
        position += bytesRead
      }
      await destinationFile.utimes(info.atime, info.mtime)
      await destinationFile.sync()
    } finally {
      await destinationFile.close()
    }
  } finally {
    await sourceFile.close()
  }
}

async function fsyncTreeDirectories(root: string): Promise<void> {
  const directories = [root]
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(current, entry.name)
      directories.push(path)
      pending.push(path)
    }
  }
  for (const directory of directories.reverse()) await fsyncDirectory(directory)
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function fsyncAncestors(start: string, root: string): Promise<void> {
  let current = resolve(start)
  const resolvedRoot = resolve(root)
  while (true) {
    await fsyncDirectory(current)
    if (current === resolvedRoot) return
    const parent = dirname(current)
    if (parent === current) throw new Error('state_directory_boundary_missing')
    current = parent
  }
}
