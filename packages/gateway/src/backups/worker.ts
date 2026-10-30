import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  assertPathOutsideDriveRoot,
  BackupCapturePageSchema,
  BackupPhaseSchema,
  BACKUP_STALL_MS,
  BackupUploadGrantSchema,
  BackupWorkerClaimResponseSchema,
  BackupWorkerCompleteRequestSchema,
  type BackupProgress,
} from '@repo/contract'

import { writeAtomicJson } from '../atomic-json'
import { buildWorkspaceBackup } from './archive'
import { workspaceMetadataEntries } from './metadata'
import { backupOperationDeadline } from './operation'
import { uploadWorkspaceBackup, type BackupMultipartSdk } from './upload'

type Completion = ReturnType<typeof BackupWorkerCompleteRequestSchema.parse>
type Failure = {
  code: 'interrupted' | 'stalled' | 'capture_failed' | 'upload_failed'
  message: string
}
type Journal = {
  backupId: string
  attemptId: string
  state: 'capturing' | 'uploaded' | 'failed'
  phase: 'metadata' | 'files' | 'upload' | 'finalizing'
  progress: BackupProgress
  completion?: Completion
  error?: Failure
}

const emptyProgress = (): BackupProgress => ({
  processedFiles: 0,
  processedRecords: 0,
  capturedBytes: 0,
  uploadedBytes: 0,
  warningCount: 0,
  warningSummary: [],
})

class InactiveAttempt extends Error {}

export function createBackupWorker(options: {
  driveDir: string
  stateDir: string
  apiUrl?: string
  getVmToken: () => Promise<string | null>
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  extraHeaders?: Record<string, string>
  sdk?: BackupMultipartSdk
  wakeSync?: () => void
  isStartBlocked?: () => boolean
  now?: () => number
  log?: (fields: Record<string, unknown>) => void
}) {
  const root = assertPathOutsideDriveRoot(join(options.stateDir, 'backups'), options.driveDir)
  const scratchDir = join(root, 'scratch')
  const journalPath = join(root, 'worker.json')
  const now = options.now ?? Date.now
  let journal: Journal | null = null
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal | null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // No stream resumes across process lifetimes. Completed artifacts only retry their report.
  if (journal?.state === 'capturing') {
    journal.state = 'failed'
    journal.error = { code: 'interrupted', message: 'Gateway restarted during capture or upload' }
    writeAtomicJson(journalPath, journal)
  }
  rmSync(scratchDir, { recursive: true, force: true })
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 })
  let active: { controller: AbortController; task: Promise<void> } | null = null
  let reporting: Promise<void> | null = null
  let lastActivity = now(),
    nextReportAt = 0,
    reportFailures = 0,
    claimedAttempt = false

  function persist(value: Journal | null) {
    writeAtomicJson(journalPath, value)
    journal = value
  }
  function touch() {
    lastActivity = now()
  }
  async function control(operation: string, body: Record<string, unknown>, signal: AbortSignal) {
    if (!options.apiUrl) throw new Error('Backup control API unavailable')
    return backupOperationDeadline(
      async requestSignal => {
        const token = await options.getVmToken()
        if (!token) throw new Error('Backup VM token unavailable')
        const response = await (options.fetch ?? fetch)(
          `${options.apiUrl!.replace(/\/+$/, '')}/v1/vm/backups/${encodeURIComponent(String(body.backupId))}/${operation}`,
          {
            method: 'POST',
            headers: {
              ...options.extraHeaders,
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(
              Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'backupId')),
            ),
            signal: requestSignal,
          },
        )
        if (response.status === 409) {
          await response.body?.cancel()
          throw new InactiveAttempt('Backup attempt is no longer active')
        }
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(`Backup ${operation} returned HTTP ${response.status}`)
        }
        return response.json()
      },
      signal,
      30_000,
    )
  }
  function checkProgress() {
    if (active && now() - lastActivity >= BACKUP_STALL_MS)
      active.controller.abort(new Error('Backup made no progress'))
  }
  async function sendReport() {
    checkProgress()
    if (!journal || now() < nextReportAt || (journal.state === 'capturing' && !claimedAttempt))
      return
    const current = journal
    const reportedState = current.state
    const operation =
      current.state === 'uploaded' ? 'complete' : current.state === 'failed' ? 'fail' : 'progress'
    const payload =
      current.state === 'uploaded'
        ? current.completion!
        : current.state === 'failed'
          ? { attemptId: current.attemptId, error: current.error }
          : { attemptId: current.attemptId, phase: current.phase, progress: current.progress }
    try {
      await control(
        operation,
        { backupId: current.backupId, ...payload },
        new AbortController().signal,
      )
      reportFailures = 0
      nextReportAt = now() + 15_000
      if (reportedState !== 'capturing' && journal === current && current.state === reportedState)
        persist(null)
    } catch (error) {
      if (error instanceof InactiveAttempt) {
        active?.controller.abort(error)
        if (journal === current) persist(null)
        return
      }
      reportFailures++
      nextReportAt = now() + Math.min(300_000, 5_000 * 2 ** Math.min(reportFailures - 1, 6))
      options.log?.({
        operation: 'backup_report_failed',
        backupId: current.backupId,
        state: current.state,
      })
    }
  }
  function reconcile(): Promise<void> {
    if (reporting) return reporting
    reporting = sendReport().finally(() => {
      reporting = null
    })
    return reporting
  }
  async function run(current: Journal, controller: AbortController) {
    const signal = controller.signal
    const watchdog = setInterval(checkProgress, 5_000)
    watchdog.unref()
    function advancePhase(phase: Journal['phase']) {
      if (
        BackupPhaseSchema.options.indexOf(phase) > BackupPhaseSchema.options.indexOf(current.phase)
      )
        current.phase = phase
    }
    let uploading = false,
      wasInterrupted = false
    try {
      const claimed = BackupWorkerClaimResponseSchema.parse(
        await control(
          'claim',
          { backupId: current.backupId, attemptId: current.attemptId },
          signal,
        ),
      )
      if (claimed.backup.id !== current.backupId || claimed.backup.attemptId !== current.attemptId)
        throw new Error('Backup claim mismatch')
      claimedAttempt = true
      touch()
      const archive = buildWorkspaceBackup({
        driveDir: options.driveDir,
        signal,
        capture: {
          backupId: current.backupId,
          workspace: claimed.workspace,
          createdAt: claimed.backup.createdAt,
        },
        records: workspaceMetadataEntries({
          cutoff: claimed.backup.createdAt,
          signal,
          scratchDir,
          fetch: options.fetch,
          page: async (query, pageSignal) => {
            const page = BackupCapturePageSchema.parse(
              await control(
                'capture',
                { backupId: current.backupId, attemptId: current.attemptId, ...query },
                pageSignal,
              ),
            )
            current.progress.processedRecords += page.records.length
            if (page.records.length || page.warnings.length) touch()
            return page
          },
        }),
        onProgress: counts => {
          current.progress.processedFiles = counts.drive
          current.progress.capturedBytes = counts.bytes
          advancePhase(counts.workspace ? 'metadata' : 'files')
          touch()
        },
      })
      uploading = true
      const result = await uploadWorkspaceBackup({
        body: archive.body,
        pathname: claimed.backup.objectPath,
        scratchDir,
        signal,
        sdk: options.sdk,
        now,
        grant: async () =>
          BackupUploadGrantSchema.parse(
            await control(
              'grant',
              { backupId: current.backupId, attemptId: current.attemptId },
              signal,
            ),
          ),
        onRead: touch,
        onProgress: bytes => {
          current.progress.uploadedBytes = bytes
          advancePhase('upload')
          touch()
        },
      })
      const summary = await archive.completed
      signal.throwIfAborted()
      current.progress.warningSummary = Object.entries(summary.warningCounts).map(
        ([code, count]) => ({ code, count }),
      )
      current.progress.warningCount = current.progress.warningSummary.reduce(
        (sum, row) => sum + row.count,
        0,
      )
      current.progress.capturedBytes = summary.counts.bytes
      current.progress.processedFiles = summary.counts.drive
      current.state = 'uploaded'
      current.phase = 'finalizing'
      current.completion = BackupWorkerCompleteRequestSchema.parse({
        attemptId: current.attemptId,
        ...result,
        completeness: summary.completeness,
        progress: current.progress,
      })
      persist(current)
    } catch (error) {
      const interrupted = signal.aborted
      wasInterrupted = interrupted
      controller.abort(error)
      if (journal !== current) return
      if (error instanceof InactiveAttempt || signal.reason instanceof InactiveAttempt) {
        persist(null)
        return
      }
      current.state = 'failed'
      current.error = interrupted
        ? {
            code:
              signal.reason instanceof Error && signal.reason.message === 'Backup made no progress'
                ? 'stalled'
                : 'interrupted',
            message: 'Backup capture was interrupted',
          }
        : {
            code: uploading ? 'upload_failed' : 'capture_failed',
            message: uploading
              ? 'Backup upload or archive encoding failed'
              : 'Backup capture could not start',
          }
      persist(current)
    } finally {
      clearInterval(watchdog)
    }
    if (wasInterrupted) return
    if (reporting) await reporting
    nextReportAt = 0
    await reconcile()
  }
  return {
    start(backupId: string, attemptId: string): { accepted: boolean } {
      if (journal || active) {
        return { accepted: journal?.backupId === backupId && journal.attemptId === attemptId }
      }
      if (options.isStartBlocked?.()) return { accepted: false }
      const current: Journal = {
        backupId,
        attemptId,
        state: 'capturing',
        phase: 'metadata',
        progress: emptyProgress(),
      }
      persist(current)
      touch()
      nextReportAt = 0
      claimedAttempt = false
      const controller = new AbortController()
      const task = Promise.resolve()
        .then(() => run(current, controller))
        .catch(() => {
          options.log?.({ operation: 'backup_worker_failed', backupId })
        })
        .finally(() => {
          active = null
        })
      active = { controller, task }
      options.wakeSync?.()
      return { accepted: true }
    },
    async cancel(backupId: string, attemptId: string): Promise<{ cancelled: boolean }> {
      if (journal?.backupId !== backupId || journal.attemptId !== attemptId)
        return { cancelled: false }
      active?.controller.abort(new Error('Backup cancelled'))
      await active?.task
      if (journal?.backupId === backupId && journal.attemptId === attemptId) persist(null)
      return { cancelled: true }
    },
    reconcile,
    isRunning: () => active !== null,
    pollAfterMs: () =>
      active ? 5_000 : journal ? Math.max(1_000, nextReportAt - now()) : undefined,
    snapshot: () =>
      journal === null
        ? null
        : {
            backupId: journal.backupId,
            attemptId: journal.attemptId,
            state: journal.state,
            phase: journal.phase,
            progress: { ...journal.progress },
          },
  }
}
