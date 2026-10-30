import { readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { unzipSync } from 'fflate'

import { isDerivedContentPath, MAX_RECURSIVE_FILE_ENTRIES } from '@repo/contract'

import { applyUpstreamTree, type UnzippedEntry, type UpstreamManifest } from './materializer'
import type { StoredMarketplaceAgentSubscription } from './subscription-store'

// The pull bounds are the serving bounds: the hub publish's zip walk and the
// puller must agree on one limit owner or the rails drift apart.
const MAX_ARCHIVE_ENTRIES = MAX_RECURSIVE_FILE_ENTRIES

export interface ConvergeFromSnapshotInput {
  /** The cached archive. Its absence is a repairable error, never an exception. */
  snapshotPath: string
  subscription: StoredMarketplaceAgentSubscription
  /**
   * What the publisher is known to have owned, or null to treat everything on
   * disk as local work. The caller decides: a download that replaced a snapshot
   * this VM never had cannot vouch for the stored manifest.
   */
  previous: UpstreamManifest | null
  driveDir: string
  /** The materializer's journal home. MUST be on the drive's filesystem. */
  stateDir: string
  maxArchiveBytes: number
  now: number
}

export type ConvergeFromSnapshotError =
  | 'cached_snapshot_missing'
  | 'invalid_archive'
  | 'recursive_limit_exceeded'

export type ConvergeFromSnapshotResult =
  | { manifest: UpstreamManifest }
  | { error: ConvergeFromSnapshotError }

/**
 * The half of the poll that needs nothing but the disk.
 *
 * The snapshot file is the boundary between the two jobs: the network leg owns
 * "`snapshot.zip` holds the publisher's current bytes", and this owns "the drive
 * matches `snapshot.zip`". One function serves both the timer and the
 * post-download path so the two cannot drift.
 *
 * A broken boundary is a returned error, not an exception, because the caller
 * repairs it by re-fetching. Anything else — a target that is not a directory, a
 * journal that will not write — throws, and stays the pull's failure to report.
 */
export async function convergeFromSnapshot(
  input: ConvergeFromSnapshotInput,
): Promise<ConvergeFromSnapshotResult> {
  const snapshot = await stat(input.snapshotPath).catch(() => null)
  if (snapshot === null || !snapshot.isFile()) return { error: 'cached_snapshot_missing' }
  if (snapshot.size > input.maxArchiveBytes) return { error: 'recursive_limit_exceeded' }
  const archive = new Uint8Array(await readFile(input.snapshotPath))

  let entries: UnzippedEntry[]
  try {
    entries = unzipArchive(archive, input.maxArchiveBytes)
  } catch (error) {
    if (error instanceof ArchiveFailure) return { error: error.code }
    throw error
  }

  const targetDir = join(input.driveDir, input.subscription.path)
  const result = await applyUpstreamTree({
    entries,
    previous: input.previous,
    targetDir,
    stateDir: input.stateDir,
    now: new Date(input.now),
    ...(input.subscription.lastConvergedAt === undefined
      ? {}
      : { reapBefore: new Date(input.subscription.lastConvergedAt) }),
  })
  // The publisher's deletions reach the drive above; what they cannot reach
  // is anything the publisher never shipped. An app's dependencies are
  // installed here, so they are absent from every manifest, which makes them
  // indistinguishable from the user's own additions to the one rule that
  // keeps local work — and an uninstalled app was left as a folder holding
  // nothing but its `node_modules`. Derived content is not local work: it is
  // regenerable output of files that have just been removed, so it goes with
  // them, and only out of directories the publisher emptied completely.
  await pruneDerivedContent(targetDir, result.applied.deletedUpstream, result.manifest)
  return { manifest: result.manifest }
}

class ArchiveFailure extends Error {
  constructor(readonly code: ConvergeFromSnapshotError) {
    super(code)
  }
}

function unzipArchive(archive: Uint8Array, maxArchiveBytes: number): UnzippedEntry[] {
  const names = validateZipDirectory(archive, maxArchiveBytes)
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(archive)
  } catch {
    throw new ArchiveFailure('invalid_archive')
  }
  let actualBytes = 0
  return names.map(path => {
    const data = files[path]
    if (data === undefined && !path.endsWith('/')) throw new ArchiveFailure('invalid_archive')
    actualBytes += data?.byteLength ?? 0
    if (actualBytes > maxArchiveBytes) {
      throw new ArchiveFailure('recursive_limit_exceeded')
    }
    return {
      path,
      data: data ?? new Uint8Array(),
      ...(path.endsWith('/') ? { kind: 'directory' as const } : {}),
    }
  })
}

function validateZipDirectory(archive: Uint8Array, maxArchiveBytes: number): string[] {
  if (archive.byteLength < 22) throw new ArchiveFailure('invalid_archive')
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const minimum = Math.max(0, archive.byteLength - 65_557)
  let eocd = -1
  for (let offset = archive.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new ArchiveFailure('invalid_archive')
  const count = view.getUint16(eocd + 10, true)
  const directorySize = view.getUint32(eocd + 12, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (count > MAX_ARCHIVE_ENTRIES || count === 0xffff) {
    throw new ArchiveFailure('recursive_limit_exceeded')
  }
  if (directoryOffset + directorySize > eocd) throw new ArchiveFailure('invalid_archive')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const names: string[] = []
  let totalBytes = 0
  let offset = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new ArchiveFailure('invalid_archive')
    }
    if ((view.getUint16(offset + 8, true) & 1) !== 0) throw new ArchiveFailure('invalid_archive')
    const uncompressed = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    totalBytes += uncompressed
    if (uncompressed === 0xffffffff || totalBytes > maxArchiveBytes) {
      throw new ArchiveFailure('recursive_limit_exceeded')
    }
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > archive.byteLength) throw new ArchiveFailure('invalid_archive')
    let name: string
    try {
      name = decoder.decode(archive.subarray(nameStart, nameEnd))
    } catch {
      throw new ArchiveFailure('invalid_archive')
    }
    if (names.includes(name)) throw new ArchiveFailure('invalid_archive')
    names.push(name)
    offset = nameEnd + extraLength + commentLength
  }
  return names
}

/**
 * Remove derived content from directories the publisher just emptied.
 *
 * Scoped twice over, because this deletes files no manifest describes. Only
 * directories that lost a shipped file this pull are considered, and only those
 * the new manifest no longer ships anything under at all — a directory the
 * publisher still ships into keeps its `node_modules`, which is the installed
 * dependencies of a live app. What is left after the derived directories go is
 * pruned only if it is empty, so a file the user put there keeps the folder.
 */
async function pruneDerivedContent(
  targetDir: string,
  deletedUpstream: readonly string[],
  manifest: UpstreamManifest,
): Promise<void> {
  const stillShipped = Object.keys(manifest.files)
  const emptied = [...new Set(deletedUpstream.map(path => dirname(path)))]
    .filter(dir => dir !== '.')
    .filter(dir => !stillShipped.some(path => path === dir || path.startsWith(`${dir}/`)))
    .sort((left, right) => right.split('/').length - left.split('/').length)
  for (const dir of emptied) {
    const absolute = join(targetDir, dir)
    const entries = await readdir(absolute).catch(() => null)
    if (entries === null) continue
    for (const entry of entries) {
      if (!isDerivedContentPath(entry)) continue
      await rm(join(absolute, entry), { recursive: true, force: true }).catch(() => undefined)
    }
    const remaining = await readdir(absolute).catch(() => ['keep'])
    if (remaining.length !== 0) continue
    // Walk up while empty. The publisher removing a whole subtree leaves the
    // directories above the one that held files, and an empty directory holds no
    // work to protect. Stops at the subscription root, which is the agent folder
    // itself and is not this rail's to remove.
    let current = dir
    while (current !== '.' && current !== '') {
      const path = join(targetDir, current)
      const entries = await readdir(path).catch(() => ['keep'])
      if (entries.length !== 0) break
      await rmdir(path).catch(() => undefined)
      current = dirname(current)
    }
  }
}
