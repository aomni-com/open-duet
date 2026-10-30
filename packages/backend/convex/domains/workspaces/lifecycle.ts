import { makeFunctionReference } from 'convex/server'
import { ConvexError, v } from 'convex/values'

import type { Doc } from '../../_generated/dataModel'
import { internalMutation, mutation, type MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { createBackupImpl, settleLifecycleImpl } from '../workspaceBackups/jobs'
import { stopStalledRestore } from '../workspaceBackups/restore'
import { pinRecoveryBackup } from './lifecycleState'
import {
  ARCHIVE_RETRY_GRACE_MS,
  dispositionAfterArchiveFailure,
  beginOperatorReprovisionImpl,
  markAdminArchivedImpl,
  markServicingArchivedImpl,
  operatorReprovisionPlanImpl,
  recordOperatorReprovisionDeferredImpl,
  servicingDecommissionCandidatesImpl,
} from './provisioningCore'
import { resolveVmImageRef } from './vmImage'
import { randomHex } from './vmToken'

export const requestReprovision = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    imageRef: v.optional(v.string()),
    discardState: v.optional(v.boolean()),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (!workspace) throw new ConvexError({ code: 'workspace_not_found' })
    const plan = await operatorReprovisionPlanImpl(ctx, args)
    if (plan.status === 'provisioning')
      return { status: 'provisioning' as const, workspaceId: workspace._id, scheduled: false }
    if (plan.activeAgentSessions > 0 || plan.activeTrainJobs > 0) {
      await recordOperatorReprovisionDeferredImpl(ctx, {
        ...args,
        activeAgentSessions: plan.activeAgentSessions,
        activeTrainJobs: plan.activeTrainJobs,
        now: args.now ?? Date.now(),
      })
      return {
        status: 'deferred' as const,
        reason: 'active_workspace_work' as const,
        activeAgentSessions: plan.activeAgentSessions,
        activeTrainJobs: plan.activeTrainJobs,
      }
    }
    if (
      !args.discardState &&
      workspace.pendingBackupLifecycle &&
      workspace.pendingBackupLifecycle.kind !== 'reprovision'
    ) {
      throw new ConvexError({
        code: 'backup_in_progress',
        backupId: workspace.pendingBackupLifecycle.backupId,
      })
    }
    const imageRef = resolveVmImageRef(args.imageRef)
    const recovery =
      workspace.status === 'unhealthy' &&
      workspace.lifecycleBackupId &&
      !workspace.pendingBackupLifecycle
        ? await ctx.db.get(workspace.lifecycleBackupId)
        : null
    // A failed replacement's Drive is not a new recovery source. A matching
    // installed acknowledgement, however, makes that VM's later edits authoritative.
    const retryFailedRecovery =
      recovery !== null &&
      (recovery.restoration?.vmGeneration === workspace.vmTokenNonce
        ? recovery.restoration?.status === 'failed'
        : recovery.lifecycle?.status === 'failed' &&
          recovery.sourceVmGeneration !== undefined &&
          recovery.sourceVmGeneration !== workspace.vmTokenNonce)
    if (
      args.discardState === true ||
      retryFailedRecovery ||
      !workspace.vmName ||
      !workspace.httpsUrl ||
      !workspace.vmTokenNonce
    ) {
      if (args.discardState && workspace.pendingBackupLifecycle) {
        const pending = await ctx.db.get(workspace.pendingBackupLifecycle.backupId)
        if (pending)
          await ctx.db.patch(pending._id, {
            pendingLifecycleOperation: undefined,
            lifecycle: {
              kind: workspace.pendingBackupLifecycle.kind,
              status: 'abandoned',
              reason: 'discard_state',
            },
          })
        await ctx.db.patch(workspace._id, { pendingBackupLifecycle: undefined })
      }
      const lifecycleBackupId = args.discardState ? undefined : workspace.lifecycleBackupId
      if (lifecycleBackupId) await pinRecoveryBackup(ctx, workspace)
      const started = await beginOperatorReprovisionImpl(ctx, {
        ...args,
        imageRef,
        lifecycleBackupId,
        previousVmName: workspace.vmName,
        now: args.now ?? Date.now(),
      })
      if (args.discardState)
        await ctx.db.patch(workspace._id, {
          birthSeedDeliveredAt: workspace.birthSeedDeliveredAt ?? args.now ?? Date.now(),
        })
      return {
        status: 'provisioning' as const,
        workspaceId: workspace._id,
        scheduled: started.scheduled,
        imageRef,
      }
    }
    if (workspace.pendingBackupLifecycle)
      return {
        status: 'backup_pending' as const,
        workspaceId: workspace._id,
        backupId: workspace.pendingBackupLifecycle.backupId,
      }
    return startCapture(ctx, workspace, args.internalKey, {
      kind: 'reprovision',
      imageRef,
      actorId: args.actorId,
    })
  },
})

type PendingLifecycle = NonNullable<Doc<'workspaces'>['pendingBackupLifecycle']>
async function startCapture(
  ctx: MutationCtx,
  workspace: Doc<'workspaces'>,
  internalKey: string,
  operation: Pick<
    PendingLifecycle,
    'kind' | 'imageRef' | 'actorId' | 'servicingStatus' | 'servicingStatusChangedAt' | 'dueAt'
  >,
) {
  const operationId = `${operation.kind}-${randomHex(16)}`
  const backup = await createBackupImpl(ctx, {
    internalKey,
    workspaceId: workspace._id,
    requestId: operationId,
    purpose: operation.kind === 'reprovision' ? 'reprovision' : 'archive',
    pendingLifecycleOperation: operationId,
  })
  await ctx.db.patch(backup._id, { lifecycle: { kind: operation.kind, status: 'capturing' } })
  await ctx.db.patch(workspace._id, {
    pendingBackupLifecycle: {
      ...operation,
      operationId,
      backupId: backup._id,
      phase: 'capturing',
      expectedVmName: workspace.vmName,
      expectedVmTokenNonce: workspace.vmTokenNonce,
    },
  })
  return { status: 'backup_pending' as const, workspaceId: workspace._id, backupId: backup._id }
}

export const requestArchive = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    actorId: v.optional(v.id('users')),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await operatorReprovisionPlanImpl(ctx, args)
    const workspace = (await ctx.db.get(args.workspaceId))!
    if (workspace.pendingBackupLifecycle && workspace.pendingBackupLifecycle.kind !== 'archive') {
      throw new ConvexError({
        code: 'backup_in_progress',
        backupId: workspace.pendingBackupLifecycle.backupId,
      })
    }
    if (workspace.pendingBackupLifecycle)
      return {
        status: 'backup_pending' as const,
        workspaceId: workspace._id,
        backupId: workspace.pendingBackupLifecycle.backupId,
      }
    return startCapture(ctx, workspace, args.internalKey, {
      kind: 'archive',
      actorId: args.actorId,
    })
  },
})

export const requestServicing = mutation({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces'), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const candidate = (await servicingDecommissionCandidatesImpl(ctx, { ...args, now }))[0]
    if (!candidate) return { status: 'skipped' as const }
    const workspace = (await ctx.db.get(args.workspaceId))!
    const activeJobs = []
    for (const status of ['queued', 'running'] as const) {
      const active = await ctx.db
        .query('workspaceBackups')
        .withIndex('by_workspace_status', q =>
          q.eq('workspaceId', workspace._id).eq('status', status),
        )
        .first()
      if (active) activeJobs.push(active)
    }
    const deadlinePassed = now >= candidate.dueAt + ARCHIVE_RETRY_GRACE_MS
    if (
      (!candidate.archive || deadlinePassed) &&
      (activeJobs.length > 0 ||
        (workspace.pendingBackupLifecycle?.kind !== 'servicing' &&
          workspace.pendingBackupLifecycle))
    ) {
      for (const active of activeJobs) {
        await ctx.db.patch(active._id, {
          status: 'failed',
          pendingLifecycleOperation: undefined,
          phase: undefined,
          objectCleanupPending: true,
          error: { code: 'interrupted', message: 'Workspace was decommissioned.' },
          updatedAt: now,
          completedAt: now,
        })
        await ctx.scheduler.runAfter(
          0,
          makeFunctionReference<'action'>('domains/workspaceBackups/dispatch:tick'),
          { backupId: active._id },
        )
      }
      const stoppingRestore = workspace.pendingBackupLifecycle?.phase === 'restoring'
      if (stoppingRestore) await stopStalledRestore(ctx, workspace)
      else if (workspace.pendingBackupLifecycle) {
        const previous = await ctx.db.get(workspace.pendingBackupLifecycle.backupId)
        if (previous)
          await ctx.db.patch(previous._id, {
            pendingLifecycleOperation: undefined,
            lifecycle: {
              kind: workspace.pendingBackupLifecycle.kind,
              status: 'abandoned',
              reason: 'workspace_decommissioned',
            },
          })
      }
      if (!stoppingRestore) await ctx.db.patch(workspace._id, { pendingBackupLifecycle: undefined })
      const result = await markServicingArchivedImpl(ctx, {
        internalKey: args.internalKey,
        workspaceId: workspace._id,
        servicingStatus: candidate.servicingStatus,
        servicingStatusChangedAt: candidate.servicingStatusChangedAt,
        lifecycleBackupId:
          stoppingRestore && candidate.archive ? workspace.lifecycleBackupId : undefined,
        expectedVmName: workspace.vmName,
        expectedVmTokenNonce: workspace.vmTokenNonce,
        now,
      })
      return { status: result.ok ? result.status : 'skipped' }
    }
    if (workspace.pendingBackupLifecycle) {
      await advanceImpl(ctx, { backupId: workspace.pendingBackupLifecycle.backupId, now })
      return {
        status: 'backup_pending' as const,
        backupId: workspace.pendingBackupLifecycle.backupId,
      }
    }
    if (!candidate.archive || !workspace.vmName || !workspace.httpsUrl || !workspace.vmTokenNonce) {
      const result = await markServicingArchivedImpl(ctx, {
        internalKey: args.internalKey,
        workspaceId: workspace._id,
        servicingStatus: candidate.servicingStatus,
        servicingStatusChangedAt: candidate.servicingStatusChangedAt,
        expectedVmName: workspace.vmName,
        expectedVmTokenNonce: workspace.vmTokenNonce,
        now,
      })
      return { status: result.ok ? result.status : 'skipped' }
    }
    if (activeJobs.length > 0) return { status: 'deferred' as const }
    return startCapture(ctx, workspace, args.internalKey, {
      kind: 'servicing',
      servicingStatus: candidate.servicingStatus,
      servicingStatusChangedAt: candidate.servicingStatusChangedAt,
      dueAt: candidate.dueAt,
    })
  },
})

export const advance = internalMutation({
  args: { backupId: v.id('workspaceBackups'), now: v.optional(v.number()) },
  handler: advanceImpl,
})

async function advanceImpl(
  ctx: MutationCtx,
  args: { backupId: import('../../_generated/dataModel').Id<'workspaceBackups'>; now?: number },
) {
  const backup = await ctx.db.get(args.backupId)
  if (!backup) return
  const workspace = await ctx.db.get(backup.workspaceId)
  const operation = workspace?.pendingBackupLifecycle
  if (
    !workspace ||
    !operation ||
    operation.backupId !== backup._id ||
    operation.phase !== 'capturing'
  )
    return
  const now = args.now ?? Date.now()
  const internalKey = process.env.DUET_API_INTERNAL_KEY ?? ''
  const sourceChanged =
    workspace.vmName !== operation.expectedVmName ||
    workspace.vmTokenNonce !== operation.expectedVmTokenNonce
  const servicingCandidate =
    operation.kind === 'servicing'
      ? (
          await servicingDecommissionCandidatesImpl(ctx, {
            internalKey,
            workspaceId: workspace._id,
            now,
          })
        )[0]
      : undefined
  if (
    sourceChanged ||
    (operation.kind === 'reprovision' && (workspace.servicingStatus ?? 'active') !== 'active') ||
    (operation.kind === 'archive' && workspace.servicingStatus === 'banned') ||
    (operation.kind === 'servicing' &&
      (!servicingCandidate ||
        servicingCandidate.servicingStatusChangedAt !== operation.servicingStatusChangedAt))
  ) {
    await ctx.db.patch(backup._id, {
      pendingLifecycleOperation: undefined,
      lifecycle: { kind: operation.kind, status: 'deferred', reason: 'workspace_changed' },
    })
    await ctx.db.patch(workspace._id, { pendingBackupLifecycle: undefined })
    return
  }
  const incomplete =
    backup.status === 'failed' || (backup.status === 'ready' && backup.completeness !== 'complete')
  if (
    operation.kind === 'servicing' &&
    servicingCandidate &&
    !(backup.status === 'ready' && backup.completeness === 'complete') &&
    (now >= servicingCandidate.dueAt + ARCHIVE_RETRY_GRACE_MS ||
      (incomplete &&
        (workspace.status === 'active' || workspace.status === 'unhealthy') &&
        dispositionAfterArchiveFailure(workspace.status, now - servicingCandidate.dueAt) ===
          'teardown'))
  ) {
    if (backup.status === 'queued' || backup.status === 'running') {
      await ctx.db.patch(backup._id, {
        status: 'failed',
        objectCleanupPending: true,
        phase: undefined,
        error: { code: 'interrupted', message: 'Servicing backup deadline expired.' },
        completedAt: now,
        updatedAt: now,
      })
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>('domains/workspaceBackups/dispatch:tick'),
        { backupId: backup._id },
      )
    }
    await markServicingArchivedImpl(ctx, {
      internalKey,
      workspaceId: workspace._id,
      servicingStatus: servicingCandidate.servicingStatus,
      servicingStatusChangedAt: servicingCandidate.servicingStatusChangedAt,
      expectedVmName: operation.expectedVmName,
      expectedVmTokenNonce: operation.expectedVmTokenNonce,
      now,
    })
    await ctx.db.patch(backup._id, {
      pendingLifecycleOperation: undefined,
      lifecycle: { kind: 'servicing', status: 'abandoned', reason: 'backup_unavailable' },
    })
    await ctx.db.patch(workspace._id, { pendingBackupLifecycle: undefined })
    return
  }
  if (
    backup.status === 'failed' ||
    (backup.status === 'ready' && backup.completeness !== 'complete')
  ) {
    await settleLifecycleImpl(ctx, {
      internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
      workspaceId: workspace._id,
      backupId: backup._id,
      operationId: operation.operationId,
      retainForRecovery: false,
    })
    await ctx.db.patch(workspace._id, { pendingBackupLifecycle: undefined })
    await ctx.db.patch(backup._id, {
      lifecycle: {
        kind: operation.kind,
        status: 'failed',
        reason: backup.status === 'ready' ? 'backup_partial' : 'backup_failed',
      },
    })
    return
  }
  if (backup.status !== 'ready' || backup.completeness !== 'complete') return
  if (operation.kind === 'servicing' && servicingCandidate) {
    await markServicingArchivedImpl(ctx, {
      internalKey,
      workspaceId: workspace._id,
      lifecycleBackupId: backup._id,
      servicingStatus: servicingCandidate.servicingStatus,
      servicingStatusChangedAt: servicingCandidate.servicingStatusChangedAt,
      expectedVmName: operation.expectedVmName,
      expectedVmTokenNonce: operation.expectedVmTokenNonce,
      now,
    })
    await settleLifecycleImpl(ctx, {
      internalKey,
      workspaceId: workspace._id,
      backupId: backup._id,
      operationId: operation.operationId,
      retainForRecovery: true,
    })
    await ctx.db.patch(workspace._id, { pendingBackupLifecycle: undefined })
    await ctx.db.patch(backup._id, { lifecycle: { kind: 'servicing', status: 'complete' } })
    return
  }
  if (operation.kind === 'archive') {
    await markAdminArchivedImpl(ctx, {
      internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
      workspaceId: workspace._id,
      lifecycleBackupId: backup._id,
      now: args.now ?? Date.now(),
    })
    await settleLifecycleImpl(ctx, {
      internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
      workspaceId: workspace._id,
      backupId: backup._id,
      operationId: operation.operationId,
      retainForRecovery: true,
    })
    await ctx.db.patch(workspace._id, { pendingBackupLifecycle: undefined })
    await ctx.db.patch(backup._id, { lifecycle: { kind: operation.kind, status: 'complete' } })
    return
  }
  const plan = await operatorReprovisionPlanImpl(ctx, { internalKey, workspaceId: workspace._id })
  if (plan.activeAgentSessions > 0 || plan.activeTrainJobs > 0) {
    await ctx.db.patch(backup._id, {
      pendingLifecycleOperation: undefined,
      lifecycle: { kind: operation.kind, status: 'deferred', reason: 'active_workspace_work' },
    })
    await ctx.db.patch(workspace._id, { pendingBackupLifecycle: undefined })
    return
  }
  await ctx.db.patch(workspace._id, {
    pendingBackupLifecycle: { ...operation, phase: 'restoring' },
  })
  await ctx.db.patch(backup._id, { lifecycle: { kind: operation.kind, status: 'restoring' } })
  await beginOperatorReprovisionImpl(ctx, {
    internalKey: process.env.DUET_API_INTERNAL_KEY ?? '',
    workspaceId: workspace._id,
    imageRef: operation.imageRef,
    lifecycleBackupId: backup._id,
    previousVmName: operation.expectedVmName,
    actorId: operation.actorId,
    now: args.now ?? Date.now(),
  })
}
