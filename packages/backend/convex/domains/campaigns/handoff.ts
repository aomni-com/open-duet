import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { campaignBySlug } from './config'

// The handoff value is the raw attribution row ID: opaque and unguessable,
// carried through a redirect and an HttpOnly product-host cookie. The row
// itself is the authority — existence, signup action, live campaign, fixed
// expiry, and the transactional single-user claim below — so no signature
// layer is needed; a forged or stale value simply resolves to nothing and
// the signup proceeds unattributed.
export async function resolveCampaignHandoffAttribution(
  ctx: GenericQueryCtx<DataModel>,
  handoff: string,
  now: number,
): Promise<Doc<'campaignAttributions'> | null> {
  const attributionId = ctx.db.normalizeId('campaignAttributions', handoff)
  if (attributionId === null) return null
  const attribution = await ctx.db.get(attributionId)
  if (
    attribution === null ||
    attribution.action !== 'signup' ||
    attribution.expiresAt <= now ||
    campaignBySlug(attribution.campaignSlug) === undefined
  ) {
    return null
  }
  return attribution
}

export async function claimCampaignHandoffAttribution(
  ctx: GenericMutationCtx<DataModel>,
  handoff: string,
  now: number,
  userId: Id<'users'>,
): Promise<Doc<'campaignAttributions'> | null> {
  const attribution = await resolveCampaignHandoffAttribution(ctx, handoff, now)
  if (attribution === null) return null
  if (attribution.acquiredByUserId !== undefined && attribution.acquiredByUserId !== userId) {
    return null
  }
  if (attribution.acquiredByUserId === undefined) {
    await ctx.db.patch(attribution._id, { acquiredByUserId: userId })
    return { ...attribution, acquiredByUserId: userId }
  }
  return attribution
}
