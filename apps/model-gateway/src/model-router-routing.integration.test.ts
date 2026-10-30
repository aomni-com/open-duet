import { expect, spyOn, test } from 'bun:test'

import { getFunctionName } from 'convex/server'

import type { ModelRouterPolicy } from '@repo/contract'

import { createModelGatewayApp } from './index'

const policy: ModelRouterPolicy = {
  version: 1,
  updatedAt: 1,
  rules: [
    {
      id: 'openai-route',
      enabled: true,
      modelGlob: 'openai/*',
      baseUrl: 'https://configured.example',
      headers: [{ name: 'authorization', value: 'Bearer route-key' }],
    },
    {
      id: 'anthropic-route',
      enabled: true,
      modelGlob: 'anthropic/*',
      baseUrl: 'https://configured.example',
      headers: [{ name: 'x-api-key', value: 'route-key' }],
    },
  ],
}

function request(
  pathname = '/v1/chat/completions',
  model = 'openai/gpt-5.6-sol',
  body: Record<string, unknown> = { messages: [] },
) {
  return new Request(`https://gateway.example${pathname}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer duet_sk_test_gateway_key',
      'content-type': 'application/json',
      'x-duet-tier': 'balanced',
    },
    body: JSON.stringify({ model, ...body }),
  })
}

test('routes a tier-priced OpenAI generation and settles native usage directly', async () => {
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = []
  const waits: Promise<unknown>[] = []
  const urls: string[] = []
  const app = createModelGatewayApp({
    internalKey: 'internal',
    aiGatewayApiKey: 'vercel-key',
    modelRouterPolicy: policy,
    convex: {
      async mutation(ref, args) {
        mutations.push({ name: getFunctionName(ref), args })
        return null
      },
    },
    preflight: async () => ({ proceed: true as const, generationId: 'generation-1' as never }),
    waitUntil: promise => waits.push(promise),
    fetch: async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      urls.push(url)
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-route-1',
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const response = await app.fetch(request())
  await Promise.all(waits)
  expect(response.status).toBe(200)
  expect(urls).toEqual(['https://configured.example/v1/chat/completions'])
  expect(mutations[0]?.name).toContain('settleRoutedGeneration')
  expect(mutations[0]?.args).toMatchObject({
    generationId: 'generation-1',
    upstreamGenerationId: 'chatcmpl-route-1',
    provider: 'openai',
    usage: { uncachedInputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
  })
})

test('falls back to Vercel when the configured route returns a 400', async () => {
  const logs = spyOn(console, 'info').mockImplementation(() => {})
  try {
    const urls: string[] = []
    const app = createModelGatewayApp({
      internalKey: 'internal',
      aiGatewayApiKey: 'vercel-key',
      upstreamBaseUrl: 'https://vercel.example',
      modelRouterPolicy: policy,
      preflight: async () => ({ proceed: true as const }),
      fetch: async input => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        urls.push(url)
        if (url.startsWith('https://configured.example'))
          return new Response('route failed', { status: 400 })
        return new Response(JSON.stringify({ id: 'gen_vercel' }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const response = await app.fetch(request())
    expect(response.status).toBe(200)
    expect(urls).toEqual([
      'https://configured.example/v1/chat/completions',
      'https://vercel.example/v1/chat/completions',
    ])
    expect(logs.mock.calls).toEqual([
      [
        '[model-gateway] configured route falling back to vercel',
        expect.objectContaining({
          operation: 'configured_route_fallback',
          ruleId: 'openai-route',
          reason: 'configured_http_400',
          fallback: 'vercel',
        }),
      ],
      [
        '[model-gateway] vercel fallback completed',
        expect.objectContaining({
          operation: 'configured_route_fallback_result',
          ruleId: 'openai-route',
          status: 200,
          ok: true,
        }),
      ],
    ])
  } finally {
    logs.mockRestore()
  }
})

test('falls back when a configured stream closes before producing content', async () => {
  const logs = spyOn(console, 'info').mockImplementation(() => {})
  try {
    const urls: string[] = []
    const app = createModelGatewayApp({
      internalKey: 'internal',
      aiGatewayApiKey: 'vercel-key',
      upstreamBaseUrl: 'https://vercel.example',
      modelRouterPolicy: policy,
      preflight: async () => ({ proceed: true as const }),
      fetch: async input => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        urls.push(url)
        if (url.startsWith('https://configured.example')) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('data: {"type":"response.created"}\n\n'),
                )
                controller.close()
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return new Response(JSON.stringify({ id: 'gen_vercel' }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const response = await app.fetch(request(undefined, 'openai/gpt-5.6-sol', { stream: true }))
    expect(response.status).toBe(200)
    expect(urls).toEqual([
      'https://configured.example/v1/chat/completions',
      'https://vercel.example/v1/chat/completions',
    ])
  } finally {
    logs.mockRestore()
  }
})

test('falls back when a configured stream stays silent before producing content', async () => {
  const logs = spyOn(console, 'info').mockImplementation(() => {})
  try {
    const urls: string[] = []
    const app = createModelGatewayApp({
      internalKey: 'internal',
      aiGatewayApiKey: 'vercel-key',
      upstreamBaseUrl: 'https://vercel.example',
      modelRouterPolicy: policy,
      preflight: async () => ({ proceed: true as const }),
      fetch: async input => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        urls.push(url)
        if (url.startsWith('https://configured.example')) {
          return new Response(new ReadableStream(), {
            headers: { 'content-type': 'text/event-stream' },
          })
        }
        return new Response(JSON.stringify({ id: 'gen_vercel' }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const response = await app.fetch(request(undefined, 'openai/gpt-5.6-sol', { stream: true }))
    expect(response.status).toBe(200)
    expect(urls).toEqual([
      'https://configured.example/v1/chat/completions',
      'https://vercel.example/v1/chat/completions',
    ])
  } finally {
    logs.mockRestore()
  }
})

test('settles nested Anthropic and Responses streaming IDs with native usage', async () => {
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = []
  const waits: Promise<unknown>[] = []
  let generation = 0
  const app = createModelGatewayApp({
    internalKey: 'internal',
    aiGatewayApiKey: 'vercel-key',
    modelRouterPolicy: policy,
    convex: {
      async mutation(ref, args) {
        mutations.push({ name: getFunctionName(ref), args })
        return null
      },
    },
    preflight: async () => ({
      proceed: true as const,
      generationId: `generation-${++generation}` as never,
    }),
    waitUntil: promise => waits.push(promise),
    fetch: async input => {
      const requestUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const pathname = new URL(requestUrl).pathname
      const body =
        pathname === '/v1/messages'
          ? 'data: {"type":"message_start","message":{"id":"msg-route-1","usage":{"input_tokens":10,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n'
          : 'data: {"type":"response.created","response":{"id":"resp-route-1"}}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":2}}}\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })

  expect(
    (await app.fetch(request('/v1/messages', 'anthropic/claude-sonnet-5', { stream: true })))
      .status,
  ).toBe(200)
  expect(
    (await app.fetch(request('/v1/responses', 'openai/gpt-5.6-sol', { stream: true }))).status,
  ).toBe(200)
  await Promise.all(waits)
  expect(mutations.map(m => m.args.upstreamGenerationId)).toEqual(['msg-route-1', 'resp-route-1'])
  expect(mutations.map(m => m.args.usage)).toEqual([
    { uncachedInputTokens: 12, cachedInputTokens: 3, outputTokens: 4 },
    { uncachedInputTokens: 8, cachedInputTokens: 0, outputTokens: 2 },
  ])
  expect(mutations[0]?.args.cacheCreationInputTokens).toBe(2)
})
