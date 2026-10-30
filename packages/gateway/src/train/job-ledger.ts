import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  GatewayTrainJobPhaseSchema,
  GatewayTrainJobReportBatchSchema,
  GatewayTrainJobReportSchema,
  MAX_TRAIN_ERROR_UTF8_BYTES,
  MAX_TRAIN_REPORTS_PER_SYNC,
  TrainIdentifierSchema,
  TrainRecordSlugSchema,
  truncateUtf8,
  type GatewayTrainJobPhase,
  type GatewayTrainJobReport,
} from '@repo/contract'

import { writeAtomicJson } from '../atomic-json'

const LEDGER_VERSION = 3 as const
const LEDGER_FILE = 'job-ledger-v3.json'
const MAX_UNACKED_REPORTS_PER_JOB = 32

const TERMINAL_PHASES = new Set<GatewayTrainJobPhase>(['done', 'failed'])
const NEXT_PHASE: Partial<Record<GatewayTrainJobPhase, GatewayTrainJobPhase>> = {
  preparing: 'snapshotting',
  snapshotting: 'training',
  training: 'finalizing',
  finalizing: 'cleanup',
}

export interface TrainJobSnapshot extends Pick<
  GatewayTrainJobReport,
  | 'jobId'
  | 'creatorUserId'
  | 'phase'
  | 'createdAt'
  | 'updatedAt'
  | 'startedAt'
  | 'completedAt'
  | 'error'
> {
  recordSlug: string
  startedAt: number
  anchorId?: string
  childPid?: number
}

interface PersistedTrainJobLedger {
  version: typeof LEDGER_VERSION
  nextGeneration: number
  jobs: Record<string, TrainJobSnapshot>
  outbox: GatewayTrainJobReport[]
}

export interface TrainJobLedger {
  /**
   * Open a job. `targetSlug` makes it a retrain: the run installs over that
   * existing record rather than minting a new one, which is why the slug is
   * persisted on the snapshot instead of being recomputed later — a resumed
   * or reloaded gateway must still write to the memory the user chose.
   */
  start(
    jobId: string,
    creatorUserId: string,
    options?: { anchorId?: string; targetSlug?: string },
  ): TrainJobSnapshot
  setPhase(jobId: string, phase: GatewayTrainJobPhase): void
  recordChildPid(jobId: string, pid: number): void
  complete(jobId: string): void
  fail(jobId: string, error: string): void
  hasRunningJob(scopeKey?: string): boolean
  snapshot(jobId: string, scopeKey?: string): TrainJobSnapshot | null
  snapshots(scopeKey: string): TrainJobSnapshot[]
  reports(): GatewayTrainJobReport[]
  acknowledge(generations: string[]): void
  reconcileAtBoot(): void
}

export interface TrainJobLedgerOptions {
  stateDir: string
  now: () => number
  wakeSync?: () => void
  isPidAlive?: (pid: number) => boolean
  killPid?: (pid: number) => void
}

export function createTrainJobLedger(options: TrainJobLedgerOptions): TrainJobLedger {
  const ledgerPath = join(options.stateDir, 'train', LEDGER_FILE)
  const ledger = readLedger(ledgerPath)
  let persistedGeneration = ledger.nextGeneration
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  const killPid = options.killPid ?? defaultKillPid

  function persist(): void {
    GatewayTrainJobReportBatchSchema.parse(ledger.outbox)
    writeAtomicJson(ledgerPath, ledger)
    const reportsChanged = ledger.nextGeneration !== persistedGeneration
    persistedGeneration = ledger.nextGeneration
    if (reportsChanged) options.wakeSync?.()
  }

  // A terminal job's corpus snapshot is unreachable — no retry endpoint
  // exists — so it is deleted on completion AND failure. Cleanup runs only
  // after the terminal state is persisted: an rm error may leak disk, never
  // a stuck non-terminal job.
  function cleanupJobDir(jobId: string): void {
    try {
      rmSync(jobSnapshotPath(options.stateDir, jobId), { recursive: true, force: true })
    } catch (error) {
      console.warn(`[train] failed to remove job snapshot for ${jobId}: ${String(error)}`)
    }
  }

  function appendReport(snapshot: TrainJobSnapshot): void {
    ledger.outbox.push(
      GatewayTrainJobReportSchema.parse(snapshotToReport(snapshot, String(ledger.nextGeneration))),
    )
    ledger.nextGeneration += 1
    pruneOutboxForJob(ledger.outbox, snapshot.jobId)
    pruneOutboxForSync(ledger.outbox)
  }

  const api: TrainJobLedger = {
    start(jobId, creatorUserId, startOptions) {
      const boundedJobId = TrainIdentifierSchema.parse(jobId)
      const reportedJobs = new Set(ledger.outbox.map(report => report.jobId))
      if (reportedJobs.size >= MAX_TRAIN_REPORTS_PER_SYNC && !reportedJobs.has(boundedJobId)) {
        throw new Error('Train report backlog is full; synchronize before starting another job')
      }
      const boundedCreatorUserId = TrainIdentifierSchema.parse(creatorUserId)
      const boundedAnchorId =
        startOptions?.anchorId === undefined
          ? undefined
          : TrainIdentifierSchema.parse(startOptions.anchorId)
      const timestamp = options.now()
      const anchorId = boundedAnchorId
      const snapshot: TrainJobSnapshot = {
        jobId: boundedJobId,
        creatorUserId: boundedCreatorUserId,
        phase: 'preparing',
        recordSlug:
          startOptions?.targetSlug === undefined
            ? deriveRecordSlug(boundedJobId, timestamp)
            : TrainRecordSlugSchema.parse(startOptions.targetSlug),
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        ...(anchorId === undefined ? {} : { anchorId }),
      }
      ledger.jobs[boundedJobId] = snapshot
      appendReport(snapshot)
      persist()
      return structuredClone(snapshot)
    },
    setPhase(jobId, phase) {
      const snapshot = requireSnapshot(ledger, jobId)
      if (NEXT_PHASE[snapshot.phase] !== phase) {
        throw new Error(`invalid train job transition: ${snapshot.phase} -> ${phase}`)
      }
      snapshot.phase = phase
      snapshot.updatedAt = options.now()
      appendReport(snapshot)
      persist()
    },
    recordChildPid(jobId, pid) {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('trainer child pid must be positive')
      const snapshot = requireSnapshot(ledger, jobId)
      if (TERMINAL_PHASES.has(snapshot.phase)) {
        throw new Error(`cannot record trainer child pid for ${snapshot.phase} job`)
      }
      snapshot.childPid = pid
      persist()
    },
    complete(jobId) {
      const snapshot = requireSnapshot(ledger, jobId)
      if (snapshot.phase === 'finalizing') {
        snapshot.phase = 'cleanup'
        snapshot.updatedAt = options.now()
        appendReport(snapshot)
        persist()
      } else if (snapshot.phase !== 'cleanup') {
        throw new Error(`invalid train job transition: ${snapshot.phase} -> done`)
      }

      const completedAt = options.now()
      snapshot.phase = 'done'
      snapshot.updatedAt = completedAt
      snapshot.completedAt = completedAt
      delete snapshot.childPid
      appendReport(snapshot)
      persist()
      cleanupJobDir(jobId)
    },
    fail(jobId, error) {
      const snapshot = requireSnapshot(ledger, jobId)
      if (TERMINAL_PHASES.has(snapshot.phase)) {
        throw new Error(`invalid train job transition: ${snapshot.phase} -> failed`)
      }
      const completedAt = options.now()
      snapshot.phase = 'failed'
      // Trainer/process diagnostics are third-party text. The gateway is their
      // owning adapter, so it keeps the scalar-safe prefix that fits the row.
      snapshot.error = truncateUtf8(error, MAX_TRAIN_ERROR_UTF8_BYTES)
      snapshot.updatedAt = completedAt
      snapshot.completedAt = completedAt
      delete snapshot.childPid
      appendReport(snapshot)
      persist()
      cleanupJobDir(jobId)
    },
    hasRunningJob(scopeKey) {
      return Object.values(ledger.jobs).some(snapshot => {
        if (TERMINAL_PHASES.has(snapshot.phase)) return false
        if (scopeKey === undefined) return true
        return snapshotMatchesScope(snapshot, scopeKey)
      })
    },
    snapshot(jobId, scopeKey) {
      const snapshot = ledger.jobs[jobId]
      if (
        snapshot === undefined ||
        (scopeKey !== undefined && !snapshotMatchesScope(snapshot, scopeKey))
      ) {
        return null
      }
      return structuredClone(snapshot)
    },
    snapshots(scopeKey) {
      return Object.values(ledger.jobs)
        .filter(snapshot => snapshotMatchesScope(snapshot, scopeKey))
        .sort(
          (left, right) =>
            right.createdAt - left.createdAt || left.jobId.localeCompare(right.jobId),
        )
        .map(snapshot => structuredClone(snapshot))
    },
    reports() {
      return structuredClone(GatewayTrainJobReportBatchSchema.parse(ledger.outbox))
    },
    acknowledge(generations) {
      const acknowledged = new Set(generations)
      const retained = ledger.outbox.filter(report => !acknowledged.has(report.generation))
      if (retained.length === ledger.outbox.length) return
      ledger.outbox = retained
      const jobsWithReports = new Set(retained.map(report => report.jobId))
      for (const [jobId, snapshot] of Object.entries(ledger.jobs)) {
        if (TERMINAL_PHASES.has(snapshot.phase) && !jobsWithReports.has(jobId)) {
          delete ledger.jobs[jobId]
        }
      }
      persist()
    },
    reconcileAtBoot() {
      sweepLegacyStaging(options.stateDir)
      for (const snapshot of Object.values(ledger.jobs)) {
        if (TERMINAL_PHASES.has(snapshot.phase)) continue
        if (snapshot.childPid !== undefined) {
          try {
            if (isPidAlive(snapshot.childPid)) killPid(snapshot.childPid)
          } catch {
            // A failed process check or signal must not block reconciliation of other jobs.
          }
        }
        api.fail(snapshot.jobId, 'gateway_restarted')
      }
    },
  }
  return api
}

function snapshotMatchesScope(snapshot: TrainJobSnapshot, scopeKey: string): boolean {
  return scopeKey === 'root' ? snapshot.anchorId === undefined : snapshot.anchorId === scopeKey
}

function readLedger(path: string): PersistedTrainJobLedger {
  if (!existsSync(path)) {
    return { version: LEDGER_VERSION, nextGeneration: 1, jobs: {}, outbox: [] }
  }
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(value) || value.version !== LEDGER_VERSION) {
    throw new Error('unsupported train job ledger version')
  }
  if (
    typeof value.nextGeneration !== 'number' ||
    !Number.isSafeInteger(value.nextGeneration) ||
    value.nextGeneration < 1
  ) {
    throw new Error('invalid train job ledger generation')
  }
  if (!isRecord(value.jobs)) throw new Error('invalid train job ledger jobs')
  const jobs: Record<string, TrainJobSnapshot> = {}
  for (const [jobId, snapshot] of Object.entries(value.jobs)) {
    const parsed = parseSnapshot(snapshot)
    if (parsed.jobId !== jobId) throw new Error('invalid train job ledger snapshot key')
    jobs[jobId] = parsed
  }
  return {
    version: LEDGER_VERSION,
    nextGeneration: value.nextGeneration,
    jobs,
    outbox: GatewayTrainJobReportBatchSchema.parse(value.outbox),
  }
}

function parseSnapshot(value: unknown): TrainJobSnapshot {
  if (!isRecord(value) || typeof value.recordSlug !== 'string' || value.recordSlug.length === 0) {
    throw new Error('invalid train job ledger snapshot')
  }
  const phase = GatewayTrainJobPhaseSchema.parse(value.phase)
  const state = phase === 'done' ? 'done' : phase === 'failed' ? 'failed' : 'running'
  const report = GatewayTrainJobReportSchema.parse({
    generation: 'ledger-snapshot',
    jobId: value.jobId,
    creatorUserId: value.creatorUserId,
    state,
    phase,
    error: value.error,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
  })
  if (report.startedAt === undefined) throw new Error('invalid train job ledger snapshot')
  if (
    value.childPid !== undefined &&
    (typeof value.childPid !== 'number' ||
      !Number.isSafeInteger(value.childPid) ||
      value.childPid <= 0)
  ) {
    throw new Error('invalid train job ledger child pid')
  }
  if (
    value.anchorId !== undefined &&
    (typeof value.anchorId !== 'string' || value.anchorId.length === 0)
  ) {
    throw new Error('invalid train job ledger anchor id')
  }
  return {
    jobId: report.jobId,
    creatorUserId: report.creatorUserId,
    phase: report.phase,
    recordSlug: value.recordSlug,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    startedAt: report.startedAt,
    ...(report.completedAt === undefined ? {} : { completedAt: report.completedAt }),
    ...(report.error === undefined ? {} : { error: report.error }),
    ...(value.anchorId === undefined ? {} : { anchorId: value.anchorId }),
    ...(value.childPid === undefined ? {} : { childPid: value.childPid }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireSnapshot(ledger: PersistedTrainJobLedger, jobId: string): TrainJobSnapshot {
  const snapshot = ledger.jobs[jobId]
  if (snapshot === undefined) throw new Error(`unknown train job: ${jobId}`)
  return snapshot
}

function jobSnapshotPath(stateDir: string, jobId: string): string {
  return join(stateDir, 'train', 'jobs', encodeURIComponent(jobId))
}

function sweepLegacyStaging(stateDir: string): void {
  const stagingRoot = join(stateDir, 'train-staging')
  try {
    for (const entry of readdirSync(stagingRoot, { withFileTypes: true, encoding: 'utf8' })) {
      if (entry.isDirectory() && entry.name.startsWith('duet-train-')) {
        rmSync(join(stagingRoot, entry.name), { recursive: true, force: true })
      }
    }
  } catch {
    return
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function defaultKillPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The child may have exited between the liveness check and the signal.
  }
}

function snapshotToReport(snapshot: TrainJobSnapshot, generation: string): GatewayTrainJobReport {
  const state =
    snapshot.phase === 'done' ? 'done' : snapshot.phase === 'failed' ? 'failed' : 'running'
  return {
    generation,
    jobId: snapshot.jobId,
    creatorUserId: snapshot.creatorUserId,
    ...(snapshot.anchorId === undefined ? {} : { anchorId: snapshot.anchorId }),
    state,
    phase: snapshot.phase,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    startedAt: snapshot.startedAt,
    ...(snapshot.completedAt === undefined ? {} : { completedAt: snapshot.completedAt }),
  }
}

function pruneOutboxForJob(outbox: GatewayTrainJobReport[], jobId: string): void {
  let count = outbox.reduce((total, report) => total + Number(report.jobId === jobId), 0)
  if (count <= MAX_UNACKED_REPORTS_PER_JOB) return
  for (let index = 0; index < outbox.length && count > MAX_UNACKED_REPORTS_PER_JOB; ) {
    const report = outbox[index]!
    if (report.jobId === jobId && report.state !== 'done' && report.state !== 'failed') {
      outbox.splice(index, 1)
      count -= 1
    } else {
      index += 1
    }
  }
}

function pruneOutboxForSync(outbox: GatewayTrainJobReport[]): void {
  while (outbox.length > MAX_TRAIN_REPORTS_PER_SYNC) {
    const latestByJob = new Map<string, number>()
    for (let index = 0; index < outbox.length; index += 1) {
      latestByJob.set(outbox[index]!.jobId, index)
    }
    // Any older report for the same job is superseded by its newest snapshot,
    // including a terminal snapshot. Distinct jobs are never discarded.
    const removable = outbox.findIndex((report, index) => latestByJob.get(report.jobId) !== index)
    if (removable === -1) {
      throw new Error('Train report outbox exceeds the bounded sync batch')
    }
    outbox.splice(removable, 1)
  }
}

function deriveRecordSlug(jobId: string, timestamp: number): string {
  const date = new Date(timestamp).toISOString().slice(0, 10)
  const jobPart =
    jobId
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/g, '') || 'job'
  const hash = createHash('sha256').update(jobId).digest('hex').slice(0, 8)
  return `train-${date}-${jobPart}-${hash}`
}
