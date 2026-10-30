import { onCompleteValidator, type RunId } from '@convex-dev/action-retrier'
import {
  makeFunctionReference,
  type FunctionReference,
  type GenericMutationCtx,
} from 'convex/server'
import type { Infer } from 'convex/values'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { internalMutation } from '../../_generated/server'
import { retrier } from '../../utils'
import { terminalizeSessionsForProvisioningFailure } from '../agentSessions/events'
import { finishRecovery } from './lifecycleState'
import { scheduleWorkspaceVm } from './vmSchedule'
import type { WorkspaceVmIdentity } from './vmTeardown'
import { hasResidualWorkspaceVmState } from './vmTeardownModel'

type MutationCtx = GenericMutationCtx<DataModel>

export function shouldAttachAfterTeardown(
  workspace: Pick<Doc<'workspaces'>, 'status' | 'servicingStatus'>,
): boolean {
  return workspace.status === 'provisioning' && workspace.servicingStatus === 'active'
}

export function shouldTerminalizeAfterTeardownFailure(
  workspace: Pick<Doc<'workspaces'>, 'status' | 'servicingStatus' | 'attachAfterVmTeardown'>,
  teardownSucceeded: boolean,
): boolean {
  return (
    !teardownSucceeded &&
    workspace.attachAfterVmTeardown === true &&
    shouldAttachAfterTeardown(workspace)
  )
}

export async function scheduleWorkspaceVmTeardown(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  options: {
    attachAfterTeardown?: boolean
    expectedIdentity?: WorkspaceVmIdentity
  } = {},
): Promise<RunId> {
  const workspace = await ctx.db.get(workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  if (workspace.vmTeardownRunId !== undefined) {
    if (options.attachAfterTeardown === true && workspace.attachAfterVmTeardown !== true) {
      await ctx.db.patch(workspaceId, { attachAfterVmTeardown: true })
    }
    return workspace.vmTeardownRunId as RunId
  }

  const runId = await retrier.run(
    ctx,
    removeVmForWorkspaceRef,
    {
      workspaceId,
      expectedIdentity: options.expectedIdentity ?? {
        vmName: workspace.vmName,
        vmTokenNonce: workspace.vmTokenNonce,
      },
    },
    { onComplete: onWorkspaceVmTeardownCompleteRef },
  )
  await ctx.db.patch(workspaceId, {
    vmTeardownRunId: runId,
    attachAfterVmTeardown: options.attachAfterTeardown === true ? true : undefined,
  })
  return runId
}

export const onWorkspaceVmTeardownComplete = internalMutation({
  args: onCompleteValidator,
  handler: async (ctx, args) => {
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_vmTeardownRunId', q => q.eq('vmTeardownRunId', args.runId))
      .unique()
    if (workspace === null) return null

    const attachAfterTeardown = workspace.attachAfterVmTeardown === true
    const teardownSucceeded = args.result.type === 'success'
    const recommissionFailed = shouldTerminalizeAfterTeardownFailure(workspace, teardownSucceeded)
    const continueAttach =
      teardownSucceeded && attachAfterTeardown && shouldAttachAfterTeardown(workspace)
    const now = Date.now()
    await ctx.db.patch(workspace._id, {
      vmTeardownRunId: undefined,
      attachAfterVmTeardown: undefined,
      nextVmImageRef: continueAttach ? workspace.nextVmImageRef : undefined,
      ...(recommissionFailed ? { status: 'unhealthy' as const, updatedAt: now } : {}),
    })
    if (recommissionFailed) {
      await finishRecovery(ctx, workspace, 'failed', 'provisioning_failed')
      await terminalizeSessionsForProvisioningFailure(ctx, {
        workspaceId: workspace._id,
        now,
      })
    }
    if (continueAttach) {
      await scheduleWorkspaceVm(ctx, workspace._id)
    } else if (teardownSucceeded && !hasResidualWorkspaceVmState(workspace)) {
      await finishRecovery(ctx, workspace, 'failed', 'provisioning_paused')
    }
    return null
  },
})

const removeVmForWorkspaceRef = makeFunctionReference(
  'domains/workspaces/vmTeardown:removeVmForWorkspace',
) as unknown as FunctionReference<
  'action',
  'internal',
  { workspaceId: Id<'workspaces'>; expectedIdentity?: WorkspaceVmIdentity },
  { removed: boolean; vmName?: string }
>

const onWorkspaceVmTeardownCompleteRef = makeFunctionReference(
  'domains/workspaces/vmTeardownSchedule:onWorkspaceVmTeardownComplete',
) as unknown as FunctionReference<'mutation', 'internal', Infer<typeof onCompleteValidator>, null>
