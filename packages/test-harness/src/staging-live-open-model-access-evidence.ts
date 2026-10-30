import assert from 'node:assert/strict'

import { DEFAULT_RESERVATION_ESTIMATE_MICRO_USD } from '@repo/contract'

import { waitForForwardProgress } from './staging-live-forward-progress'

export type OpenModelRow = Record<string, unknown> & { id: string; type: string }
export type GenerationRow = Record<string, unknown> & { _id: string }
export type ExpectedGeneration = {
  workspaceId: string
  model: string
  modality: 'text' | 'image' | 'video'
  billingMode: 'post_response' | 'reservation'
}

// This model rejected the selected short-video controls with HTTP 400 in live
// staging; its hold was released without a generation ID. Exclude that failed
// probe combination from acceptance, without filtering production discovery.
const FAILED_LIVE_VIDEO_PROBES = new Set(['bytedance/seedance-v1.0-pro-fast'])

/** Failed output can still have incurred cost; keep its payer alive through settlement. */
export function waitForFailedOpenModelAccounting(load: () => Promise<GenerationRow[]>) {
  return waitForForwardProgress({
    label: 'failed open-model attempt accounting before teardown',
    load,
    isComplete: rows =>
      rows.every(row => ['settled', 'released'].includes(String(row.status))),
    hasProgress: (before, after) => JSON.stringify(before) !== JSON.stringify(after),
    timeoutMs: 300_000,
    pollMs: 2_000,
    maxConsecutiveUnchangedObservations: 120,
    summarize: rows => rows.map(({ _id, model, status }) => ({ _id, model, status })),
  })
}

/** Output success is insufficient: the actual upstream cost must reach the payer's ledger. */
export function inspectOpenModelSettlement(
  generation: GenerationRow,
  transactions: Array<Record<string, unknown>>,
  expected: ExpectedGeneration,
) {
  assert.equal(generation.workspaceId, expected.workspaceId, 'wrong billing workspace')
  assert.equal(generation.model, expected.model, 'wrong concrete model')
  assert.equal(generation.modality, expected.modality, 'wrong accounting modality')
  assert.equal(generation.billingMode, expected.billingMode, 'wrong billing mode')
  assert(
    generation.tier === undefined || generation.tier === 'services',
    'direct generation carried a compound billing claim',
  )
  assert.equal(generation.status, 'settled', 'generation did not settle actual cost')
  assert(typeof generation.upstreamGenerationId === 'string', 'missing upstream generation ID')
  assert(
    typeof generation.upstreamCostMicroUsd === 'number' &&
      Number.isFinite(generation.upstreamCostMicroUsd) &&
      generation.upstreamCostMicroUsd >= 0,
    'missing actual upstream cost',
  )
  assert.equal(
    generation.billedCostMicroUsd,
    generation.upstreamCostMicroUsd,
    'not billed at upstream cost',
  )
  const reference =
    expected.billingMode === 'reservation'
      ? generation.reservationId
      : `ai_generation:${generation.upstreamGenerationId}`
  assert(typeof reference === 'string', 'missing media reservation ID')
  const transaction = transactions.find(row => row.reference === reference)
  assert(transaction, 'missing terminal ledger entry')
  assert.equal(
    transaction.amountMicroUsd,
    generation.upstreamCostMicroUsd === 0 ? 0 : -generation.upstreamCostMicroUsd,
    'ledger amount differs from actual cost',
  )
  if (expected.billingMode === 'reservation') {
    assert.equal(transaction.type, 'reservation', 'missing native media reservation')
    const metadata = transaction.metadata as Record<string, unknown> | undefined
    assert.equal(metadata?.status, 'settled', 'reservation did not settle')
    assert.equal(metadata?.estimateMicroUsd, DEFAULT_RESERVATION_ESTIMATE_MICRO_USD, 'native media did not reserve the configured hold')
    assert.equal(
      metadata?.actualCostMicroUsd,
      generation.upstreamCostMicroUsd,
      'reservation actual cost differs',
    )
  } else {
    assert.equal(transaction.type, 'usage', 'missing direct usage debit')
  }
  return {
    generationId: generation._id,
    upstreamGenerationId: generation.upstreamGenerationId,
    workspaceId: generation.workspaceId,
    model: generation.model,
    modality: generation.modality,
    billingMode: generation.billingMode,
    status: generation.status,
    reservationId: generation.reservationId,
    tier: generation.tier,
    upstreamCostMicroUsd: generation.upstreamCostMicroUsd,
    billedCostMicroUsd: generation.billedCostMicroUsd,
    ledger: {
      type: transaction.type,
      reference,
      amountMicroUsd: transaction.amountMicroUsd,
      metadata: transaction.metadata,
    },
  }
}

export function selectOpenModelProbes(models: OpenModelRow[], cataloguedIds: ReadonlySet<string>) {
  const pricedImages = models
    .flatMap(model => {
      const pricing = model.pricing as { image?: unknown } | undefined
      const price = numericPrice(pricing?.image)
      return model.type === 'image' && !cataloguedIds.has(model.id) && price !== undefined
        ? [{ model, estimatedUsd: price }]
        : []
    })
    .sort((a, b) => a.estimatedUsd - b.estimatedUsd || a.model.id.localeCompare(b.model.id))
  const videos = models
    .flatMap(model => {
      if (
        model.type !== 'video' ||
        cataloguedIds.has(model.id) ||
        FAILED_LIVE_VIDEO_PROBES.has(model.id)
      )
        return []
      const capabilities = model.video_capabilities as
        | {
            supported_operations?: string[]
            supported_aspect_ratios?: string[]
            supported_resolutions?: string[]
            supported_durations_seconds?: number[]
          }
        | undefined
      if (
        !capabilities?.supported_operations?.includes('text-to-video') ||
        !capabilities.supported_aspect_ratios?.includes('16:9')
      )
        return []
      const duration = Math.min(
        ...(capabilities.supported_durations_seconds ?? []).filter(
          value => Number.isInteger(value) && value > 0 && value <= 5,
        ),
      )
      if (!Number.isFinite(duration)) return []
      const pricing = model.pricing as
        | { video_duration_pricing?: Array<{ resolution?: string; cost_per_second?: unknown }> }
        | undefined
      return (pricing?.video_duration_pricing ?? []).flatMap(entry => {
        // Audio/quality/provider modes are not selected by this small acceptance request.
        if (Object.keys(entry).some(key => key !== 'resolution' && key !== 'cost_per_second'))
          return []
        const dimensions =
          entry.resolution === '480p'
            ? '854x480'
            : entry.resolution === '720p'
              ? '1280x720'
              : undefined
        const price = numericPrice(entry.cost_per_second)
        if (
          !dimensions ||
          price === undefined ||
          !capabilities.supported_resolutions?.includes(entry.resolution!)
        )
          return []
        return [
          {
            model,
            duration,
            resolution: dimensions,
            aspectRatio: '16:9',
            estimatedUsd: price * duration,
          },
        ]
      })
    })
    .sort((a, b) => a.estimatedUsd - b.estimatedUsd || a.model.id.localeCompare(b.model.id))
  const languageImages = models
    .flatMap(model => {
      const modalities = model.modalities as { output?: string[] } | undefined
      const pricing = model.pricing as { output?: unknown } | undefined
      const price = numericPrice(pricing?.output)
      return model.type === 'language' &&
        !cataloguedIds.has(model.id) &&
        modalities?.output?.includes('image') &&
        price !== undefined
        ? [{ model, outputTokenUsd: price }]
        : []
    })
    .sort((a, b) => a.outputTokenUsd - b.outputTokenUsd || a.model.id.localeCompare(b.model.id))
  assert(pricedImages[0], 'no priced uncatalogued native image model discovered')
  assert(videos[0], 'no priced uncatalogued short text-to-video model discovered')
  assert(languageImages[0], 'no priced image-producing language model discovered')
  return { image: pricedImages[0], video: videos[0], languageImage: languageImages[0] }
}

function numericPrice(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}
