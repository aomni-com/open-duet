/**
 * Extracts the Vercel AI Gateway `generationId` from a proxied response without
 * consuming the body. Works with JSON and SSE streaming responses across the
 * OpenAI/Anthropic passthrough shapes and gateway model endpoints.
 */

function generationIdFromJson(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>

  if (typeof record.generationId === 'string') return record.generationId

  for (const key of ['providerMetadata', 'provider_metadata'] as const) {
    const meta = record[key]
    if (meta && typeof meta === 'object') {
      for (const entry of Object.values(meta as Record<string, unknown>)) {
        if (entry && typeof entry === 'object') {
          const id = (entry as Record<string, unknown>).generationId
          if (typeof id === 'string') return id
        }
      }
    }
  }

  if (typeof record.id === 'string' && record.id.startsWith('gen_')) return record.id

  return null
}

function generationIdFromSseText(text: string): string | null {
  const byField = text.match(/"generationId"\s*:\s*"([^"]+)"/)
  if (byField) return byField[1] ?? null
  const byGenId = text.match(/"id"\s*:\s*"(gen_[^"]+)"/)
  if (byGenId) return byGenId[1] ?? null
  return null
}

export function extractGenerationId(upstream: Response): {
  body: ReadableStream<Uint8Array> | null
  generationId: Promise<string | null>
} {
  if (!upstream.body) {
    return { body: null, generationId: Promise.resolve(null) }
  }

  const contentType = upstream.headers.get('content-type') ?? ''
  const isSse = contentType.includes('text/event-stream')

  if (!isSse) {
    const [forClient, forParsing] = upstream.body.tee()
    const generationId = new Response(forParsing).json().then(generationIdFromJson, () => null)
    return { body: forClient, generationId }
  }

  return forwardSseWithGenerationId(upstream.body)
}

function forwardSseWithGenerationId(upstream: ReadableStream<Uint8Array>): {
  body: ReadableStream<Uint8Array>
  generationId: Promise<string | null>
} {
  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let cancelled = false
  let settled = false
  let reading = Promise.resolve()
  let resolveId: (id: string | null) => void = () => undefined
  const generationId = new Promise<string | null>(resolve => {
    resolveId = resolve
  })
  const settle = (id: string | null) => {
    if (settled) return
    settled = true
    resolveId(id)
  }
  // Inline media can precede billing metadata. Bound decoded text even when a
  // transport hands us a large chunk, retaining overlap across every slice.
  const windowSize = 16_384
  const inspect = (chunk: Uint8Array) => {
    for (let offset = 0; offset < chunk.length && !settled; offset += windowSize) {
      buffer += decoder.decode(chunk.subarray(offset, offset + windowSize), { stream: true })
      const id = generationIdFromSseText(buffer)
      if (id) settle(id)
      buffer = buffer.slice(-windowSize)
    }
  }
  const read = async (controller?: ReadableStreamDefaultController<Uint8Array>) => {
    const next = await reader.read()
    if (next.done) {
      settle(null)
      if (!cancelled) controller?.close()
      return false
    }
    inspect(next.value)
    if (!cancelled) controller?.enqueue(next.value)
    return true
  }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Observe forwarding rather than teeing: a second eager reader would
      // buffer the entire video on the slow client's branch.
      reading = read(controller).then(
        () => undefined,
        error => {
          settle(null)
          if (!cancelled) controller.error(error)
        },
      )
      return reading
    },
    async cancel() {
      cancelled = true
      if (settled) {
        await reader.cancel().catch(() => undefined)
        return
      }
      // The pending read may carry the ID. Finish it before taking over reads;
      // billing can then finish without queueing bytes for the departed client.
      await reading
      try {
        while (!settled && (await read())) {
          /* drain to billing metadata or EOF */
        }
      } catch {
        settle(null)
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    },
  })
  return { body, generationId }
}
