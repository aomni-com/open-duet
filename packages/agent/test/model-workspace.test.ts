import { afterEach, beforeEach, expect, test } from 'bun:test'

import { generateImage, generateText, experimental_generateVideo as generateVideo } from 'ai'

import { createEmbeddingClient } from '../src/memory/embedding.js'
import { createDuetModelGateway, fetchModelCatalog } from '../src/model-resolution/model-gateway.js'
import { duetModels, duetStreamFn } from '../src/model-resolution/models.js'
import { resolveModelName } from '../src/model-resolution/resolver.js'
import { setActiveDuetTier } from '../src/model-routing/active-tier.js'
import { modelRefreshCompletion } from './helpers/model-refresh-upstream.js'

const environment = [
  'DUET_API_KEY',
  'DUET_GATEWAY_BASE_URL',
  'DUET_WORKSPACE',
  'AI_GATEWAY_API_KEY',
] as const
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const name of environment) {
    saved.set(name, process.env[name])
    delete process.env[name]
  }
  process.env.DUET_API_KEY = 'workspace-client-key'
  setActiveDuetTier('balanced')
})

test('catalog reads carry the same explicit workspace as embedding requests', async () => {
  const captured: Array<{ path: string; workspace: string | null; key: string | null }> = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      captured.push({
        path,
        workspace: request.headers.get('x-duet-workspace'),
        key: request.headers.get('authorization'),
      })
      return path === '/v1/models'
        ? Response.json({ data: [{ id: 'fixture/image', type: 'image' }] })
        : Response.json({ data: [{ embedding: [1, 0] }], model: 'fixture/embedding' })
    },
  })
  try {
    process.env.DUET_GATEWAY_BASE_URL = server.url.origin
    const embed = createEmbeddingClient()
    for (const workspace of ['harbor', 'orchard']) {
      process.env.DUET_WORKSPACE = workspace
      expect(await embed(['the same query'])).toEqual({
        embeddings: [[1, 0]],
        model: 'fixture/embedding',
      })
      expect((await fetchModelCatalog()).get('fixture/image')).toBe('image')
    }
    expect(captured).toEqual([
      { path: '/v1/embeddings', workspace: 'harbor', key: 'Bearer workspace-client-key' },
      { path: '/v1/models', workspace: 'harbor', key: 'Bearer workspace-client-key' },
      { path: '/v1/embeddings', workspace: 'orchard', key: 'Bearer workspace-client-key' },
      { path: '/v1/models', workspace: 'orchard', key: 'Bearer workspace-client-key' },
    ])
  } finally {
    server.stop(true)
  }
})

afterEach(() => {
  for (const name of environment) {
    const value = saved.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  setActiveDuetTier(undefined)
})

test('one Duet key carries the selected workspace through actual chat requests', async () => {
  const captured: Array<{ workspace: string | null; tier: string | null; key: string | null }> = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      captured.push({
        workspace: request.headers.get('x-duet-workspace'),
        tier: request.headers.get('x-duet-tier'),
        key: request.headers.get('authorization') ?? request.headers.get('x-api-key'),
      })
      return modelRefreshCompletion('anthropic/claude-sonnet-5.5')
    },
  })
  try {
    process.env.DUET_GATEWAY_BASE_URL = server.url.origin
    for (const workspace of ['harbor', 'orchard']) {
      process.env.DUET_WORKSPACE = workspace
      const stream = await duetStreamFn(
        resolveModelName('duet-gateway:anthropic/claude-sonnet-5.5'),
        { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
        { apiKey: process.env.DUET_API_KEY },
      )
      const result = await stream.result()
      expect(result.stopReason).toBe('stop')
    }
    expect(captured).toEqual([
      { workspace: 'harbor', tier: 'balanced', key: 'workspace-client-key' },
      { workspace: 'orchard', tier: 'balanced', key: 'workspace-client-key' },
    ])
  } finally {
    server.stop(true)
  }
})

test('AI SDK chat, image, video and catalog requests preserve workspace and tier', async () => {
  const captured: Array<{
    path: string
    workspace: string | null
    tier: string | null
    key: string | null
  }> = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      captured.push({
        path,
        workspace: request.headers.get('x-duet-workspace'),
        tier: request.headers.get('x-duet-tier'),
        key: request.headers.get('authorization'),
      })
      if (path === '/v4/ai/config') return Response.json({ models: [] })
      if (path === '/v4/ai/image-model')
        return Response.json({
          images: [
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
          ],
        })
      if (path === '/v4/ai/video-model')
        return new Response(
          `data: ${JSON.stringify({ type: 'result', videos: [{ type: 'base64', data: btoa('video-bytes'), mediaType: 'video/mp4' }], warnings: [] })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      return Response.json({
        content: [{ type: 'text', text: 'hello' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      })
    },
  })
  try {
    process.env.DUET_GATEWAY_BASE_URL = server.url.origin
    for (const workspace of ['harbor', 'orchard']) {
      process.env.DUET_WORKSPACE = workspace
      const gateway = createDuetModelGateway()
      await gateway.getAvailableModels()
      expect(
        (await generateText({ model: gateway('fixture/chat'), prompt: 'hi', maxRetries: 0 })).text,
      ).toBe('hello')
      expect(
        (
          await generateImage({
            model: gateway.imageModel('fixture/image'),
            prompt: 'draw',
            maxRetries: 0,
          })
        ).image.mediaType,
      ).toBe('image/png')
      expect(
        (
          await generateVideo({
            model: gateway.video('fixture/video'),
            prompt: 'animate',
            maxRetries: 0,
          })
        ).video.mediaType,
      ).toBe('video/mp4')
    }
    expect(captured).toEqual(
      ['harbor', 'orchard'].flatMap(workspace =>
        ['config', 'language-model', 'image-model', 'video-model'].map(endpoint => ({
          path: `/v4/ai/${endpoint}`,
          workspace,
          tier: 'balanced',
          key: 'Bearer workspace-client-key',
        })),
      ),
    )
  } finally {
    server.stop(true)
  }
})

test('the AI SDK Vercel fallback omits Duet workspace and tier headers', async () => {
  const originalFetch = globalThis.fetch
  const captured: Array<{ workspace: string | null; tier: string | null; key: string | null }> = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      captured.push({
        workspace: request.headers.get('x-duet-workspace'),
        tier: request.headers.get('x-duet-tier'),
        key: request.headers.get('authorization'),
      })
      return Response.json({ models: [] })
    },
  })
  try {
    delete process.env.DUET_API_KEY
    process.env.AI_GATEWAY_API_KEY = 'vercel-fixture-key'
    process.env.DUET_WORKSPACE = 'harbor'
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const target = new URL(input instanceof Request ? input.url : String(input))
        expect(target.hostname).toBe('ai-gateway.vercel.sh')
        return originalFetch(new URL(target.pathname, server.url), init)
      },
      { preconnect: originalFetch.preconnect },
    )
    await createDuetModelGateway().getAvailableModels()
    expect(captured).toEqual([{ workspace: null, tier: null, key: 'Bearer vercel-fixture-key' }])
  } finally {
    globalThis.fetch = originalFetch
    server.stop(true)
  }
})

test.each(['duet-gateway', 'vercel-ai-gateway', 'openai-codex', 'github-copilot', 'anthropic'])(
  '%s keeps workspace selection specific to Duet without choosing a missing target',
  async provider => {
    const captured: Array<{ workspace: string | null; tier: string | null }> = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        captured.push({
          workspace: request.headers.get('x-duet-workspace'),
          tier: request.headers.get('x-duet-tier'),
        })
        return Response.json({ error: { message: 'controlled request capture' } }, { status: 400 })
      },
    })
    try {
      if (provider === 'duet-gateway') delete process.env.DUET_WORKSPACE
      else process.env.DUET_WORKSPACE = 'harbor'
      const model = provider.endsWith('gateway')
        ? resolveModelName(`${provider}:anthropic/claude-sonnet-5.5`)
        : duetModels().getModels(provider)[0]!
      const key = [
        'e30',
        btoa(
          JSON.stringify({
            'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
          }),
        ).replace(/=+$/, ''),
        'fixture-token',
      ].join('.')
      const stream = await duetStreamFn(
        model,
        { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
        {
          apiKey: key,
          fetch: Object.assign(
            (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
              fetch(
                new URL(
                  new URL(input instanceof Request ? input.url : String(input)).pathname,
                  server.url,
                ),
                init,
              ),
            { preconnect: fetch.preconnect },
          ),
        },
      )
      expect((await stream.result()).stopReason).toBe('error')
      expect(captured).toEqual([
        { workspace: null, tier: provider === 'duet-gateway' ? 'balanced' : null },
      ])
    } finally {
      server.stop(true)
    }
  },
)
