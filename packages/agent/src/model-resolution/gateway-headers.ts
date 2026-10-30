import { activeDuetTier } from '../model-routing/active-tier.js'

export const DUET_TIER_HEADER = 'x-duet-tier'
export const DUET_WORKSPACE_HEADER = 'x-duet-workspace'

/** Billing selection belongs only on requests sent through the Duet gateway. */
export type GatewayHeaderMode = 'agent' | 'direct-generation'

export function duetGatewayHeaders(
  mode: GatewayHeaderMode = 'agent',
): Record<string, string> | undefined {
  const tier = mode === 'agent' ? activeDuetTier() : undefined
  const workspace = process.env.DUET_WORKSPACE
  if (tier === undefined && !workspace) return undefined
  return {
    ...(tier === undefined ? {} : { [DUET_TIER_HEADER]: tier }),
    ...(workspace ? { [DUET_WORKSPACE_HEADER]: workspace } : {}),
  }
}
