import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import { workspaceVmCapsForPlan, type WorkspaceVmCaps } from '@repo/contract'

import type { DataModel, Doc } from '../../_generated/dataModel'
import { workspaceTierEntitlement } from './tierPolicy'

type DbCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>

export async function desiredWorkspaceVmCaps(
  ctx: DbCtx,
  workspace: Doc<'workspaces'>,
  now: number,
): Promise<WorkspaceVmCaps> {
  const entitlement = await workspaceTierEntitlement(ctx, workspace, now)
  return workspaceVmCapsForPlan(entitlement.plan)
}
