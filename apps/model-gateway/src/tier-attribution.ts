import {
  AttributionTierIdSchema,
  SERVICES_ATTRIBUTION_TIER,
  X_DUET_TIER_HEADER,
  modelByGatewayId,
  type ApprovedModelCatalog,
  type GatewayBlock,
  type AttributionTierId,
} from '@repo/contract'

type TierAttribution = { tier: AttributionTierId } | { block: GatewayBlock } | { internal: true }

// The tier claim is a billing attribution, not an entitlement: any model may run
// under any tier, and settlement decides whether it bills flat or at cost.
export function attributeTier(
  headers: Headers,
  model: string,
  catalog: ApprovedModelCatalog,
): TierAttribution {
  const claimedTier = headers.get(X_DUET_TIER_HEADER)
  if (claimedTier === null && modelByGatewayId(catalog, model)?.internal === true) {
    return { internal: true }
  }
  if (claimedTier === null) return { tier: SERVICES_ATTRIBUTION_TIER }

  const parsedTier = AttributionTierIdSchema.safeParse(claimedTier)
  if (!parsedTier.success) {
    return {
      block: {
        status: 403,
        body: { error: 'tier_not_allowed', code: 'tier_not_allowed' },
      },
    }
  }
  return { tier: parsedTier.data }
}
