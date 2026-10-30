import { describe, expect, test } from 'bun:test'

import { openSessionEventStream } from './stream'

describe('session SSE owner', () => {
  test('uses fetch so reconnect sends Last-Event-ID without a public query fallback', async () => {
    const frames: unknown[] = []
    const requests: Array<{ url: string; headers: Headers; signal: AbortSignal | null }> = []
    let cancelled = false
    const fetchImpl = async (input: string, init: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        signal: init?.signal ?? null,
      })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                ': keepalive\n\nevent: turn_started\r\ndata: {"seq":43,"event":{"type":"turn_started"}}\r\n\r\nevent: turn_started\ndata: {invalid\n\n',
              ),
            )
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 200 },
      )
    }

    const stream = openSessionEventStream({
      workspaceSlug: 'acme space',
      sessionId: 'session/1',
      afterSeq: 42,
      onFrame: frame => frames.push(frame),
      onError: () => {},
      fetchImpl,
    })
    await Bun.sleep(1)
    stream.close()
    await Bun.sleep(1)

    expect(requests[0]!.url).toBe('/api/duet/ws/acme%20space/agent/sessions/session%2F1/events')
    expect(requests[0]!.headers.get('last-event-id')).toBe('42')
    expect(requests[0]!.headers.get('accept')).toBe('text/event-stream')
    expect(frames).toEqual([{ seq: 43, event: { type: 'turn_started' } }])
    expect(requests[0]!.signal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  test('reports HTTP failure and clean EOF to the explicit reconnect owner', async () => {
    const errors: Event[] = []
    openSessionEventStream({
      workspaceSlug: 'acme',
      sessionId: 'session-1',
      onFrame: () => {},
      onError: event => errors.push(event),
      fetchImpl: async () => new Response(null, { status: 409 }),
    })
    openSessionEventStream({
      workspaceSlug: 'acme',
      sessionId: 'session-2',
      onFrame: () => {},
      onError: event => errors.push(event),
      fetchImpl: async () => new Response(''),
    })

    await Bun.sleep(1)
    expect(errors).toHaveLength(2)
    expect(errors.every(event => event.type === 'error')).toBe(true)
  })
})
