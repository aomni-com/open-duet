import { onCompleteValidator, type RunId } from '@convex-dev/action-retrier'
import type { GenericMutationCtx } from 'convex/server'

import { internal } from '../../_generated/api'
import type { DataModel, Id } from '../../_generated/dataModel'
import { internalMutation } from '../../_generated/server'
import { retrier } from '../../utils'
import { writeAuditEvent } from '../audit/model'
import { auditActor } from './provisioningShared'

type MutationCtx = GenericMutationCtx<DataModel>

export async function scheduleWorkspaceVmResize(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  now = Date.now(),
): Promise<RunId> {
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  if (workspace.vmResizeRunId !== undefined) return workspace.vmResizeRunId as RunId

  const runId = await retrier.run(
    ctx,
    internal.domains.workspaces.vmDisk.resizeWorkspaceVmDisk,
    { workspaceId },
    { onComplete: internal.domains.workspaces.vmDiskSchedule.onWorkspaceVmResizeComplete },
  )
  await ctx.db.patch(workspaceId, { vmResizeRunId: runId, updatedAt: now })
  await writeAuditEvent(ctx, {
    workspaceId,
    event: 'workspace.vm_disk_resize_scheduled',
    actorId: auditActor(workspace),
    provenance: { source: 'workspace_vm_disk_resize' },
    at: now,
  })
  return runId
}

export const onWorkspaceVmResizeComplete = internalMutation({
  args: onCompleteValidator,
  handler: async (ctx, args) => {
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_vmResizeRunId', q => q.eq('vmResizeRunId', args.runId))
      .unique()
    if (workspace === null) return null
    await ctx.db.patch(workspace._id, { vmResizeRunId: undefined })
    return null
  },
})
