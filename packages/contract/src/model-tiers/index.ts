import { z } from 'zod'

import type { RoutingTable } from '@repo/agent/model-routing/table'

import type { SubscriptionPlanId } from '../plans/index'

export const MODEL_TIER_IDS = ['frontier', 'balanced', 'economy'] as const
export const ModelTierIdSchema = z.enum(MODEL_TIER_IDS)

export type ModelTierId = z.infer<typeof ModelTierIdSchema>

export const PROVIDER_MODEL_ALIAS_IDS = [
  'openai-frontier',
  'openai-max',
  'anthropic-frontier',
  'anthropic-max',
  'anthropic-balanced',
  'google-recommended',
] as const
export const ProviderModelAliasIdSchema = z.enum(PROVIDER_MODEL_ALIAS_IDS)
export type ProviderModelAliasId = z.infer<typeof ProviderModelAliasIdSchema>
export const MODEL_SELECTION_IDS = [...MODEL_TIER_IDS, ...PROVIDER_MODEL_ALIAS_IDS] as const
export const ModelSelectionIdSchema = z.enum(MODEL_SELECTION_IDS)
export type ModelSelectionId = z.infer<typeof ModelSelectionIdSchema>

/**
 * What work run under the `services` grant bills as — named for that capability,
 * because holding it is exactly what lets a caller spend here. Not a tier a
 * person can pick, and deliberately outside `MODEL_TIER_IDS`: it never appears in
 * the plan ladder, the pricing page, a session, or a workspace default.
 *
 * Router selections charge a stable customer tariff for the chosen capability;
 * model upgrades affect margins, not that tariff. Services work is the
 * opposite: its author pinned the model, so there is no route to cover — it
 * bills what the model actually cost. Attributing it to a user tier would either
 * overbill a cheap model or let a `frontier` claim charge 6.7x for the same
 * tokens.
 */
export const SERVICES_ATTRIBUTION_TIER = 'services'

/** Everything `x-duet-tier` may claim, and everything a generation may record. */
export const ATTRIBUTION_TIER_IDS = [...MODEL_SELECTION_IDS, SERVICES_ATTRIBUTION_TIER] as const
export const AttributionTierIdSchema = z.enum(ATTRIBUTION_TIER_IDS)
export type AttributionTierId = z.infer<typeof AttributionTierIdSchema>

/** Persisted attribution outlives the selections available for new work. */
export const RECORDED_MODEL_SELECTION_IDS = MODEL_SELECTION_IDS
export const RecordedModelSelectionIdSchema = z.enum(RECORDED_MODEL_SELECTION_IDS)
export const RECORDED_ATTRIBUTION_TIER_IDS = [
  ...RECORDED_MODEL_SELECTION_IDS,
  SERVICES_ATTRIBUTION_TIER,
] as const
export const RecordedAttributionTierIdSchema = z.enum(RECORDED_ATTRIBUTION_TIER_IDS)
export type RecordedAttributionTierId = z.infer<typeof RecordedAttributionTierIdSchema>

type BillableTierId = Exclude<RecordedAttributionTierId, typeof SERVICES_ATTRIBUTION_TIER>

/**
 * Whether a generation of this model under this claim bills at a tier's flat
 * rate. Its closure covers current routes and historical generations awaiting
 * settlement. Other models still run and bill their actual upstream cost;
 * a caller cannot assign an arbitrary model the tariff of its choosing.
 */
export function tierBillsAtFlatRate(
  tier: RecordedAttributionTierId,
  gatewayModelId: string,
): tier is BillableTierId {
  return (
    tier !== SERVICES_ATTRIBUTION_TIER && BILLING_TARIFFS[tier].closure.includes(gatewayModelId)
  )
}

export type Score = 1 | 2 | 3 | 4 | 5

export type ModelTier = {
  id: ModelTierId
  label: 'Max' | 'Standard' | 'Economy'
  description: string
  scores: { speed: Score; intelligence: Score; cost: Score }
  rates: {
    inputTokensPer1M: number
    outputTokensPer1M: number
    cachedInputTokensPer1M: number
  }
  closure: readonly string[]
  /**
   * What the tier picker and public copy name. Presentation, not billing or
   * routing: a model stays listed across a release that stops routing to it,
   * and a listed model bills flat only if `closure` covers it.
   */
  disclosedModels: readonly { gatewayModelId: string; label: string }[]
}

/**
 * Closures cover the built-in routing table of the pinned duet-agent release
 * plus historical targets, so delayed generations keep their customer tariff.
 * They gate nothing — a model missing
 * from a closure still runs under that tier and bills at its upstream cost (see
 * `tierBillsAtFlatRate`). If an agent release changes its built-in table,
 * add its targets here without changing the tariff or removing old coverage.
 *
 * Derivation, for the next editor: the route targets and vision fallbacks
 * that write what the user reads, as duet-gateway ids
 * (dist/src/model-routing/table.js and model-resolution/catalog.js in the
 * pinned package). Everything else stays out and bills at cost: support
 * models — the route classifier, memory, embeddings — so a Max session's
 * housekeeping is not charged Max prices, and the advisor, which costs more
 * than the tier rates cover. A model that is also a route target stays in.
 */
export const MODEL_TIERS: Readonly<Record<ModelTierId, ModelTier>> = {
  frontier: {
    id: 'frontier',
    label: 'Max',
    description:
      'Automatically routes each task to frontier models from OpenAI, Anthropic, and open source providers for the strongest results.',
    scores: { speed: 3, intelligence: 5, cost: 5 },
    rates: {
      inputTokensPer1M: 4,
      outputTokensPer1M: 20,
      cachedInputTokensPer1M: 0.2,
    },
    closure: [
      'anthropic/claude-opus-5',
      'anthropic/claude-opus-5.5',
      'moonshotai/kimi-k3',
      'openai/gpt-5.6-sol',
      'openai/gpt-6-sol',
      'openai/gpt-6.1-sol',
    ],
    disclosedModels: [
      { gatewayModelId: 'anthropic/claude-fable-5.1', label: 'Claude Fable 5.1' },
      { gatewayModelId: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5' },
      { gatewayModelId: 'moonshotai/kimi-k3', label: 'Kimi K3' },
      { gatewayModelId: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { gatewayModelId: 'openai/gpt-6-astra', label: 'GPT-6 Astra' },
    ],
  },
  balanced: {
    id: 'balanced',
    label: 'Standard',
    description:
      'Automatically routes each task to leading models from OpenAI, Anthropic, and open source providers, balancing quality, speed, and cost.',
    scores: { speed: 4, intelligence: 4, cost: 3 },
    rates: {
      inputTokensPer1M: 2.5,
      outputTokensPer1M: 12.75,
      cachedInputTokensPer1M: 0.25,
    },
    closure: [
      'anthropic/claude-sonnet-5',
      'anthropic/claude-sonnet-5.5',
      'moonshotai/kimi-k3',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-6-sol',
      'openai/gpt-6.1-sol',
    ],
    disclosedModels: [
      { gatewayModelId: 'anthropic/claude-fable-5.1', label: 'Claude Fable 5.1' },
      { gatewayModelId: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
      { gatewayModelId: 'moonshotai/kimi-k3', label: 'Kimi K3' },
      { gatewayModelId: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    ],
  },
  economy: {
    id: 'economy',
    label: 'Economy',
    description:
      'Low-cost models from OpenAI, Anthropic, and open source providers for scheduled maintenance work. Not recommended as your main model.',
    scores: { speed: 5, intelligence: 2, cost: 1 },
    rates: { inputTokensPer1M: 0.5, outputTokensPer1M: 2.5, cachedInputTokensPer1M: 0.05 },
    closure: [
      'anthropic/claude-haiku-5.5',
      'deepseek/deepseek-v4.1-flash',
      'openai/gpt-5.6-luna',
      'openai/gpt-6-luna',
      'moonshotai/kimi-k3',
    ],
    disclosedModels: [{ gatewayModelId: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5' }],
  },
}

/** Stable product selection; current execution target is separate from historical rate coverage. */
export type ProviderModelAlias = {
  id: ProviderModelAliasId
  label: string
  /** Stable CLI family written into managed routing so an installed binary can resolve it. */
  modelName: string
  modelLabel: string
  gatewayModelId: string
  scores: ModelTier['scores']
  /** Duet's customer-facing billing tariff. */
  rates: ModelTier['rates']
  /** Provider list price used to explain margin; never used as the tariff. */
  upstreamRates: ModelTier['rates']
  /** Retain previously shipped targets on upgrades so delayed generations keep their flat price. */
  closure: readonly string[]
}

const PROVIDER_ALIAS_RATES = {
  openaiFrontier: { inputTokensPer1M: 11, outputTokensPer1M: 55, cachedInputTokensPer1M: 1.05 },
  anthropicFrontier: { inputTokensPer1M: 11, outputTokensPer1M: 55, cachedInputTokensPer1M: 0.3 },
  openaiMax: { inputTokensPer1M: 3, outputTokensPer1M: 15, cachedInputTokensPer1M: 0.2 },
  anthropicMax: { inputTokensPer1M: 5, outputTokensPer1M: 20, cachedInputTokensPer1M: 0.25 },
  sonnet: { inputTokensPer1M: 3, outputTokensPer1M: 15, cachedInputTokensPer1M: 0.2 },
  googleRecommended: { inputTokensPer1M: 4, outputTokensPer1M: 20, cachedInputTokensPer1M: 0.2 },
} satisfies Record<string, ModelTier['rates']>

const PROVIDER_ALIAS_SCORES = {
  openaiFrontier: { intelligence: 5, speed: 2, cost: 5 },
  openaiMax: { intelligence: 4, speed: 3, cost: 2 },
  anthropicFrontier: { intelligence: 5, speed: 2, cost: 4 },
  anthropicMax: { intelligence: 4, speed: 3, cost: 3 },
  sonnet: { intelligence: 4, speed: 4, cost: 2 },
  googleRecommended: { intelligence: 4, speed: 2, cost: 3 },
} satisfies Record<string, ModelTier['scores']>

export const PROVIDER_MODEL_ALIASES: Readonly<Record<ProviderModelAliasId, ProviderModelAlias>> = {
  'openai-frontier': {
    id: 'openai-frontier',
    label: 'OpenAI frontier',
    modelName: 'astra',
    modelLabel: 'GPT-6 Astra',
    gatewayModelId: 'openai/gpt-6-astra',
    scores: PROVIDER_ALIAS_SCORES.openaiFrontier,
    rates: PROVIDER_ALIAS_RATES.openaiFrontier,
    upstreamRates: { inputTokensPer1M: 10, outputTokensPer1M: 50, cachedInputTokensPer1M: 1 },
    closure: ['openai/gpt-6-astra'],
  },
  'openai-max': {
    id: 'openai-max',
    label: 'OpenAI recommended',
    modelName: 'sol',
    modelLabel: 'GPT-6.1 Sol',
    gatewayModelId: 'openai/gpt-6.1-sol',
    scores: PROVIDER_ALIAS_SCORES.openaiMax,
    rates: PROVIDER_ALIAS_RATES.openaiMax,
    upstreamRates: { inputTokensPer1M: 2, outputTokensPer1M: 10, cachedInputTokensPer1M: 0.2 },
    closure: ['openai/gpt-5.6-sol', 'openai/gpt-6-sol', 'openai/gpt-6.1-sol'],
  },
  'anthropic-frontier': {
    id: 'anthropic-frontier',
    label: 'Anthropic frontier',
    modelName: 'fable',
    modelLabel: 'Claude Fable 5.1',
    gatewayModelId: 'anthropic/claude-fable-5.1',
    scores: PROVIDER_ALIAS_SCORES.anthropicFrontier,
    rates: PROVIDER_ALIAS_RATES.anthropicFrontier,
    upstreamRates: { inputTokensPer1M: 10, outputTokensPer1M: 50, cachedInputTokensPer1M: 0.25 },
    closure: ['anthropic/claude-fable-5.1'],
  },
  'anthropic-max': {
    id: 'anthropic-max',
    label: 'Anthropic recommended',
    modelName: 'opus',
    modelLabel: 'Claude Opus 5.5',
    gatewayModelId: 'anthropic/claude-opus-5.5',
    scores: PROVIDER_ALIAS_SCORES.anthropicMax,
    rates: PROVIDER_ALIAS_RATES.anthropicMax,
    upstreamRates: { inputTokensPer1M: 4, outputTokensPer1M: 20, cachedInputTokensPer1M: 0.2 },
    closure: ['anthropic/claude-opus-5', 'anthropic/claude-opus-5.5'],
  },
  'anthropic-balanced': {
    id: 'anthropic-balanced',
    label: 'Anthropic balanced',
    modelName: 'sonnet-5.5',
    modelLabel: 'Claude Sonnet 5.5',
    gatewayModelId: 'anthropic/claude-sonnet-5.5',
    scores: PROVIDER_ALIAS_SCORES.sonnet,
    rates: PROVIDER_ALIAS_RATES.sonnet,
    upstreamRates: { inputTokensPer1M: 2, outputTokensPer1M: 10, cachedInputTokensPer1M: 0.1 },
    closure: ['anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5.5'],
  },
  'google-recommended': {
    id: 'google-recommended',
    label: 'Gemini recommended',
    modelName: 'argon',
    modelLabel: 'Gemini 4 Argon',
    gatewayModelId: 'google/gemini-4-argon',
    scores: PROVIDER_ALIAS_SCORES.googleRecommended,
    rates: PROVIDER_ALIAS_RATES.googleRecommended,
    upstreamRates: { inputTokensPer1M: 4, outputTokensPer1M: 20, cachedInputTokensPer1M: 0.2 },
    closure: ['google/gemini-4-argon'],
  },
}

/** Product aliases augment a runtime-owned routing table for every composition host. */
export function buildManagedRoutingTable(baseTable: RoutingTable): RoutingTable {
  return {
    ...baseTable,
    tiers: {
      ...baseTable.tiers,
      ...Object.fromEntries(
        Object.values(PROVIDER_MODEL_ALIASES).map(alias => {
          const target = { modelName: alias.modelName, thinkingLevel: 'medium' as const }
          return [
            alias.id,
            {
              routes: { general: { description: `All work on ${alias.label}.`, target } },
              advisor: { enabled: false, target, minStepsBetween: 5 },
            },
          ]
        }),
      ),
    },
  }
}

export const MODEL_SELECTIONS = { ...MODEL_TIERS, ...PROVIDER_MODEL_ALIASES }

const BILLING_TARIFFS = MODEL_SELECTIONS

/**
 * One typical turn, in tokens. Not what anyone is charged — billing meters
 * real tokens — but the shape every "about N messages" estimate divides by,
 * kept in one place so the assumption is legible rather than buried in a
 * rounded literal.
 *
 * A message is a whole turn, not a single model call: the agent re-reads the
 * conversation (mostly cache hits after the first turn), thinks, runs a couple
 * of tools, and answers.
 */
export const TYPICAL_MESSAGE_USAGE = {
  uncachedInputTokens: 6_000,
  cachedInputTokens: 30_000,
  outputTokens: 1_200,
} as const

/**
 * How many typical turns a credit balance buys at this tier, rounded to two
 * significant figures so no surface implies precision it lacks. Credits meter
 * real usage, so this is an estimate, never a cap.
 */
export function estimateTierMessages(tier: ModelSelectionId, creditsMicroUsd: number): number {
  if (!Number.isFinite(creditsMicroUsd) || creditsMicroUsd <= 0) return 0
  const messages = creditsMicroUsd / priceTierUsageMicroUsd(tier, TYPICAL_MESSAGE_USAGE)
  if (messages <= 0) return 0
  const magnitude = 10 ** (Math.floor(Math.log10(messages)) - 1)
  return Math.round(messages / magnitude) * magnitude
}

/** The billing facts a tier default keys on: active subscription + plan. */
export type TierEntitlement = {
  subscriber: boolean
  /** Active plan; meaningful only while `subscriber` is true. */
  plan?: SubscriptionPlanId
}

// Starter and Pro default to Standard; Max defaults to Max.
// Defaults only — every tier is open to every workspace.
const PLAN_DEFAULT_TIER: Record<SubscriptionPlanId, ModelTierId> = {
  starter: 'balanced',
  pro: 'balanced',
  max: 'frontier',
}

// Capability order, not price order — what "upgrade, never downgrade" means
// for a stored tier when a plan change moves the default underneath it.
const TIER_RANK: Record<ModelTierId, number> = { economy: 0, balanced: 1, frontier: 2 }

export function raiseTier(tier: ModelTierId, floor: ModelTierId): ModelTierId {
  return TIER_RANK[tier] >= TIER_RANK[floor] ? tier : floor
}

export function defaultTierFor({ subscriber, plan }: TierEntitlement): ModelTierId {
  if (!subscriber) return 'balanced'
  // A subscriber with an unreadable plan keeps the pre-plan default rather
  // than being bumped up or down on missing data.
  return plan === undefined ? 'balanced' : PLAN_DEFAULT_TIER[plan]
}

export function coerceStoredTier(
  stored: string | undefined,
  options: TierEntitlement & { workspaceDefault?: string },
): ModelSelectionId {
  const storedTier = ModelSelectionIdSchema.safeParse(stored)
  const workspaceTier = ModelSelectionIdSchema.safeParse(options.workspaceDefault)
  return storedTier.success
    ? storedTier.data
    : workspaceTier.success
      ? workspaceTier.data
      : defaultTierFor(options)
}

/**
 * Rate scaling for exact money math. A rate quoted in dollars per 1M tokens is
 * numerically microUSD per token, so scaling by 1000 gives nanoUSD per token —
 * an integer for every rate we quote (three decimals is the documented limit,
 * asserted by the tier-rate test). Math.round absorbs the binary
 * representation of literals like 0.15, whose float product is 150.0000…3.
 */
const NANO_PER_MICRO = 1000n

function nanoUsdPerToken(dollarsPer1M: number): bigint {
  const scaled = Math.round(dollarsPer1M * 1000)
  if (Math.abs(dollarsPer1M * 1000 - scaled) > 1e-6) {
    throw new RangeError(`Tier rate ${dollarsPer1M} has more than three decimals`)
  }
  return BigInt(scaled)
}

function tokenCount(name: string, count: number): bigint {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(`${name} must be a non-negative finite integer`)
  }
  return BigInt(count)
}

/**
 * Charge for one generation, in whole microUSD.
 *
 * Every product is accumulated as an exact integer (the largest realistic
 * ones already exceed Number.MAX_SAFE_INTEGER once scaled) and the single
 * rounding happens on the final division — never per component, which would
 * let three separate half-cent roundings compound into a visible overcharge.
 */
export function priceTierUsageMicroUsd(
  tier: BillableTierId,
  usage: {
    uncachedInputTokens: number
    cachedInputTokens: number
    outputTokens: number
  },
): number {
  // Read each field by name: usage crosses a JSON boundary at settlement, so
  // an absent field is reachable at runtime and must throw rather than
  // multiply undefined into a NaN charge.
  const uncachedInputTokens = tokenCount('uncachedInputTokens', usage?.uncachedInputTokens)
  const cachedInputTokens = tokenCount('cachedInputTokens', usage?.cachedInputTokens)
  const outputTokens = tokenCount('outputTokens', usage?.outputTokens)

  const rates = BILLING_TARIFFS[tier].rates
  const totalNanoUsd =
    uncachedInputTokens * nanoUsdPerToken(rates.inputTokensPer1M) +
    cachedInputTokens * nanoUsdPerToken(rates.cachedInputTokensPer1M) +
    outputTokens * nanoUsdPerToken(rates.outputTokensPer1M)

  const microUsd = totalNanoUsd / NANO_PER_MICRO
  const remainder = totalNanoUsd % NANO_PER_MICRO
  const rounded = remainder * 2n >= NANO_PER_MICRO ? microUsd + 1n : microUsd

  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Tier charge for ${tier} exceeds safe integer precision`)
  }
  return Number(rounded)
}
