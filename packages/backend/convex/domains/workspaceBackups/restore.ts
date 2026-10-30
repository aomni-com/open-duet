import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { RESTORE_STALL_MS, VmRestoreCommandSchema } from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import { internalMutation, mutation, type MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { finishRecovery, pinRecoveryBackup } from '../workspaces/lifecycleState'
import { scheduleWorkspaceVmTeardown } from '../workspaces/vmTeardownSchedule'

const watchRef = makeFunctionReference<'mutation'>('domains/workspaceBackups/restore:watch')

export const report = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    vmTokenHash: v.string(),
    command: v.any(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const command = VmRestoreCommandSchema.parse(args.command)
    const workspace = await ctx.db.get(args.workspaceId)
    if (
      !workspace ||
      workspace.vmTokenHash !== args.vmTokenHash ||
      !workspace.vmTokenNonce ||
      !workspace.vmName
    )
      throw new Error('unauthorized')
    // Deleting settled recovery clears this reference atomically. Tell the
    // current VM to retire its descriptor even after the backup row is gone.
    if (command.kind === 'claim' && workspace.lifecycleBackupId === undefined)
      return { status: 'abandoned' as const, processedBytes: 0, processedEntries: 0 }
    const backupId = ctx.db.normalizeId('workspaceBackups', command.backupId)
    const backup = backupId ? await ctx.db.get(backupId) : null
    if (
      !backup ||
      backup.workspaceId !== workspace._id ||
      workspace.lifecycleBackupId !== backup._id ||
      backup.status !== 'ready' ||
      backup.completeness !== 'complete'
    )
      throw new Error('restore_unavailable')
    const prior = backup.restoration
    const sameAttempt =
      prior?.attemptId === command.attemptId && prior.vmGeneration === workspace.vmTokenNonce
    if (command.kind === 'claim') {
      if (workspace.pendingBackupLifecycle?.phase === 'capturing')
        throw new Error('restore_unavailable')
      if (sameAttempt) {
        if (prior.status === 'stopping') throw new Error('restore_stopping')
        return {
          status: prior.status,
          processedBytes: prior.processedBytes,
          processedEntries: prior.processedEntries,
        }
      }
      if (prior?.vmGeneration === workspace.vmTokenNonce && prior.status !== 'failed')
        throw new Error('restore_attempt_mismatch')
      await pinRecoveryBackup(ctx, workspace)
      await ctx.db.patch(backup._id, {
        restoration: {
          attemptId: command.attemptId,
          vmGeneration: workspace.vmTokenNonce,
          vmName: workspace.vmName,
          status: 'running',
          phase: 'download',
          processedBytes: 0,
          processedEntries: 0,
          lastProgressAt: Date.now(),
        },
      })
      await ctx.scheduler.runAfter(RESTORE_STALL_MS, watchRef, {
        backupId: backup._id,
        attemptId: command.attemptId,
        vmGeneration: workspace.vmTokenNonce,
      })
      return { status: 'running' as const, processedBytes: 0, processedEntries: 0 }
    }
    if (!sameAttempt) throw new Error('restore_attempt_mismatch')
    if (prior.status === 'stopping') throw new Error('restore_stopping')
    if (command.kind === 'failed') {
      if (prior.status !== 'failed') {
        await ctx.db.patch(backup._id, { restoration: { ...prior, status: 'failed' } })
        await finishRecovery(ctx, workspace, 'failed', 'restore_failed')
        await ctx.db.patch(workspace._id, { status: 'unhealthy', updatedAt: Date.now() })
      }
    } else if (command.kind === 'installed') {
      if (prior.status === 'failed') throw new Error('restore_attempt_failed')
      if (prior.status !== 'installed')
        await ctx.db.patch(backup._id, {
          restoration: { ...prior, status: 'installed', lastProgressAt: Date.now() },
        })
    } else {
      if (prior.status !== 'running') throw new Error('restore_attempt_finished')
      if (
        command.processedBytes < prior.processedBytes ||
        command.processedEntries < prior.processedEntries
      )
        throw new Error('restore_progress_regressed')
      if (
        command.processedBytes > prior.processedBytes ||
        command.processedEntries > prior.processedEntries
      )
        await ctx.db.patch(backup._id, {
          restoration: {
            ...prior,
            phase: command.phase,
            processedBytes: command.processedBytes,
            processedEntries: command.processedEntries,
            lastProgressAt: Date.now(),
          },
        })
    }
    return { ok: true as const }
  },
})

// The VM can disappear without sending a terminal acknowledgement. Keep the
// artifact pinned until the provider confirms this exact generation is gone.
export async function stopStalledRestore(ctx: MutationCtx, workspace: Doc<'workspaces'>) {
  const operation = workspace.pendingBackupLifecycle
  if (operation?.phase !== 'restoring') return
  const backup = await ctx.db.get(operation.backupId)
  if (
    !backup ||
    backup.pendingLifecycleOperation !== operation.operationId ||
    !workspace.vmTokenNonce ||
    !workspace.vmName
  )
    return
  const prior = backup.restoration
  const restoration =
    prior?.vmGeneration === workspace.vmTokenNonce
      ? prior
      : {
          attemptId: `unclaimed-${workspace.vmTokenNonce}`,
          vmGeneration: workspace.vmTokenNonce,
          vmName: workspace.vmName,
          phase: 'download' as const,
          processedBytes: 0,
          processedEntries: 0,
          lastProgressAt: Date.now(),
        }
  await ctx.db.patch(backup._id, { restoration: { ...restoration, status: 'stopping' } })
  await ctx.db.patch(workspace._id, {
    status:
      workspace.status === 'active' || workspace.status === 'provisioning'
        ? 'unhealthy'
        : workspace.status,
    vmTokenHash: undefined,
    updatedAt: Date.now(),
  })
  await scheduleWorkspaceVmTeardown(ctx, workspace._id, {
    expectedIdentity: { vmName: restoration.vmName, vmTokenNonce: restoration.vmGeneration },
  })
  await ctx.scheduler.runAfter(60_000, watchRef, {
    backupId: backup._id,
    attemptId: restoration.attemptId,
    vmGeneration: restoration.vmGeneration,
  })
}

export async function watchRestore(
  ctx: MutationCtx,
  args: { backupId: Id<'workspaceBackups'>; attemptId: string; vmGeneration: string },
) {
  const backup = await ctx.db.get(args.backupId)
  const restoration = backup?.restoration
  if (
    !backup ||
    !restoration ||
    restoration.attemptId !== args.attemptId ||
    restoration.vmGeneration !== args.vmGeneration ||
    restoration.status === 'failed'
  )
    return
  const workspace = await ctx.db.get(backup.workspaceId)
  if (
    !workspace ||
    workspace.pendingBackupLifecycle?.phase !== 'restoring' ||
    workspace.pendingBackupLifecycle.backupId !== backup._id ||
    workspace.vmTokenNonce !== restoration.vmGeneration
  )
    return
  const remaining = restoration.lastProgressAt + RESTORE_STALL_MS - Date.now()
  if (restoration.status !== 'stopping' && remaining > 0) {
    await ctx.scheduler.runAfter(remaining, watchRef, args)
    return
  }
  await stopStalledRestore(ctx, workspace)
}
export const watch = internalMutation({
  args: { backupId: v.id('workspaceBackups'), attemptId: v.string(), vmGeneration: v.string() },
  handler: watchRestore,
})
