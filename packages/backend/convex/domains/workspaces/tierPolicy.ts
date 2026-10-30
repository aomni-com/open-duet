import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import {
  ModelSelectionIdSchema,
  coerceStoredTier,
  type ModelSelectionId,
  type TierEntitlement,
} from '@repo/contract'

import type { DataModel, Doc } from '../../_generated/dataModel'
import { tierEntitlementOf } from '../credits/subscriptions'

type DbCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>

export async function workspaceTierEntitlement(
  ctx: DbCtx,
  workspace: Doc<'workspaces'>,
  now: number,
): Promise<TierEntitlement> {
  const billingUser = await ctx.db.get(workspace.billingUserId)
  if (billingUser === null) throw new Error('Workspace billing user not found')
  return tierEntitlementOf(billingUser, now)
}

/**
 * Takes the payer row rather than fetching it: the one caller — the workspace
 * summary — already holds it, memoized across every workspace one person
 * funds, and re-reading it here would put a second read of the same row on the
 * per-request auth path.
 */
export function workspaceDefaultTierProjection(
  workspace: Doc<'workspaces'>,
  payer: Doc<'users'>,
  now: number,
): {
  configured?: ModelSelectionId
  effective: ModelSelectionId
} {
  const configured = ModelSelectionIdSchema.safeParse(workspace.defaultModelId)
  return {
    ...(configured.success ? { configured: configured.data } : {}),
    effective: coerceStoredTier(workspace.defaultModelId, tierEntitlementOf(payer, now)),
  }
}
