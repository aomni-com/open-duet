import assert from 'node:assert/strict'

import {
  APPROVED_MODELS,
  isKnownTimelineEvent,
  type SessionTimelineEntry,
  PROVIDER_MODEL_ALIASES,
  priceTierUsageMicroUsd,
  type ProviderModelAliasId,
} from '@repo/contract'

export type GenerationRow = Record<string, unknown> & { _id: string }
export type AliasGenerationEvidence = {
  id: string
  upstreamGenerationId: string
  model: string
  tier: string | undefined
  usage: { uncachedInputTokens: number; cachedInputTokens: number; outputTokens: number }
  billedCostMicroUsd: number
  debitMicroUsd: number
}

/** All execution generations must settle; internal housekeeping is reported separately. */
export function inspectAliasGenerations(
  alias: ProviderModelAliasId,
  rows: GenerationRow[],
  transactions: Record<string, unknown>[],
): {
  execution: AliasGenerationEvidence[]
  support: Array<{ id: string; model: string; tier: unknown; status: unknown }>
} | null {
  const target = PROVIDER_MODEL_ALIASES[alias].gatewayModelId
  const execution: AliasGenerationEvidence[] = []
  const support: Array<{ id: string; model: string; tier: unknown; status: unknown }> = []
  for (const row of rows) {
    if (
      row.model !== target &&
      APPROVED_MODELS.entries.some(model => model.internal && model.gatewayModelId === row.model)
    ) {
      support.push({ id: row._id, model: String(row.model), tier: row.tier, status: row.status })
      continue
    }
    assert.equal(row.model, target, 'unexpected execution model')
    assert.equal(row.tier, alias, 'incorrect alias attribution')
    assert(
      !['upstream_failed', 'charge_failed', 'released'].includes(String(row.status)),
      `${alias} generation ${row._id} ended ${String(row.status)}`,
    )
    if (row.status !== 'settled') return null
    assert(
      typeof row.upstreamGenerationId === 'string' && row.upstreamGenerationId.length > 0,
      'missing upstream generation id',
    )
    const metadata = record(row.upstreamMetadata)
    const tokens = record(metadata.usage)
    const usage = {
      uncachedInputTokens: integer(tokens.uncachedInputTokens),
      cachedInputTokens: integer(tokens.cachedInputTokens),
      outputTokens: integer(tokens.outputTokens),
    }
    const expected = priceTierUsageMicroUsd(alias, usage)
    assert.equal(row.billedCostMicroUsd, expected, 'incorrect fixed alias charge')
    const debits = transactions.filter(
      entry =>
        entry.type === 'usage' && entry.reference === `ai_generation:${row.upstreamGenerationId}`,
    )
    if (debits.length === 0) return null
    assert.equal(debits.length, 1, 'duplicate generation ledger debit')
    assert.equal(debits[0]!.amountMicroUsd, -expected, 'incorrect generation ledger debit')
    execution.push({
      id: row._id,
      upstreamGenerationId: row.upstreamGenerationId,
      model: target,
      tier: alias,
      usage,
      billedCostMicroUsd: expected,
      debitMicroUsd: -expected,
    })
  }
  return execution.some(row => row.usage.outputTokens > 0) ? { execution, support } : null
}

function record(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'missing generation usage',
  )
  return value as Record<string, unknown>
}
function integer(value: unknown): number {
  assert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'invalid generation token count',
  )
  return value
}

export function inspectAliasRoutingArtifact(table: unknown): void {
  const tiers = record(record(table).tiers)
  for (const [alias, metadata] of Object.entries(PROVIDER_MODEL_ALIASES)) {
    const tier = record(tiers[alias])
    const routes = record(tier.routes)
    assert.deepEqual(Object.keys(routes), ['general'], `${alias} has multiple routes`)
    const route = record(routes.general)
    const target = record(route.target)
    assert.equal(target.modelName, metadata.modelName, `${alias} has a stale backing model`)
    assert.equal(target.thinkingLevel, 'medium', `${alias} changed effort`)
    assert.equal(route.visionFallbackModelName, undefined, `${alias} has a vision fallback`)
    assert.equal(record(tier.advisor).enabled, false, `${alias} enables an advisor`)
  }
}

export function inspectAliasHistory(
  previous: SessionTimelineEntry[],
  current: SessionTimelineEntry[],
  prompt: string,
): void {
  for (const row of previous)
    assert.deepEqual(
      current.find(next => next.seq === row.seq),
      row,
      'alias resume lost prior transcript',
    )
  const lastSeq = Math.max(0, ...previous.map(row => row.seq))
  const fresh = current
    .filter(row => row.seq > lastSeq)
    .map(row => row.event)
    .filter(isKnownTimelineEvent)
  assert(
    fresh.some(event => event.type === 'prompt_submitted' && event.prompt === prompt),
    'completed turn history omitted current prompt',
  )
  const reply = fresh
    .flatMap(event =>
      event.type === 'step' && event.step.type === 'text' ? [event.step.text] : [],
    )
    .join('')
  assert(reply.includes('ALIAS_OK'), 'completed turn history omitted current assistant reply')
  assert(
    fresh.some(event => event.type === 'complete' && event.status === 'completed'),
    'completed turn history omitted current completion',
  )
}
