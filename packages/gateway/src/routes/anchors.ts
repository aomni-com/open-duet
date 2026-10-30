import type { Dir, Dirent } from 'node:fs'
import { lstat, mkdir, opendir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import {
  DUET_ANCHOR_MARKER_FILE,
  MAX_ANCHOR_RENAME_CANDIDATES,
  AnchorMoveCandidatesReportSchema,
  noisyTreeRoot,
  type AnchorMoveCandidatesReport,
  type GatewayAnchor,
} from '@repo/contract'

import { writeAtomicJson } from '../atomic-json'
import { assertSafeDirectory, safeDriveDirectory, writeNoFollowFile } from '../sync/mounts'

export interface AnchorReconcilerOptions {
  driveDir: string
  stateDir: string
  reportMoveCandidates: (reports: AnchorMoveCandidatesReport[]) => Promise<void>
  /** Called when a cycle is skipped, with why — reconciliation is blind until it stops. */
  onReconcileSkipped?: (reason: 'drive_unreadable' | 'restore_in_flight') => void
  /**
   * Whether a drive restore is mid-flight. The restore empties the drive root's
   * children and swaps staged ones in, so a walk landing inside that window sees
   * folders that are about to exist as folders that do not.
   */
  restoreInFlight?: () => boolean
  onReconcileTelemetry?: (event: AnchorReconcileTelemetry) => void
  /** Maximum directory entries processed by one mover search. */
  walkEntryLimit?: number
  now?: () => number
}

export interface AnchorReconcileTelemetry {
  path: 'fast' | 'slow' | 'skipped'
  anchorCount: number
  anchorProbes: number
  walkEntries: number
  markerResolutionOperations: number
  excludedSubtrees: number
  durationMs: number
  skipReason?: 'drive_unreadable' | 'restore_in_flight'
  walkLimitReached?: boolean
}

export interface AnchorReconciler {
  reconcile(anchors: GatewayAnchor[]): Promise<AnchorMoveCandidatesReport[]>
}

interface AnchorSnapshot {
  path: string
  inodeKey: string | null
  marker: string | null
  kind: 'directory' | 'file'
  consecutiveMissingPolls: number
  pendingReport?: {
    report: AnchorMoveCandidatesReport
    anchorIdentity: string
  }
}

interface PathSnapshot {
  path: string
  inodeKey: string
  kind: 'directory' | 'file'
  marker: string | null
}

const SNAPSHOT_FILE = 'anchor-snapshots.json'
const DEFAULT_WALK_ENTRY_LIMIT = 40_960

export function createAnchorReconciler(options: AnchorReconcilerOptions): AnchorReconciler {
  const config = options
  const previous = new Map<string, AnchorSnapshot>()
  let loadedPrevious = false

  async function reconcile(anchors: GatewayAnchor[]): Promise<AnchorMoveCandidatesReport[]> {
    const startedAt = config.now?.() ?? performance.now()
    if (config.restoreInFlight?.() === true) {
      config.onReconcileSkipped?.('restore_in_flight')
      emitTelemetry('skipped', anchors.length, 0, 0, 0, startedAt, 'restore_in_flight')
      return []
    }
    await loadPreviousOnce()
    if (anchors.length === 0) {
      if (previous.size > 0) {
        previous.clear()
        await persistPrevious()
      }
      emitTelemetry('fast', 0, 0, 0, 0, startedAt)
      return []
    }
    const pendingReports: AnchorMoveCandidatesReport[] = []
    let pendingCleared = false
    let pendingProbeCount = 0
    for (const anchor of anchors) {
      const snapshot = previous.get(anchor.id)
      if (snapshot?.pendingReport === undefined) continue
      if (
        snapshot.path !== anchor.path ||
        snapshot.pendingReport.anchorIdentity !== anchorReportIdentity(anchor)
      ) {
        delete snapshot.pendingReport
        pendingCleared = true
        continue
      }
      pendingProbeCount += 1
      const current = await probeAnchorPath(config.driveDir, anchor.path)
      if (current !== undefined && canUseDirectAnchorSnapshot(anchor, current, snapshot)) {
        delete snapshot.pendingReport
        pendingCleared = true
        continue
      }
      pendingReports.push(snapshot.pendingReport.report)
    }
    if (pendingCleared) await persistPrevious()
    if (pendingReports.length > 0) {
      emitTelemetry('fast', anchors.length, pendingProbeCount, 0, 0, startedAt)
      await config.reportMoveCandidates(pendingReports)
      for (const report of pendingReports) {
        const snapshot = previous.get(report.anchorId)
        if (snapshot !== undefined) delete snapshot.pendingReport
      }
      await persistPrevious()
      return pendingReports
    }
    // A drive we cannot read is not a drive with nothing on it. Every anchor
    // would report its folder missing in the same breath, and one unmount, one
    // permission fault, one half-finished restore would read downstream as the
    // user having deleted every app and agent they own. Missing-folder evidence
    // is only evidence when the walk actually happened: skip the cycle whole —
    // no reports, and no missing counters advanced, so nothing inches toward a
    // reap on the strength of a walk that never looked.
    const directlyProbed = await Promise.all(
      anchors.map(anchor => probeAnchorPath(config.driveDir, anchor.path)),
    )
    const directPathIsUsable = directlyProbed.every((current, index) => {
      const anchor = anchors[index]!
      return (
        current !== undefined &&
        canUseDirectAnchorSnapshot(anchor, current, previous.get(anchor.id))
      )
    })
    let currentPaths: PathSnapshot[]
    let walkEntries = 0
    let excludedSubtrees = 0
    let walkComplete = true
    if (directPathIsUsable) {
      currentPaths = directlyProbed as PathSnapshot[]
    } else {
      const drive = await snapshotDrive(
        config.driveDir,
        config.walkEntryLimit ?? DEFAULT_WALK_ENTRY_LIMIT,
      )
      if (!drive.ok) {
        config.onReconcileSkipped?.('drive_unreadable')
        emitTelemetry(
          'skipped',
          anchors.length,
          anchors.length,
          0,
          0,
          startedAt,
          'drive_unreadable',
        )
        return []
      }
      if (!drive.certain) {
        config.onReconcileSkipped?.('drive_unreadable')
        emitTelemetry(
          'skipped',
          anchors.length,
          anchors.length,
          drive.walkEntries,
          drive.excludedSubtrees,
          startedAt,
          'drive_unreadable',
        )
        return []
      }
      const moverPathsByPath = new Map(drive.paths.map(snapshot => [snapshot.path, snapshot]))
      directlyProbed.forEach(snapshot => {
        if (snapshot !== undefined) moverPathsByPath.set(snapshot.path, snapshot)
      })
      currentPaths = Array.from(moverPathsByPath.values())
      walkEntries = drive.walkEntries
      excludedSubtrees = drive.excludedSubtrees
      walkComplete = drive.complete
    }
    const byPath = new Map(currentPaths.map(snapshot => [snapshot.path, snapshot]))
    const byInode = groupByInode(currentPaths)
    const byMarker = groupByMarker(currentPaths)
    const reports: AnchorMoveCandidatesReport[] = []
    const anchorsById = new Map(anchors.map(anchor => [anchor.id, anchor]))
    const activeIds = new Set(anchorsById.keys())
    let snapshotsChanged = false
    let markerResolutionOperations = currentPaths.length

    for (const anchor of anchors) {
      const earlier = previous.get(anchor.id)
      const current = byPath.get(anchor.path)
      if (current !== undefined) {
        const prepared = await prepareCurrentAnchorSnapshot(
          config.driveDir,
          anchor,
          current,
          earlier,
        )
        if (prepared.ok) {
          previous.set(anchor.id, {
            ...prepared.snapshot,
            consecutiveMissingPolls: 0,
          })
          snapshotsChanged = true
          continue
        }
        const missing = recordMissingObservation(anchor, earlier)
        previous.set(anchor.id, missing)
        snapshotsChanged = true
        markerResolutionOperations += 1
        reports.push({
          anchorId: anchor.id,
          candidates: renameCandidatesFromEarlier(earlier, byInode),
          anchorPathExists: true,
          consecutiveMissingPolls: missing.consecutiveMissingPolls,
          markerMatches: markerMatchesForAnchor(anchor, byMarker),
        })
        continue
      }

      // A newly accepted share delivers its mount anchor and sync projection
      // together, while anchors intentionally reconcile first. Active only: a
      // broken anchor is observed, never materialized, or recreating the folder
      // would be this rail answering a question the share rail owns.
      if (earlier === undefined && anchor.kind === 'share-mount' && anchor.state === 'active') {
        const materialized = await materializeShareMount(config.driveDir, anchor)
        if (materialized !== null) {
          previous.set(anchor.id, {
            ...materialized,
            consecutiveMissingPolls: 0,
          })
          snapshotsChanged = true
          continue
        }
      }

      const missing = recordMissingObservation(anchor, earlier)
      previous.set(anchor.id, missing)
      snapshotsChanged = true
      markerResolutionOperations += 1
      reports.push({
        anchorId: anchor.id,
        candidates: renameCandidatesFromEarlier(earlier, byInode),
        anchorPathExists: false,
        consecutiveMissingPolls: missing.consecutiveMissingPolls,
        markerMatches: markerMatchesForAnchor(anchor, byMarker),
        missingIsConclusive: true,
      })
    }

    for (const anchorId of Array.from(previous.keys())) {
      if (!activeIds.has(anchorId)) {
        previous.delete(anchorId)
        snapshotsChanged = true
      }
    }

    for (const report of reports) {
      const snapshot = previous.get(report.anchorId)
      const anchor = anchorsById.get(report.anchorId)
      if (snapshot !== undefined && anchor !== undefined) {
        snapshot.pendingReport = {
          report,
          anchorIdentity: anchorReportIdentity(anchor),
        }
      }
    }
    if (snapshotsChanged || reports.length > 0) await persistPrevious()

    emitTelemetry(
      directPathIsUsable ? 'fast' : 'slow',
      anchors.length,
      anchors.length,
      walkEntries,
      excludedSubtrees,
      startedAt,
      undefined,
      markerResolutionOperations,
      !walkComplete,
    )
    if (reports.length > 0) {
      await config.reportMoveCandidates(reports)
      for (const report of reports) {
        const snapshot = previous.get(report.anchorId)
        if (snapshot !== undefined) delete snapshot.pendingReport
      }
      await persistPrevious()
    }
    return reports
  }

  function emitTelemetry(
    path: AnchorReconcileTelemetry['path'],
    anchorCount: number,
    anchorProbes: number,
    walkEntries: number,
    excludedSubtrees: number,
    startedAt: number,
    skipReason?: AnchorReconcileTelemetry['skipReason'],
    markerResolutionOperations = 0,
    walkLimitReached = false,
  ): void {
    const finishedAt = config.now?.() ?? performance.now()
    config.onReconcileTelemetry?.({
      path,
      anchorCount,
      anchorProbes,
      walkEntries,
      markerResolutionOperations,
      excludedSubtrees,
      durationMs: Math.max(0, finishedAt - startedAt),
      ...(skipReason === undefined ? {} : { skipReason }),
      ...(walkLimitReached ? { walkLimitReached: true } : {}),
    })
  }

  async function loadPreviousOnce(): Promise<void> {
    if (loadedPrevious) return
    loadedPrevious = true
    try {
      const parsed = JSON.parse(
        await readFile(join(config.stateDir, SNAPSHOT_FILE), 'utf8'),
      ) as unknown
      if (!Array.isArray(parsed)) return
      for (const entry of parsed) {
        if (!isSnapshotEntry(entry)) continue
        previous.set(entry.anchorId, {
          path: entry.path,
          inodeKey: entry.inodeKey,
          marker: entry.marker,
          kind: entry.kind,
          consecutiveMissingPolls: entry.consecutiveMissingPolls ?? 0,
          ...(entry.pendingReport === undefined ? {} : { pendingReport: entry.pendingReport }),
        })
      }
    } catch {
      // Missing or corrupt snapshots only remove inode history; marker evidence still lets the backend resolve conservatively.
    }
  }

  async function persistPrevious(): Promise<void> {
    const entries = Array.from(previous.entries()).map(([anchorId, snapshot]) => ({
      anchorId,
      ...snapshot,
    }))
    writeAtomicJson(join(config.stateDir, SNAPSHOT_FILE), entries)
  }

  return { reconcile }
}

async function materializeShareMount(
  driveDir: string,
  anchor: GatewayAnchor,
): Promise<AnchorSnapshot | null> {
  const directory = await safeDriveDirectory(driveDir, anchor.path)
  if (directory === null || !(await assertSafeDirectory(driveDir, directory))) return null
  const marker = markerPayload(anchor)
  try {
    await writeNoFollowFile(join(directory, DUET_ANCHOR_MARKER_FILE), `${marker}\n`, 0o600)
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid mount path: symlink escape')
      return null
    throw error
  }
  if (!(await assertSafeDirectory(driveDir, directory))) return null
  const info = await lstat(directory)
  return {
    path: anchor.path,
    inodeKey: `${info.dev}:${info.ino}`,
    marker,
    kind: 'directory',
    consecutiveMissingPolls: 0,
  }
}

/**
 * Walk the drive, distinguishing "nothing is there" from "we could not look".
 *
 * The root is probed on its own and its failures are fatal to the cycle: an
 * empty result is treated downstream as proof that folders are gone, so it must
 * only ever mean a readable drive that really is empty. Failures deeper in the
 * tree stay swallowed — one unreadable subdirectory is a local fact, and the
 * anchors inside it report missing on their own evidence.
 */
async function snapshotDrive(
  driveDir: string,
  entryLimit: number,
): Promise<
  | {
      ok: true
      complete: boolean
      paths: PathSnapshot[]
      walkEntries: number
      excludedSubtrees: number
      certain: boolean
    }
  | { ok: false }
> {
  try {
    if (!(await lstat(driveDir)).isDirectory()) return { ok: false }
  } catch {
    return { ok: false }
  }
  const paths: PathSnapshot[] = []
  const directories = [driveDir]
  let walkEntries = 0
  let excludedSubtrees = 0
  let certain = true
  for (const directory of directories) {
    let handle: Dir
    try {
      handle = await opendir(directory)
    } catch {
      if (directory === driveDir) return { ok: false }
      certain = false
      continue
    }
    while (true) {
      let entry: Dirent<string> | null
      try {
        entry = await handle.read()
      } catch {
        closeDirectory(handle)
        if (directory === driveDir) return { ok: false }
        certain = false
        break
      }
      if (entry === null) {
        closeDirectory(handle)
        break
      }
      if (walkEntries >= entryLimit) {
        closeDirectory(handle)
        return { ok: true, complete: false, paths, walkEntries, excludedSubtrees, certain }
      }
      walkEntries += 1
      const current = join(directory, entry.name)
      const path = relative(driveDir, current).split(sep).join('/')
      if (noisyTreeRoot(path) !== null) {
        excludedSubtrees += 1
        continue
      }
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await lstat(current)
      } catch {
        certain = false
        continue
      }
      const isDirectory = info.isDirectory()
      const inodeKey = `${info.dev}:${info.ino}`
      const marker = isDirectory ? await readAnchorMarkerResult(current, inodeKey) : null
      if (marker !== null && !marker.ok) certain = false
      paths.push({
        path,
        inodeKey,
        kind: isDirectory ? 'directory' : 'file',
        marker: marker?.value ?? null,
      })
      if (isDirectory) directories.push(current)
    }
  }
  return { ok: true, complete: true, paths, walkEntries, excludedSubtrees, certain }
}

function closeDirectory(directory: Dir): void {
  try {
    directory.closeSync()
  } catch {
    // A failed read may already have closed the handle.
  }
}

async function probeAnchorPath(driveDir: string, path: string): Promise<PathSnapshot | undefined> {
  const absolutePath = join(driveDir, path)
  try {
    const info = await lstat(absolutePath)
    const isDirectory = info.isDirectory()
    return {
      path,
      inodeKey: `${info.dev}:${info.ino}`,
      kind: isDirectory ? 'directory' : 'file',
      marker: isDirectory ? await readAnchorMarker(absolutePath) : null,
    }
  } catch {
    return undefined
  }
}

function canUseDirectAnchorSnapshot(
  anchor: GatewayAnchor,
  current: PathSnapshot,
  earlier: AnchorSnapshot | undefined,
): boolean {
  if (current.kind === 'file') {
    return (
      earlier === undefined ||
      (earlier.kind === 'file' &&
        (earlier.inodeKey === null || earlier.inodeKey === current.inodeKey))
    )
  }
  const expected = markerPayload(anchor)
  if (current.marker === expected || anchor.state !== 'active') return true
  return !(
    earlier !== undefined &&
    earlier.path === anchor.path &&
    (earlier.kind !== 'directory' || earlier.marker === expected)
  )
}

async function prepareCurrentAnchorSnapshot(
  driveDir: string,
  anchor: GatewayAnchor,
  current: PathSnapshot,
  earlier: AnchorSnapshot | undefined,
): Promise<{ ok: true; snapshot: AnchorSnapshot } | { ok: false }> {
  if (current.kind === 'file') {
    if (earlier !== undefined && earlier.kind !== 'file') return { ok: false }
    if (
      earlier !== undefined &&
      earlier.kind === 'file' &&
      earlier.inodeKey !== null &&
      earlier.inodeKey !== current.inodeKey
    )
      return { ok: false }
    return {
      ok: true,
      snapshot: {
        path: anchor.path,
        inodeKey: current.inodeKey,
        marker: null,
        kind: 'file',
        consecutiveMissingPolls: 0,
      },
    }
  }

  const expected = markerPayload(anchor)
  if (current.marker === expected) {
    return {
      ok: true,
      snapshot: {
        path: anchor.path,
        inodeKey: current.inodeKey,
        marker: expected,
        kind: 'directory',
        consecutiveMissingPolls: 0,
      },
    }
  }
  // A broken anchor is observed, never adopted. Broken anchors ride the
  // projection only so their verdict can be rechecked — the folder may come back
  // under a new name, or stay gone and have its row reaped — but nobody has
  // authorized a reclaim, and stamping this anchor's marker onto whatever now
  // occupies the path would be adopting a stranger's folder on no authority.
  // Something IS here, so there is no missing-folder verdict to reach either:
  // record what is actually on disk and report nothing, because re-deciding
  // `broken` on an already-broken anchor every 5 seconds is pure audit spam.
  if (anchor.state !== 'active') {
    return {
      ok: true,
      snapshot: {
        path: anchor.path,
        inodeKey: current.inodeKey,
        marker: current.marker,
        kind: 'directory',
        consecutiveMissingPolls: 0,
      },
    }
  }

  // The anti-hijack refusal: a known directory anchor whose folder no longer
  // carries the expected marker is, at this path, a stranger — refused, never
  // silently re-adopted. But only while the CLAIM is the one that was already
  // refused: the backend re-mints the marker nonce exclusively through an
  // editor-authenticated reanchor or register-heal, so an expected payload the
  // earlier snapshot never carried is proof of an authorized reclaim and is
  // adopted immediately — no waiting for the refused snapshot to age out. A
  // kind flip (an anchored file replaced by a directory) stays refused; no
  // nonce ever vouches for that.
  if (
    earlier !== undefined &&
    earlier.path === anchor.path &&
    (earlier.kind !== 'directory' || earlier.marker === expected)
  ) {
    return { ok: false }
  }
  await writeAnchorMarker(join(driveDir, anchor.path), expected)
  return {
    ok: true,
    snapshot: {
      path: anchor.path,
      inodeKey: current.inodeKey,
      marker: expected,
      kind: 'directory',
      consecutiveMissingPolls: 0,
    },
  }
}

async function readAnchorMarker(directory: string): Promise<string | null> {
  return (await readAnchorMarkerResult(directory)).value
}

async function readAnchorMarkerResult(
  directory: string,
  expectedDirectoryInodeKey?: string,
): Promise<{ ok: true; value: string | null } | { ok: false; value: null }> {
  try {
    return {
      ok: true,
      value: (await readFile(join(directory, DUET_ANCHOR_MARKER_FILE), 'utf8')).trim(),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (expectedDirectoryInodeKey === undefined) return { ok: true, value: null }
      try {
        const current = await lstat(directory)
        if (
          current.isDirectory() &&
          `${current.dev}:${current.ino}` === expectedDirectoryInodeKey
        ) {
          return { ok: true, value: null }
        }
      } catch {
        // The directory changed between its snapshot and marker read.
      }
    }
    return { ok: false, value: null }
  }
}

async function writeAnchorMarker(directory: string, payload: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, DUET_ANCHOR_MARKER_FILE), `${payload}\n`, { mode: 0o600 })
}

function markerPayload(anchor: GatewayAnchor): string {
  return `duet-anchor:v1:${anchor.id}:${anchor.markerNonce}`
}

function anchorReportIdentity(anchor: GatewayAnchor): string {
  return `${anchor.kind}:${expectedSnapshotKind(anchor)}:${markerPayload(anchor)}`
}

function isSnapshotEntry(value: unknown): value is AnchorSnapshot & { anchorId: string } {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.anchorId === 'string' &&
    typeof entry.path === 'string' &&
    (typeof entry.inodeKey === 'string' || entry.inodeKey === null) &&
    (typeof entry.marker === 'string' || entry.marker === null) &&
    (entry.kind === 'directory' || entry.kind === 'file') &&
    (entry.consecutiveMissingPolls === undefined ||
      (typeof entry.consecutiveMissingPolls === 'number' &&
        Number.isInteger(entry.consecutiveMissingPolls) &&
        entry.consecutiveMissingPolls >= 0)) &&
    (entry.pendingReport === undefined ||
      (typeof entry.pendingReport === 'object' &&
        entry.pendingReport !== null &&
        typeof (entry.pendingReport as Record<string, unknown>).anchorIdentity === 'string' &&
        AnchorMoveCandidatesReportSchema.safeParse(
          (entry.pendingReport as Record<string, unknown>).report,
        ).success))
  )
}

function recordMissingObservation(
  anchor: GatewayAnchor,
  earlier: AnchorSnapshot | undefined,
): AnchorSnapshot {
  const kind = earlier?.kind ?? expectedSnapshotKind(anchor)
  return {
    path: earlier?.path ?? anchor.path,
    inodeKey: earlier?.inodeKey ?? null,
    marker: earlier?.marker ?? (kind === 'directory' ? markerPayload(anchor) : null),
    kind,
    consecutiveMissingPolls: (earlier?.consecutiveMissingPolls ?? 0) + 1,
  }
}

function expectedSnapshotKind(anchor: GatewayAnchor): AnchorSnapshot['kind'] {
  const settings = anchor.settings
  return typeof settings === 'object' &&
    settings !== null &&
    'kind' in settings &&
    settings.kind === 'file'
    ? 'file'
    : 'directory'
}

function markerMatchesForAnchor(anchor: GatewayAnchor, byMarker: Map<string, string[]>): string[] {
  const expected = markerPayload(anchor)
  return (byMarker.get(expected) ?? [])
    .filter(path => path !== anchor.path)
    .sort()
    .slice(0, MAX_ANCHOR_RENAME_CANDIDATES)
}

function groupByMarker(paths: PathSnapshot[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const path of paths) {
    if (path.marker === null) continue
    const existing = grouped.get(path.marker)
    if (existing === undefined) grouped.set(path.marker, [path.path])
    else existing.push(path.path)
  }
  return grouped
}

function groupByInode(paths: PathSnapshot[]): Map<string, PathSnapshot[]> {
  const grouped = new Map<string, PathSnapshot[]>()
  for (const path of paths) {
    const existing = grouped.get(path.inodeKey)
    if (existing === undefined) grouped.set(path.inodeKey, [path])
    else existing.push(path)
  }
  return grouped
}

function renameCandidatesFromEarlier(
  earlier: AnchorSnapshot | undefined,
  byInode: Map<string, PathSnapshot[]>,
): AnchorMoveCandidatesReport['candidates'] {
  if (earlier?.inodeKey === null || earlier?.inodeKey === undefined || earlier.marker === null)
    return []
  return (byInode.get(earlier.inodeKey) ?? [])
    .filter(candidate => candidate.path !== earlier.path && candidate.marker === earlier.marker)
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, MAX_ANCHOR_RENAME_CANDIDATES)
    .map(candidate => ({
      fromPath: earlier.path,
      toPath: candidate.path,
      confidence: 0.75,
      inodeMatch: true,
      markerMatch: true,
    }))
}
