import { ConvexError } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { writeAuditEvent } from '../audit/model'
import { reconcileServicingStatus } from '../credits/subscriptions'
import { reconcileWorkspaceVmDisks } from './vmDiskPolicy'

/** Callers authorize the actor; every payer change shares the same owner and billing rules. */
export async function reassignWorkspacePayer(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    newBillingUserId: Id<'users'>
    actorId: Id<'users'>
    now: number
  },
): Promise<void> {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) throw new Error('Workspace not found')
  const membership = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q =>
      q.eq('workspaceId', args.workspaceId).eq('userId', args.newBillingUserId),
    )
    .unique()
  if (
    membership === null ||
    membership.role !== 'owner' ||
    (await ctx.db.get(args.newBillingUserId)) === null
  ) {
    throw new ConvexError({ error: 'owner_candidate_required' })
  }
  if (workspace.billingUserId === args.newBillingUserId) return
  await ctx.db.patch(args.workspaceId, {
    billingUserId: args.newBillingUserId,
    updatedAt: args.now,
  })
  await reconcileServicingStatus(ctx, workspace.billingUserId, args.now)
  await reconcileWorkspaceVmDisks(ctx, workspace.billingUserId, args.now)
  await reconcileServicingStatus(ctx, args.newBillingUserId, args.now)
  await reconcileWorkspaceVmDisks(ctx, args.newBillingUserId, args.now)
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.billing_user_changed',
    actorId: args.actorId,
    provenance: {
      oldBillingUserId: workspace.billingUserId,
      newBillingUserId: args.newBillingUserId,
    },
    at: args.now,
  })
}
