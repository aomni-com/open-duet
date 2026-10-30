import { describe, expect, test } from 'bun:test'

import { extractGenerationId } from './extract-generation-id'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

async function resolveId(result: ReturnType<typeof extractGenerationId>): Promise<string | null> {
  if (result.body) await new Response(result.body).text()
  return result.generationId
}

describe('extractGenerationId JSON responses', () => {
  test('reads a top-level generationId', async () => {
    const res = extractGenerationId(jsonResponse({ generationId: 'gen_top' }))
    expect(await resolveId(res)).toBe('gen_top')
  })

  test('reads generationId nested under camelCase providerMetadata', async () => {
    const res = extractGenerationId(
      jsonResponse({
        images: ['...'],
        providerMetadata: { gateway: { generationId: 'gen_image_42' } },
      }),
    )
    expect(await resolveId(res)).toBe('gen_image_42')
  })

  test('reads generationId nested under snake_case provider_metadata', async () => {
    const res = extractGenerationId(
      jsonResponse({ provider_metadata: { gateway: { generationId: 'gen_snake' } } }),
    )
    expect(await resolveId(res)).toBe('gen_snake')
  })

  test('falls back to a gen-prefixed top-level id', async () => {
    const res = extractGenerationId(jsonResponse({ id: 'gen_fallback' }))
    expect(await resolveId(res)).toBe('gen_fallback')
  })

  test('does not treat provider response ids as gateway generation ids', async () => {
    const res = extractGenerationId(jsonResponse({ id: 'resp_provider_123' }))
    expect(await resolveId(res)).toBeNull()
  })

  test('resolves null for unparseable JSON', async () => {
    const res = extractGenerationId(
      new Response('not json{', { headers: { 'content-type': 'application/json' } }),
    )
    expect(await resolveId(res)).toBeNull()
  })
})

describe('extractGenerationId SSE responses', () => {
  test('extracts the gateway generationId from a video result event', async () => {
    const event =
      'data: ' +
      JSON.stringify({
        type: 'result',
        videos: [{ type: 'url', url: 'https://x/v.mp4', mediaType: 'video/mp4' }],
        providerMetadata: { gateway: { generationId: 'gen_video_99' } },
      }) +
      '\n\n'
    const res = extractGenerationId(sseResponse([event]))
    expect(await resolveId(res)).toBe('gen_video_99')
  })

  test('extracts a gen-prefixed id from an OpenAI text chunk', async () => {
    const chunk = 'data: ' + JSON.stringify({ id: 'gen_text_7', object: 'chat.completion.chunk' })
    const res = extractGenerationId(sseResponse([chunk]))
    expect(await resolveId(res)).toBe('gen_text_7')
  })

  test('extracts the Anthropic message_start message id', async () => {
    const chunk =
      'event: message_start\n' +
      'data: ' +
      JSON.stringify({ type: 'message_start', message: { id: 'gen_anthropic_1' } }) +
      '\n\n'
    const res = extractGenerationId(sseResponse([chunk]))
    expect(await resolveId(res)).toBe('gen_anthropic_1')
  })

  test('does not match an upstream provider id without the gen prefix', async () => {
    const chunk = 'data: ' + JSON.stringify({ id: 'chatcmpl-abc', object: 'chat.completion.chunk' })
    const res = extractGenerationId(sseResponse([chunk]))
    expect(await resolveId(res)).toBeNull()
  })

  test('resolves null when no id ever appears', async () => {
    const res = extractGenerationId(sseResponse(['data: {"type":"ping"}\n\n', 'data: [DONE]\n\n']))
    expect(await resolveId(res)).toBeNull()
  })

  test.each([7, 8_192, 131_072])(
    'extracts metadata after inline video across %i-byte chunks without changing client bytes',
    async chunkSize => {
      const event = `data: ${JSON.stringify({
        type: 'result',
        videos: [{ type: 'base64', data: 'A'.repeat(65_536), mediaType: 'video/mp4' }],
        providerMetadata: { gateway: { generationId: 'gen_inline_video' } },
      })}\n\n`
      const chunks = []
      for (let offset = 0; offset < event.length; offset += chunkSize) {
        chunks.push(event.slice(offset, offset + chunkSize))
      }
      const result = extractGenerationId(sseResponse(chunks))
      expect(await new Response(result.body).text()).toBe(event)
      expect(await result.generationId).toBe('gen_inline_video')
    },
  )

  test('forwards a large response with no generation ID through EOF', async () => {
    const chunks = ['data: {"type":"result","videos":[{"data":"', 'A'.repeat(65_536), '"}]}\n\n']
    const result = extractGenerationId(sseResponse(chunks))
    expect(await new Response(result.body).text()).toBe(chunks.join(''))
    expect(await result.generationId).toBeNull()
  })

  test('a broken upstream stream resolves no ID without hiding the client stream error', async () => {
    const failure = new Error('fixture stream failure')
    const result = extractGenerationId(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(failure)
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    await expect(new Response(result.body).text()).rejects.toThrow('fixture stream failure')
    expect(await result.generationId).toBeNull()
  })

  test('forwards the body bytes unchanged to the client', async () => {
    const chunk = 'data: {"id":"gen_passthrough"}\n\n'
    const res = extractGenerationId(sseResponse([chunk]))
    const forwarded = res.body ? await new Response(res.body).text() : ''
    expect(forwarded).toBe(chunk)
  })

  test('a slow client does not buffer the remaining video while billing waits for trailing metadata', async () => {
    let pulls = 0
    const chunks = [
      'data: {"type":"result","videos":[{"data":"' + 'A'.repeat(65_536),
      'A'.repeat(65_536),
      '"}],"providerMetadata":{"gateway":{"generationId":"gen_after_slow_client"}}}\n\n',
    ]
    const result = extractGenerationId(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const chunk = chunks[pulls++]
              if (chunk === undefined) controller.close()
              else controller.enqueue(new TextEncoder().encode(chunk))
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    try {
      await Bun.sleep(0)
      expect(pulls).toBe(1)
    } finally {
      await result.body?.cancel()
    }
    expect(await result.generationId).toBe('gen_after_slow_client')
  })

  test('cancels a stalled upstream immediately once the generation ID is known', async () => {
    let upstreamCancelled = false
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const result = extractGenerationId(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c
            c.enqueue(new TextEncoder().encode('data: {"id":"gen_before_stall"}\n\n'))
          },
          cancel() {
            upstreamCancelled = true
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const client = result.body!.getReader()
    await client.read()
    await Bun.sleep(0)
    const cancellation = client.cancel()
    try {
      await Bun.sleep(0)
      expect(upstreamCancelled).toBe(true)
    } finally {
      if (!upstreamCancelled) controller.close()
      await cancellation
    }
    expect(await result.generationId).toBe('gen_before_stall')
  })

  test('continues scanning when the client cancels during a pending upstream read', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const res = extractGenerationId(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    )

    await Bun.sleep(0) // Let forwarding block on its first upstream read.
    const cancel = res.body?.cancel()
    controller!.enqueue(new TextEncoder().encode('data: {"id":"gen_after_cancel"}\n\n'))

    expect(await res.generationId).toBe('gen_after_cancel')
    await cancel
  })
})
