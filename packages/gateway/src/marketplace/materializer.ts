import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { formatSyncConflictName, isPublishExcludedDrivePath } from '@repo/contract'

/**
 * Journaled three-way repair for a marketplace agent tree.
 *
 * Live entries are never unlinked: replacement first renames each inode into a
 * same-filesystem quarantine. A sweep preserves divergent bytes as conflict
 * copies and retains every quarantine for a later run. Deferred reap hashes a
 * retained inode immediately before unlinking it. A writer can still change an
 * already-open inode in the microseconds between that final hash and unlink;
 * that narrow race is the accepted residual bound of the soft-repair model.
 */

export interface UpstreamManifest {
  files: Record<string, { sha256: string }>
}

/** Lossless adapter shape: an array preserves duplicate ZIP names for rejection. */
export interface UnzippedEntry {
  path: string
  data: Uint8Array
  kind?: 'file' | 'directory' | 'symlink'
}

export type MaterializerJournalPhase = 'staged' | 'swapped' | 'swept'

export interface ApplyUpstreamTreeInput {
  entries: readonly UnzippedEntry[]
  previous: UpstreamManifest | null
  targetDir: string
  /** Gateway-owned state root; it must share a filesystem with targetDir. */
  stateDir: string
  now: Date
  /** Retained quarantines at or before this timestamp are eligible for reap. */
  reapBefore?: Date
  /** Crash/concurrency probe seam; production callers leave this unset. */
  onJournalPhase?: (phase: MaterializerJournalPhase, operationPath?: string) => void | Promise<void>
}

export interface ApplyUpstreamTreeResult {
  manifest: UpstreamManifest
  applied: {
    restored: string[]
    conflictRenamed: string[]
    deletedUpstream: string[]
    keptLocal: number
  }
}

interface PreparedTree {
  files: Map<string, { data: Uint8Array; sha256: string }>
  manifest: UpstreamManifest
}

interface JournalOperation {
  type: 'delete' | 'ensure-directory' | 'install'
  path: string
  complete: boolean
  changed: boolean
  restored: boolean
  deleted: boolean
  quarantineIds: string[]
}

interface QuarantineRecord {
  id: string
  runId: string
  logicalPath: string
  oldSha256: string | null
  swapped: boolean
  baselineDigest: string | null
  retainedAt: string
  conflictPaths: string[]
  conflictCollision: number
  pendingConflict?: { path: string; digest: string; at: string }
}

interface ActiveJournal {
  id: string
  phase: MaterializerJournalPhase
  fingerprint: string
  conflictAt: string
  previous: UpstreamManifest | null
  manifest: UpstreamManifest
  keptLocal: number
  operations: JournalOperation[]
  quarantines: QuarantineRecord[]
}

interface MaterializerState {
  targetDir: string
  retained: QuarantineRecord[]
  active: ActiveJournal | null
}

interface ReplayedTransaction {
  fingerprint: string
  result: ApplyUpstreamTreeResult
}

const STATE_FILE = 'state.json'
const MATERIALIZER_CONFLICT_ATTEMPTS = 32
const MATERIALIZER_CONFLICT_PATH_ATTEMPTS = 4_096
const targetQueues = new Map<string, Promise<void>>()

function contendedPath(path: string): Error {
  return new Error(`Marketplace path is temporarily contended: ${path}`)
}

export async function applyUpstreamTree(
  input: ApplyUpstreamTreeInput,
): Promise<ApplyUpstreamTreeResult> {
  const targetDir = resolve(input.targetDir)
  return withTargetQueue(targetDir, async () => applyUpstreamTreeLocked(input, targetDir))
}

async function applyUpstreamTreeLocked(
  input: ApplyUpstreamTreeInput,
  targetDir: string,
): Promise<ApplyUpstreamTreeResult> {
  const prepared = prepareEntries(input.entries)
  validateManifest(input.previous)
  validateDate(input.now, 'materializer time')
  if (input.reapBefore !== undefined) validateDate(input.reapBefore, 'reap cutoff')

  const targetInfo = await lstatOrNull(targetDir)
  if (targetInfo !== null && !targetInfo.isDirectory()) {
    throw new Error('Official-agent materializer target must be a directory')
  }
  await mkdir(targetDir, { recursive: true })
  const stateRoot = resolve(input.stateDir)
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const stateRootInfo = await lstat(stateRoot)
  if (!stateRootInfo.isDirectory() || stateRootInfo.isSymbolicLink()) {
    throw new Error('Official-agent materializer state root must be a directory')
  }
  if ((await stat(targetDir)).dev !== (await stat(stateRoot)).dev) {
    throw new Error('Official-agent quarantine must share a filesystem with its target')
  }

  const stateDir = stateDirectoryFor(targetDir, stateRoot)
  let state = await loadOrCreateState(stateDir, targetDir)
  await reapOrphanTransactions(stateDir, state.active?.id)
  let recovered: ReplayedTransaction | null = null
  if (state.active !== null) {
    recovered = await replayActive(state, targetDir, stateDir, input.onJournalPhase)
    state = await readState(stateDir, targetDir)
  }

  const reapedConflicts = await reapEligible(
    state,
    targetDir,
    stateDir,
    input.reapBefore,
    input.now,
  )
  state = await readState(stateDir, targetDir)

  const requestedFingerprint = transactionFingerprint(input.previous, prepared.manifest)
  if (recovered !== null && recovered.fingerprint === requestedFingerprint) {
    recovered.result.applied.conflictRenamed.push(...reapedConflicts)
    return recovered.result
  }

  const effectivePrevious = recovered?.result.manifest ?? input.previous
  const keptLocal = await countLocalAdditions(targetDir, effectivePrevious, prepared.manifest)
  await stageTransaction(state, stateDir, effectivePrevious, prepared, input.now, keptLocal)
  await input.onJournalPhase?.('staged')

  const replayed = await replayActive(state, targetDir, stateDir, input.onJournalPhase)
  replayed.result.applied.conflictRenamed.unshift(...reapedConflicts)
  return replayed.result
}

async function stageTransaction(
  state: MaterializerState,
  stateDir: string,
  previous: UpstreamManifest | null,
  prepared: PreparedTree,
  now: Date,
  keptLocal: number,
): Promise<void> {
  const id = randomUUID()
  const transactionDir = transactionDirectory(stateDir, id)
  await mkdir(join(transactionDir, 'content'), { recursive: true })
  for (const file of prepared.files.values()) {
    await writeFile(join(transactionDir, 'content', file.sha256), file.data, { flag: 'wx' }).catch(
      error => {
        if (!isErrorCode(error, 'EEXIST')) throw error
      },
    )
  }
  const journal: ActiveJournal = {
    id,
    phase: 'staged',
    fingerprint: transactionFingerprint(previous, prepared.manifest),
    conflictAt: now.toISOString(),
    previous,
    manifest: prepared.manifest,
    keptLocal,
    operations: createOperations(previous, prepared.manifest),
    quarantines: [],
  }
  state.active = journal
  await writeState(stateDir, state)
}

async function replayActive(
  state: MaterializerState,
  targetDir: string,
  stateDir: string,
  hook: ApplyUpstreamTreeInput['onJournalPhase'],
): Promise<ReplayedTransaction> {
  const journal = state.active
  if (journal === null) throw new Error('Official-agent materializer has no active journal')

  if (journal.phase === 'staged') {
    await performSwaps(state, journal, targetDir, stateDir, hook)
    await hook?.('swapped')
    const nextPaths = Object.keys(journal.manifest.files)
    for (const operation of journal.operations) {
      if (
        operation.type !== 'delete' ||
        nextPaths.every(
          path => !path.startsWith(`${operation.path}/`) && !operation.path.startsWith(`${path}/`),
        )
      ) {
        operation.complete = false
      }
    }
    await writeState(stateDir, state)
    await performSwaps(state, journal, targetDir, stateDir, hook)
    journal.phase = 'swapped'
    await writeState(stateDir, state)
  }
  if (journal.phase === 'swapped') {
    await sweepQuarantines(state, journal, targetDir, stateDir, hook)
    journal.phase = 'swept'
    await writeState(stateDir, state)
    await hook?.('swept')
  }

  const result = resultFromJournal(journal)
  state.retained.push(...journal.quarantines)
  state.active = null
  await writeState(stateDir, state)
  await rm(transactionDirectory(stateDir, journal.id), { recursive: true, force: true })
  return { fingerprint: journal.fingerprint, result }
}

async function performSwaps(
  state: MaterializerState,
  journal: ActiveJournal,
  targetDir: string,
  stateDir: string,
  hook: ApplyUpstreamTreeInput['onJournalPhase'],
): Promise<void> {
  for (let index = 0; index < journal.operations.length; index += 1) {
    const operation = journal.operations[index]!
    if (operation.complete) continue
    if (operation.type === 'delete') {
      await deletePath(state, journal, operation, targetDir, stateDir, hook)
    } else if (operation.type === 'ensure-directory') {
      await ensureDirectory(state, journal, operation, targetDir, stateDir, hook)
    } else {
      await installFile(state, journal, operation, index, targetDir, stateDir, hook)
    }
    operation.complete = true
    await writeState(stateDir, state)
  }
}

async function deletePath(
  state: MaterializerState,
  journal: ActiveJournal,
  operation: JournalOperation,
  targetDir: string,
  stateDir: string,
  hook: ApplyUpstreamTreeInput['onJournalPhase'],
): Promise<void> {
  const target = join(targetDir, operation.path)
  const record = await quarantineLivePath(
    state,
    journal,
    operation,
    target,
    journal.previous!.files[operation.path]!.sha256,
    stateDir,
    hook,
  )
  if (record !== null) {
    operation.changed = true
    operation.deleted = true
  }
}

async function ensureDirectory(
  state: MaterializerState,
  journal: ActiveJournal,
  operation: JournalOperation,
  targetDir: string,
  stateDir: string,
  hook: ApplyUpstreamTreeInput['onJournalPhase'],
): Promise<void> {
  const target = join(targetDir, operation.path)
  for (let attempt = 0; attempt < MATERIALIZER_CONFLICT_ATTEMPTS; attempt += 1) {
    const info = await lstatOrNull(target)
    if (info?.isDirectory()) return
    if (info !== null) {
      operation.changed = true
      await writeState(stateDir, state)
      await quarantineLivePath(
        state,
        journal,
        operation,
        target,
        journal.previous?.files[operation.path]?.sha256 ?? null,
        stateDir,
        hook,
      )
    }
    try {
      await mkdir(target)
      return
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error
    }
  }
  throw contendedPath(operation.path)
}

async function installFile(
  state: MaterializerState,
  journal: ActiveJournal,
  operation: JournalOperation,
  index: number,
  targetDir: string,
  stateDir: string,
  hook: ApplyUpstreamTreeInput['onJournalPhase'],
): Promise<void> {
  const target = join(targetDir, operation.path)
  const nextHash = journal.manifest.files[operation.path]!.sha256
  if ((await hashRegularFile(target)) === nextHash) {
    if (operation.changed) operation.restored = true
    return
  }

  operation.changed = true
  await writeState(stateDir, state)
  for (let attempt = 0; attempt < MATERIALIZER_CONFLICT_ATTEMPTS; attempt += 1) {
    if ((await lstatOrNull(target)) !== null) {
      await quarantineLivePath(
        state,
        journal,
        operation,
        target,
        journal.previous?.files[operation.path]?.sha256 ?? null,
        stateDir,
        hook,
      )
    }
    const installTemp = join(
      transactionDirectory(stateDir, journal.id),
      `install-${index}-${operation.quarantineIds.length}`,
    )
    await rm(installTemp, { force: true })
    await copyFile(
      join(transactionDirectory(stateDir, journal.id), 'content', nextHash),
      installTemp,
      constants.COPYFILE_EXCL,
    )
    try {
      await link(installTemp, target)
      await rm(installTemp, { force: true })
      await hook?.('swapped', operation.path)
      operation.restored = true
      return
    } catch (error) {
      await rm(installTemp, { force: true })
      if (!isErrorCode(error, 'EEXIST')) throw error
      if ((await hashRegularFile(target)) === nextHash) {
        operation.restored = true
        return
      }
    }
  }
  throw contendedPath(operation.path)
}

async function quarantineLivePath(
  state: MaterializerState,
  journal: ActiveJournal,
  operation: JournalOperation,
  target: string,
  oldSha256: string | null,
  stateDir: string,
  hook: ApplyUpstreamTreeInput['onJournalPhase'],
): Promise<QuarantineRecord | null> {
  const pending = operation.quarantineIds
    .map(id => journal.quarantines.find(record => record.id === id))
    .find(record => record !== undefined && !record.swapped)
  if (pending !== undefined) {
    if ((await lstatOrNull(quarantinePath(stateDir, pending.id))) !== null) {
      pending.swapped = true
      await writeState(stateDir, state)
      return pending
    }
    if ((await lstatOrNull(target)) === null) {
      operation.quarantineIds = operation.quarantineIds.filter(id => id !== pending.id)
      journal.quarantines = journal.quarantines.filter(record => record.id !== pending.id)
      await writeState(stateDir, state)
      return null
    }
    try {
      await rename(target, quarantinePath(stateDir, pending.id))
      await hook?.('swapped', operation.path)
      pending.swapped = true
      await writeState(stateDir, state)
      return pending
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error
      return null
    }
  }

  if ((await lstatOrNull(target)) === null) return null
  const id = `${journal.id}-${String(journal.quarantines.length).padStart(4, '0')}`
  const record: QuarantineRecord = {
    id,
    runId: journal.id,
    logicalPath: operation.path,
    oldSha256,
    swapped: false,
    baselineDigest: null,
    retainedAt: journal.conflictAt,
    conflictPaths: [],
    conflictCollision: 0,
  }
  journal.quarantines.push(record)
  operation.quarantineIds.push(id)
  await writeState(stateDir, state)
  try {
    await rename(target, quarantinePath(stateDir, id))
    await hook?.('swapped', operation.path)
    record.swapped = true
    await writeState(stateDir, state)
    return record
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

async function sweepQuarantines(
  state: MaterializerState,
  journal: ActiveJournal,
  targetDir: string,
  stateDir: string,
  hook: ApplyUpstreamTreeInput['onJournalPhase'],
): Promise<void> {
  for (const record of journal.quarantines) {
    if (record.baselineDigest !== null) continue
    const path = quarantinePath(stateDir, record.id)
    const digest = await snapshotDigest(path)
    if (digest === null) {
      record.baselineDigest = sha256('missing')
    } else if (record.oldSha256 !== null && digest === regularDigest(record.oldSha256)) {
      record.baselineDigest = digest
    } else {
      const lastConflict = record.conflictPaths.at(-1)
      if (
        lastConflict !== undefined &&
        (await snapshotDigest(join(targetDir, lastConflict))) === digest
      ) {
        record.baselineDigest = digest
      } else {
        const copied = await preserveStableConflict(
          state,
          record,
          targetDir,
          stateDir,
          new Date(journal.conflictAt),
        )
        record.baselineDigest = copied.digest
      }
    }
    record.retainedAt = journal.conflictAt
    await hook?.('swept', record.logicalPath)
    await writeState(stateDir, state)
  }
}

async function reapEligible(
  state: MaterializerState,
  targetDir: string,
  stateDir: string,
  reapBefore: Date | undefined,
  now: Date,
): Promise<string[]> {
  if (reapBefore === undefined) return []
  const conflicts: string[] = []
  for (let index = 0; index < state.retained.length; ) {
    const record = state.retained[index]!
    if (new Date(record.retainedAt) > reapBefore) {
      index += 1
      continue
    }
    const path = quarantinePath(stateDir, record.id)
    const digest = await snapshotDigest(path)
    if (digest === null) {
      state.retained.splice(index, 1)
      await writeState(stateDir, state)
      continue
    }
    if (digest !== record.baselineDigest) {
      const copied = await preserveStableConflict(state, record, targetDir, stateDir, now)
      record.baselineDigest = copied.digest
      record.retainedAt = now.toISOString()
      conflicts.push(...copied.paths)
      await writeState(stateDir, state)
      index += 1
      continue
    }
    // Accepted residual bound: an already-open writer can change this inode
    // after the final digest and before the internal quarantine unlink.
    await rm(path, { recursive: true, force: true })
    state.retained.splice(index, 1)
    await writeState(stateDir, state)
  }
  return conflicts
}

async function preserveStableConflict(
  state: MaterializerState,
  record: QuarantineRecord,
  targetDir: string,
  stateDir: string,
  at: Date,
): Promise<{ digest: string; paths: string[] }> {
  const source = quarantinePath(stateDir, record.id)
  const copiedPaths: string[] = []
  for (let attempt = 0; attempt < MATERIALIZER_CONFLICT_ATTEMPTS; attempt += 1) {
    const before = await snapshotDigest(source)
    if (before === null) return { digest: sha256('missing'), paths: copiedPaths }
    let candidate: string
    if (record.pendingConflict?.digest === before) {
      candidate = record.pendingConflict.path
    } else {
      candidate = await nextConflictPath(record, targetDir, at)
      record.pendingConflict = { path: candidate, digest: before, at: at.toISOString() }
      await writeState(stateDir, state)
    }
    const destination = join(targetDir, candidate)
    const existingDigest = await snapshotDigest(destination)
    if (existingDigest !== before) {
      if (existingDigest !== null) {
        record.conflictCollision += 1
        record.pendingConflict = undefined
        continue
      }
      try {
        if (!(await ensureConflictParents(targetDir, candidate))) {
          record.conflictCollision += 1
          record.pendingConflict = undefined
          continue
        }
        await copyEntryNoClobber(source, destination)
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) throw error
        record.conflictCollision += 1
        record.pendingConflict = undefined
        continue
      }
    }
    const after = await snapshotDigest(source)
    if (!record.conflictPaths.includes(candidate)) record.conflictPaths.push(candidate)
    if (!copiedPaths.includes(candidate)) copiedPaths.push(candidate)
    record.pendingConflict = undefined
    record.conflictCollision += 1
    await writeState(stateDir, state)
    if (after === before) return { digest: after, paths: copiedPaths }
  }
  throw contendedPath(record.logicalPath)
}

async function nextConflictPath(
  record: QuarantineRecord,
  targetDir: string,
  at: Date,
): Promise<string> {
  for (
    let collision = record.conflictCollision;
    collision < record.conflictCollision + MATERIALIZER_CONFLICT_PATH_ATTEMPTS;
    collision += 1
  ) {
    const candidate = await conflictPathOutsideBlockedAncestor(
      record.logicalPath,
      targetDir,
      at,
      collision,
    )
    if ((await lstatOrNull(join(targetDir, candidate))) === null) {
      record.conflictCollision = collision
      return candidate
    }
  }
  throw contendedPath(record.logicalPath)
}

async function conflictPathOutsideBlockedAncestor(
  logicalPath: string,
  targetDir: string,
  at: Date,
  collision: number,
): Promise<string> {
  const segments = logicalPath.split('/')
  for (let length = 1; length < segments.length; length += 1) {
    const ancestor = segments.slice(0, length).join('/')
    const info = await lstatOrNull(join(targetDir, ancestor))
    if (info !== null && !info.isDirectory()) {
      return [
        formatSyncConflictName(ancestor, at, 'CREATOR', collision),
        ...segments.slice(length),
      ].join('/')
    }
  }
  return formatSyncConflictName(logicalPath, at, 'CREATOR', collision)
}

async function ensureConflictParents(targetDir: string, relativePath: string): Promise<boolean> {
  const parents = dirname(relativePath)
    .split('/')
    .filter(segment => segment !== '.')
  let current = targetDir
  for (const parent of parents) {
    current = join(current, parent)
    const info = await lstatOrNull(current)
    if (info?.isDirectory()) continue
    if (info !== null) return false
    try {
      await mkdir(current)
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error
      if (!(await lstat(current)).isDirectory()) return false
    }
  }
  return true
}

async function copyEntryNoClobber(source: string, destination: string): Promise<void> {
  const info = await lstat(source)
  if (info.isFile()) {
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  } else if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination)
  } else if (info.isDirectory()) {
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
  } else {
    throw new Error('Unsupported local filesystem entry at upstream-owned path')
  }
}

function prepareEntries(entries: readonly UnzippedEntry[]): PreparedTree {
  const seen = new Set<string>()
  const files = new Map<string, { data: Uint8Array; sha256: string }>()
  const archiveKinds = new Map<string, UnzippedEntry['kind']>()
  for (const entry of entries) {
    if (entry.kind !== undefined && !['file', 'directory', 'symlink'].includes(entry.kind)) {
      throw new Error(`Archive entry has invalid kind: ${entry.path}`)
    }
    const path = validateArchivePath(
      entry.path,
      entry.kind === 'directory' || entry.path.endsWith('/'),
    )
    if (seen.has(path)) throw new Error(`Duplicate archive entry: ${path}`)
    seen.add(path)
    const kind = entry.kind ?? (entry.path.endsWith('/') ? 'directory' : 'file')
    archiveKinds.set(path, kind)
    if (kind !== 'file' || isPublishExcludedDrivePath(path)) continue
    if (!(entry.data instanceof Uint8Array))
      throw new Error(`Archive entry has invalid data: ${path}`)
    files.set(path, { data: entry.data, sha256: sha256(entry.data) })
  }
  for (const path of [...archiveKinds.keys()].sort()) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const parentKind = archiveKinds.get(segments.slice(0, index).join('/'))
      if (parentKind === 'file' || parentKind === 'symlink') {
        throw new Error(`Archive entry descends through non-directory entry: ${path}`)
      }
    }
  }
  return {
    files,
    manifest: {
      files: Object.fromEntries(
        [...files.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, file]) => [path, { sha256: file.sha256 }]),
      ),
    },
  }
}

function createOperations(
  previous: UpstreamManifest | null,
  manifest: UpstreamManifest,
): JournalOperation[] {
  const nextPaths = new Set(Object.keys(manifest.files))
  const operation = (type: JournalOperation['type'], path: string): JournalOperation => ({
    type,
    path,
    complete: false,
    changed: false,
    restored: false,
    deleted: false,
    quarantineIds: [],
  })
  const deletions = Object.keys(previous?.files ?? {})
    .filter(path => !nextPaths.has(path) && !isPublishExcludedDrivePath(path))
    .sort(deepestFirst)
    .map(path => operation('delete', path))
  const directories = new Set<string>()
  for (const path of nextPaths) {
    let parent = dirname(path)
    while (parent !== '.') {
      directories.add(parent)
      parent = dirname(parent)
    }
  }
  return [
    ...deletions,
    ...[...directories].sort(shallowestFirst).map(path => operation('ensure-directory', path)),
    ...[...nextPaths].sort().map(path => operation('install', path)),
  ]
}

function resultFromJournal(journal: ActiveJournal): ApplyUpstreamTreeResult {
  return {
    manifest: journal.manifest,
    applied: {
      restored: journal.operations
        .filter(operation => operation.restored)
        .map(operation => operation.path),
      conflictRenamed: journal.quarantines.flatMap(record => record.conflictPaths),
      deletedUpstream: journal.operations
        .filter(operation => operation.type === 'delete' && operation.deleted)
        .map(operation => operation.path),
      keptLocal: journal.keptLocal,
    },
  }
}

async function snapshotDigest(path: string): Promise<string | null> {
  const info = await lstatOrNull(path)
  if (info === null) return null
  if (info.isFile()) return regularDigest(await hashRegularFile(path))
  if (info.isSymbolicLink()) return sha256(`symlink\0${await readlink(path)}`)
  if (!info.isDirectory()) return sha256(`special\0${info.mode}`)
  const hash = createHash('sha256').update('directory\0')
  const pending = [{ absolute: path, relative: '' }]
  while (pending.length > 0) {
    const current = pending.pop()!
    const names = await readdir(current.absolute)
    names.sort().reverse()
    for (const name of names) {
      const relative = current.relative === '' ? name : `${current.relative}/${name}`
      const absolute = join(current.absolute, name)
      const child = await lstat(absolute)
      if (child.isDirectory()) {
        hash.update(`d\0${relative}\0`)
        pending.push({ absolute, relative })
      } else if (child.isFile()) {
        hash.update(`f\0${relative}\0${await hashRegularFile(absolute)}\0`)
      } else if (child.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${await readlink(absolute)}\0`)
      } else {
        hash.update(`s\0${relative}\0${child.mode}\0`)
      }
    }
  }
  return hash.digest('hex')
}

function regularDigest(sha: string | null): string {
  return sha256(`file\0${sha ?? 'missing'}`)
}

async function hashRegularFile(path: string): Promise<string | null> {
  const info = await lstatOrNull(path)
  if (!info?.isFile()) return null
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return sha256(await handle.readFile())
  } finally {
    await handle.close()
  }
}

async function countLocalAdditions(
  targetDir: string,
  previous: UpstreamManifest | null,
  next: UpstreamManifest,
): Promise<number> {
  const owned = new Set([...Object.keys(previous?.files ?? {}), ...Object.keys(next.files)])
  let count = 0
  const pending = [{ absolute: targetDir, relative: '' }]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const name of await readdir(current.absolute)) {
      const relative = current.relative === '' ? name : `${current.relative}/${name}`
      const absolute = join(current.absolute, name)
      const info = await lstat(absolute)
      if (info.isDirectory()) pending.push({ absolute, relative })
      else if (!owned.has(relative)) count += 1
    }
  }
  return count
}

function validateArchivePath(rawPath: string, allowTrailingSlash: boolean): string {
  if (
    rawPath.length === 0 ||
    rawPath.includes('\0') ||
    rawPath.includes('\\') ||
    rawPath.startsWith('/') ||
    /^[A-Za-z]:/.test(rawPath)
  ) {
    throw new Error(`Unsafe archive path: ${rawPath}`)
  }
  const path = allowTrailingSlash && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
  const parts = path.split('/')
  if (path.length === 0 || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`Unsafe archive path: ${rawPath}`)
  }
  return path
}

function validateManifest(manifest: UpstreamManifest | null): void {
  if (manifest === null) return
  for (const [path, descriptor] of Object.entries(manifest.files)) {
    validateArchivePath(path, false)
    if (!/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
      throw new Error(`Invalid upstream manifest digest: ${path}`)
    }
  }
}

async function loadOrCreateState(stateDir: string, targetDir: string): Promise<MaterializerState> {
  if ((await lstatOrNull(stateDir)) !== null) return readState(stateDir, targetDir)
  const temporary = `${stateDir}.init-${randomUUID()}`
  const state: MaterializerState = { targetDir, retained: [], active: null }
  await mkdir(join(temporary, 'quarantine'), { recursive: true })
  await mkdir(join(temporary, 'transactions'), { recursive: true })
  await writeFile(join(temporary, STATE_FILE), `${JSON.stringify(state)}\n`, { flag: 'wx' })
  try {
    await rename(temporary, stateDir)
    return state
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    if (!isErrorCode(error, 'EEXIST') && !isErrorCode(error, 'ENOTEMPTY')) throw error
    return readState(stateDir, targetDir)
  }
}

async function reapOrphanTransactions(
  stateDir: string,
  activeId: string | undefined,
): Promise<void> {
  const transactionsDir = join(stateDir, 'transactions')
  for (const name of await readdir(transactionsDir)) {
    if (name !== activeId) {
      await rm(join(transactionsDir, name), { recursive: true, force: true })
    }
  }
}

async function readState(stateDir: string, targetDir: string): Promise<MaterializerState> {
  const info = await lstat(stateDir)
  if (!info.isDirectory())
    throw new Error('Official-agent materializer state path is not a directory')
  const parsed = JSON.parse(await readFile(join(stateDir, STATE_FILE), 'utf8')) as MaterializerState
  if (!isValidState(parsed, targetDir)) {
    throw new Error('Official-agent materializer journal is invalid')
  }
  return parsed
}

function isValidState(state: MaterializerState, targetDir: string): boolean {
  try {
    if (
      state.targetDir !== targetDir ||
      !Array.isArray(state.retained) ||
      !state.retained.every(isValidQuarantine)
    ) {
      return false
    }
    if (state.active === null) return true
    const active = state.active
    validateManifest(active.previous)
    validateManifest(active.manifest)
    const expectedOperations = createOperations(active.previous, active.manifest)
    const operationsValid =
      expectedOperations.length === active.operations.length &&
      active.operations.every((operation, index) => {
        const expected = expectedOperations[index]!
        return (
          operation.type === expected.type &&
          operation.path === expected.path &&
          typeof operation.complete === 'boolean' &&
          typeof operation.changed === 'boolean' &&
          typeof operation.restored === 'boolean' &&
          typeof operation.deleted === 'boolean' &&
          Array.isArray(operation.quarantineIds) &&
          operation.quarantineIds.every(id => typeof id === 'string')
        )
      })
    const activeIds = new Set(active.quarantines.map(record => record.id))
    const referencedIds = active.operations.flatMap(operation => operation.quarantineIds)
    const allRecords = [...state.retained, ...active.quarantines]
    return (
      /^[0-9a-f-]{36}$/.test(state.active.id) &&
      ['staged', 'swapped', 'swept'].includes(active.phase) &&
      active.fingerprint === transactionFingerprint(active.previous, active.manifest) &&
      Number.isFinite(new Date(active.conflictAt).valueOf()) &&
      Number.isInteger(active.keptLocal) &&
      active.keptLocal >= 0 &&
      operationsValid &&
      Array.isArray(active.quarantines) &&
      active.quarantines.every(record => record.runId === active.id && isValidQuarantine(record)) &&
      referencedIds.every(id => activeIds.has(id)) &&
      new Set(allRecords.map(record => record.id)).size === allRecords.length
    )
  } catch {
    return false
  }
}

function isValidQuarantine(record: QuarantineRecord): boolean {
  try {
    validateArchivePath(record.logicalPath, false)
    return (
      /^[0-9a-f-]{36}-[0-9]{4}$/.test(record.id) &&
      /^[0-9a-f-]{36}$/.test(record.runId) &&
      (record.oldSha256 === null || /^[a-f0-9]{64}$/.test(record.oldSha256)) &&
      typeof record.swapped === 'boolean' &&
      (record.baselineDigest === null || /^[a-f0-9]{64}$/.test(record.baselineDigest)) &&
      Number.isFinite(new Date(record.retainedAt).valueOf()) &&
      Array.isArray(record.conflictPaths) &&
      record.conflictPaths.every(path => validateArchivePath(path, false) === path) &&
      Number.isInteger(record.conflictCollision) &&
      record.conflictCollision >= 0 &&
      (record.pendingConflict === undefined ||
        (/^[a-f0-9]{64}$/.test(record.pendingConflict.digest) &&
          Number.isFinite(new Date(record.pendingConflict.at).valueOf()) &&
          validateArchivePath(record.pendingConflict.path, false) === record.pendingConflict.path))
    )
  } catch {
    return false
  }
}

async function writeState(stateDir: string, state: MaterializerState): Promise<void> {
  const temporary = join(stateDir, `${STATE_FILE}.tmp`)
  await writeFile(temporary, `${JSON.stringify(state)}\n`)
  await rename(temporary, join(stateDir, STATE_FILE))
}

function stateDirectoryFor(targetDir: string, stateRoot: string): string {
  const identity = createHash('sha256').update(targetDir).digest('hex').slice(0, 12)
  return join(stateRoot, `.${basename(targetDir)}.marketplace-materializer-${identity}`)
}

function transactionDirectory(stateDir: string, id: string): string {
  return join(stateDir, 'transactions', id)
}

function quarantinePath(stateDir: string, id: string): string {
  return join(stateDir, 'quarantine', id)
}

function transactionFingerprint(previous: UpstreamManifest | null, next: UpstreamManifest): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalManifest(previous)))
    .update('\0')
    .update(JSON.stringify(canonicalManifest(next)))
    .digest('hex')
}

function canonicalManifest(manifest: UpstreamManifest | null): UpstreamManifest | null {
  if (manifest === null) return null
  return {
    files: Object.fromEntries(
      Object.entries(manifest.files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, descriptor]) => [path, { sha256: descriptor.sha256.toLowerCase() }]),
    ),
  }
}

function validateDate(value: Date, label: string): void {
  if (!Number.isFinite(value.valueOf())) throw new Error(`Invalid ${label}`)
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function lstatOrNull(path: string) {
  return lstat(path).catch(error => {
    if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ENOTDIR')) return null
    throw error
  })
}

function deepestFirst(a: string, b: string): number {
  return b.split('/').length - a.split('/').length || a.localeCompare(b)
}

function shallowestFirst(a: string, b: string): number {
  return a.split('/').length - b.split('/').length || a.localeCompare(b)
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function withTargetQueue<T>(targetDir: string, run: () => Promise<T>): Promise<T> {
  const previous = targetQueues.get(targetDir) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolveGate => {
    release = resolveGate
  })
  const tail = previous.then(() => gate)
  targetQueues.set(targetDir, tail)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (targetQueues.get(targetDir) === tail) targetQueues.delete(targetDir)
  }
}
