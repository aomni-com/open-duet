import { expect, test } from 'bun:test'

import { readSseSegment, SseFrameParser } from './sse-segment-reader.ts'

test('parses fragmented SSE frames without losing multi-line data or comments', () => {
  const parser = new SseFrameParser()

  expect(parser.push('id: 4\r')).toEqual([])
  expect(parser.push('\nevent: task\r\ndata: {"title":')).toEqual([])
  expect(parser.push('"probe"}\r\ndata: continued\r\n\r')).toEqual([])
  expect(parser.push('\n: heartbeat\n\n')).toEqual([
    {
      id: '4',
      event: 'task',
      data: '{"title":"probe"}\ncontinued',
      comments: [],
    },
    { data: undefined, event: undefined, id: undefined, comments: ['heartbeat'] },
  ])
})

test('records an incrementally delivered resumable SSE segment through clean close', async () => {
  const encoder = new TextEncoder()
  let requestHeaders = new Headers()
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    requestHeaders = new Headers(init?.headers)
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': keepa'))
          controller.enqueue(encoder.encode('live\r\nid: 42\r'))
          controller.enqueue(encoder.encode('\nevent: task\r\ndata: {"title":"probe"}\r\n\r\n'))
          controller.close()
        },
      }),
      {
        status: 200,
        headers: {
          'cache-control': 'no-cache',
          'content-type': 'text/event-stream',
        },
      },
    )
  }

  const segment = await readSseSegment({
    url: 'https://probe.example/events',
    headers: { accept: '*/*' },
    lastEventId: 41,
    capMs: 1_000,
    fetchImpl,
  })

  expect(requestHeaders.get('accept')).toBe('text/event-stream')
  expect(requestHeaders.get('last-event-id')).toBe('41')
  expect(segment.status).toBe(200)
  expect(segment.responseHeaders['content-type']).toBe('text/event-stream')
  expect(segment.chunks).toHaveLength(3)
  expect(segment.chunks[2]).toMatchObject({
    keepalives: 1,
    ids: [42],
    eventTypes: ['task'],
  })
  expect(segment.chunks.map(chunk => chunk.atMs)).toEqual(
    segment.chunks.map(chunk => chunk.atMs).sort((left, right) => left - right),
  )
  expect(segment.ttfbMs).toBeGreaterThanOrEqual(0)
  expect(segment.lastId).toBe(42)
  expect(segment.endedBy).toBe('clean_close')
})

test('ends a body read at the probe cap even when the stream ignores request abort', async () => {
  const encoder = new TextEncoder()
  // The margins are deliberately wide: the contract is that the cap ends the
  // read at all, not that timers fire promptly on a loaded machine — a 10ms
  // cap raced against a 100ms deadline flaked in full-repo gates from event
  // loop starvation alone.
  const segment = await withinDeadline(
    readSseSegment({
      url: 'https://probe.example/events',
      capMs: 50,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('event: snapshot\ndata: {}\n\n'))
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    }),
    'segment reader did not honor its cap',
  )

  expect(segment.endedBy).toBe('probe_cap')
  expect(segment.lifetimeMs).toBeGreaterThanOrEqual(50)
  expect(segment.lifetimeMs).toBeLessThan(5_000)
})

test('reports parsed frames on an injected bounded clock', async () => {
  const encoder = new TextEncoder()
  const times = [1_000, 1_020, 1_100, 1_100]
  let scheduledCapMs = -1
  const frames: unknown[] = []
  const segment = await readSseSegment({
    url: 'https://probe.example/events',
    capMs: 321,
    clock: {
      now: () => times.shift() ?? 1_100,
      setTimeout: (_callback, ms) => {
        scheduledCapMs = ms
        return 'timer'
      },
      clearTimeout: () => undefined,
    },
    onFrame: frame => frames.push(frame),
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: task\ndata: {"ok":true}\n\n'))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
  })

  expect(scheduledCapMs).toBe(321)
  expect(segment.startedAtIso).toBe(new Date(1_000).toISOString())
  expect(segment.ttfbMs).toBe(20)
  expect(segment.lifetimeMs).toBe(100)
  expect(frames).toEqual([{ id: undefined, event: 'task', data: '{"ok":true}', comments: [] }])
})

test('exposes response metadata and can stop after a matching frame', async () => {
  const encoder = new TextEncoder()
  let responseStatus = 0
  const segment = await readSseSegment({
    url: 'https://probe.example/events',
    capMs: 1_000,
    onResponse: record => {
      responseStatus = record.status
    },
    stopWhenFrame: frame => frame.data !== undefined,
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': connected\n\ndata: {}\n\n'))
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
  })

  expect(responseStatus).toBe(200)
  expect(segment.endedBy).toBe('matched_frame')
  expect(segment.lifetimeMs).toBeGreaterThanOrEqual(0)
})

test('external cancellation ends an open body without waiting for the cap', async () => {
  const controller = new AbortController()
  const pending = readSseSegment({
    url: 'https://probe.example/events',
    capMs: 60_000,
    signal: controller.signal,
    fetchImpl: async () =>
      new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  })

  controller.abort()
  const segment = await withinDeadline(pending, 'external cancellation did not stop the reader')
  expect(segment.endedBy).toBe('aborted')
})

async function withinDeadline<T>(pending: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
