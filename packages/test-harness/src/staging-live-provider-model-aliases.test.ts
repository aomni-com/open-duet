import { afterEach, beforeEach, expect, test } from 'bun:test'

import { APPROVED_MODELS, PROVIDER_MODEL_ALIASES } from '@repo/contract'

import {
  inspectAliasGenerations,
  inspectAliasHistory,
} from './staging-live-provider-model-aliases-evidence'

const alias = PROVIDER_MODEL_ALIASES['openai-frontier']
const originalRates = alias.rates
const originalTarget = alias.gatewayModelId
const originalModelName = alias.modelName
beforeEach(() => {
  alias.rates = { inputTokensPer1M: 2, outputTokensPer1M: 3, cachedInputTokensPer1M: 0.5 }
  alias.gatewayModelId = 'fixture/alias'
  alias.modelName = 'fixture-family'
})
afterEach(() => {
  alias.rates = originalRates
  alias.gatewayModelId = originalTarget
  alias.modelName = originalModelName
})

const generation = {
  _id: 'generation-1',
  model: 'fixture/alias',
  tier: 'openai-frontier',
  status: 'settled',
  upstreamGenerationId: 'upstream-1',
  billedCostMicroUsd: 5_500_000,
  upstreamCostMicroUsd: 4_000_000,
  upstreamMetadata: {
    usage: {
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    },
  },
}
const transaction = {
  type: 'usage',
  reference: 'ai_generation:upstream-1',
  amountMicroUsd: -5_500_000,
}

test('requires settlement and its exact ledger debit before accepting execution evidence', () => {
  expect(inspectAliasGenerations('openai-frontier', [generation], [])).toBeNull()
  const evidence = inspectAliasGenerations('openai-frontier', [generation], [transaction])
  expect(evidence?.execution[0]).toMatchObject({
    id: 'generation-1',
    model: 'fixture/alias',
    tier: 'openai-frontier',
    billedCostMicroUsd: 5_500_000,
    debitMicroUsd: -5_500_000,
  })
  expect(() =>
    inspectAliasGenerations(
      'openai-frontier',
      [generation],
      [{ ...transaction, amountMicroUsd: -1 }],
    ),
  ).toThrow('ledger debit')
})

test('separates housekeeping without letting it prove execution or hide a model fallback', () => {
  const support = {
    _id: 'support-1',
    model: APPROVED_MODELS.entries.find(model => model.internal)!.gatewayModelId,
    tier: 'openai-frontier',
    status: 'forwarding',
  }
  expect(inspectAliasGenerations('openai-frontier', [support], [])).toBeNull()
  expect(
    inspectAliasGenerations('openai-frontier', [support, generation], [transaction])?.support,
  ).toEqual([
    {
      id: 'support-1',
      model: APPROVED_MODELS.entries.find(model => model.internal)!.gatewayModelId,
      tier: 'openai-frontier',
      status: 'forwarding',
    },
  ])
  expect(() =>
    inspectAliasGenerations(
      'openai-frontier',
      [{ ...generation, model: 'fixture/unexpected' }],
      [transaction],
    ),
  ).toThrow('unexpected execution model')
})

test('refuses a managed table that silently points an alias at another execution model', async () => {
  const { inspectAliasRoutingArtifact } =
    await import('./staging-live-provider-model-aliases-evidence')
  expect(() =>
    inspectAliasRoutingArtifact({
      tiers: {
        'openai-frontier': {
          routes: {
            general: { target: { modelName: 'fixture-wrong-family', thinkingLevel: 'medium' } },
          },
          advisor: { enabled: false },
        },
      },
    }),
  ).toThrow('openai-frontier has a stale backing model')
})

test('does not accept wrong attribution or a partly settled execution batch', () => {
  expect(() =>
    inspectAliasGenerations(
      'openai-frontier',
      [{ ...generation, tier: 'openai-max' }],
      [transaction],
    ),
  ).toThrow('alias attribution')
  expect(
    inspectAliasGenerations(
      'openai-frontier',
      [generation, { ...generation, _id: 'pending', status: 'forwarding' }],
      [transaction],
    ),
  ).toBeNull()
  expect(() =>
    inspectAliasGenerations('openai-frontier', [generation], [transaction, transaction]),
  ).toThrow('duplicate')
  expect(() =>
    inspectAliasGenerations(
      'openai-frontier',
      [{ ...generation, billedCostMicroUsd: 4_000_000 }],
      [transaction],
    ),
  ).toThrow('fixed alias charge')
})

test('reports terminal provider or settlement failure instead of polling it forever', () => {
  for (const status of ['upstream_failed', 'charge_failed', 'released']) {
    expect(() =>
      inspectAliasGenerations('openai-frontier', [{ ...generation, status }], []),
    ).toThrow(status)
  }
})

test('empty completed-turn history cannot prove conversation continuity', () => {
  expect(() => inspectAliasHistory([], [], 'Reply ALIAS_OK')).toThrow('current prompt')
})

test('requires fresh prompt, reply, and completion while retaining earlier turns', () => {
  const prompt = 'Reply ALIAS_OK'
  const first: import('@repo/contract').SessionTimelineEntry[] = [
    {
      seq: 1,
      createdAt: 1,
      event: {
        type: 'prompt_submitted',
        prompt,
        inputKind: 'initial',
        behavior: 'follow_up',
        sender: { kind: 'system' },
        images: [],
        attachments: [],
      },
    },
    { seq: 2, createdAt: 2, event: { type: 'step', step: { type: 'text', text: 'ALIAS_OK' } } },
    { seq: 3, createdAt: 3, event: { type: 'complete', status: 'completed' } },
  ]
  const second = first.map(row => ({ ...row, seq: row.seq + 3, createdAt: row.createdAt + 3 }))
  expect(() => inspectAliasHistory([], first, prompt)).not.toThrow()
  expect(() => inspectAliasHistory(first, [...first, ...second], prompt)).not.toThrow()
  expect(() => inspectAliasHistory(first, first, prompt)).toThrow('current prompt')
  expect(() => inspectAliasHistory(first, [...first, second[0]!, second[2]!], prompt)).toThrow(
    'assistant reply',
  )
  expect(() => inspectAliasHistory(first, second, prompt)).toThrow('lost prior transcript')
})
