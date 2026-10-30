import { expect, spyOn } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setActiveDuetTier, activeDuetTier } from '@repo/agent/model-routing/active-tier'
import { APPROVED_MODELS, modelByRole } from '@repo/contract'

import { testIfDocker } from '../../agent/test/helpers/docker-only.js'
import { runModelCommand } from '../src/cli/model.js'

testIfDocker.each([
  ['default video role', undefined, 5],
  ['bytedance/seedance-2.5', 'bytedance/seedance-2.5', 5],
  ['google/veo-3.1-generate-001', 'google/veo-3.1-generate-001', 4],
  ['spacexai/grok-imagine-video-1.5', 'spacexai/grok-imagine-video-1.5', 5],
])(
  '%s preserves source image URLs, video request controls and file output',
  async (_label, model, duration) => {
    const temp = await mkdtemp(join(tmpdir(), 'media-refresh-'))
    const oldKey = process.env.DUET_API_KEY
    const oldBase = process.env.DUET_GATEWAY_BASE_URL
    const requests: Array<{ model: string | null; body: unknown }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({ model: request.headers.get('ai-model-id'), body: await request.json() })
        return new Response(
          `data: ${JSON.stringify({ type: 'result', videos: [{ type: 'base64', data: btoa('video-bytes'), mediaType: 'video/mp4' }], warnings: [] })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    try {
      process.env.DUET_API_KEY = 'controlled'
      process.env.DUET_GATEWAY_BASE_URL = server.url.toString()
      const output = join(temp, 'clip.mp4')
      await runModelCommand([
        ...(model ? ['-m', model] : []),
        '--type',
        'video',
        '--image',
        'https://example.test/source.png',
        '--duration',
        String(duration),
        '--aspect',
        '16:9',
        '--resolution',
        '1280x720',
        '-o',
        output,
        'animate',
      ])
      expect(requests).toEqual([
        {
          model: model ?? modelByRole(APPROVED_MODELS, 'video')!.gatewayModelId,
          body: expect.objectContaining({
            prompt: 'animate',
            duration,
            aspectRatio: '16:9',
            resolution: '1280x720',
            image: { type: 'url', url: 'https://example.test/source.png' },
          }),
        },
      ])
      expect(await readFile(output, 'utf8')).toBe('video-bytes')
    } finally {
      server.stop(true)
      if (oldKey === undefined) delete process.env.DUET_API_KEY
      else process.env.DUET_API_KEY = oldKey
      if (oldBase === undefined) delete process.env.DUET_GATEWAY_BASE_URL
      else process.env.DUET_GATEWAY_BASE_URL = oldBase
      await rm(temp, { recursive: true, force: true })
    }
  },
  30_000,
)

testIfDocker(
  'stable Gemini image generation uses the language image endpoint and writes its image',
  async () => {
    const temp = await mkdtemp(join(tmpdir(), 'image-refresh-'))
    const oldKey = process.env.DUET_API_KEY
    const oldBase = process.env.DUET_GATEWAY_BASE_URL
    const requests: Array<{ model: string | null; path: string; body: unknown }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/v1/models')
          return Response.json({
            data: [{ id: 'google/gemini-3.1-flash-image', type: 'language' }],
          })
        requests.push({
          model: request.headers.get('ai-language-model-id'),
          path,
          body: await request.json(),
        })
        return Response.json({
          content: [
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'data', data: btoa('image-bytes') },
            },
          ],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        })
      },
    })
    try {
      process.env.DUET_API_KEY = 'controlled'
      process.env.DUET_GATEWAY_BASE_URL = server.url.toString()
      const output = join(temp, 'image.png')
      await runModelCommand([
        '-m',
        'google/gemini-3.1-flash-image',
        '--type',
        'image',
        '-o',
        output,
        'draw a fox',
      ])
      expect(requests).toEqual([
        {
          model: 'google/gemini-3.1-flash-image',
          path: '/v4/ai/language-model',
          body: expect.objectContaining({
            prompt: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
            providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'] } },
          }),
        },
      ])
      expect(await readFile(output, 'utf8')).toBe('image-bytes')
    } finally {
      server.stop(true)
      if (oldKey === undefined) delete process.env.DUET_API_KEY
      else process.env.DUET_API_KEY = oldKey
      if (oldBase === undefined) delete process.env.DUET_GATEWAY_BASE_URL
      else process.env.DUET_GATEWAY_BASE_URL = oldBase
      await rm(temp, { recursive: true, force: true })
    }
  },
  30_000,
)

testIfDocker(
  'omitted image model preserves editing controls, multiple file bytes, warnings and direct billing',
  async () => {
    const temp = await mkdtemp(join(tmpdir(), 'image-default-'))
    const env = {
      DUET_API_KEY: process.env.DUET_API_KEY,
      DUET_GATEWAY_BASE_URL: process.env.DUET_GATEWAY_BASE_URL,
      DUET_WORKSPACE: process.env.DUET_WORKSPACE,
    }
    const previousTier = activeDuetTier()
    const stderr: string[] = []
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(chunk => {
      stderr.push(String(chunk))
      return true
    })
    const requests: Array<{
      model: string | null
      path: string
      tier: string | null
      workspace: string | null
      body: unknown
    }> = []
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/v1/models') return Response.json({ data: [] })
        requests.push({
          model: request.headers.get('ai-model-id'),
          path,
          tier: request.headers.get('x-duet-tier'),
          workspace: request.headers.get('x-duet-workspace'),
          body: await request.json(),
        })
        return Response.json({
          images: [bytes.toString('base64'), bytes.toString('base64')],
          warnings: [{ type: 'other', message: 'controlled warning' }],
        })
      },
    })
    try {
      process.env.DUET_API_KEY = 'controlled'
      process.env.DUET_GATEWAY_BASE_URL = server.url.toString()
      process.env.DUET_WORKSPACE = 'fixture'
      setActiveDuetTier('frontier')
      const input = join(temp, 'source.png')
      const output = join(temp, 'art.png')
      await Bun.write(input, bytes)
      await runModelCommand([
        '--type',
        'image',
        '--image',
        input,
        '--size',
        '1024x1024',
        '--aspect',
        '1:1',
        '--background',
        'transparent',
        '--n',
        '2',
        '--seed',
        '7',
        '-o',
        output,
        'edit a fox',
      ])
      expect(requests).toEqual([
        {
          model: modelByRole(APPROVED_MODELS, 'image')!.gatewayModelId,
          path: '/v4/ai/image-model',
          tier: null,
          workspace: 'fixture',
          body: expect.objectContaining({
            prompt: 'edit a fox',
            n: 2,
            size: '1024x1024',
            aspectRatio: '1:1',
            seed: 7,
            providerOptions: { openai: { background: 'transparent' } },
            files: [{ type: 'file', mediaType: 'image/png', data: bytes.toString('base64') }],
          }),
        },
      ])
      expect(await readFile(join(temp, 'art-1.png'))).toEqual(bytes)
      expect(await readFile(join(temp, 'art-2.png'))).toEqual(bytes)
      expect(stderr.join('')).toContain('controlled warning')
    } finally {
      stderrSpy.mockRestore()
      setActiveDuetTier(previousTier)
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      server.stop(true)
      await rm(temp, { recursive: true, force: true })
    }
  },
  30_000,
)
