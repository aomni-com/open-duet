import { expect, test } from 'bun:test'

import { DEFAULT_RESERVATION_ESTIMATE_MICRO_USD } from '@repo/contract'

import {
  inspectOpenModelSettlement,
  selectOpenModelProbes,
  waitForFailedOpenModelAccounting,
} from './staging-live-open-model-access-evidence'
import { runWorkspaceBrowserJourney } from './staging-live-workspace-browser'

test('a failed media output retains its payer until pending accounting becomes terminal', async () => {
  let reads = 0
  const rows = await waitForFailedOpenModelAccounting(async () => [
    {
      _id: 'paid-video',
      status: ['charge_failed', 'upstream_failed', 'reconciling', 'settled'][reads++],
      upstreamCostMicroUsd: 20_000,
    },
  ])
  expect(rows).toEqual([{ _id: 'paid-video', status: 'settled', upstreamCostMicroUsd: 20_000 }])
}, 15_000)

test('output with a settled surcharge cannot pass direct at-cost acceptance', () => {
  const generation = {
    _id: 'generation',
    workspaceId: 'workspace',
    model: 'raw/image',
    modality: 'image',
    status: 'settled',
    upstreamGenerationId: 'upstream',
    billingMode: 'reservation',
    reservationId: 'hold',
    upstreamCostMicroUsd: 7_000,
    billedCostMicroUsd: 9_000,
  }
  const transactions = [
    {
      type: 'reservation',
      reference: 'hold',
      amountMicroUsd: -9_000,
      metadata: { status: 'settled', estimateMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD, actualCostMicroUsd: 9_000 },
    },
  ]
  expect(() =>
    inspectOpenModelSettlement(generation, transactions, {
      workspaceId: 'workspace',
      model: 'raw/image',
      modality: 'image',
      billingMode: 'reservation',
    }),
  ).toThrow('at upstream cost')
})

test('selects priced uncatalogued generators and the cheapest supported short video controls', () => {
  const native = (id: string, image: string) => ({
    id,
    type: 'image',
    pricing: { image },
    modalities: { output: ['image'] },
  })
  const video = (id: string, operation = 'text-to-video', cost = '0.02') => ({
    id,
    type: 'video',
    video_capabilities: {
      supported_operations: [operation],
      supported_aspect_ratios: ['16:9'],
      supported_resolutions: ['480p', '720p'],
      supported_durations_seconds: [5, 2],
    },
    pricing: {
      video_duration_pricing: [
        { resolution: '720p', cost_per_second: '0.1' },
        { resolution: '480p', cost_per_second: cost },
      ],
    },
  })
  const selected = selectOpenModelProbes(
    [
      native('catalogued', '0.001'),
      native('unpriced', ''),
      native('native', '0.007'),
      video('needs-image', 'image-to-video'),
      video('video'),
      video('bytedance/seedance-v1.0-pro-fast', 'text-to-video', '0.001'),
      {
        id: 'catalogued-language-image',
        type: 'language',
        modalities: { output: ['image', 'text'] },
        pricing: { output: '0.000001' },
      },
      {
        id: 'vision-only',
        type: 'language',
        modalities: { input: ['image'], output: ['text'] },
        pricing: { output: '0.000001' },
      },
      {
        id: 'language-image',
        type: 'language',
        modalities: { output: ['image', 'text'] },
        pricing: { output: '0.00003' },
      },
    ],
    new Set(['catalogued', 'catalogued-language-image']),
  )
  expect(selected.image.model.id).toBe('native')
  expect(selected.video).toMatchObject({
    model: { id: 'video' },
    duration: 2,
    resolution: '854x480',
    aspectRatio: '16:9',
    estimatedUsd: 0.04,
  })
  expect(selected.languageImage.model.id).toBe('language-image')
})

test('an expired journey cannot allocate a fresh workspace or issue paid work', async () => {
  await expect(
    runWorkspaceBrowserJourney({
      journey: 'expired',
      label: 'Expired',
      deadlineAt: Date.now() - 1,
      run: async () => {
        throw new Error('acceptance must not run')
      },
    }),
  ).rejects.toThrow('acceptance deadline expired')
})

test('native media proves its configured hold, actual-cost true-up and terminal reservation', () => {
  const generation = {
    _id: 'media',
    workspaceId: 'payer',
    model: 'raw/native',
    modality: 'video',
    status: 'settled',
    upstreamGenerationId: 'provider-video',
    billingMode: 'reservation',
    reservationId: 'reservation',
    upstreamCostMicroUsd: 42_000,
    billedCostMicroUsd: 42_000,
  }
  const transaction = {
    type: 'reservation',
    reference: 'reservation',
    amountMicroUsd: -42_000,
    metadata: { status: 'settled', estimateMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD, actualCostMicroUsd: 42_000 },
  }
  const expected = {
    workspaceId: 'payer',
    model: 'raw/native',
    modality: 'video' as const,
    billingMode: 'reservation' as const,
  }
  expect(inspectOpenModelSettlement(generation, [transaction], expected)).toMatchObject({
    upstreamGenerationId: 'provider-video',
    upstreamCostMicroUsd: 42_000,
    ledger: { reference: 'reservation', amountMicroUsd: -42_000 },
  })
  expect(() =>
    inspectOpenModelSettlement({ ...generation, status: 'released' }, [transaction], expected),
  ).toThrow('did not settle actual cost')
  expect(() =>
    inspectOpenModelSettlement(
      generation,
      [{ ...transaction, metadata: { ...transaction.metadata, estimateMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD + 1 } }],
      expected,
    ),
  ).toThrow('did not reserve the configured hold')
  expect(() =>
    inspectOpenModelSettlement(generation, [{ ...transaction, amountMicroUsd: -43_000 }], expected),
  ).toThrow('ledger amount differs')
})

test('image-producing language calls use direct usage settlement and the intended payer', () => {
  const generation = {
    _id: 'language-image',
    workspaceId: 'payer',
    model: 'raw/language-image',
    modality: 'text',
    status: 'settled',
    upstreamGenerationId: 'language-upstream',
    billingMode: 'post_response',
    upstreamCostMicroUsd: 34_000,
    billedCostMicroUsd: 34_000,
  }
  const transactions = [
    { type: 'usage', reference: 'ai_generation:language-upstream', amountMicroUsd: -34_000 },
  ]
  const expected = {
    workspaceId: 'payer',
    model: 'raw/language-image',
    modality: 'text' as const,
    billingMode: 'post_response' as const,
  }
  expect(inspectOpenModelSettlement(generation, transactions, expected)).toMatchObject({
    model: 'raw/language-image',
    ledger: { type: 'usage', reference: 'ai_generation:language-upstream' },
  })
  expect(() =>
    inspectOpenModelSettlement({ ...generation, workspaceId: 'other' }, transactions, expected),
  ).toThrow('wrong billing workspace')
  expect(() =>
    inspectOpenModelSettlement(
      { ...generation, upstreamCostMicroUsd: undefined },
      transactions,
      expected,
    ),
  ).toThrow('missing actual upstream cost')
  expect(() =>
    inspectOpenModelSettlement(
      { ...generation, upstreamGenerationId: undefined },
      transactions,
      expected,
    ),
  ).toThrow('missing upstream generation ID')
  expect(() => inspectOpenModelSettlement(generation, [], expected)).toThrow(
    'missing terminal ledger entry',
  )
})

test('direct services attribution is accepted', () => {
  const generation = {
    _id: 'services-generation',
    workspaceId: 'payer',
    model: 'raw/text',
    modality: 'text',
    status: 'settled',
    tier: 'services',
    upstreamGenerationId: 'services-upstream',
    billingMode: 'post_response',
    upstreamCostMicroUsd: 10,
    billedCostMicroUsd: 10,
  }
  const transaction = {
    type: 'usage',
    reference: 'ai_generation:services-upstream',
    amountMicroUsd: -10,
  }
  const expected = {
    workspaceId: 'payer',
    model: 'raw/text',
    modality: 'text' as const,
    billingMode: 'post_response' as const,
  }
  expect(inspectOpenModelSettlement(generation, [transaction], expected)).toMatchObject({
    tier: 'services',
  })
})

test('a compound billing claim fails even when its tariff happens to equal upstream cost', () => {
  expect(() =>
    inspectOpenModelSettlement(
      {
        _id: 'generation',
        workspaceId: 'workspace',
        model: 'raw/text',
        modality: 'text',
        billingMode: 'post_response',
        status: 'settled',
        tier: 'balanced',
        upstreamGenerationId: 'upstream',
        upstreamCostMicroUsd: 10,
        billedCostMicroUsd: 10,
      },
      [{ type: 'usage', reference: 'ai_generation:upstream', amountMicroUsd: -10 }],
      {
        workspaceId: 'workspace',
        model: 'raw/text',
        modality: 'text',
        billingMode: 'post_response',
      },
    ),
  ).toThrow('compound billing claim')
})

test('video selection never prices an audio mode the acceptance request cannot select', () => {
  const models = [
    { id: 'image', type: 'image', pricing: { image: '0.01' } },
    {
      id: 'language-image',
      type: 'language',
      modalities: { output: ['image'] },
      pricing: { output: '0.000003' },
    },
    ...['conditional', 'plain'].map(id => ({
      id,
      type: 'video',
      video_capabilities: {
        supported_operations: ['text-to-video'],
        supported_aspect_ratios: ['16:9'],
        supported_resolutions: ['480p'],
        supported_durations_seconds: [2],
      },
      pricing: {
        video_duration_pricing: [
          id === 'conditional'
            ? { resolution: '480p', audio: false, cost_per_second: '0.001' }
            : { resolution: '480p', cost_per_second: '0.02' },
        ],
      },
    })),
  ]
  expect(selectOpenModelProbes(models, new Set()).video.model.id).toBe('plain')
})
