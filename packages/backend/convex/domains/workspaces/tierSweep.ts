import type { GenericMutationCtx } from 'convex/server'

import { ModelTierIdSchema, raiseTier, type ModelTierId } from '@repo/contract'

import type { DataModel, Id } from '../../_generated/dataModel'

/**
 * A plan switch moves the default tier underneath every stored quality choice,
 * so stored tiers follow it — but only ever upward (David, 2026-08-13). A
 * session or workspace deliberately set above the new default keeps its
 * choice; one sitting below it is raised to the default, even on a plan
 * downgrade. Unset tiers stay unset — they already resolve through the
 * workspace default to the plan default.
 *
 * Lives apart from tierPolicy so the credits domain can trigger it without a
 * subscriptions ↔ tierPolicy import cycle.
 */
export async function raiseStoredTiersToPlanDefault(
  ctx: GenericMutationCtx<DataModel>,
  billingUserId: Id<'users'>,
  floor: ModelTierId,
): Promise<void> {
  // take() caps, not paginators: they bound the worst case a single webhook
  // mutation will read/write, far above any real account's working set. A
  // pathological tail beyond the cap keeps its old tier — it still renders and
  // clamps correctly, it just isn't auto-raised.
  const workspaces = await ctx.db
    .query('workspaces')
    .withIndex('by_billing_user', q => q.eq('billingUserId', billingUserId))
    .take(100)
  for (const workspace of workspaces) {
    if (workspace.status === 'deleted') continue
    const workspaceTier = ModelTierIdSchema.safeParse(workspace.defaultModelId)
    if (workspaceTier.success && raiseTier(workspaceTier.data, floor) !== workspaceTier.data) {
      await ctx.db.patch(workspace._id, { defaultModelId: floor })
    }
    const sessions = await ctx.db
      .query('agentSessions')
      .withIndex('by_workspace_bucket', q => q.eq('workspaceId', workspace._id))
      .take(1000)
    for (const session of sessions) {
      if (session.archiveState === 'deleting') continue
      const sessionTier = ModelTierIdSchema.safeParse(session.lastModelId)
      if (sessionTier.success && raiseTier(sessionTier.data, floor) !== sessionTier.data) {
        await ctx.db.patch(session._id, { lastModelId: floor })
      }
    }
  }
}
