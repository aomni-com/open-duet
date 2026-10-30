import type { GenericMutationCtx } from 'convex/server'

import { JsonObjectSchema, normalizeAttributionSignals } from '@repo/contract'

import type { DataModel, Id } from '../../_generated/dataModel'
import type { CampaignDefinition } from './config'

type CampaignMutationCtx = GenericMutationCtx<DataModel>

export interface MintCampaignAttributionArgs {
  campaignSlug: string
  action: string
  currentJourneyToken?: string
  signals: unknown
  now: number
}

export interface CampaignAttributionReceipt {
  attributionId: Id<'campaignAttributions'>
  expiresAt: number
}

export class CampaignDisabledError extends Error {
  constructor() {
    super('Campaign is disabled')
  }
}

export async function mintOrReuseCampaignAttribution(
  ctx: CampaignMutationCtx,
  args: MintCampaignAttributionArgs,
  campaign: CampaignDefinition,
): Promise<CampaignAttributionReceipt> {
  const currentId =
    args.currentJourneyToken === undefined
      ? null
      : ctx.db.normalizeId('campaignAttributions', args.currentJourneyToken)
  const current = currentId === null ? null : await ctx.db.get(currentId)
  if (
    current !== null &&
    current.campaignSlug === args.campaignSlug &&
    current.action === args.action &&
    current.expiresAt > args.now
  ) {
    return { attributionId: current._id, expiresAt: current.expiresAt }
  }
  if (!campaign.enabled) throw new CampaignDisabledError()

  const attributionId = await ctx.db.insert('campaignAttributions', {
    campaignSlug: args.campaignSlug,
    action: args.action,
    signals: normalizeAttributionSignals(args.signals),
    createdAt: args.now,
    expiresAt: args.now + campaign.attributionWindowMs,
  })
  return { attributionId, expiresAt: args.now + campaign.attributionWindowMs }
}

// A lead is a plain contact record, not a campaign journey. Leads are followed
// up by email and arrive as their own acquisition later, so capturing one mints
// no attribution and emits no analytics event — there is no user to attribute
// it to yet, and inventing an identity for one would fragment every sink.
export async function captureCampaignLead(
  ctx: CampaignMutationCtx,
  args: { campaignSlug: string; data: unknown; now: number },
  campaign: CampaignDefinition,
): Promise<{ leadId: Id<'campaignLeads'> }> {
  if (!campaign.enabled) throw new CampaignDisabledError()
  const leadId = await ctx.db.insert('campaignLeads', {
    campaignSlug: args.campaignSlug,
    data: JsonObjectSchema.parse(args.data),
    createdAt: args.now,
  })
  return { leadId }
}
