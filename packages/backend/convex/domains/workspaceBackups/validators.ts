import { v } from 'convex/values'
export const backupPurpose = v.union(
  v.literal('export'),
  v.literal('archive'),
  v.literal('reprovision'),
)
export const backupStatus = v.union(
  v.literal('queued'),
  v.literal('running'),
  v.literal('ready'),
  v.literal('failed'),
  v.literal('deleting'),
)
export const backupPhase = v.union(
  v.literal('metadata'),
  v.literal('files'),
  v.literal('upload'),
  v.literal('finalizing'),
)
export const backupProgress = v.object({
  processedFiles: v.number(),
  processedRecords: v.number(),
  capturedBytes: v.number(),
  uploadedBytes: v.number(),
  warningCount: v.number(),
  warningSummary: v.array(v.object({ code: v.string(), count: v.number() })),
})
export const backupError = v.object({ code: v.string(), message: v.string() })

export const backupLifecycleKind = v.union(
  v.literal('reprovision'),
  v.literal('archive'),
  v.literal('servicing'),
)
export const backupLifecycle = v.object({
  kind: backupLifecycleKind,
  status: v.union(
    v.literal('capturing'),
    v.literal('restoring'),
    v.literal('complete'),
    v.literal('failed'),
    v.literal('deferred'),
    v.literal('abandoned'),
  ),
  reason: v.optional(v.string()),
})
export const pendingBackupLifecycle = v.object({
  operationId: v.string(),
  kind: backupLifecycleKind,
  backupId: v.id('workspaceBackups'),
  phase: v.union(v.literal('capturing'), v.literal('restoring')),
  expectedVmName: v.optional(v.string()),
  expectedVmTokenNonce: v.optional(v.string()),
  imageRef: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
  servicingStatus: v.optional(v.union(v.literal('paused'), v.literal('banned'))),
  servicingStatusChangedAt: v.optional(v.number()),
  dueAt: v.optional(v.number()),
})

export const backupRestoration = v.object({
  attemptId: v.string(),
  vmGeneration: v.string(),
  vmName: v.string(),
  status: v.union(
    v.literal('running'),
    v.literal('installed'),
    v.literal('failed'),
    v.literal('stopping'),
  ),
  phase: v.union(
    v.literal('download'),
    v.literal('index'),
    v.literal('extract'),
    v.literal('install'),
  ),
  processedBytes: v.number(),
  processedEntries: v.number(),
  lastProgressAt: v.number(),
})
