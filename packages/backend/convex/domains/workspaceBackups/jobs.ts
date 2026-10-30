import { makeFunctionReference, paginationOptsValidator } from 'convex/server'
import { ConvexError, v, type Infer } from 'convex/values'

import {
  BACKUP_UPLOAD_GRANT_MS,
  BACKUP_UPLOAD_SETTLE_MS,
  BACKUP_STALL_MS,
  BackupCreateRequestSchema,
  BackupErrorSchema,
  BackupProgressSchema,
} from '@repo/contract'

import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { mutation, query } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { randomHex } from '../workspaces/vmToken'
import { backupError, backupPhase, backupProgress, backupPurpose } from './validators'

const workspaceArgs = { internalKey: v.string(), workspaceId: v.id('workspaces') }
const jobArgs = { ...workspaceArgs, backupId: v.id('workspaceBackups') }
const attemptArgs = { ...jobArgs, attemptId: v.string(), sourceVmGeneration: v.string() }
const emptyProgress = {
  processedFiles: 0,
  processedRecords: 0,
  capturedBytes: 0,
  uploadedBytes: 0,
  warningCount: 0,
  warningSummary: [],
}
async function owned(
  ctx: QueryCtx,
  args: {
    internalKey: string
    workspaceId: Doc<'workspaces'>['_id']
    backupId: Doc<'workspaceBackups'>['_id']
  },
) {
  requireApiInternalKey(args.internalKey)
  const job = await ctx.db.get(args.backupId)
  return job?.workspaceId === args.workspaceId ? job : null
}
async function current(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Doc<'workspaces'>['_id']
    backupId: Doc<'workspaceBackups'>['_id']
    attemptId: string
    sourceVmGeneration: string
  },
) {
  const job = await owned(ctx, args)
  const workspace = await ctx.db.get(args.workspaceId)
  return job &&
    job.attemptId === args.attemptId &&
    workspace?.vmTokenNonce === args.sourceVmGeneration &&
    job.sourceVmGeneration === args.sourceVmGeneration
    ? job
    : null
}
const createArgs = v.object({
  ...workspaceArgs,
  requestId: v.string(),
  purpose: v.optional(backupPurpose),
  pendingLifecycleOperation: v.optional(v.string()),
})
export const create = mutation({ args: createArgs, handler: createBackupImpl })

export async function createBackupImpl(ctx: MutationCtx, args: Infer<typeof createArgs>) {
  requireApiInternalKey(args.internalKey)
  if (!BackupCreateRequestSchema.safeParse({ requestId: args.requestId }).success)
    throw new ConvexError({ code: 'invalid_request' })
  if (args.pendingLifecycleOperation && args.pendingLifecycleOperation.length > 128)
    throw new ConvexError({ code: 'invalid_lifecycle_operation' })
  const workspace = await ctx.db.get(args.workspaceId)
  if (!workspace || workspace.status === 'deleted')
    throw new ConvexError({ code: 'workspace_not_found' })
  const existing = await ctx.db
    .query('workspaceBackups')
    .withIndex('by_request', q =>
      q.eq('workspaceId', args.workspaceId).eq('requestId', args.requestId),
    )
    .unique()
  if (existing) return existing
  for (const status of ['queued', 'running'] as const) {
    const active = await ctx.db
      .query('workspaceBackups')
      .withIndex('by_workspace_status', q =>
        q.eq('workspaceId', args.workspaceId).eq('status', status),
      )
      .first()
    if (active) throw new ConvexError({ code: 'backup_in_progress', backupId: active._id })
  }
  const now = Date.now()
  const attemptId = randomHex(16)
  const id = await ctx.db.insert('workspaceBackups', {
    workspaceId: args.workspaceId,
    requestId: args.requestId,
    purpose: args.purpose ?? 'export',
    pendingLifecycleOperation: args.pendingLifecycleOperation,
    status: 'queued',
    attemptId,
    objectPath: '',
    objectCleanupPending: false,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    progress: emptyProgress,
  })
  await ctx.db.patch(id, {
    objectPath: `workspace-backups/${args.workspaceId}/${id}/${attemptId}.zip`,
  })
  await ctx.scheduler.runAfter(0, backupTick, { backupId: id })
  return (await ctx.db.get(id))!
}
export const get = query({ args: jobArgs, handler: owned })
export const list = query({
  args: { ...workspaceArgs, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 100)
      throw new ConvexError({ code: 'invalid_page_size' })
    return ctx.db
      .query('workspaceBackups')
      .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
      .order('desc')
      .paginate(args.paginationOpts)
  },
})
export const claim = mutation({
  args: attemptArgs,
  handler: async (ctx, args) => {
    const job = await owned(ctx, args)
    const workspace = await ctx.db.get(args.workspaceId)
    if (
      !job ||
      job.attemptId !== args.attemptId ||
      workspace?.vmTokenNonce !== args.sourceVmGeneration
    )
      return null
    if (job.status === 'running' && job.sourceVmGeneration === args.sourceVmGeneration) return job
    if (job.status !== 'queued') return null
    const now = Date.now()
    await ctx.db.patch(job._id, {
      status: 'running',
      sourceVmGeneration: args.sourceVmGeneration,
      phase: 'metadata',
      startedAt: now,
      updatedAt: now,
      lastProgressAt: now,
    })
    return ctx.db.get(job._id)
  },
})
export const progress = mutation({
  args: { ...attemptArgs, phase: backupPhase, progress: backupProgress },
  handler: async (ctx, args) => {
    const job = await current(ctx, args)
    if (!job || job.status !== 'running') return false
    const phases = ['metadata', 'files', 'upload', 'finalizing']
    if (phases.indexOf(args.phase) < phases.indexOf(job.phase ?? 'metadata')) return false
    const progress = BackupProgressSchema.parse(args.progress)
    for (const field of [
      'processedFiles',
      'processedRecords',
      'capturedBytes',
      'uploadedBytes',
      'warningCount',
    ] as const) {
      if (progress[field] < job.progress[field]) return false
    }
    const moved =
      args.phase !== job.phase ||
      (
        [
          'processedFiles',
          'processedRecords',
          'capturedBytes',
          'uploadedBytes',
          'warningCount',
        ] as const
      ).some(field => progress[field] > job.progress[field])
    await ctx.db.patch(job._id, {
      progress,
      phase: args.phase,
      updatedAt: Date.now(),
      ...(moved ? { lastProgressAt: Date.now() } : {}),
    })
    return true
  },
})
export const complete = mutation({
  args: {
    ...attemptArgs,
    bytes: v.number(),
    sha256: v.string(),
    completeness: v.union(v.literal('complete'), v.literal('partial')),
    progress: v.optional(backupProgress),
  },
  handler: async (ctx, args) => {
    const job = await current(ctx, args)
    if (!job) return false
    if (job.status === 'ready')
      return (
        job.bytes === args.bytes &&
        job.sha256 === args.sha256 &&
        job.completeness === args.completeness
      )
    if (job.status !== 'running') return false
    if (!Number.isSafeInteger(args.bytes) || args.bytes <= 0 || !/^[a-f0-9]{64}$/.test(args.sha256))
      throw new ConvexError({ code: 'invalid_object_metadata' })
    const now = Date.now()
    await ctx.db.patch(job._id, {
      status: 'ready',
      uploadGrantExpiresAt: undefined,
      phase: undefined,
      bytes: args.bytes,
      sha256: args.sha256,
      completeness: args.completeness,
      ...(args.progress ? { progress: BackupProgressSchema.parse(args.progress) } : {}),
      completedAt: now,
      updatedAt: now,
    })
    return true
  },
})
export const fail = mutation({
  args: { ...attemptArgs, error: backupError },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args)
    // Dispatch can fail before claim has persisted a source generation.
    if (!job || job.attemptId !== args.attemptId || !['queued', 'running'].includes(job.status))
      return false
    const workspace = await ctx.db.get(args.workspaceId)
    if ((workspace?.vmTokenNonce ?? '') !== args.sourceVmGeneration) return false
    if (job.sourceVmGeneration && job.sourceVmGeneration !== args.sourceVmGeneration) return false
    const error = BackupErrorSchema.parse(args.error)
    await ctx.db.patch(job._id, {
      status: 'failed',
      objectCleanupPending: true,
      phase: undefined,
      error,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    })
    return true
  },
})
export const requestDelete = mutation({
  args: jobArgs,
  handler: async (ctx, args) => {
    const job = await owned(ctx, args)
    if (!job) return { deleted: true, emptyDriveOnNextStart: false, backup: null }
    if (job.pendingLifecycleOperation) throw new ConvexError({ code: 'backup_in_use' })
    const workspace = await ctx.db.get(args.workspaceId)
    const emptyDriveOnNextStart =
      job.emptyDriveOnNextStart ??
      (workspace?.lifecycleBackupId === job._id && workspace.status === 'archived')
    if (workspace?.lifecycleBackupId === job._id)
      await ctx.db.patch(workspace._id, { lifecycleBackupId: undefined })
    if (job.status !== 'deleting') {
      await ctx.db.patch(job._id, {
        status: 'deleting',
        objectCleanupPending: true,
        phase: undefined,
        updatedAt: Date.now(),
        emptyDriveOnNextStart,
      })
      await ctx.scheduler.runAfter(0, backupTick, { backupId: job._id })
    }
    return { deleted: false, emptyDriveOnNextStart, backup: await ctx.db.get(job._id) }
  },
})
export const finishDelete = mutation({
  args: jobArgs,
  handler: async (ctx, args) => {
    const job = await owned(ctx, args)
    if (!job) return true
    if (job.status !== 'deleting' || uploadAuthorityMayBeLive(job)) return false
    await ctx.db.delete(job._id)
    return true
  },
})
export const cleanupFailed = mutation({
  args: { ...jobArgs, error: backupError },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args)
    if (!job || job.status !== 'deleting') return false
    await ctx.db.patch(job._id, {
      error: BackupErrorSchema.parse(args.error),
      updatedAt: Date.now(),
    })
    return true
  },
})
const settleLifecycleArgs = v.object({
  ...jobArgs,
  operationId: v.string(),
  retainForRecovery: v.boolean(),
})
export const settleLifecycle = mutation({
  args: settleLifecycleArgs,
  handler: settleLifecycleImpl,
})

export async function settleLifecycleImpl(
  ctx: MutationCtx,
  args: Infer<typeof settleLifecycleArgs>,
) {
  const job = await owned(ctx, args)
  if (!job || job.pendingLifecycleOperation !== args.operationId) return false
  if (args.retainForRecovery) {
    if (job.status !== 'ready') throw new ConvexError({ code: 'backup_not_ready' })
    if (job.completeness !== 'complete') throw new ConvexError({ code: 'backup_incomplete' })
    const workspace = await ctx.db.get(args.workspaceId)
    if (!workspace) throw new ConvexError({ code: 'workspace_not_found' })
    await ctx.db.patch(workspace._id, { lifecycleBackupId: job._id })
  }
  await ctx.db.patch(job._id, { pendingLifecycleOperation: undefined })
  return true
}

export const markObjectRemoved = mutation({
  args: jobArgs,
  handler: async (ctx, args) => {
    const job = await owned(ctx, args)
    if (!job) return true
    if (job.status !== 'failed' || uploadAuthorityMayBeLive(job)) return false
    await ctx.db.patch(job._id, { objectCleanupPending: false })
    return true
  },
})

// Allow an in-flight provider request to settle after its last token expires.
function uploadAuthorityMayBeLive(job: Doc<'workspaceBackups'>): boolean {
  return (
    job.uploadGrantExpiresAt !== undefined &&
    job.uploadGrantExpiresAt + BACKUP_UPLOAD_SETTLE_MS > Date.now()
  )
}

export const authorizeUpload = mutation({
  args: attemptArgs,
  handler: async (ctx, args) => {
    const job = await current(ctx, args)
    if (!job || job.status !== 'running') return null
    const expiresAt = Date.now() + BACKUP_UPLOAD_GRANT_MS
    await ctx.db.patch(job._id, { uploadGrantExpiresAt: expiresAt })
    return { expiresAt }
  },
})

const backupTick = makeFunctionReference<'action'>('domains/workspaceBackups/dispatch:tick')

export const authenticateVm = query({
  args: { internalKey: v.string(), backupId: v.id('workspaceBackups'), vmTokenHash: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_vmTokenHash', q => q.eq('vmTokenHash', args.vmTokenHash))
      .unique()
    if (
      !workspace ||
      !workspace.vmTokenNonce ||
      workspace.status === 'deleted' ||
      workspace.status === 'retired'
    )
      return null
    const backup = await ctx.db.get(args.backupId)
    return { backup: backup?.workspaceId === workspace._id ? backup : null, workspace }
  },
})

export const reconcile = mutation({
  args: { internalKey: v.string(), backupId: v.id('workspaceBackups') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const backup = await ctx.db.get(args.backupId)
    if (!backup) return null
    const workspace = await ctx.db.get(backup.workspaceId)
    if (
      ['queued', 'running'].includes(backup.status) &&
      (backup.lastProgressAt < Date.now() - BACKUP_STALL_MS ||
        (backup.sourceVmGeneration && backup.sourceVmGeneration !== workspace?.vmTokenNonce))
    ) {
      await ctx.db.patch(backup._id, {
        status: 'failed',
        objectCleanupPending: true,
        phase: undefined,
        error: {
          code: 'stalled',
          message: 'Backup stopped making progress or its VM was replaced.',
        },
        completedAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
    return { backup: (await ctx.db.get(backup._id))!, workspace }
  },
})
