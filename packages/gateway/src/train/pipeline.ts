import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import {
  decodeTrainInlineFileContent,
  isPathInside,
  normalizeDrivePath,
  type DriveFileEvent,
  type GatewayTrainJobPhase,
  type TrainCorpusFile,
  type TrainRecord,
} from '@repo/contract'

import type { TrainScope } from './agent-scope'
import { MemoryStoreError, readMemoryRecord, removeMemoryArchive } from './memory-store'
import { indexTrainRecord, markTrainRecordRepair } from './record-index'

export type TrainExecutionPhase = Extract<
  GatewayTrainJobPhase,
  'snapshotting' | 'training' | 'finalizing'
>

export interface TrainRunnerInput {
  stagingDir: string
  slug: string
  storeDir: string
  commandTimeoutMs?: number
  onChildPid?: (pid: number) => void
  env?: Record<string, string>
}

export interface TrainRunnerResult {
  record: TrainRecord | null
  stdout: string
  stderr: string
}

export type TrainRunner = (input: TrainRunnerInput) => Promise<TrainRunnerResult>

export class TrainCorpusError extends Error {
  constructor(readonly code: 'empty_corpus' | 'invalid_request') {
    super(code)
    this.name = 'TrainCorpusError'
  }
}

export async function assembleTrainCorpus(input: {
  jobDir: string
  driveDir: string
  files?: TrainCorpusFile[]
  driveFiles?: string[]
}): Promise<void> {
  for (const file of input.files ?? []) {
    const relativePath = safeCorpusPath(file.filename)
    const target = await safeCorpusTarget(input.jobDir, relativePath)
    await writeFile(target, decodeTrainInlineFileContent(file), { mode: 0o600 })
  }

  const driveRoot = await realpath(input.driveDir).catch(() => null)
  for (const driveFile of input.driveFiles ?? []) {
    const normalized = normalizeDrivePath(driveFile)
    if (!normalized.ok || driveRoot === null) throw new TrainCorpusError('invalid_request')
    const lexicalSource = join(input.driveDir, normalized.relativePath)
    const lexicalInfo = await lstat(lexicalSource).catch(() => null)
    if (lexicalInfo === null || lexicalInfo.isSymbolicLink() || !lexicalInfo.isFile()) {
      throw new TrainCorpusError('invalid_request')
    }
    const source = await realpath(lexicalSource).catch(() => null)
    if (source === null || !isPathInside(driveRoot, source)) {
      throw new TrainCorpusError('invalid_request')
    }
    const target = await safeCorpusTarget(input.jobDir, normalized.relativePath)
    await copyFile(source, target)
  }

  if (!(await containsFile(input.jobDir))) throw new TrainCorpusError('empty_corpus')
}

export async function runGatewayTrainPipeline(input: {
  stagingDir: string
  stateDir: string
  driveDir: string
  recordSlug: string
  runner: TrainRunner
  ensureRunner?: () => Promise<void>
  env?: Record<string, string>
  actor: string
  resolveTargetScope: () => TrainScope
  emitFileEvent?: (event: DriveFileEvent) => void
  onPhase: (phase: TrainExecutionPhase) => Promise<void> | void
  onChildPid?: (pid: number) => void
}): Promise<TrainRunnerResult> {
  const storeDir = join(input.stagingDir, 'store')
  await input.ensureRunner?.()
  await input.onPhase('training')
  const result = await input.runner({
    stagingDir: input.stagingDir,
    slug: input.recordSlug,
    storeDir,
    onChildPid: input.onChildPid,
    env: input.env,
  })
  const record = await readMemoryRecord(input.recordSlug, { storeDir, stateDir: input.stateDir })
  await input.onPhase('finalizing')
  const targetScope = input.resolveTargetScope()
  const targetStoreDir = await resolveMemoryStore(
    input.driveDir,
    targetScope.agentRoot,
    targetScope.memoriesDir,
  )
  const prior = await readExistingMemoryRecord(input.recordSlug, {
    storeDir: targetStoreDir,
    stateDir: input.stateDir,
  })
  const repairGeneration = await markTrainRecordRepair(
    targetScope,
    input.stateDir,
    input.recordSlug,
  )
  await installMemoryFile({
    sourceStoreDir: storeDir,
    targetStoreDir,
    slug: input.recordSlug,
  })
  await indexTrainRecord(targetScope, input.stateDir, input.recordSlug, repairGeneration)
  emitTrainFileEvent(input.emitFileEvent, {
    kind: 'write',
    path: relative(input.driveDir, join(targetScope.memoriesDir, `${input.recordSlug}.md`))
      .split(sep)
      .join('/'),
    actor: input.actor,
    at: Date.now(),
  })
  if (prior?.archiveId !== undefined && prior.archiveId !== record.archiveId) {
    await removeMemoryArchive(input.stateDir, prior.archiveId)
  }
  return { ...result, record }
}

async function readExistingMemoryRecord(
  slug: string,
  options: { storeDir: string; stateDir: string },
): Promise<TrainRecord | null> {
  try {
    return await readMemoryRecord(slug, options)
  } catch (error) {
    if (error instanceof MemoryStoreError && error.code === 'not_found') return null
    throw error
  }
}

async function installMemoryFile(input: {
  sourceStoreDir: string
  targetStoreDir: string
  slug: string
}): Promise<{ size: number; mtimeMs: number }> {
  const source = join(input.sourceStoreDir, `${input.slug}.md`)
  const sourceStatus = await lstat(source)
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile()) {
    throw new Error('Training output must be a regular memory file.')
  }
  const target = join(input.targetStoreDir, `${input.slug}.md`)
  const targetStatus = await lstat(target).catch(error => {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  })
  if (targetStatus?.isSymbolicLink() || (targetStatus !== null && !targetStatus.isFile())) {
    throw new Error('Training target must be a regular memory file.')
  }

  const temporary = join(input.targetStoreDir, `.${input.slug}.${randomUUID()}.tmp`)
  try {
    await copyFile(source, temporary)
    await chmod(temporary, 0o600)
    const installed = await stat(temporary)
    await rename(temporary, target)
    return { size: installed.size, mtimeMs: installed.mtimeMs }
  } finally {
    await rm(temporary, { force: true })
  }
}

async function resolveMemoryStore(
  driveDir: string,
  agentRoot: string,
  memoriesDir: string,
): Promise<string> {
  const driveRoot = await realpath(driveDir).catch(() => null)
  if (driveRoot === null) throw new Error('Training drive no longer exists.')
  const driveStatus = await lstat(driveDir)
  if (driveStatus.isSymbolicLink() || !driveStatus.isDirectory()) {
    throw new Error('Training drive must be a real directory.')
  }
  if (resolve(memoriesDir) !== resolve(agentRoot, '.agents', 'memories')) {
    throw new Error('Training memory store does not match the resolved agent root.')
  }
  const agentStatus = await lstat(agentRoot).catch(() => null)
  const resolvedAgentRoot = await realpath(agentRoot).catch(() => null)
  if (
    agentStatus === null ||
    resolvedAgentRoot === null ||
    agentStatus.isSymbolicLink() ||
    !agentStatus.isDirectory() ||
    !isPathInside(driveRoot, resolvedAgentRoot)
  ) {
    throw new Error('Training agent root is unavailable.')
  }
  let parent = resolvedAgentRoot
  for (const segment of ['.agents', 'memories']) {
    const child = join(parent, segment)
    let status = await lstat(child).catch(error => {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    })
    if (status === null) {
      await mkdir(child, { mode: 0o700 })
      status = await lstat(child)
    }
    if (status.isSymbolicLink()) {
      throw new Error('Training memory store cannot be symlink.')
    }
    if (!status.isDirectory()) {
      throw new Error('Training memory store must be a real directory.')
    }
    parent = await realpath(child)
    if (!isPathInside(driveRoot, parent)) {
      throw new Error('Training memory store escaped the drive.')
    }
  }
  return parent
}

function safeCorpusPath(filename: string): string {
  const normalized = normalizeDrivePath(filename)
  if (!normalized.ok) throw new TrainCorpusError('invalid_request')
  return normalized.relativePath
}

async function safeCorpusTarget(jobDir: string, relativePath: string): Promise<string> {
  const root = await realpath(jobDir)
  let parent = root
  const parentParts = dirname(relativePath)
    .split('/')
    .filter(part => part.length > 0 && part !== '.')
  for (const part of parentParts) {
    const next = join(parent, part)
    let info = await lstat(next).catch(() => null)
    if (info === null) {
      await mkdir(next, { mode: 0o700 })
      info = await lstat(next)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TrainCorpusError('invalid_request')
    }
    parent = await realpath(next)
    if (!isPathInside(root, parent)) throw new TrainCorpusError('invalid_request')
  }
  const target = join(parent, basename(relativePath))
  const targetInfo = await lstat(target).catch(() => null)
  if (targetInfo?.isSymbolicLink() || (targetInfo !== null && !targetInfo.isFile())) {
    throw new TrainCorpusError('invalid_request')
  }
  return target
}

async function containsFile(path: string): Promise<boolean> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isFile()) return true
    if (entry.isDirectory() && (await containsFile(join(path, entry.name)))) return true
  }
  return false
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

export function emitTrainFileEvent(
  emit: ((event: DriveFileEvent) => void) | undefined,
  event: DriveFileEvent,
): void {
  try {
    emit?.(event)
  } catch {
    // Attribution is observational and must never turn a successful file mutation into a failure.
  }
}
