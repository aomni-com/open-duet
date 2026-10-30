import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import { v } from 'convex/values'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { internalMutation, internalQuery } from '../../_generated/server'
import { finishRecovery } from './lifecycleState'

type MutationCtx = GenericMutationCtx<DataModel>
type QueryCtx = GenericQueryCtx<DataModel>

export const CLEARED_WORKSPACE_VM_FIELDS = {
  vmName: undefined,
  vmDiskGb: undefined,
  vmResizeRunId: undefined,
  sshDest: undefined,
  httpsUrl: undefined,
  vmCleanupPending: undefined,
  vmTokenNonce: undefined,
  vmTokenHash: undefined,
  syncthingDeviceId: undefined,
} as const

export function hasResidualWorkspaceVmState(workspace: Doc<'workspaces'>): boolean {
  return Object.keys(CLEARED_WORKSPACE_VM_FIELDS).some(
    field => workspace[field as keyof typeof CLEARED_WORKSPACE_VM_FIELDS] !== undefined,
  )
}

export const workspaceVmTeardownPlan = internalQuery({
  args: { workspaceId: v.id('workspaces') },
  handler: (ctx, args) => workspaceVmTeardownPlanImpl(ctx, args),
})

export const clearWorkspaceVm = internalMutation({
  args: {
    workspaceId: v.id('workspaces'),
    expectedVmName: v.optional(v.string()),
    expectedVmTokenNonce: v.optional(v.string()),
  },
  handler: (ctx, args) => clearWorkspaceVmImpl(ctx, args),
})

async function workspaceVmTeardownPlanImpl(ctx: QueryCtx, args: { workspaceId: Id<'workspaces'> }) {
  const workspace = await ctx.db.get(args.workspaceId)
  return workspace === null
    ? null
    : {
        vmName: workspace.vmName,
        vmTokenNonce: workspace.vmTokenNonce,
        hasResidualVmState: hasResidualWorkspaceVmState(workspace),
      }
}

async function clearWorkspaceVmImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    expectedVmName?: string
    expectedVmTokenNonce?: string
  },
) {
  const workspace = await ctx.db.get(args.workspaceId)
  // Reprovision clears the old nonce before teardown. Undefined is therefore
  // still the scheduled generation; any different defined nonce is a replacement.
  if (
    workspace === null ||
    workspace.vmName !== args.expectedVmName ||
    (workspace.vmTokenNonce !== args.expectedVmTokenNonce && workspace.vmTokenNonce !== undefined)
  ) {
    return { cleared: false as const }
  }
  await ctx.db.patch(args.workspaceId, CLEARED_WORKSPACE_VM_FIELDS)
  if (workspace.pendingBackupLifecycle?.phase === 'restoring') {
    const backup = await ctx.db.get(workspace.pendingBackupLifecycle.backupId)
    if (
      backup?.restoration?.status === 'stopping' &&
      backup.restoration.vmGeneration === args.expectedVmTokenNonce
    ) {
      await ctx.db.patch(backup._id, { restoration: { ...backup.restoration, status: 'failed' } })
      await finishRecovery(ctx, workspace, 'failed', 'restore_stalled')
    }
  }
  return { cleared: true as const }
}
