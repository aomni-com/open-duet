import { v } from 'convex/values'

import { mutation } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { campaignBySlug } from './config'
import { CampaignDisabledError, captureCampaignLead, mintOrReuseCampaignAttribution } from './model'

const attributionArgs = {
  internalKey: v.string(),
  campaignSlug: v.string(),
  action: v.string(),
  currentJourneyToken: v.optional(v.string()),
  signals: v.any(),
  now: v.number(),
}

export const mintAttribution = mutation({
  args: attributionArgs,
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const campaign = campaignBySlug(args.campaignSlug)
    if (campaign === undefined) return { ok: false as const, error: 'not_found' as const }
    try {
      // The attribution row ID is itself the signup handoff value; the row's
      // stored action/expiry/claim state authorizes it at bootstrap.
      const receipt = await mintOrReuseCampaignAttribution(ctx, args, campaign)
      return { ok: true as const, ...receipt }
    } catch (error) {
      if (error instanceof CampaignDisabledError) {
        return { ok: false as const, error: 'campaign_disabled' as const }
      }
      throw error
    }
  },
})

export const captureLead = mutation({
  args: {
    internalKey: v.string(),
    campaignSlug: v.string(),
    data: v.any(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const campaign = campaignBySlug(args.campaignSlug)
    if (campaign === undefined) return { ok: false as const, error: 'not_found' as const }
    try {
      const receipt = await captureCampaignLead(ctx, args, campaign)
      return { ok: true as const, ...receipt }
    } catch (error) {
      if (error instanceof CampaignDisabledError) {
        return { ok: false as const, error: 'campaign_disabled' as const }
      }
      throw error
    }
  },
})
