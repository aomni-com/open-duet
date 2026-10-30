import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGateway, generateImage } from 'ai'
import { type ConvexHttpClient } from 'convex/browser'
import { getFunctionName } from 'convex/server'

import {
  APPROVED_MODELS,
  MODEL_TIERS,
  createApprovedModelCatalog,
  DEFAULT_RESERVATION_ESTIMATE_MICRO_USD,
  dollarsToMicroUsd,
  fetchModelCatalog,
  hashApiKey,
  priceTierUsageMicroUsd,
  VERCEL_AI_GATEWAY_REFERER,
  VERCEL_AI_GATEWAY_TITLE,
  X_DUET_GATEWAY_CODE_HEADER,
  X_DUET_GATEWAY_HEADER,
  type GatewayBlock,
} from '@repo/contract'
import {
  convexDev,
  createFakeVag,
  generateAuthKeys,
  mutate,
  query,
  serveFakeVag,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { createModelGatewayApp, type ConvexMutationClient } from './index'
import { inspectGatewayRequest } from './request-inspection'

const PLATFORM_KEY = 'test-platform-key'
const CALLER_KEY = 'duet_sk_test_gateway_key'
const UPSTREAM = 'https://fake-vag.test'
const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/backend')
const INTERNAL_KEY = 'test-model-gateway-app-internal-key'
const workspaceForKey = new Map<string, string>()
const ALLOW_PREFLIGHT = async () => ({ proceed: true as const })
// Text requests in this suite claim balanced, so they name a model that tier
// bills at its flat rate. Chat needs no catalog entry.
const APPROVED_CHAT_MODEL = MODEL_TIERS.balanced.closure[0]!
const APPROVED_IMAGE_MODEL = approvedModelFor('image')
const APPROVED_VIDEO_MODEL = approvedModelFor('video')
const APPROVED_EMBEDDING_MODEL = approvedModelFor('embedding')
const REQUEST_CATALOG = createApprovedModelCatalog([
  {
    id: 'test:chat',
    gatewayModelId: 'test/chat',
    kind: 'chat',
    name: 'Test Chat',
    simpleName: 'Chat',
    description: 'Fixture chat model',
    internal: true,
  },
  {
    id: 'test:image',
    gatewayModelId: 'test/image',
    kind: 'image',
    name: 'Test Image',
    simpleName: 'Image',
    description: 'Fixture image model',
    pricing: { perImage: 0.01 },
  },
  {
    id: 'test:locked-chat',
    gatewayModelId: 'test/locked-chat',
    kind: 'chat',
    name: 'Test Locked Chat',
    simpleName: 'Locked Chat',
    description: 'Fixture provider-locked chat model',
    internal: true,
    providerLock: ['fixture-primary', 'fixture-secondary'],
  },
  {
    id: 'test:video',
    gatewayModelId: 'test/video',
    kind: 'video',
    name: 'Test Video',
    simpleName: 'Video',
    description: 'Fixture video model',
    pricing: { perSecond: 0.01 },
  },
  {
    id: 'test:embedding',
    gatewayModelId: 'test/embedding',
    kind: 'embedding',
    name: 'Test Embedding',
    simpleName: 'Embedding',
    description: 'Fixture embedding model',
    internal: true,
    hidden: true,
    providerLock: ['fixture-primary', 'fixture-secondary'],
  },
])

describe('model gateway wire contract', () => {
  test('selects the workspace at preflight without forwarding the selector upstream', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const convex: ConvexMutationClient = {
      async mutation(ref, args) {
        if (getFunctionName(ref) !== 'domains/modelGateway/model:gatewayPreflight') {
          throw new Error('Unexpected gateway operation')
        }
        return args.workspaceSlug === 'second'
          ? { proceed: true, workspaceId: 'second-id', workspaceSlug: 'second', userId: 'user-id' }
          : {
              proceed: false,
              block: {
                status: 403,
                body: { error: 'Select a workspace', code: 'workspace_ambiguous' },
              },
            }
      },
    }
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      internalKey: INTERNAL_KEY,
      convex,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
    })
    const response = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${CALLER_KEY}`, 'x-duet-workspace': 'second' },
    })
    expect(response.status).toBe(200)
    expect(fake.requests[0]?.headers.get('x-duet-workspace')).toBeNull()
    expect(fake.requests[0]?.headers.get('authorization')).toBe(`Bearer ${PLATFORM_KEY}`)
    const refused = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${CALLER_KEY}` },
    })
    expect(refused.status).toBe(403)
    expect(fake.requests).toHaveLength(1)
  })

  test.each([
    ['outside the claimed tier closure', 'anthropic/claude-opus-5'],
    ['missing from the approved catalog', 'vendor/model-released-yesterday'],
  ])('preflights a model %s instead of refusing it', async (_case, model) => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const preflights: Array<Record<string, unknown>> = []
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: async args => {
        preflights.push(args)
        return { proceed: true }
      },
    })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model, messages: [] }),
    })

    expect(response.status).toBe(200)
    expect(preflights).toEqual([expect.objectContaining({ model, tier: 'balanced' })])
    expect(fake.requests).toHaveLength(1)
  })

  test.each(['frontier', 'openai-frontier', 'openai-max', 'anthropic-frontier', 'anthropic-max'])(
    'preflights %s and never forwards its attribution header upstream',
    async tier => {
      const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
      const preflights: Array<Record<string, unknown>> = []
      const app = createModelGatewayApp({
        aiGatewayApiKey: PLATFORM_KEY,
        upstreamBaseUrl: UPSTREAM,
        fetch: fake.fetch,
        preflight: async args => {
          preflights.push(args)
          return { proceed: true }
        },
      })

      const response = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CALLER_KEY}`,
          'content-type': 'application/json',
          'x-duet-tier': tier,
        },
        body: JSON.stringify({ model: 'anthropic/claude-opus-5', messages: [] }),
      })

      expect(response.status).toBe(200)
      expect(preflights).toHaveLength(1)
      expect(preflights[0]).toMatchObject({
        model: 'anthropic/claude-opus-5',
        tier,
      })
      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0]?.headers.get('x-duet-tier')).toBeNull()
    },
  )

  test.each(['/v1/messages', '/v1/chat/completions', '/v1/responses'])(
    'defaults headerless %s requests to provider-cost services billing',
    async endpoint => {
      const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
      const preflights: Array<Record<string, unknown>> = []
      const app = createModelGatewayApp({
        aiGatewayApiKey: PLATFORM_KEY,
        upstreamBaseUrl: UPSTREAM,
        fetch: fake.fetch,
        preflight: async args => {
          preflights.push(args)
          return { proceed: true }
        },
      })
      const headers = new Headers({
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
      })

      const response = await app.request(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'anthropic/claude-opus-5', messages: [] }),
      })

      expect(response.status).toBe(200)
      expect(preflights).toEqual([
        expect.objectContaining({
          model: 'anthropic/claude-opus-5',
          tier: 'services',
        }),
      ])
      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0]?.headers.get('x-duet-tier')).toBeNull()
    },
  )

  test.each([
    ['empty', ''],
    ['unknown', 'legacy-recommended'],
  ])('rejects a %s tier claim for a non-internal chat model', async (_case, tier) => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const preflights: Array<Record<string, unknown>> = []
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: async args => {
        preflights.push(args)
        return { proceed: true }
      },
    })
    const headers = new Headers({
      authorization: `Bearer ${CALLER_KEY}`,
      'content-type': 'application/json',
    })
    if (tier !== undefined) headers.set('x-duet-tier', tier)

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'anthropic/claude-opus-5', messages: [] }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'tier_not_allowed',
      code: 'tier_not_allowed',
    })
    expect(preflights).toHaveLength(0)
    expect(fake.requests).toHaveLength(0)
  })

  test.each([
    ['memory', 'openai/gpt-5.4-mini'],
    ['embedding', 'google/gemini-embedding-2'],
  ])('allows headerless internal %s requests without tier attribution', async (_label, model) => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const preflights: Array<Record<string, unknown>> = []
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: async args => {
        preflights.push(args)
        return { proceed: true }
      },
    })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model }),
    })

    expect(response.status).toBe(200)
    expect(preflights).toHaveLength(1)
    expect(preflights[0]).not.toHaveProperty('tier')
    expect(fake.requests).toHaveLength(1)
  })

  test('limits the internal exception to requests with no tier header', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const preflights: Array<Record<string, unknown>> = []
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: async args => {
        preflights.push(args)
        return { proceed: true }
      },
    })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model: 'openai/gpt-5.4-mini' }),
    })

    // A tier header wins over the internal exception: the request is
    // attributed to the tier it claimed, not waved through as internal.
    expect(response.status).toBe(200)
    expect(preflights).toEqual([
      expect.objectContaining({ model: 'openai/gpt-5.4-mini', tier: 'balanced' }),
    ])
  })

  test.each([
    ['image', approvedModelFor('image')],
    ['video', approvedModelFor('video')],
  ])('keeps headerless %s requests on the media reservation rail', async (_label, model) => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const preflights: Array<Record<string, unknown>> = []
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: async args => {
        preflights.push(args)
        return { proceed: true }
      },
    })

    const response = await app.request('/v4/ai/generate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model }),
    })

    expect(response.status).toBe(200)
    expect(preflights[0]).toMatchObject({
      billingMode: 'reservation',
      estimateMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD,
      model,
    })
    expect(preflights[0]).not.toHaveProperty('tier')
    expect(fake.requests).toHaveLength(1)
  })

  test('replaces caller routing policy with the locked model providers', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${CALLER_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test/locked-chat',
        messages: [],
        providerOptions: {
          cache_control: { type: 'ephemeral' },
          gateway: { only: ['caller-provider'], order: ['caller-order'] },
        },
      }),
    })

    expect(response.status).toBe(200)
    const forwardedBody = fake.requests[0]!.body!
    expect(JSON.parse(forwardedBody)).toEqual({
      model: 'test/locked-chat',
      messages: [],
      providerOptions: {
        cache_control: { type: 'ephemeral' },
        gateway: {
          only: ['fixture-primary', 'fixture-secondary'],
          order: ['caller-order'],
        },
      },
    })
    expect(fake.requests[0]!.headers.get('content-length')).toBe(
      String(Buffer.byteLength(forwardedBody)),
    )
  })

  test.each([
    {
      format: 'openai-chat',
      path: '/v1/chat/completions',
      modelHeader: undefined,
      body: { model: 'test/locked-chat', messages: [] },
    },
    {
      format: 'ai-sdk',
      path: '/v4/ai/language-model',
      modelHeader: 'test/locked-chat',
      body: { prompt: 'hello' },
    },
    {
      format: 'embeddings',
      path: '/v1/embeddings',
      modelHeader: undefined,
      body: { model: 'test/embedding', input: 'hello' },
    },
  ])('applies provider locks to $format JSON bodies', async ({ path, modelHeader, body }) => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: ALLOW_PREFLIGHT,
    })

    const headers = new Headers({
      authorization: `Bearer ${CALLER_KEY}`,
      'content-type': 'application/json',
    })
    if (modelHeader !== undefined) headers.set('ai-language-model-id', modelHeader)
    const response = await app.request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(200)
    expect(JSON.parse(fake.requests[0]!.body!).providerOptions).toEqual({
      gateway: { only: ['fixture-primary', 'fixture-secondary'] },
    })
  })

  test('uses the body model for preflight and forwarding when a header conflicts', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const preflights: Array<Record<string, unknown>> = []
    const body = JSON.stringify({
      model: 'test/chat',
      messages: [],
      providerOptions: {
        cache_control: { type: 'ephemeral' },
        gateway: { only: ['caller-provider'] },
      },
    })
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: async args => {
        preflights.push(args)
        return { proceed: true }
      },
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
        'ai-model-id': 'test/image',
      },
      body,
    })

    expect(response.status).toBe(200)
    expect(preflights).toHaveLength(1)
    expect(preflights[0]).toMatchObject({
      model: 'test/chat',
      modality: 'text',
      billingMode: 'post_response',
    })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.body).toBe(body)
    // The upstream gateway routes by the model header over the body, so the
    // forwarded header must be rewritten to the body model — otherwise a
    // caller passes an approved model in the body (preflight) and a different
    // one in the header (served): a live enforcement bypass.
    expect(fake.requests[0]?.headers.get('ai-model-id')).toBe('test/chat')
  })

  test('falls back to an AI SDK model header only when the JSON body has no model field', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const preflights: Array<Record<string, unknown>> = []
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: async args => {
        preflights.push(args)
        return { proceed: true }
      },
    })

    const response = await app.request('/v4/ai/image', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
        'ai-model-id': 'test/image',
      },
      body: JSON.stringify({ prompt: 'fixture' }),
    })

    expect(response.status).toBe(200)
    expect(preflights[0]).toMatchObject({
      model: 'test/image',
      modality: 'image',
      billingMode: 'reservation',
      estimateMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD,
    })
  })

  test.each([
    ['malformed JSON', '{', undefined],
    ['null JSON', 'null', undefined],
    ['array JSON', '[]', undefined],
    ['empty model', JSON.stringify({ model: '' }), 'test/chat'],
    ['whitespace model', JSON.stringify({ model: '  ' }), 'test/chat'],
    ['non-string model', JSON.stringify({ model: 42 }), 'test/chat'],
    ['missing model', '{}', undefined],
  ])('fails closed before preflight and upstream for %s', async (_case, body, headerModel) => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const preflights: Array<Record<string, unknown>> = []
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: async args => {
        preflights.push(args)
        return { proceed: true }
      },
    })
    const headers: Record<string, string> = {
      authorization: `Bearer ${CALLER_KEY}`,
      'content-type': 'application/json',
    }
    if (headerModel !== undefined) headers['ai-model-id'] = headerModel

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body,
    })

    expect(response.status).toBe(400)
    expect(preflights).toHaveLength(0)
    expect(fake.requests).toHaveLength(0)
  })

  test.each([
    ['test/chat', 'chat', 'post_response'],
    ['test/image', 'image', 'reservation'],
    ['test/video', 'video', 'reservation'],
    ['test/embedding', 'embedding', 'post_response'],
  ] as const)(
    'classifies catalog model %s as %s with %s billing',
    async (model, modality, billingMode) => {
      const request = new Request('https://gateway.test/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      })

      expect(await inspectGatewayRequest(request, REQUEST_CATALOG)).toMatchObject({
        kind: 'generation',
        model,
        modality,
        billingMode,
        jsonBody: { model },
      })
    },
  )

  test.each([
    ['/image-model', 'image', 'reservation'],
    ['/v4/ai/image-model', 'image', 'reservation'],
    ['/v4/ai/image', 'image', 'reservation'],
    ['/v1/images/generations', 'image', 'reservation'],
    ['/video-model', 'video', 'reservation'],
    ['/v4/ai/video-model', 'video', 'reservation'],
    ['/v4/ai/video', 'video', 'reservation'],
    ['/embedding-model', 'embedding', 'post_response'],
    ['/v4/ai/embedding-model', 'embedding', 'post_response'],
    ['/v1/embeddings', 'embedding', 'post_response'],
  ] as const)(
    'bills %s by operation instead of catalog membership or hints',
    async (path, modality, billingMode) => {
      const model = modality === 'embedding' ? 'test/image' : 'vendor/new-model'
      const requests: Array<Record<string, unknown>> = []
      const app = createModelGatewayApp({
        approvedModelCatalog: REQUEST_CATALOG,
        aiGatewayApiKey: PLATFORM_KEY,
        preflight: async request => {
          requests.push(request)
          return { proceed: true }
        },
        fetch: async () => Response.json({ generated: 'fixture-output' }),
      })
      const response = await app.request(path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CALLER_KEY}`,
          'content-type': 'application/json',
          'x-duet-tier': 'balanced',
        },
        body: JSON.stringify({ model, prompt: 'fixture' }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ generated: 'fixture-output' })
      expect(requests).toEqual([
        expect.objectContaining({
          model,
          modality: modality === 'embedding' ? 'text' : modality,
          billingMode,
          ...(billingMode === 'reservation'
            ? { estimateMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD }
            : { tier: 'balanced' }),
        }),
      ])
      if (billingMode === 'reservation') expect(requests[0]!.tier).toBeUndefined()
    },
  )

  test('uncatalogued SDK image preserves bytes on the native hold and reconciliation path', async () => {
    const model = 'fixture/new-image'
    const image =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    const pending: Promise<unknown>[] = []
    const recorded: Array<{ name: string; args: Record<string, unknown> }> = []
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      internalKey: INTERNAL_KEY,
      preflight: async request => {
        expect(request).toMatchObject({
          model,
          modality: 'image',
          billingMode: 'reservation',
          estimateMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD,
        })
        return { proceed: true, generationId: 'fixture-image-generation' }
      },
      fetch: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe('/v4/ai/image-model')
        expect(new Headers(init?.headers).get('ai-model-id')).toBe(model)
        return Response.json({
          images: [image],
          providerMetadata: { gateway: { generationId: 'gen_uncatalogued_image' } },
        })
      },
      convex: {
        mutation: async (ref, args) => {
          recorded.push({ name: getFunctionName(ref), args })
          return null
        },
      },
      waitUntil: work => pending.push(work),
      now: () => 42,
    })
    const gateway = createGateway({
      baseURL: 'https://gateway.test/v4/ai',
      apiKey: CALLER_KEY,
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          app.fetch(new Request(input, init)),
        { preconnect: fetch.preconnect },
      ),
    })
    const result = await generateImage({
      model: gateway.imageModel(model),
      prompt: 'A blue pixel.',
      maxRetries: 0,
    })
    expect(result.image.uint8Array).toEqual(new Uint8Array(Buffer.from(image, 'base64')))
    expect(result.image.mediaType).toBe('image/png')
    await Promise.all(pending)
    expect(recorded).toEqual([
      {
        name: 'domains/modelGateway/model:recordUpstreamGenerationId',
        args: {
          internalKey: INTERNAL_KEY,
          generationId: 'fixture-image-generation',
          upstreamGenerationId: 'gen_uncatalogued_image',
          now: 42,
        },
      },
    ])
  })

  test('classifies every GET as a model-less catalog read, including /v1/models/<id>', async () => {
    for (const path of ['/v1/models', '/v1/models/test%2Fchat']) {
      const request = new Request(`https://gateway.test${path}`, { method: 'GET' })
      expect(await inspectGatewayRequest(request, REQUEST_CATALOG)).toMatchObject({
        kind: 'catalog',
      })
    }
  })

  test('round-trips a multi-megabyte base64 image body and corrects content-length', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const body = JSON.stringify({
      model: 'test/chat',
      messages: [{ image: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` }],
    })
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
        'content-length': '1',
      },
      body,
    })

    expect(response.status).toBe(200)
    expect(fake.requests[0]?.body).toBe(body)
    expect(fake.requests[0]?.headers.get('content-length')).toBe(String(Buffer.byteLength(body)))
  })

  test('accepts x-api-key credentials for Anthropic /v1/messages', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CALLER_KEY,
        'content-type': 'application/json',
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', messages: [] }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(fake.requests[0]?.url.pathname).toBe('/v1/messages')
  })

  test('accepts Bearer credentials for OpenAI /v1/responses', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model: APPROVED_CHAT_MODEL, input: 'hi' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ generationId: 'gen_fake_1', id: 'gen_fake_1' })
    expect(fake.requests[0]?.url.pathname).toBe('/v1/responses')
  })

  test('rejects Vercel vck credentials with a 401 envelope', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer vck_not_allowed' },
      body: JSON.stringify({ model: APPROVED_CHAT_MODEL }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized', code: 'invalid_api_key' })
    expect(fake.requests).toHaveLength(0)
  })

  test('marks every Duet policy block with its gateway code', async () => {
    type BillingBlock = Extract<GatewayBlock, { status: 402 }>
    const billingBlocks = {
      insufficient_credits: {
        status: 402,
        body: {
          error: 'insufficient_credits',
          code: 'insufficient_credits',
          tier: 'account',
          balanceMicroUsd: 0,
          autoTopupScheduled: false,
          billingUrl: 'https://app.duet.so/settings/billing',
        },
      },
      monthly_cap: {
        status: 402,
        body: {
          error: 'monthly_cap',
          code: 'monthly_cap',
          tier: 'workspace',
          balanceMicroUsd: 1_000_000,
          autoTopupScheduled: false,
          billingUrl: 'https://app.duet.so/settings/billing',
        },
      },
      subscription_required: {
        status: 402,
        body: {
          error: 'subscription_required',
          code: 'subscription_required',
          billingUrl: 'https://app.duet.so/settings/billing',
        },
      },
      subscription_inactive: {
        status: 402,
        body: {
          error: 'subscription_inactive',
          code: 'subscription_inactive',
          billingUrl: 'https://app.duet.so/settings/billing',
        },
      },
      payment_required: {
        status: 402,
        body: {
          error: 'payment_required',
          code: 'payment_required',
          billingUrl: 'https://app.duet.so/settings/billing',
        },
      },
    } as const satisfies Record<BillingBlock['body']['code'], BillingBlock>

    const cases: Array<{ response: Response; code: string }> = []
    for (const [code, block] of Object.entries(billingBlocks)) {
      const app = createModelGatewayApp({
        aiGatewayApiKey: PLATFORM_KEY,
        upstreamBaseUrl: UPSTREAM,
        preflight: async () => ({ proceed: false as const, block }),
      })
      cases.push({
        response: await app.request('/v1/responses', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${CALLER_KEY}`,
            'content-type': 'application/json',
            'x-duet-tier': 'balanced',
          },
          body: JSON.stringify({ model: APPROVED_CHAT_MODEL, input: 'blocked' }),
        }),
        code,
      })
    }

    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      preflight: async () => ({
        proceed: false,
        block: {
          status: 402,
          body: {
            error: 'insufficient_credits',
            code: 'insufficient_credits',
            tier: 'account',
            balanceMicroUsd: 0,
            autoTopupScheduled: false,
            billingUrl: 'https://app.duet.so/settings/billing',
          },
        },
      }),
    })

    cases.push(
      {
        response: await app.request('/v1/models'),
        code: 'missing_api_key',
      },
      {
        response: await app.request('/v1/credits', {
          headers: { authorization: `Bearer ${CALLER_KEY}` },
        }),
        code: 'endpoint_not_available',
      },
    )

    for (const { response, code } of cases) {
      expect(response.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
      expect(response.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe(code)
    }
  })

  test('preserves query strings verbatim when forwarding', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/models?limit=5&cursor=a%2Fb&repeat=1&repeat=2', {
      headers: { authorization: `Bearer ${CALLER_KEY}` },
    })

    expect(response.status).toBe(200)
    expect(fake.requests[0]?.url.pathname).toBe('/v1/models')
    expect(fake.requests[0]?.url.search).toBe('?limit=5&cursor=a%2Fb&repeat=1&repeat=2')
  })

  test('streams SSE bytes unchanged without waiting for the stream to close', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const encoder = new TextEncoder()
    const firstChunk = 'data: {"id":"gen_fake_stream"}\n\n'
    const secondChunk = 'data: [DONE]\n\n'
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      preflight: ALLOW_PREFLIGHT,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c
              c.enqueue(encoder.encode(firstChunk))
            },
          }),
          {
            headers: {
              'content-type': 'text/event-stream',
              'content-encoding': 'gzip',
              'content-length': '999',
              'transfer-encoding': 'chunked',
            },
          },
        ),
    })

    const response = await Promise.race([
      app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CALLER_KEY}`,
          'ai-language-model-id': APPROVED_CHAT_MODEL,
          'x-duet-tier': 'balanced',
        },
        body: '{}',
      }),
      sleep(250).then(() => {
        throw new Error('gateway buffered the upstream stream')
      }),
    ])

    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('transfer-encoding')).toBeNull()

    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(firstChunk)
    controller!.enqueue(encoder.encode(secondChunk))
    controller!.close()
    const rest = await reader.read()
    expect(new TextDecoder().decode(rest.value)).toBe(secondChunk)
    expect(await reader.read()).toEqual({ done: true, value: undefined })
  })

  test.each(['/v1/credits', '/v1/generation'])(
    'refuses %s with the chat-app endpoint_not_available body',
    async path => {
      const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
      const app = createModelGatewayApp({
        aiGatewayApiKey: PLATFORM_KEY,
        upstreamBaseUrl: UPSTREAM,
        fetch: fake.fetch,
        preflight: ALLOW_PREFLIGHT,
      })

      const response = await app.request(path, {
        headers: { authorization: `Bearer ${CALLER_KEY}` },
      })

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error:
          'This endpoint is not available. To review your AI usage and credit balance, open the billing settings page in your Duet workspace.',
        code: 'endpoint_not_available',
      })
      expect(fake.requests).toHaveLength(0)
    },
  )

  test('strips caller hop/auth headers and sets platform gateway identity exactly', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'x-api-key': CALLER_KEY,
        connection: 'close',
        host: 'gateway.duet.so',
        'transfer-encoding': 'chunked',
        'content-type': 'application/json',
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model: APPROVED_CHAT_MODEL, messages: [] }),
    })

    expect(response.status).toBe(200)
    const upstreamHeaders = fake.requests[0]!.headers
    expect(upstreamHeaders.get('authorization')).toBe(`Bearer ${PLATFORM_KEY}`)
    expect(upstreamHeaders.get('http-referer')).toBe(VERCEL_AI_GATEWAY_REFERER)
    expect(upstreamHeaders.get('x-title')).toBe(VERCEL_AI_GATEWAY_TITLE)
    expect(upstreamHeaders.get('x-api-key')).toBeNull()
    expect(upstreamHeaders.get('connection')).toBeNull()
    expect(upstreamHeaders.get('host')).toBeNull()
    expect(upstreamHeaders.get('transfer-encoding')).toBeNull()
    expect(upstreamHeaders.get('x-duet-tier')).toBeNull()
    expect(upstreamHeaders.get('content-type')).toBe('application/json')
  })

  test('lists every valid upstream model without catalog or type filtering on /v1/models', async () => {
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: async () =>
        Response.json({
          object: 'list',
          upstream_page: 'fixture-page',
          data: [
            { id: 'vendor/new-chat', type: 'language', marker: 'keep-uncatalogued-chat' },
            { id: 'vendor/new-video', type: 'video', marker: 'keep-uncatalogued-media' },
            { id: 'vendor/untyped', marker: 'keep-untyped' },
            { id: 'vendor/future', type: 'future-operation', capability: { new: true } },
            null,
            { id: 3, type: 'image' },
            [],
            { id: 'test/image', type: 'image', marker: 'keep-priced-media' },
            {
              id: 'test/embedding',
              type: 'embedding',
              marker: 'keep-hidden',
              future_property: ['untouched'],
            },
          ],
        }),
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${CALLER_KEY}` },
    })

    expect(response.status).toBe(200)
    expect(await response.clone().json()).toEqual({
      object: 'list',
      upstream_page: 'fixture-page',
      data: [
        { id: 'vendor/new-chat', type: 'language', marker: 'keep-uncatalogued-chat' },
        { id: 'vendor/new-video', type: 'video', marker: 'keep-uncatalogued-media' },
        { id: 'vendor/untyped', marker: 'keep-untyped' },
        { id: 'vendor/future', type: 'future-operation', capability: { new: true } },
        { id: 'test/image', type: 'image', marker: 'keep-priced-media' },
        {
          id: 'test/embedding',
          type: 'embedding',
          marker: 'keep-hidden',
          future_property: ['untouched'],
        },
      ],
    })
    expect(
      await fetchModelCatalog('https://gateway.test', CALLER_KEY, async () => response.clone()),
    ).toEqual(
      new Map([
        ['vendor/new-chat', 'language'],
        ['vendor/new-video', 'video'],
        ['test/image', 'image'],
        ['test/embedding', 'embedding'],
      ]),
    )
  })

  test('fails closed when a successful upstream model list is malformed', async () => {
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: async () => Response.json({ data: { leaked: 'unfiltered-upstream-data' } }),
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${CALLER_KEY}` },
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'The upstream model catalog returned an invalid response.',
      code: 'invalid_upstream_response',
    })
  })

  test('passes an upstream /v1/models failure through unchanged', async () => {
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: async () =>
        Response.json(
          { error: 'upstream-catalog-failure', detail: { retry: true } },
          { status: 500, headers: { 'x-upstream-marker': 'preserved' } },
        ),
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${CALLER_KEY}` },
    })

    expect(response.status).toBe(500)
    expect(response.headers.get('x-upstream-marker')).toBe('preserved')
    expect(response.headers.get(X_DUET_GATEWAY_HEADER)).toBeNull()
    expect(response.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBeNull()
    expect(await response.json()).toEqual({
      error: 'upstream-catalog-failure',
      detail: { retry: true },
    })
  })

  test('passes OpenAI /v1/chat/completions through', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model: APPROVED_CHAT_MODEL }),
    })

    expect(response.status).toBe(200)
    expect(fake.requests[0]?.url.pathname).toBe('/v1/chat/completions')
  })

  test('passes /v4/ai requests through', async () => {
    const fake = createFakeVag({ aiGatewayApiKey: PLATFORM_KEY })
    const app = createModelGatewayApp({
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: fake.fetch,
      preflight: ALLOW_PREFLIGHT,
    })

    const response = await app.request('/v4/ai/language-model', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'ai-language-model-id': APPROVED_CHAT_MODEL,
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model: APPROVED_CHAT_MODEL }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(fake.requests[0]?.url.pathname).toBe('/v4/ai/language-model')
  })
})

describe('model gateway text billing loop', () => {
  const fundedTotalCost = 0.004321
  const fundedInputTokens = 137
  const fundedOutputTokens = 59
  // What the customer pays for those tokens under the tier they asked for —
  // derived from the same rate card the gateway bills from, never hardcoded.
  const fundedBilledMicroUsd = priceTierUsageMicroUsd('balanced', {
    uncachedInputTokens: fundedInputTokens,
    cachedInputTokens: 0,
    outputTokens: fundedOutputTokens,
  })
  const missingIdTotalCost = 0.001234
  const fake = createFakeVag({
    aiGatewayApiKey: PLATFORM_KEY,
    scenarios: [
      {
        method: 'GET',
        path: '/v1/models',
        json: {
          object: 'list',
          data: [{ id: APPROVED_CHAT_MODEL, type: 'language', object: 'model' }],
        },
      },
      {
        method: 'POST',
        path: '/v1/messages',
        totalCost: fundedTotalCost,
        inputTokens: fundedInputTokens,
        outputTokens: fundedOutputTokens,
        sseChunkDelayMs: 75,
        sseChunks: generationId => [
          'event: message_start\n',
          `data: ${JSON.stringify({ type: 'message_start', message: { id: generationId } })}\n\n`,
        ],
      },
      {
        method: 'POST',
        path: '/v1/chat/completions',
        totalCost: missingIdTotalCost,
        sseChunks: ['data: {"type":"done"}\n\n'],
      },
      {
        method: 'POST',
        path: '/v1/responses',
        totalCost: 0,
      },
    ],
  })
  const waitUntil = createWaitUntilCollector()
  let served: { url: string; stop: () => void }
  let convex: ConvexDevFixture
  let owner: SignedInUser

  beforeAll(async () => {
    served = serveFakeVag(fake)
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        AI_GATEWAY_API_KEY: PLATFORM_KEY,
        AI_GATEWAY_BASE_URL: served.url,
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
        DUET_USAGE_ROLLUP_MAX_JITTER_MS: '0',
      },
      reset: true,
    })
    owner = await signInWithMagicLink(
      convex,
      uniqueEmail('modelgw-app-owner'),
      'Model Gateway App Owner',
    )
  }, 240_000)

  afterAll(async () => {
    served?.stop()
    await convex?.stop()
  })

  test('one human credential targets catalog, chat, embeddings and media without leaking its workspace', async () => {
    const first = await createWorkspace(convex, owner, uniqueSlug('human-wire-first'))
    const second = await createWorkspace(convex, owner, uniqueSlug('human-wire-second'))
    const firstWorkspace = await workspaceById(owner.client, first)
    const secondWorkspace = await workspaceById(owner.client, second)
    const issued = await issueAiKey(owner.client, firstWorkspace.slug)
    const capture = createFakeVag({
      aiGatewayApiKey: PLATFORM_KEY,
      scenarios: [
        { path: '/v1/models', json: { data: [{ id: APPROVED_CHAT_MODEL, type: 'language' }] } },
        { path: '/v1/messages', json: {} },
        { path: '/v1/embeddings', json: {} },
        { path: '/v4/ai/image', json: {} },
      ],
    })
    const pending = createWaitUntilCollector()
    const app = createModelGatewayApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      fetch: capture.fetch,
      waitUntil: pending.waitUntil,
    })
    const startBalance = await balance(convex, first)
    const vmKey = (await mutate(convex, 'domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: first,
      now: Date.now(),
    })) as { key: string }
    const conflicting = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${vmKey.key}`, 'x-duet-workspace': secondWorkspace.slug },
    })
    expect(conflicting.status).toBe(403)
    expect(await conflicting.json()).toMatchObject({ code: 'workspace_mismatch' })
    for (const workspaceSlug of [undefined, 'not-a-member']) {
      const headers = new Headers({ authorization: `Bearer ${issued.key}` })
      if (workspaceSlug !== undefined) headers.set('x-duet-workspace', workspaceSlug)
      const refused = await app.request('/v1/models', { headers })
      expect(refused.status).toBe(403)
    }
    expect(capture.requests).toEqual([])
    expect(await listGenerations(convex, first)).toEqual([])
    expect(await listGenerations(convex, second)).toEqual([])
    for (const [path, model, workspaceSlug] of [
      ['/v1/models', undefined, firstWorkspace.slug],
      ['/v1/messages', APPROVED_CHAT_MODEL, firstWorkspace.slug],
      ['/v1/embeddings', APPROVED_EMBEDDING_MODEL, secondWorkspace.slug],
      ['/v4/ai/image', APPROVED_IMAGE_MODEL, secondWorkspace.slug],
    ] as const) {
      const response = await app.request(path, {
        method: model === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${issued.key}`,
          'x-duet-workspace': workspaceSlug,
          'content-type': 'application/json',
        },
        ...(model === undefined
          ? {}
          : { body: JSON.stringify({ model, messages: [], input: ['hello'] }) }),
      })
      expect(response.status).toBe(200)
      await response.text()
      await pending.drain()
      expect(capture.requests.at(-1)?.headers.get('x-duet-workspace')).toBeNull()
      expect(capture.requests.at(-1)?.headers.get('authorization')).toBe(`Bearer ${PLATFORM_KEY}`)
    }
    expect(
      (await listGenerations(convex, first)).map(row => ({
        workspaceId: row.workspaceId,
        status: row.status,
      })),
    ).toEqual([{ workspaceId: first, status: 'released' }])
    expect(
      (await listGenerations(convex, second)).map(row => ({
        workspaceId: row.workspaceId,
        status: row.status,
      })),
    ).toEqual([
      { workspaceId: second, status: 'released' },
      { workspaceId: second, status: 'released' },
    ])
    expect(await balance(convex, first)).toBe(startBalance)
    expect((await listTransactions(convex, first)).some(row => row.type === 'usage')).toBe(false)
    expect((await listTransactions(convex, second)).some(row => row.type === 'usage')).toBe(false)
    capture.assertNoPendingScenarios()
  }, 60_000)

  test('passes embeddings through after auth and preflight, then releases the unbillable generation', async () => {
    const app = createModelGatewayApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: served.url,
      fetch: fake.fetch,
      waitUntil: waitUntil.waitUntil,
    })

    const unauthenticated = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: APPROVED_EMBEDDING_MODEL, input: ['hello'] }),
    })
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toEqual({
      error: 'unauthorized',
      code: 'missing_api_key',
    })

    const emptyWorkspaceId = await createWorkspace(
      convex,
      owner,
      uniqueSlug('modelgw-embed-empty'),
      0,
    )
    await drainWorkspace(convex, emptyWorkspaceId)
    const emptyWorkspace = await workspaceById(owner.client, emptyWorkspaceId)
    const emptyKey = await issueAiKey(owner.client, emptyWorkspace.slug)
    const requestsBeforeBlock = fake.requests.length
    const blocked = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${emptyKey.key}`,
        'x-duet-workspace': workspaceForKey.get(emptyKey.key)!,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: APPROVED_EMBEDDING_MODEL, input: ['blocked'] }),
    })
    expect(blocked.status).toBe(402)
    expect(await blocked.json()).toEqual({
      error: 'insufficient_credits',
      code: 'insufficient_credits',
      tier: 'account',
      balanceMicroUsd: 0,
      autoTopupScheduled: false,
      billingUrl: 'http://localhost:3000/settings/billing',
    })
    expect(fake.requests).toHaveLength(requestsBeforeBlock)

    const fundedWorkspaceId = await createWorkspace(
      convex,
      owner,
      uniqueSlug('modelgw-embed-funded'),
    )
    const fundedWorkspace = await workspaceById(owner.client, fundedWorkspaceId)
    const fundedKey = await issueAiKey(owner.client, fundedWorkspace.slug)
    const fundedStartBalance = await balance(convex, fundedWorkspaceId)
    const requestBody = JSON.stringify({
      model: APPROVED_EMBEDDING_MODEL,
      input: ['byte identical'],
    })
    const expectedBody = JSON.stringify({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      model: APPROVED_EMBEDDING_MODEL,
    })

    const forwardedBefore = fake.requests.length
    const forwarded = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fundedKey.key}`,
        'x-duet-workspace': workspaceForKey.get(fundedKey.key)!,
        'content-type': 'application/json',
      },
      body: requestBody,
    })

    expect(forwarded.status).toBe(200)
    expect(await forwarded.text()).toBe(expectedBody)
    expect(fake.requests).toHaveLength(forwardedBefore + 1)
    expect(fake.requests.at(-1)?.url.pathname).toBe('/v1/embeddings')
    expect(fake.requests.at(-1)?.body).toBe(requestBody)
    expect(fake.generationIds).toHaveLength(0)
    await waitUntil.drain()
    const generation = await onlyGeneration(convex, fundedWorkspaceId)
    expect(generation).toMatchObject({
      status: 'released',
      billingMode: 'post_response',
    })
    expect(generation.upstreamGenerationId).toBeUndefined()
    expect(await balance(convex, fundedWorkspaceId)).toBe(fundedStartBalance)
    expect(
      (await listTransactions(convex, fundedWorkspaceId)).some(row => row.type === 'usage'),
    ).toBe(false)
  }, 60_000)

  test('preflights, captures delayed generation ids, reconciles usage, and releases unbillable calls', async () => {
    const app = createModelGatewayApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: served.url,
      fetch: fake.fetch,
      waitUntil: waitUntil.waitUntil,
    })

    const emptyWorkspaceId = await createWorkspace(convex, owner, uniqueSlug('modelgw-empty'), 0)
    await drainWorkspace(convex, emptyWorkspaceId)
    const emptyWorkspace = await workspaceById(owner.client, emptyWorkspaceId)
    const emptyKey = await issueAiKey(owner.client, emptyWorkspace.slug)
    const requestsBeforeBlock = fake.requests.length
    const blocked = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${emptyKey.key}`,
        'x-duet-workspace': workspaceForKey.get(emptyKey.key)!,
        'content-type': 'application/json',
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model: APPROVED_CHAT_MODEL }),
    })
    expect(blocked.status).toBe(402)
    expect(await blocked.json()).toEqual({
      error: 'insufficient_credits',
      code: 'insufficient_credits',
      tier: 'account',
      balanceMicroUsd: 0,
      autoTopupScheduled: false,
      billingUrl: 'http://localhost:3000/settings/billing',
    })
    expect(fake.requests).toHaveLength(requestsBeforeBlock)

    const fundedWorkspaceId = await createWorkspace(convex, owner, uniqueSlug('modelgw-funded'))
    const fundedWorkspace = await workspaceById(owner.client, fundedWorkspaceId)
    const fundedKey = await issueAiKey(owner.client, fundedWorkspace.slug)
    const fundedStartBalance = await balance(convex, fundedWorkspaceId)

    const preflightStarted = performance.now()
    const streamed = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': fundedKey.key,
        'x-duet-workspace': workspaceForKey.get(fundedKey.key)!,
        'content-type': 'application/json',
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model: APPROVED_CHAT_MODEL, messages: [] }),
    })
    const preflightLatencyMs = Math.round(performance.now() - preflightStarted)
    console.info(`model-gateway funded preflight latency: ${preflightLatencyMs}ms`)

    expect(streamed.status).toBe(200)
    expect(streamed.headers.get('content-type')).toContain('text/event-stream')
    const forwardingGeneration = await onlyGeneration(convex, fundedWorkspaceId)
    const fundedGenerationId = requiredString(forwardingGeneration, '_id')
    expect(forwardingGeneration).toMatchObject({
      status: 'forwarding',
      tier: 'balanced',
    })

    const streamedText = await streamed.text()
    expect(streamedText).toContain('message_start')
    await waitUntil.drain()
    const reconcilingGeneration = await getGeneration(convex, fundedGenerationId)
    expect(reconcilingGeneration).toMatchObject({
      status: 'reconciling',
      upstreamGenerationId: fake.generationIds[0],
    })

    const settledGeneration = await eventually(
      () => getGeneration(convex, fundedGenerationId),
      generation => generation.status === 'settled',
      25_000,
    )
    expect(settledGeneration).toMatchObject({
      status: 'settled',
      upstreamGenerationId: fake.generationIds[0],
      // This call is TIERED, so the two costs deliberately differ: upstream is
      // what the provider charged us, billed is what the tier's own rate card
      // charges the customer for the same tokens. Asserting one number for both
      // is what a virtual tier exists to break.
      upstreamCostMicroUsd: dollarsToMicroUsd(fundedTotalCost),
      billedCostMicroUsd: fundedBilledMicroUsd,
      // The NORMALIZED shape the reconciler stores (`services/aiGateway.ts`),
      // not the raw generation record. `total_cost` lands in
      // `upstreamCostMicroUsd`; the token counts land under `usage`.
      upstreamMetadata: {
        usage: {
          uncachedInputTokens: fundedInputTokens,
          cachedInputTokens: 0,
          outputTokens: fundedOutputTokens,
        },
      },
    })
    const usage = (await listTransactions(convex, fundedWorkspaceId)).find(
      row => row.reference === `ai_generation:${fake.generationIds[0]}`,
    )
    // The wallet is debited the TIER price, not what the provider charged us.
    // Asserting the upstream cost here would pass only if tiered traffic billed
    // at cost, which is the one thing virtual tiers exist to change.
    expect(usage).toMatchObject({
      amountMicroUsd: -fundedBilledMicroUsd,
      type: 'usage',
      userId: owner.user._id,
    })
    expect(await balance(convex, fundedWorkspaceId)).toBe(fundedStartBalance - fundedBilledMicroUsd)
    const monthlyUsage = await eventually(
      () => monthlyWorkspaceUsage(convex, fundedWorkspaceId),
      rows => rows.some(row => row.inputTokens === fundedInputTokens),
      10_000,
    )
    expect(monthlyUsage).toContainEqual(
      expect.objectContaining({
        // Spend is what the workspace was charged — the tier price, matching
        // the wallet debit above. Tokens are the raw telemetry either way.
        spendMicroUsd: fundedBilledMicroUsd,
        inputTokens: fundedInputTokens,
        outputTokens: fundedOutputTokens,
      }),
    )
    await expectLedgerBalanceReconciles(convex, fundedWorkspaceId)

    const missingWorkspaceId = await createWorkspace(convex, owner, uniqueSlug('modelgw-missing'))
    const missingWorkspace = await workspaceById(owner.client, missingWorkspaceId)
    const missingKey = await issueAiKey(owner.client, missingWorkspace.slug)
    const missingStartBalance = await balance(convex, missingWorkspaceId)
    const missing = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${missingKey.key}`,
        'x-duet-workspace': workspaceForKey.get(missingKey.key)!,
        'content-type': 'application/json',
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model: APPROVED_CHAT_MODEL }),
    })
    expect(missing.status).toBe(200)
    await missing.text()
    await waitUntil.drain()
    const missingGeneration = await onlyGeneration(convex, missingWorkspaceId)
    expect(missingGeneration).toMatchObject({
      status: 'released',
      billingMode: 'post_response',
    })
    expect(missingGeneration.upstreamGenerationId).toBeUndefined()
    expect(await balance(convex, missingWorkspaceId)).toBe(missingStartBalance)
    expect(
      (await listTransactions(convex, missingWorkspaceId)).some(row => row.type === 'usage'),
    ).toBe(false)
    expect(fake.generationPolls.has(fake.generationIds[1]!)).toBe(false)

    const zeroWorkspaceId = await createWorkspace(convex, owner, uniqueSlug('modelgw-zero-text'))
    const zeroWorkspace = await workspaceById(owner.client, zeroWorkspaceId)
    const zeroKey = await issueAiKey(owner.client, zeroWorkspace.slug)
    const zeroStartBalance = await balance(convex, zeroWorkspaceId)
    const zero = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${zeroKey.key}`,
        'x-duet-workspace': workspaceForKey.get(zeroKey.key)!,
        'content-type': 'application/json',
        'x-duet-tier': 'balanced',
      },
      body: JSON.stringify({ model: APPROVED_CHAT_MODEL }),
    })
    expect(zero.status).toBe(200)
    await zero.text()
    await waitUntil.drain()
    const zeroGeneration = await eventually(
      () => onlyGeneration(convex, zeroWorkspaceId),
      generation => generation.status === 'settled',
      25_000,
    )
    expect(zeroGeneration).toMatchObject({
      status: 'settled',
      billingMode: 'post_response',
      upstreamGenerationId: fake.generationIds[2],
      billedCostMicroUsd: 0,
    })
    expect(await balance(convex, zeroWorkspaceId)).toBe(zeroStartBalance)

    const catalogWorkspaceId = await createWorkspace(convex, owner, uniqueSlug('modelgw-catalog'))
    const catalogWorkspace = await workspaceById(owner.client, catalogWorkspaceId)
    const catalogKey = await issueAiKey(owner.client, catalogWorkspace.slug)
    const catalog = await app.request('/v1/models', {
      headers: {
        authorization: `Bearer ${catalogKey.key}`,
        'x-duet-workspace': workspaceForKey.get(catalogKey.key)!,
      },
    })
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toEqual({
      object: 'list',
      data: [{ id: APPROVED_CHAT_MODEL, type: 'language', object: 'model' }],
    })
    expect(await listGenerations(convex, catalogWorkspaceId)).toEqual([])
    fake.assertNoPendingScenarios()
  }, 120_000) // widened: the full billing loop's round trips stretch past 40s under whole-repo gate load
})

describe('model gateway media reservation loop', () => {
  const aboveEstimateCost = 2.75
  const aboveEstimateInputTokens = 41
  const aboveEstimateOutputTokens = 17
  const belowEstimateCost = 0.25
  const fake = createFakeVag({
    aiGatewayApiKey: PLATFORM_KEY,
    scenarios: [
      {
        method: 'POST',
        path: '/v4/ai/image',
        totalCost: aboveEstimateCost,
        inputTokens: aboveEstimateInputTokens,
        outputTokens: aboveEstimateOutputTokens,
        sseChunkDelayMs: 100,
        sseChunks: generationId => [`data: ${JSON.stringify({ generationId, type: 'image' })}\n\n`],
      },
      {
        method: 'POST',
        path: '/v4/ai/video',
        totalCost: belowEstimateCost,
      },
      {
        method: 'POST',
        path: '/v4/ai/image',
        totalCost: 0,
      },
      {
        method: 'POST',
        path: '/v4/ai/image',
        status: 503,
        json: { error: 'provider_unavailable', code: 'provider_unavailable' },
      },
      {
        method: 'POST',
        path: '/v4/ai/image',
        json: { ok: true },
      },
    ],
  })
  const waitUntil = createWaitUntilCollector()
  let served: { url: string; stop: () => void }
  let convex: ConvexDevFixture
  let owner: SignedInUser

  beforeAll(async () => {
    served = serveFakeVag(fake)
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        AI_GATEWAY_API_KEY: PLATFORM_KEY,
        AI_GATEWAY_BASE_URL: served.url,
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
        DUET_USAGE_ROLLUP_MAX_JITTER_MS: '0',
      },
      reset: true,
    })
    owner = await signInWithMagicLink(
      convex,
      uniqueEmail('modelgw-media-owner'),
      'Model Gateway Media Owner',
    )
  }, 240_000)

  afterAll(async () => {
    served?.stop()
    await convex?.stop()
  })

  test('blocks media reservations below the estimate plus hard floor and at the monthly cap', async () => {
    const app = mediaApp(convex, served, fake, waitUntil)

    const lowWorkspaceId = await createWorkspace(
      convex,
      owner,
      uniqueSlug('modelgw-media-low'),
      DEFAULT_RESERVATION_ESTIMATE_MICRO_USD + dollarsToMicroUsd(1) - 1,
    )
    const lowWorkspace = await workspaceById(owner.client, lowWorkspaceId)
    const lowKey = await issueAiKey(owner.client, lowWorkspace.slug)
    const requestsBeforeLowBlock = fake.requests.length
    const low = await mediaRequest(app, lowKey.key, '/v4/ai/image', APPROVED_IMAGE_MODEL)
    expect(low.status).toBe(402)
    expect(await low.json()).toEqual({
      error: 'insufficient_credits',
      code: 'insufficient_credits',
      tier: 'account',
      balanceMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD + dollarsToMicroUsd(1) - 1,
      autoTopupScheduled: false,
      billingUrl: 'http://localhost:3000/settings/billing',
    })
    expect(fake.requests).toHaveLength(requestsBeforeLowBlock)

    const cappedWorkspaceId = await createWorkspace(convex, owner, uniqueSlug('modelgw-media-cap'))
    await mutate(convex, 'domains/credits/internal:setMonthlyCap', {
      internalKey: INTERNAL_KEY,
      workspaceId: cappedWorkspaceId,
      maxMonthlySpendMicroUsd: dollarsToMicroUsd(1),
    })
    const cappedWorkspace = await workspaceById(owner.client, cappedWorkspaceId)
    const cappedKey = await issueAiKey(owner.client, cappedWorkspace.slug)
    const requestsBeforeCapBlock = fake.requests.length
    const capped = await mediaRequest(app, cappedKey.key, '/v4/ai/image', APPROVED_IMAGE_MODEL)
    expect(capped.status).toBe(402)
    expect(await capped.json()).toMatchObject({
      error: 'monthly_cap',
      code: 'monthly_cap',
      tier: 'workspace',
      balanceMicroUsd: dollarsToMicroUsd(10),
      autoTopupScheduled: false,
      billingUrl: 'http://localhost:3000/settings/billing',
    })
    expect(fake.requests).toHaveLength(requestsBeforeCapBlock)
  }, 60_000)

  test('holds media reservations and settles true-up above and below the estimate', async () => {
    const app = mediaApp(convex, served, fake, waitUntil)

    const aboveWorkspaceId = await createWorkspace(convex, owner, uniqueSlug('modelgw-media-above'))
    const aboveWorkspace = await workspaceById(owner.client, aboveWorkspaceId)
    const aboveKey = await issueAiKey(owner.client, aboveWorkspace.slug)
    const aboveStart = await balance(convex, aboveWorkspaceId)
    const above = await mediaRequest(app, aboveKey.key, '/v4/ai/image', APPROVED_IMAGE_MODEL)
    expect(above.status).toBe(200)
    const heldGeneration = await onlyGeneration(convex, aboveWorkspaceId)
    expect(heldGeneration).toMatchObject({
      status: 'forwarding',
      billingMode: 'reservation',
      modality: 'image',
      model: APPROVED_IMAGE_MODEL,
    })
    const heldReservation = reservationProjection(
      await listTransactions(convex, aboveWorkspaceId),
      requiredString(heldGeneration, 'reservationId'),
    )
    expect(heldReservation).toMatchObject({
      amountMicroUsd: -DEFAULT_RESERVATION_ESTIMATE_MICRO_USD,
      type: 'reservation',
      metadata: {
        status: 'held',
        event: 'hold',
        estimateMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD,
      },
    })
    expect(await balance(convex, aboveWorkspaceId)).toBe(
      aboveStart - DEFAULT_RESERVATION_ESTIMATE_MICRO_USD,
    )

    await above.text()
    await waitUntil.drain()
    const aboveSettled = await eventually(
      () => getGeneration(convex, requiredString(heldGeneration, '_id')),
      generation => generation.status === 'settled',
      25_000,
    )
    expect(aboveSettled).toMatchObject({
      status: 'settled',
      upstreamGenerationId: fake.generationIds[0],
      billedCostMicroUsd: dollarsToMicroUsd(aboveEstimateCost),
      upstreamMetadata: {
        usage: {
          uncachedInputTokens: aboveEstimateInputTokens,
          cachedInputTokens: 0,
          outputTokens: aboveEstimateOutputTokens,
        },
      },
    })
    const aboveSettledReservation = reservationProjection(
      await listTransactions(convex, aboveWorkspaceId),
      requiredString(aboveSettled, 'reservationId'),
    )
    expect(aboveSettledReservation).toMatchObject({
      amountMicroUsd: -dollarsToMicroUsd(aboveEstimateCost),
      metadata: {
        status: 'settled',
        estimateMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD,
        actualCostMicroUsd: dollarsToMicroUsd(aboveEstimateCost),
      },
    })
    expect(await balance(convex, aboveWorkspaceId)).toBe(
      aboveStart - dollarsToMicroUsd(aboveEstimateCost),
    )
    const aboveMonthlyUsage = await eventually(
      () => monthlyWorkspaceUsage(convex, aboveWorkspaceId),
      rows => rows.some(row => row.inputTokens === aboveEstimateInputTokens),
      10_000,
    )
    expect(aboveMonthlyUsage).toContainEqual(
      expect.objectContaining({
        spendMicroUsd: dollarsToMicroUsd(aboveEstimateCost),
        inputTokens: aboveEstimateInputTokens,
        outputTokens: aboveEstimateOutputTokens,
      }),
    )
    await expectLedgerBalanceReconciles(convex, aboveWorkspaceId)

    const belowWorkspaceId = await createWorkspace(convex, owner, uniqueSlug('modelgw-media-below'))
    const belowWorkspace = await workspaceById(owner.client, belowWorkspaceId)
    const belowKey = await issueAiKey(owner.client, belowWorkspace.slug)
    const belowStart = await balance(convex, belowWorkspaceId)
    const below = await mediaRequest(app, belowKey.key, '/v4/ai/video', APPROVED_VIDEO_MODEL)
    expect(below.status).toBe(200)
    await below.text()
    await waitUntil.drain()
    const belowGeneration = await eventually(
      () => onlyGeneration(convex, belowWorkspaceId),
      generation => generation.status === 'settled',
      25_000,
    )
    expect(belowGeneration).toMatchObject({
      status: 'settled',
      billingMode: 'reservation',
      modality: 'video',
      billedCostMicroUsd: dollarsToMicroUsd(belowEstimateCost),
    })
    expect(await balance(convex, belowWorkspaceId)).toBe(
      belowStart - dollarsToMicroUsd(belowEstimateCost),
    )
    await expectLedgerBalanceReconciles(convex, belowWorkspaceId)
  }, 60_000)

  test('releases reservations for zero cost, upstream failures, and missing generation ids', async () => {
    const app = mediaApp(convex, served, fake, waitUntil)

    const zeroWorkspaceId = await createWorkspace(convex, owner, uniqueSlug('modelgw-media-zero'))
    const zeroWorkspace = await workspaceById(owner.client, zeroWorkspaceId)
    const zeroKey = await issueAiKey(owner.client, zeroWorkspace.slug)
    const zeroStart = await balance(convex, zeroWorkspaceId)
    const zero = await mediaRequest(app, zeroKey.key, '/v4/ai/image', APPROVED_IMAGE_MODEL)
    expect(zero.status).toBe(200)
    await zero.text()
    await waitUntil.drain()
    const zeroGeneration = await eventually(
      () => onlyGeneration(convex, zeroWorkspaceId),
      generation => generation.status === 'released',
      25_000,
    )
    expect(zeroGeneration).toMatchObject({ status: 'released', billingMode: 'reservation' })
    expect(await balance(convex, zeroWorkspaceId)).toBe(zeroStart)
    expect(
      reservationProjection(
        await listTransactions(convex, zeroWorkspaceId),
        requiredString(zeroGeneration, 'reservationId'),
      ),
    ).toMatchObject({
      amountMicroUsd: 0,
      metadata: { status: 'released', releaseReason: 'zero_cost' },
    })

    const failedWorkspaceId = await createWorkspace(
      convex,
      owner,
      uniqueSlug('modelgw-media-failed'),
    )
    const failedWorkspace = await workspaceById(owner.client, failedWorkspaceId)
    const failedKey = await issueAiKey(owner.client, failedWorkspace.slug)
    const failedStart = await balance(convex, failedWorkspaceId)
    const failed = await mediaRequest(app, failedKey.key, '/v4/ai/image', APPROVED_IMAGE_MODEL)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({
      error: 'provider_unavailable',
      code: 'provider_unavailable',
    })
    await waitUntil.drain()
    const failedGeneration = await onlyGeneration(convex, failedWorkspaceId)
    expect(failedGeneration).toMatchObject({ status: 'released', billingMode: 'reservation' })
    expect(await balance(convex, failedWorkspaceId)).toBe(failedStart)
    expect(
      reservationProjection(
        await listTransactions(convex, failedWorkspaceId),
        requiredString(failedGeneration, 'reservationId'),
      ),
    ).toMatchObject({
      amountMicroUsd: 0,
      metadata: { status: 'released', releaseReason: 'upstream_failed' },
    })

    const missingWorkspaceId = await createWorkspace(
      convex,
      owner,
      uniqueSlug('modelgw-media-missing'),
    )
    const missingWorkspace = await workspaceById(owner.client, missingWorkspaceId)
    const missingKey = await issueAiKey(owner.client, missingWorkspace.slug)
    const missingStart = await balance(convex, missingWorkspaceId)
    const missing = await mediaRequest(app, missingKey.key, '/v4/ai/image', APPROVED_IMAGE_MODEL)
    expect(missing.status).toBe(200)
    expect(await missing.json()).toEqual({ ok: true })
    await waitUntil.drain()
    const missingGeneration = await onlyGeneration(convex, missingWorkspaceId)
    expect(missingGeneration).toMatchObject({ status: 'released', billingMode: 'reservation' })
    expect(await balance(convex, missingWorkspaceId)).toBe(missingStart)
    expect(
      reservationProjection(
        await listTransactions(convex, missingWorkspaceId),
        requiredString(missingGeneration, 'reservationId'),
      ),
    ).toMatchObject({
      amountMicroUsd: 0,
      metadata: { status: 'released', releaseReason: 'missing_generation_id' },
    })
    fake.assertNoPendingScenarios()
  }, 70_000)
})

describe('model gateway upstream billing error handling', () => {
  test('streams provider non-ok responses unchanged and releases the generation', async () => {
    const convex = createRecordingConvex()
    const waitUntil = createWaitUntilCollector()
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      convex,
      internalKey: INTERNAL_KEY,
      waitUntil: waitUntil.waitUntil,
      preflight: async () => ({ proceed: true, generationId: 'local_generation' }),
      fetch: async () =>
        Response.json(
          { error: 'provider_error', code: 'provider_error' },
          { status: 429, headers: { 'x-provider': 'fake' } },
        ),
    })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'ai-language-model-id': 'test/chat',
      },
      body: '{}',
    })

    expect(response.status).toBe(429)
    expect(response.headers.get('x-provider')).toBe('fake')
    expect(await response.json()).toEqual({ error: 'provider_error', code: 'provider_error' })
    await waitUntil.drain()
    expect(convex.calls).toEqual([
      {
        name: 'domains/modelGateway/model:releaseGeneration',
        args: {
          internalKey: INTERNAL_KEY,
          generationId: 'local_generation',
          reason: 'missing_upstream_generation_id',
          now: expect.any(Number),
        },
      },
    ])
  })

  test('records transport exceptions as upstream failures', async () => {
    const convex = createRecordingConvex()
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      convex,
      internalKey: INTERNAL_KEY,
      preflight: async () => ({ proceed: true, generationId: 'local_generation' }),
      fetch: async () => {
        throw new Error('socket closed')
      },
    })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'ai-language-model-id': 'test/chat',
      },
      body: '{}',
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'upstream_failed', code: 'upstream_failed' })
    expect(convex.calls).toEqual([
      {
        name: 'domains/modelGateway/model:recordUpstreamFailure',
        args: {
          internalKey: INTERNAL_KEY,
          generationId: 'local_generation',
          error: 'socket closed',
          now: expect.any(Number),
        },
      },
    ])
  })

  /* Preflight already cleared this caller to spend, so a 402 arriving from
     upstream is Duet's provider account, not the caller's balance. Forwarding
     the status verbatim makes the two indistinguishable, and the caller's own
     surfaces read a 402 as "you are out of credits" — they would tell a fully
     funded person to go top up while the real outage sat on Duet's side. The
     same argument covers 401: the caller's key was accepted here, so an
     upstream 401 is the platform key. */
  test.each([401, 402] as const)(
    "does not forward an upstream %i as the caller's own refusal",
    async status => {
      const convex = createRecordingConvex()
      const app = createModelGatewayApp({
        approvedModelCatalog: REQUEST_CATALOG,
        aiGatewayApiKey: PLATFORM_KEY,
        upstreamBaseUrl: UPSTREAM,
        convex,
        internalKey: INTERNAL_KEY,
        preflight: async () => ({ proceed: true, generationId: 'local_generation' }),
        fetch: async () =>
          Response.json({ error: { message: 'insufficient credits' } }, { status }),
      })

      const response = await app.request('/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CALLER_KEY}`,
          'ai-language-model-id': 'test/chat',
        },
        body: '{}',
      })

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'upstream_failed', code: 'upstream_failed' })
      // Nothing that could make a caller surface name a billing refusal.
      expect(response.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBeNull()
      // The generation preflight opened is settled as a failure rather than
      // left on the books as something that ran.
      expect(convex.calls).toEqual([
        {
          name: 'domains/modelGateway/model:recordUpstreamFailure',
          args: {
            internalKey: INTERNAL_KEY,
            generationId: 'local_generation',
            error: `upstream_${status}`,
            now: expect.any(Number),
          },
        },
      ])
    },
  )

  test('releases reservation generations on transport exceptions', async () => {
    const convex = createRecordingConvex()
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      convex,
      internalKey: INTERNAL_KEY,
      preflight: async () => ({
        proceed: true,
        generationId: 'local_generation',
        reservationId: 'ai_generation:local_generation',
      }),
      fetch: async () => {
        throw new Error('socket closed')
      },
    })

    const response = await app.request('/v4/ai/image', {
      method: 'POST',
      headers: { authorization: `Bearer ${CALLER_KEY}`, 'ai-model-id': 'test/image' },
      body: '{}',
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'upstream_failed', code: 'upstream_failed' })
    expect(convex.calls).toEqual([
      {
        name: 'domains/modelGateway/model:releaseGeneration',
        args: {
          internalKey: INTERNAL_KEY,
          generationId: 'local_generation',
          reason: 'upstream_failed',
          now: expect.any(Number),
        },
      },
    ])
  })

  test('releases reservation generations when reconcile scheduling fails', async () => {
    const convex = createRecordingConvex()
    const waitUntil = createWaitUntilCollector()
    convex.failMutation = 'domains/modelGateway/model:recordUpstreamGenerationId'
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      aiGatewayApiKey: PLATFORM_KEY,
      upstreamBaseUrl: UPSTREAM,
      convex,
      internalKey: INTERNAL_KEY,
      waitUntil: waitUntil.waitUntil,
      preflight: async () => ({
        proceed: true,
        generationId: 'local_generation',
        reservationId: 'ai_generation:local_generation',
      }),
      fetch: async () => Response.json({ generationId: 'gen_failed_schedule' }),
    })

    const response = await app.request('/v4/ai/image', {
      method: 'POST',
      headers: { authorization: `Bearer ${CALLER_KEY}`, 'ai-model-id': 'test/image' },
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ generationId: 'gen_failed_schedule' })
    await waitUntil.drain()
    expect(convex.calls).toEqual([
      {
        name: 'domains/modelGateway/model:recordUpstreamGenerationId',
        args: {
          internalKey: INTERNAL_KEY,
          generationId: 'local_generation',
          upstreamGenerationId: 'gen_failed_schedule',
          now: expect.any(Number),
        },
      },
      {
        name: 'domains/modelGateway/model:releaseGeneration',
        args: {
          internalKey: INTERNAL_KEY,
          generationId: 'local_generation',
          reason: 'reconcile_schedule_failed',
          now: expect.any(Number),
        },
      },
    ])
  })

  test('releases preflighted generations when the upstream key is missing', async () => {
    const convex = createRecordingConvex()
    const app = createModelGatewayApp({
      approvedModelCatalog: REQUEST_CATALOG,
      upstreamBaseUrl: UPSTREAM,
      convex,
      internalKey: INTERNAL_KEY,
      preflight: async () => ({ proceed: true, generationId: 'local_generation' }),
      fetch: async () => {
        throw new Error('fetch should not run without an upstream key')
      },
    })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'ai-language-model-id': 'test/chat',
      },
      body: '{}',
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'upstream_not_configured',
      code: 'upstream_not_configured',
    })
    expect(convex.calls).toEqual([
      {
        name: 'domains/modelGateway/model:releaseGeneration',
        args: {
          internalKey: INTERNAL_KEY,
          generationId: 'local_generation',
          reason: 'upstream_not_configured',
          now: expect.any(Number),
        },
      },
    ])
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function approvedModelFor(kind: 'image' | 'video' | 'embedding'): string {
  // Predicate over the catalog, never a named model: the entry must be
  // chargeable.
  const model = APPROVED_MODELS.entries.find(entry => entry.kind === kind && entry.isFree !== true)
  if (model === undefined) throw new Error(`Test requires an approved ${kind} model`)
  return model.gatewayModelId
}

function createWaitUntilCollector(): {
  waitUntil: (promise: Promise<unknown>) => void
  drain: () => Promise<void>
} {
  const promises: Promise<unknown>[] = []
  return {
    waitUntil(promise) {
      promises.push(promise)
    },
    async drain() {
      while (promises.length > 0) {
        await Promise.all(promises.splice(0))
      }
    },
  }
}

function createRecordingConvex(): ConvexMutationClient & {
  calls: Array<{ name: string; args: Record<string, unknown> }>
  failMutation?: string
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  return {
    calls,
    async mutation(ref, args) {
      const name = getFunctionName(ref)
      calls.push({ name, args })
      if (name === this.failMutation) throw new Error(`forced ${name} failure`)
      return null
    },
  }
}

function mediaApp(
  convex: ConvexDevFixture,
  served: { url: string },
  fake: ReturnType<typeof createFakeVag>,
  waitUntil: { waitUntil: (promise: Promise<unknown>) => void },
): ReturnType<typeof createModelGatewayApp> {
  return createModelGatewayApp({
    convexUrl: convex.url,
    internalKey: INTERNAL_KEY,
    aiGatewayApiKey: PLATFORM_KEY,
    upstreamBaseUrl: served.url,
    fetch: fake.fetch,
    waitUntil: waitUntil.waitUntil,
  })
}

async function mediaRequest(
  app: ReturnType<typeof createModelGatewayApp>,
  key: string,
  path: string,
  model: string,
): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'x-duet-workspace': workspaceForKey.get(key)!,
      'content-type': 'application/json',
      'ai-model-id': model,
    },
    body: '{}',
  })
}

async function createWorkspace(
  convex: ConvexDevFixture,
  owner: SignedInUser,
  slug: string,
  grantMicroUsd = dollarsToMicroUsd(10),
): Promise<string> {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug,
    name: `${slug} workspace`,
  })) as string
  const now = Date.now()
  const provisioningTokenHash = await hashApiKey(`provisioning-${workspaceId}`)
  await mutate(convex, 'testing/workspaces:prepareWorkspaceForRegistration', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    workspaceId,
    slug,
    name: `${slug} workspace`,
    imageRef: 'ttl.sh/duet-model-gateway-app-test:1h',
    provisioningTokenHash,
    provisioningTokenExpiresAt: now + 60_000,
    now,
  })
  await mutate(convex, 'domains/workspaces/provisioning:registerVm', {
    internalKey: INTERNAL_KEY,
    provisioningTokenHash,
    workspaceHint: workspaceId,
    now: now + 1,
  })
  const currentBalance = await balance(convex, workspaceId)
  if (currentBalance !== grantMicroUsd) {
    await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      amountMicroUsd: grantMicroUsd - currentBalance,
      type: 'adjustment',
      reference: `balance:${workspaceId}:model-gateway-app-test`,
    })
  }
  return workspaceId
}

async function issueAiKey(
  client: ConvexHttpClient,
  workspaceSlug: string,
): Promise<{ key: string }> {
  const actor = (await query(client, 'domains/users/queries:current', {})) as UserRow
  const issued = (await mutate(client, 'domains/apiKeys/userApi:issue', {
    internalKey: INTERNAL_KEY,
    actorId: actor._id,
    name: 'Model test key',
    now: Date.now(),
  })) as { key: string }
  workspaceForKey.set(issued.key, workspaceSlug)
  return issued
}

async function workspaceById(
  client: ConvexHttpClient,
  workspaceId: string,
): Promise<{ _id: string; slug: string }> {
  const rows = (await query(client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: { _id: string; slug: string }
  }>
  const workspace = rows.find(row => row.workspace._id === workspaceId)?.workspace
  if (workspace === undefined) throw new Error(`Workspace not found in test list: ${workspaceId}`)
  return workspace
}

async function balance(convex: ConvexDevFixture, workspaceId: string): Promise<number> {
  const decision = (await query(convex, 'testing/credits:walletForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as { balanceMicroUsd: number }
  return decision.balanceMicroUsd
}

async function drainWorkspace(convex: ConvexDevFixture, workspaceId: string): Promise<void> {
  const current = await balance(convex, workspaceId)
  if (current === 0) return
  await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    amountMicroUsd: -current,
    type: 'adjustment',
    reference: `drain:${workspaceId}:model-gateway-app-test`,
  })
}

async function getGeneration(
  convex: ConvexDevFixture,
  generationId: string,
): Promise<Record<string, unknown>> {
  return (await query(convex, 'domains/modelGateway/model:getGeneration', {
    internalKey: INTERNAL_KEY,
    generationId,
  })) as Record<string, unknown>
}

async function onlyGeneration(
  convex: ConvexDevFixture,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const generations = await listGenerations(convex, workspaceId)
  expect(generations).toHaveLength(1)
  return generations[0]!
}

async function listGenerations(
  convex: ConvexDevFixture,
  workspaceId: string,
): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'testing/modelGateway:listGenerationsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
}

async function listTransactions(
  convex: ConvexDevFixture,
  workspaceId: string,
): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'testing/credits:listWorkspaceTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
}

async function monthlyWorkspaceUsage(
  convex: ConvexDevFixture,
  workspaceId: string,
): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'domains/credits/internal:listUsageReport', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    period: 'monthly',
    group: 'workspace',
  })) as Array<Record<string, unknown>>
}

async function expectLedgerBalanceReconciles(
  convex: ConvexDevFixture,
  workspaceId: string,
): Promise<void> {
  const workspaceTransactions = await listTransactions(convex, workspaceId)
  const userId = workspaceTransactions[0]?.userId
  if (typeof userId !== 'string') throw new Error('Account ledger row is missing userId')
  const transactions = (await query(convex, 'testing/credits:listAccountTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    userId,
  })) as Array<Record<string, unknown>>
  const ledgerSum = transactions.reduce((sum, row) => sum + (row.amountMicroUsd as number), 0)
  expect(await balance(convex, workspaceId)).toBe(ledgerSum)
}

function reservationProjection(
  transactions: Array<Record<string, unknown>>,
  reservationId: string,
): Record<string, unknown> {
  const row = transactions.find(transaction => transaction.reference === reservationId)
  if (row === undefined) throw new Error(`Reservation row not found: ${reservationId}`)
  return row
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const started = Date.now()
  let value = await read()
  while (!done(value)) {
    if (Date.now() - started > timeoutMs) return value
    await sleep(250)
    value = await read()
  }
  return value
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') throw new Error(`Expected ${field} to be a string`)
  return value
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

interface UserRow {
  _id: string
  email: string
}
