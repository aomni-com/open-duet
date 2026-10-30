import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'

import { createApprovedModelCatalog } from '@repo/contract'

import { createModelGatewayApp, type ModelGatewayAppOptions } from './index'

const logs = spyOn(console, 'error').mockImplementation(() => {})
afterEach(() => logs.mockClear())
afterAll(() => logs.mockRestore())

function appWith(options: ModelGatewayAppOptions) {
  return createModelGatewayApp({
    aiGatewayApiKey: 'platform-secret',
    internalKey: 'backend-secret',
    preflight: async () => ({ proceed: true, generationId: 'generation-1' }),
    ...options,
  })
}

function request() {
  return new Request('https://gateway.test/v1/chat/completions?secret=query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer duet_sk_caller_secret',
      'content-type': 'application/json',
      'x-duet-tier': 'balanced',
    },
    body: JSON.stringify({
      model: 'vendor/model',
      messages: [{ role: 'user', content: 'private prompt' }],
    }),
  })
}

test('keeps the lost forwarding cause and backend correlation when recording fails, then recovers', async () => {
  let failing = true
  const app = appWith({
    fetch: async () => {
      if (failing)
        throw new TypeError('private upstream URL and provider output', {
          cause: Object.assign(new Error('private transport message'), { code: 'ECONNREFUSED' }),
        })
      return new Response('ok')
    },
    convex: {
      mutation: async () => {
        throw new Error('[Request ID: 0123456789abcdef] private backend details')
      },
    },
    waitUntil: promise => {
      void promise.catch(() => {})
    },
  })
  const response = await app.fetch(request())
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ error: 'upstream_failed', code: 'upstream_failed' })
  expect(logs.mock.calls).toEqual([
    [
      '[model-gateway] forwarding failure not recorded',
      {
        operation: 'forward_model_request',
        generationId: 'generation-1',
        forwardingCode: 'ECONNREFUSED',
        recordingRequestId: '0123456789abcdef',
      },
    ],
  ])
  failing = false
  expect(await (await app.fetch(request())).text()).toBe('ok')
  expect(logs.mock.calls).toHaveLength(1)
})

test('catalog transport failures have no durable generation owner', async () => {
  const app = appWith({
    preflight: async () => ({ proceed: true }),
    fetch: async () => {
      throw Object.assign(new Error('private timeout URL'), { code: 'ETIMEDOUT' })
    },
  })
  const response = await app.request('/v1/models', {
    headers: { authorization: 'Bearer duet_sk_caller_secret' },
  })
  expect(response.status).toBe(502)
  expect(logs.mock.calls).toEqual([
    [
      '[model-gateway] forwarding failure not recorded',
      {
        operation: 'forward_model_request',
        forwardingCode: 'ETIMEDOUT',
      },
    ],
  ])
})

test('successful persistence retains the original error without duplicating it in logs', async () => {
  const records: Record<string, unknown>[] = []
  const app = appWith({
    fetch: async () => {
      throw new Error('durably recorded failure')
    },
    convex: {
      mutation: async (_ref, args) => {
        records.push(args)
        return null
      },
    },
  })
  expect((await app.fetch(request())).status).toBe(502)
  expect(records).toEqual([
    {
      internalKey: 'backend-secret',
      generationId: 'generation-1',
      error: 'durably recorded failure',
      now: expect.any(Number),
    },
  ])
  expect(logs.mock.calls).toEqual([])
})

test.each([true, false])(
  'caller cancellation stays quiet with generation owner %s',
  async hasGeneration => {
    const app = appWith({
      preflight: async () =>
        hasGeneration ? { proceed: true, generationId: 'generation-1' } : { proceed: true },
      fetch: async () => {
        throw new DOMException('caller cancelled', 'AbortError')
      },
      convex: {
        mutation: async () => {
          throw new Error('recording unavailable')
        },
      },
    })
    expect((await app.fetch(request())).status).toBe(502)
    expect(logs.mock.calls).toEqual([])
  },
)

test('recording transport failure remains separate and arbitrary codes never enter diagnostics', async () => {
  const app = appWith({
    fetch: async () => {
      throw Object.assign(new Error('private provider body'), { code: 'secret-code' })
    },
    convex: {
      mutation: async () => {
        throw Object.assign(new Error('private backend URL'), { code: 'ECONNRESET' })
      },
    },
  })
  expect((await app.fetch(request())).status).toBe(502)
  expect(logs.mock.calls).toEqual([
    [
      '[model-gateway] forwarding failure not recorded',
      {
        operation: 'forward_model_request',
        generationId: 'generation-1',
        forwardingCode: 'unknown',
        recordingCode: 'ECONNRESET',
      },
    ],
  ])
})

test('a failed console sink does not change the forwarding response', async () => {
  logs.mockImplementationOnce(() => {
    throw new Error('sink unavailable')
  })
  const app = appWith({
    fetch: async () => {
      throw Object.assign(new Error('transport'), { code: 'ECONNREFUSED' })
    },
    convex: {
      mutation: async () => {
        throw new Error('recording unavailable')
      },
    },
  })
  expect((await app.fetch(request())).status).toBe(502)
})

test('catalog failure without a recognized cause adds no generic status-only diagnostic', async () => {
  const app = appWith({
    preflight: async () => ({ proceed: true }),
    fetch: async () => {
      throw new Error('arbitrary upstream text')
    },
  })
  expect(
    (
      await app.request('/v1/models', {
        headers: { authorization: 'Bearer duet_sk_caller_secret' },
      })
    ).status,
  ).toBe(502)
  expect(logs.mock.calls).toEqual([])
})

test.each([true, false])(
  'media release logs only if durable release fails: %s',
  async releaseFails => {
    const app = appWith({
      approvedModelCatalog: createApprovedModelCatalog([
        {
          id: 'fixture:image',
          gatewayModelId: 'fixture/image',
          kind: 'image',
          name: 'Fixture',
          simpleName: 'Fixture',
          description: 'Fixture',
          pricing: { perImage: 0.01 },
        },
      ]),
      fetch: async () => {
        throw Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })
      },
      convex: {
        mutation: async () => {
          if (releaseFails)
            throw Object.assign(new Error('backend offline'), { code: 'ECONNRESET' })
          return { released: true, balanceMicroUsd: 1 }
        },
      },
    })
    const response = await app.request('/v1/images/generations', {
      method: 'POST',
      headers: {
        authorization: 'Bearer duet_sk_caller_secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'fixture/image', prompt: 'private prompt' }),
    })
    expect(response.status).toBe(502)
    expect(logs.mock.calls).toEqual(
      releaseFails
        ? [
            [
              '[model-gateway] forwarding failure not recorded',
              {
                operation: 'forward_model_request',
                generationId: 'generation-1',
                forwardingCode: 'ETIMEDOUT',
                recordingCode: 'ECONNRESET',
              },
            ],
          ]
        : [],
    )
  },
)
