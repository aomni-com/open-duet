import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import { vmDiskGbForPlan, type SubscriptionPlanId } from '@repo/contract'

import type { DataModel, Doc } from '../../_generated/dataModel'
import { scheduleWorkspaceVmResize } from './vmDiskSchedule'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>

export function storagePlanForUser(user: Doc<'users'>): SubscriptionPlanId {
  return user.billing?.subscription?.plan ?? 'starter'
}

export async function desiredVmDiskGb(
  ctx: QueryCtx,
  workspace: Doc<'workspaces'>,
): Promise<number> {
  const billingUser = await ctx.db.get(workspace.billingUserId)
  if (billingUser === null) throw new Error('Workspace billing user not found')
  return vmDiskGbForPlan(storagePlanForUser(billingUser))
}

export async function reconcileWorkspaceVmDisks(
  ctx: MutationCtx,
  userId: Doc<'users'>['_id'],
  now: number,
): Promise<void> {
  const workspaces = ctx.db
    .query('workspaces')
    .withIndex('by_billing_user', q => q.eq('billingUserId', userId))
  for await (const workspace of workspaces) {
    if (
      workspace.status === 'deleted' ||
      workspace.status === 'retired' ||
      workspace.status === 'archived' ||
      workspace.vmName === undefined ||
      workspace.vmDiskGb === undefined
    ) {
      continue
    }
    if ((await desiredVmDiskGb(ctx, workspace)) > workspace.vmDiskGb) {
      try {
        await scheduleWorkspaceVmResize(ctx, workspace._id, now)
      } catch (error) {
        console.error(`VM disk resize scheduling failed for ${workspace._id}: ${String(error)}`)
      }
    }
  }
}
