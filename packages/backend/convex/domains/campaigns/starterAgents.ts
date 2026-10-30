import { v } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import { query, type MutationCtx, type QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { campaignBySlug, type CampaignDefinition } from './config'

export type CampaignLookup = (slug: string) => CampaignDefinition | undefined

export const starterAgentsForUser = query({
  args: {
    internalKey: v.string(),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await starterAgentsForUserImpl(ctx, args.userId)
  },
})

export async function starterAgentsForUserImpl(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  lookup: CampaignLookup = campaignBySlug,
): Promise<readonly string[]> {
  const user = await ctx.db.get(userId)
  if (user?.acquisitionAttributionId === undefined) return []
  const attribution = await ctx.db.get(user.acquisitionAttributionId)
  // `acquisitionAttributionId` is written onto the user at signup and never
  // rewritten, so the pointer IS the claim — there is no flow that can point one
  // user at another's attribution. A back-check here would only fire on
  // hand-corrupted data, and it bought nothing the write path does not already
  // guarantee.
  if (attribution === null) return []
  const campaign = lookup(attribution.campaignSlug)
  if (campaign?.enabled !== true) return []
  return campaign.starterAgents ?? []
}
