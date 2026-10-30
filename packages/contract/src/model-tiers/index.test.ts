import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  MODEL_TIERS,
  ModelTierIdSchema,
  PROVIDER_MODEL_ALIASES,
  PROVIDER_MODEL_ALIAS_IDS,
  RecordedAttributionTierIdSchema,
  AttributionTierIdSchema,
  coerceStoredTier,
  defaultTierFor,
  priceTierUsageMicroUsd,
  ATTRIBUTION_TIER_IDS,
  MODEL_TIER_IDS,
  SERVICES_ATTRIBUTION_TIER,
  TYPICAL_MESSAGE_USAGE,
  estimateTierMessages,
  tierBillsAtFlatRate,
  type ModelTierId,
} from './index'

describe('ModelTierIdSchema', () => {
  test('accepts only the three virtual tier ids', () => {
    expect(MODEL_TIER_IDS).toEqual(['frontier', 'balanced', 'economy'])
    expect(['frontier', 'balanced', 'economy'].map(id => ModelTierIdSchema.parse(id))).toEqual([
      'frontier',
      'balanced',
      'economy',
    ])
    expect(ModelTierIdSchema.safeParse('recommended').success).toBe(false)
  })
})

test('exposes Sonnet 5.5 as an explicit provider selection', () => {
  expect(PROVIDER_MODEL_ALIAS_IDS).toContain('anthropic-balanced')
  expect(PROVIDER_MODEL_ALIASES['anthropic-balanced']).toMatchObject({
    id: 'anthropic-balanced',
    modelName: 'sonnet-5.5',
    gatewayModelId: 'anthropic/claude-sonnet-5.5',
    modelLabel: 'Claude Sonnet 5.5',
    rates: { inputTokensPer1M: 3, outputTokensPer1M: 15, cachedInputTokensPer1M: 0.2 },
    upstreamRates: { inputTokensPer1M: 2, outputTokensPer1M: 10, cachedInputTokensPer1M: 0.1 },
    scores: { intelligence: 4, speed: 4, cost: 2 },
  })
})

test('exposes Gemini Argon as the recommended Google selection', () => {
  expect(PROVIDER_MODEL_ALIAS_IDS).toContain('google-recommended')
  expect(PROVIDER_MODEL_ALIASES['google-recommended']).toMatchObject({
    id: 'google-recommended',
    label: 'Gemini recommended',
    modelName: 'argon',
    gatewayModelId: 'google/gemini-4-argon',
    modelLabel: 'Gemini 4 Argon',
    rates: { inputTokensPer1M: 4, outputTokensPer1M: 20, cachedInputTokensPer1M: 0.2 },
    upstreamRates: { inputTokensPer1M: 4, outputTokensPer1M: 20, cachedInputTokensPer1M: 0.2 },
    scores: { intelligence: 4, speed: 2, cost: 3 },
  })
})

test('provider aliases never bill below their audited upstream rates', () => {
  for (const alias of Object.values(PROVIDER_MODEL_ALIASES)) {
    expect(alias.upstreamRates, alias.id).toBeDefined()
    for (const key of ['inputTokensPer1M', 'cachedInputTokensPer1M', 'outputTokensPer1M'] as const) {
      expect(alias.rates[key], `${alias.id} ${key}`).toBeGreaterThanOrEqual(
        alias.upstreamRates[key],
      )
    }
  }
})

describe('MODEL_TIERS', () => {
  // The cost score reads as price, not efficiency: a tier that charges more
  // per token must show strictly more dollar dots than every cheaper tier.
  test('scores cost in the same direction as the rates', () => {
    const byRate = Object.values(MODEL_TIERS).sort(
      (a, b) => a.rates.outputTokensPer1M - b.rates.outputTokensPer1M,
    )
    for (let i = 1; i < byRate.length; i++) {
      const cheaper = byRate[i - 1]!
      const pricier = byRate[i]!
      expect(pricier.scores.cost).toBeGreaterThan(cheaper.scores.cost)
    }
  })

  // Pricing scales rates by 1000 to reach exact integer math, so a rate with
  // more than three decimals would silently lose precision.
  test('quotes every rate with at most three decimals', () => {
    for (const tier of Object.values(MODEL_TIERS)) {
      for (const rate of Object.values(tier.rates)) {
        expect(Math.round(rate * 1000)).toBeCloseTo(rate * 1000, 6)
      }
    }
  })
})

describe('tierBillsAtFlatRate', () => {
  test('covers upgraded Sol and historical Sol usage without changing tier boundaries', () => {
    for (const model of ['openai/gpt-6.1-sol', 'openai/gpt-6-sol']) {
      expect(tierBillsAtFlatRate('frontier', model)).toBe(true)
      expect(tierBillsAtFlatRate('balanced', model)).toBe(true)
      expect(tierBillsAtFlatRate('openai-max', model)).toBe(true)
    }
  })

  test('covers Sonnet 5.5 at the Balanced tariff without dropping historical Sonnet usage', () => {
    expect(tierBillsAtFlatRate('balanced', 'anthropic/claude-sonnet-5.5')).toBe(true)
    expect(tierBillsAtFlatRate('balanced', 'anthropic/claude-sonnet-5')).toBe(true)
  })

  test('bills a user tier flat only for models covered by its tariff', () => {
    expect(tierBillsAtFlatRate('frontier', 'anthropic/claude-opus-5')).toBe(true)
    // A model outside the tier's rate set still runs; it bills what it cost,
    // so claiming a cheap tier never buys an expensive model below cost.
    expect(tierBillsAtFlatRate('balanced', 'vendor/model-added-upstream-later')).toBe(false)
  })

  // A flat rate covers the models that write what the user reads. Support calls
  // — the route classifier, memory, embeddings — bill at cost, or a Max
  // session's embeddings would be charged Max prices.
  test('bills support models at cost unless the tier routes user output to them', () => {
    for (const tier of MODEL_TIER_IDS) {
      expect(tierBillsAtFlatRate(tier, 'google/gemini-embedding-2')).toBe(false)
    }
    expect(tierBillsAtFlatRate('frontier', 'openai/gpt-5.6-luna')).toBe(false)
    expect(tierBillsAtFlatRate('balanced', 'openai/gpt-5.6-luna')).toBe(false)
  })

  // The advisor is a pricier model than the tier rate covers, so its consults
  // bill what they cost.
  test('bills the advisor at cost', () => {
    expect(tierBillsAtFlatRate('frontier', 'anthropic/claude-fable-5.1')).toBe(false)
    expect(tierBillsAtFlatRate('balanced', 'anthropic/claude-fable-5.1')).toBe(false)
  })
})

describe('estimateTierMessages', () => {
  // A credit balance means nothing to a reader; "about N messages" does. The
  // divisor is one typical turn, priced at that tier's own rate, so the same
  // balance buys fewer Max messages than Standard ones.
  test('divides a balance by one typical turn at the tier rate', () => {
    const perMessage = (tier: ModelTierId) => priceTierUsageMicroUsd(tier, TYPICAL_MESSAGE_USAGE)

    for (const tier of MODEL_TIER_IDS) {
      expect(estimateTierMessages(tier, perMessage(tier))).toBe(1)
      expect(estimateTierMessages(tier, perMessage(tier) * 10)).toBe(10)
    }
    expect(perMessage('balanced')).toBeLessThan(perMessage('frontier'))
  })

  // Two significant figures, so a surface never implies precision it lacks.
  test('rounds to two significant figures and floors an empty balance at zero', () => {
    const perMessage = priceTierUsageMicroUsd('balanced', TYPICAL_MESSAGE_USAGE)

    expect(estimateTierMessages('balanced', perMessage * 416)).toBe(420)
    expect(estimateTierMessages('balanced', 0)).toBe(0)
    expect(estimateTierMessages('balanced', -1)).toBe(0)
  })
})

describe('defaultTierFor', () => {
  test('defaults Starter and Pro to Standard and Max to Max', () => {
    expect(defaultTierFor({ subscriber: true, plan: 'starter' })).toBe('balanced')
    expect(defaultTierFor({ subscriber: true, plan: 'pro' })).toBe('balanced')
    expect(defaultTierFor({ subscriber: true, plan: 'max' })).toBe('frontier')
  })

  test('defaults unknown plans and non-subscribers to Standard', () => {
    // A subscriber whose plan is unreadable keeps the old subscriber default;
    // a non-subscriber lands on balanced even if a stale plan value rides along.
    expect(defaultTierFor({ subscriber: true })).toBe('balanced')
    expect(defaultTierFor({ subscriber: false })).toBe('balanced')
    expect(defaultTierFor({ subscriber: false, plan: 'max' })).toBe('balanced')
  })
})

describe('coerceStoredTier', () => {
  test('rejects legacy ids, falls through invalid defaults, and never clamps a paid tier', () => {
    const cases: [
      string | undefined,
      { workspaceDefault?: string; subscriber: boolean; plan?: 'starter' | 'pro' | 'max' },
      ModelTierId,
    ][] = [
      ['frontier', { subscriber: true }, 'frontier'],
      ['frontier', { subscriber: false }, 'frontier'],
      ['recommended', { workspaceDefault: 'frontier', subscriber: true }, 'frontier'],
      ['recommended', { workspaceDefault: 'balanced', subscriber: false }, 'balanced'],
      ['recommended', { workspaceDefault: 'balanced:zai', subscriber: true }, 'balanced'],
      [undefined, { workspaceDefault: 'balanced', subscriber: true }, 'balanced'],
      [undefined, { subscriber: false }, 'balanced'],
      // No stored value anywhere: the billing plan decides the default.
      [undefined, { subscriber: true, plan: 'max' }, 'frontier'],
      [undefined, { subscriber: true, plan: 'starter' }, 'balanced'],
      // A stored/workspace tier still beats the plan default.
      ['balanced', { subscriber: true, plan: 'max' }, 'balanced'],
    ]

    for (const [stored, options, expected] of cases) {
      expect(coerceStoredTier(stored, options)).toBe(expected)
    }
  })
})

describe('priceTierUsageMicroUsd', () => {
  const originalRates = MODEL_TIERS.balanced.rates

  beforeEach(() => {
    MODEL_TIERS.balanced.rates = {
      inputTokensPer1M: 2.5,
      outputTokensPer1M: 12.75,
      cachedInputTokensPer1M: 0.25,
    }
  })

  afterEach(() => {
    MODEL_TIERS.balanced.rates = originalRates
  })

  test('rounds once after summing all three full-precision components', () => {
    const usage = { uncachedInputTokens: 1, cachedInputTokens: 2, outputTokens: 1 }
    // The fixture rates total 15.75 microUSD; rounding each component first overcharges.
    expect(priceTierUsageMicroUsd('balanced', usage)).toBe(16)
    expect(Math.round(2.5) + Math.round(0.5) + Math.round(12.75)).toBe(17)
  })

  test('rejects negative, fractional, and non-finite token counts', () => {
    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const field of ['uncachedInputTokens', 'cachedInputTokens', 'outputTokens'] as const) {
        expect(() =>
          priceTierUsageMicroUsd('balanced', {
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            [field]: invalid,
          }),
        ).toThrow(/non-negative finite integer/)
      }
    }
  })

  // Settlement builds usage from a parsed upstream payload, so a field can be
  // absent at runtime even though the type says otherwise. Absent must throw,
  // never silently price as NaN.
  test('rejects a missing token count instead of pricing it as NaN', () => {
    for (const field of ['uncachedInputTokens', 'cachedInputTokens', 'outputTokens'] as const) {
      const usage: Record<string, number> = {
        uncachedInputTokens: 10,
        cachedInputTokens: 10,
        outputTokens: 10,
      }
      delete usage[field]
      expect(() =>
        priceTierUsageMicroUsd(
          'balanced',
          usage as unknown as Parameters<typeof priceTierUsageMicroUsd>[1],
        ),
      ).toThrow(/non-negative finite integer/)
    }
  })

  // Rates carry decimals that binary floating point cannot represent, so
  // summing rate*token products in floats drifts. Pricing scales to integers
  // first and divides once, retaining fractional microUSD even at large counts.
  test('prices large token counts exactly, without float drift', () => {
    expect(
      priceTierUsageMicroUsd('balanced', {
        uncachedInputTokens: 300_000_000_000_021,
        cachedInputTokens: 500_000_000_000_039,
        outputTokens: 100_000_000_000_033,
      }),
    ).toBe(2_150_000_000_000_483)
  })

  test('refuses usage whose exact charge would exceed safe integer precision', () => {
    expect(() =>
      priceTierUsageMicroUsd('balanced', {
        uncachedInputTokens: Number.MAX_SAFE_INTEGER,
        cachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toThrow(/exceeds safe integer precision/)
  })
})

describe('the services attribution tier', () => {
  test('is not a tier a person can pick', () => {
    // It must never reach the plan ladder, the pricing page, a session, or a
    // workspace default — all of which enumerate MODEL_TIER_IDS.
    expect(MODEL_TIER_IDS).toEqual(['frontier', 'balanced', 'economy'])
    expect(MODEL_TIER_IDS as readonly string[]).not.toContain(SERVICES_ATTRIBUTION_TIER)
    expect(ATTRIBUTION_TIER_IDS).toContain(SERVICES_ATTRIBUTION_TIER)
  })

  test('bills at the model, not at a flat rate', () => {
    // User tiers charge the published tariff, including subsidized routes;
    // services work instead settles at its upstream cost.
    const model = MODEL_TIERS.balanced.closure[0]!
    expect(tierBillsAtFlatRate('balanced', model)).toBe(true)
    expect(tierBillsAtFlatRate(SERVICES_ATTRIBUTION_TIER, model)).toBe(false)
  })
})

test('stored aliases retain precedence over workspace and plan defaults', () => {
  expect(
    coerceStoredTier('openai-frontier', {
      subscriber: true,
      plan: 'max',
      workspaceDefault: 'anthropic-max',
    }),
  ).toBe('openai-frontier')
  expect(
    coerceStoredTier(undefined, { subscriber: false, workspaceDefault: 'anthropic-max' }),
  ).toBe('anthropic-max')
})

test('economy can be selected and claimed', () => {
  expect(ModelTierIdSchema.parse('economy')).toBe('economy')
  expect(AttributionTierIdSchema.parse('economy')).toBe('economy')
  expect(RecordedAttributionTierIdSchema.parse('economy')).toBe('economy')
  expect(coerceStoredTier('economy', { subscriber: true, plan: 'max' })).toBe('economy')
  expect(tierBillsAtFlatRate('economy', 'anthropic/claude-haiku-5.5')).toBe(true)
  expect(tierBillsAtFlatRate('economy', 'openai/gpt-6-luna')).toBe(true)

})
