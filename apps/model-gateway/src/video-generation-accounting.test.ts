import { expect, test } from 'bun:test'

import { createGateway, experimental_generateVideo as generateVideo } from 'ai'
import { getFunctionName } from 'convex/server'

import { DEFAULT_RESERVATION_ESTIMATE_MICRO_USD } from '@repo/contract'

import { createModelGatewayApp } from './index'

test('forwards inline video intact and records its trailing generation metadata for settlement', async () => {
  const body = `data: ${JSON.stringify({
    type: 'result',
    videos: [{ type: 'base64', data: 'A'.repeat(65_536), mediaType: 'video/mp4' }],
    providerMetadata: { gateway: { generationId: 'gen_video_settlement' } },
  })}\n\n`
  const pending: Promise<unknown>[] = []
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = []
  const app = createModelGatewayApp({
    aiGatewayApiKey: 'fixture-platform',
    internalKey: 'fixture-internal',
    preflight: async request => {
      expect(request.model).toBe('google/veo-3.1-generate-001')
      expect(request.billingMode).toBe('reservation')
      return { proceed: true, generationId: 'fixture-generation' }
    },
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const bytes = new TextEncoder().encode(body)
            for (let offset = 0; offset < bytes.length; offset += 8_192) {
              controller.enqueue(bytes.subarray(offset, offset + 8_192))
            }
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    convex: {
      mutation: async (ref, args) => {
        mutations.push({ name: getFunctionName(ref), args })
        return null
      },
    },
    waitUntil: work => pending.push(work),
    now: () => 42,
  })
  const response = await app.request('/video-model', {
    method: 'POST',
    headers: {
      authorization: 'Bearer duet_sk_fixture_video',
      'content-type': 'application/json',
      'ai-model-id': 'google/veo-3.1-generate-001',
    },
    body: JSON.stringify({ prompt: 'A static blue circle.', n: 1 }),
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(body)
  await Promise.all(pending)
  expect(mutations).toEqual([
    {
      name: 'domains/modelGateway/model:recordUpstreamGenerationId',
      args: {
        internalKey: 'fixture-internal',
        generationId: 'fixture-generation',
        upstreamGenerationId: 'gen_video_settlement',
        now: 42,
      },
    },
  ])
})

test('uncatalogued SDK video preserves output bytes and records its trailing settlement ID', async () => {
  const model = 'fixture/new-video'
  const data = 'A'.repeat(65_536)
  const body = `data: ${JSON.stringify({
    type: 'result',
    videos: [{ type: 'base64', data, mediaType: 'video/mp4' }],
    providerMetadata: { gateway: { generationId: 'gen_uncatalogued_video' } },
  })}\n\n`
  const pending: Promise<unknown>[] = []
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = []
  let forwardedBytes: string | undefined
  const app = createModelGatewayApp({
    aiGatewayApiKey: 'fixture-platform',
    internalKey: 'fixture-internal',
    preflight: async request => {
      expect(request).toMatchObject({
        model,
        modality: 'video',
        billingMode: 'reservation',
        estimateMicroUsd: DEFAULT_RESERVATION_ESTIMATE_MICRO_USD,
      })
      expect(request.tier).toBeUndefined()
      return { proceed: true, generationId: 'fixture-generation' }
    },
    fetch: async (input, init) => {
      expect(new URL(String(input)).pathname).toBe('/v4/ai/video-model')
      expect(new Headers(init?.headers).get('ai-model-id')).toBe(model)
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
    convex: {
      mutation: async (ref, args) => {
        mutations.push({ name: getFunctionName(ref), args })
        return null
      },
    },
    waitUntil: work => pending.push(work),
    now: () => 42,
  })
  const gateway = createGateway({
    baseURL: 'https://gateway.test/v4/ai',
    apiKey: 'duet_sk_fixture_video',
    headers: { 'x-duet-tier': 'balanced' },
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await app.fetch(new Request(input, init))
        forwardedBytes = await response.clone().text()
        return response
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const result = await generateVideo({
    model: gateway.video(model),
    prompt: 'A static blue circle.',
    maxRetries: 0,
  })
  expect(result.video.uint8Array).toEqual(new Uint8Array(Buffer.from(data, 'base64')))
  expect(forwardedBytes).toBe(body)
  await Promise.all(pending)
  expect(mutations).toEqual([
    {
      name: 'domains/modelGateway/model:recordUpstreamGenerationId',
      args: {
        internalKey: 'fixture-internal',
        generationId: 'fixture-generation',
        upstreamGenerationId: 'gen_uncatalogued_video',
        now: 42,
      },
    },
  ])
})
