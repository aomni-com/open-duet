import type { RunId } from '@convex-dev/action-retrier'
import type { GenericMutationCtx } from 'convex/server'

import type { DataModel, Id } from '../../_generated/dataModel'
import { pinRecoveryBackup } from './lifecycleState'
import { resolveVmImageRef } from './vmImage'
import { scheduleWorkspaceVm } from './vmSchedule'
import { hasResidualWorkspaceVmState } from './vmTeardownModel'
import { scheduleWorkspaceVmTeardown } from './vmTeardownSchedule'

type MutationCtx = GenericMutationCtx<DataModel>

export async function requestWorkspaceVmAttach(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<RunId> {
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  await pinRecoveryBackup(ctx, workspace)
  await ctx.db.patch(workspaceId, { nextVmImageRef: resolveVmImageRef(workspace.nextVmImageRef) })
  if (workspace.vmTeardownRunId !== undefined || hasResidualWorkspaceVmState(workspace)) {
    return await scheduleWorkspaceVmTeardown(ctx, workspaceId, {
      attachAfterTeardown: true,
      expectedIdentity: {
        vmName: workspace.vmName,
        vmTokenNonce: workspace.vmTokenNonce,
      },
    })
  }
  return await scheduleWorkspaceVm(ctx, workspaceId)
}
