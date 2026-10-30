import { onCompleteValidator, type RunId } from '@convex-dev/action-retrier'
import type { GenericMutationCtx } from 'convex/server'

import { internal } from '../../_generated/api'
import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { internalMutation } from '../../_generated/server'
import { retrier } from '../../utils'
import { terminalizeSessionsForProvisioningFailure } from '../agentSessions/events'
import { writeAuditEvent } from '../audit/model'
import { finishRecovery } from './lifecycleState'
import { auditActor } from './provisioningShared'
import { resolveVmImageRef } from './vmImage'
import { hasResidualWorkspaceVmState } from './vmTeardownModel'

type MutationCtx = GenericMutationCtx<DataModel>

export function shouldTerminalizeAfterAttachFailure(
  workspace: Pick<Doc<'workspaces'>, 'status' | 'servicingStatus'>,
  attachFailed: boolean,
): boolean {
  return (
    attachFailed && workspace.status === 'provisioning' && workspace.servicingStatus === 'active'
  )
}

export async function scheduleWorkspaceVm(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<RunId> {
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  if (workspace.vmAttachRunId !== undefined) return workspace.vmAttachRunId as RunId

  const imageRef = resolveVmImageRef(workspace.nextVmImageRef)
  const runId = await retrier.run(
    ctx,
    internal.domains.workspaces.vmAttach.ensureWorkspaceVm,
    { workspaceId, imageRef },
    { onComplete: internal.domains.workspaces.vmSchedule.onWorkspaceVmAttachComplete },
  )
  const now = Date.now()
  await ctx.db.patch(workspaceId, {
    vmAttachRunId: runId,
    nextVmImageRef: imageRef,
    updatedAt: now,
  })
  await writeAuditEvent(ctx, {
    workspaceId,
    event: 'workspace.vm_attach_scheduled',
    actorId: auditActor(workspace),
    provenance: { source: 'workspace_vm_schedule' },
    at: now,
  })
  return runId
}

export const onWorkspaceVmAttachComplete = internalMutation({
  args: onCompleteValidator,
  handler: async (ctx, args) => {
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_vmAttachRunId', q => q.eq('vmAttachRunId', args.runId))
      .unique()
    if (workspace === null) return null

    const now = Date.now()
    const provisioningFailed = shouldTerminalizeAfterAttachFailure(
      workspace,
      args.result.type === 'failed',
    )
    await ctx.db.patch(workspace._id, {
      vmAttachRunId: undefined,
      nextVmImageRef: undefined,
      ...(provisioningFailed ? { status: 'unhealthy' as const, updatedAt: now } : {}),
    })
    if (provisioningFailed && args.result.type === 'failed') {
      await writeAuditEvent(ctx, {
        workspaceId: workspace._id,
        event: 'workspace.provisioning_failed',
        actorId: auditActor(workspace),
        provenance: {
          source: 'workspace_vm_attach',
          reason: args.result.error,
        },
        at: now,
      })
    }
    if (provisioningFailed) {
      await finishRecovery(ctx, workspace, 'failed', 'provisioning_failed')
      await terminalizeSessionsForProvisioningFailure(ctx, {
        workspaceId: workspace._id,
        now,
      })
    } else if (
      args.result.type === 'success' &&
      args.result.returnValue?.status === 'paused' &&
      !hasResidualWorkspaceVmState(workspace)
    ) {
      await finishRecovery(ctx, workspace, 'failed', 'provisioning_paused')
    }
    return null
  },
})
