import type { ConversionTriggerEventName, JsonObject } from '@repo/contract'

import { convertOnSignupAndPurchase } from './conversionFunctions'
import type { ConversionFunction } from './conversionTypes'
import type {
  GoogleDestinationConfig,
  MetaDestinationConfig,
  OpenAiDestinationConfig,
  RedditDestinationConfig,
} from './destinationAdapters'

const DAY_MS = 24 * 60 * 60 * 1_000

export interface CampaignConversionDefinition {
  on: readonly ConversionTriggerEventName[]
  origins?: readonly string[]
  run: ConversionFunction<JsonObject>
  config: JsonObject
}

export interface CampaignDestinations {
  meta: MetaDestinationConfig
  google: GoogleDestinationConfig
  reddit: RedditDestinationConfig
  openai: OpenAiDestinationConfig
}

export interface CampaignDefinition {
  enabled: boolean
  attributionWindowMs: number
  starterAgents?: readonly string[]
  conversion?: CampaignConversionDefinition
  destinations?: Readonly<Partial<CampaignDestinations>>
}

// Deliberately no validation of `starterAgents` names. The official catalog is
// whatever folders exist in the hub workspace at runtime — agents are authored
// there, not in this repo — so nothing here can know which names are real. An
// earlier version checked them against the seed manifest and threw at module
// load, which meant naming a legitimately-created official agent broke the
// Convex deploy. A name that does not resolve simply installs nothing.
export function defineCampaigns<const T extends Record<string, CampaignDefinition>>(
  definitions: T,
): T {
  return definitions
}

const CONVERT_ON_SIGNUP_AND_PURCHASE = {
  on: ['user.signed_up', 'subscription.started'],
  run: convertOnSignupAndPurchase,
  config: {},
} as const

// Account IDs, action mappings, and credentials have not been provisioned.
// Keep each real server destination explicit and disabled instead of inventing
// placeholder endpoints or silently falling back to a browser pixel.
const DISABLED_DESTINATIONS = {
  meta: { enabled: false },
  google: { enabled: false },
  reddit: { enabled: false },
  openai: { enabled: false },
} as const

export const campaigns = defineCampaigns({
  organic: {
    enabled: true,
    attributionWindowMs: 30 * DAY_MS,
    conversion: CONVERT_ON_SIGNUP_AND_PURCHASE,
    destinations: DISABLED_DESTINATIONS,
  },
  // The /l/<slug> campaign landers. Each slug tags signups through
  // onboarding: starterAgents installs the seat the lander promised.
  team: {
    enabled: true,
    attributionWindowMs: 30 * DAY_MS,
    starterAgents: ['people-researcher', 'operations-analyst', 'writer'],
    conversion: CONVERT_ON_SIGNUP_AND_PURCHASE,
    destinations: DISABLED_DESTINATIONS,
  },
  business: {
    enabled: true,
    attributionWindowMs: 30 * DAY_MS,
    starterAgents: [
      'performance-marketer',
      'sales-development-rep',
      'support-agent',
      'operations-analyst',
    ],
    conversion: CONVERT_ON_SIGNUP_AND_PURCHASE,
    destinations: DISABLED_DESTINATIONS,
  },
  sell: {
    enabled: true,
    attributionWindowMs: 30 * DAY_MS,
    starterAgents: ['landing-page-builder', 'brand-designer', 'writer'],
    conversion: CONVERT_ON_SIGNUP_AND_PURCHASE,
    destinations: DISABLED_DESTINATIONS,
  },
  // The bespoke landers demoted from indexed product pages to /l/<slug>.
  // No starterAgents: they argue the platform rather than one job, so the
  // default onboarding set is the honest install.
  platform: {
    enabled: true,
    attributionWindowMs: 30 * DAY_MS,
    conversion: CONVERT_ON_SIGNUP_AND_PURCHASE,
    destinations: DISABLED_DESTINATIONS,
  },
  'file-sharing': {
    enabled: true,
    attributionWindowMs: 30 * DAY_MS,
    conversion: CONVERT_ON_SIGNUP_AND_PURCHASE,
    destinations: DISABLED_DESTINATIONS,
  },
  'agent-cloud': {
    enabled: true,
    attributionWindowMs: 30 * DAY_MS,
    conversion: CONVERT_ON_SIGNUP_AND_PURCHASE,
    destinations: DISABLED_DESTINATIONS,
  },
  main: {
    enabled: true,
    attributionWindowMs: 30 * DAY_MS,
    conversion: CONVERT_ON_SIGNUP_AND_PURCHASE,
    destinations: DISABLED_DESTINATIONS,
  },
})

export type CampaignSlug = keyof typeof campaigns

export function campaignBySlug(slug: string): CampaignDefinition | undefined {
  return Object.hasOwn(campaigns, slug) ? campaigns[slug as CampaignSlug] : undefined
}
