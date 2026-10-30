import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { resolveRegistrationRestore } from './seed'

export async function pinRecoveryBackup(ctx: MutationCtx, workspace: Doc<'workspaces'>) {
  if (!workspace.lifecycleBackupId) return
  const restore = await resolveRegistrationRestore(ctx, workspace)
  if (restore?.kind !== 'workspace-backup') throw new Error('Recovery backup unavailable')
  const pending = workspace.pendingBackupLifecycle
  const operation =
    pending?.phase === 'restoring'
      ? pending
      : {
          operationId: `restore-${workspace._id}-${Date.now()}`,
          kind: 'reprovision' as const,
          backupId: workspace.lifecycleBackupId,
          phase: 'restoring' as const,
        }
  await ctx.db.patch(workspace.lifecycleBackupId, {
    pendingLifecycleOperation: operation.operationId,
    lifecycle: { kind: operation.kind, status: 'restoring' },
  })
  await ctx.db.patch(workspace._id, { pendingBackupLifecycle: operation })
}

export async function finishRecovery(
  ctx: MutationCtx,
  workspace: Doc<'workspaces'>,
  status: 'complete' | 'failed',
  reason?: string,
) {
  const operation = workspace.pendingBackupLifecycle
  if (!operation || operation.phase !== 'restoring') return
  const backup = await ctx.db.get(operation.backupId)
  if (
    status === 'complete' &&
    (backup?.restoration?.status !== 'installed' ||
      backup.restoration.vmGeneration !== workspace.vmTokenNonce)
  )
    return
  if (
    status === 'failed' &&
    backup?.restoration &&
    backup.restoration.vmGeneration === workspace.vmTokenNonce &&
    backup.restoration.status !== 'failed'
  )
    return
  if (backup?.pendingLifecycleOperation === operation.operationId) {
    await ctx.db.patch(backup._id, {
      pendingLifecycleOperation: undefined,
      lifecycle: { kind: operation.kind, status, ...(reason ? { reason } : {}) },
    })
  }
  await ctx.db.patch(workspace._id, { pendingBackupLifecycle: undefined })
}
