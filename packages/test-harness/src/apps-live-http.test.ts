import { expect, test } from 'bun:test'

import { proveAppHttpContract } from './apps-live-http.ts'

test('proves task writes, reads, and fragmented SSE lifecycle through the public URL', async () => {
  const encoder = new TextEncoder()
  const calls: Array<{ url: string; init: RequestInit }> = []
  let firstEventsController: ReadableStreamDefaultController<Uint8Array> | undefined
  let taskTitle = ''
  let eventRequests = 0

  const evidence = await proveAppHttpContract({
    appUrl: 'https://pulse--workspace.edge-staging.duet.so',
    taskTitle: 'TASK-r1',
    segmentCapMs: 1_000,
    reconnectCapMs: 1_000,
    requestCapMs: 1_000,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init })
      const pathname = new URL(url).pathname
      if (pathname === '/events') {
        eventRequests += 1
        if (eventRequests === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                firstEventsController = controller
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(': reconnect'))
              controller.enqueue(encoder.encode('ed\n\n'))
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (pathname === '/api/tasks' && init.method === 'POST') {
        taskTitle = ((await new Response(init.body).json()) as { title: string }).title
        firstEventsController?.enqueue(encoder.encode('event: task\ndata: {"changed":'))
        firstEventsController?.enqueue(encoder.encode('true}\n\n'))
        firstEventsController?.close()
        return Response.json({ task: { title: taskTitle } }, { status: 201 })
      }
      if (pathname === '/api/tasks') {
        return Response.json({ tasks: [{ title: taskTitle }] })
      }
      throw new Error(`unexpected request ${url}`)
    },
  })

  expect(evidence.apiWriteStatus).toBe(201)
  expect(evidence.apiReadStatus).toBe(200)
  expect(evidence.eventsStatus).toBe(200)
  expect(evidence.eventsContentType).toBe('text/event-stream')
  expect(evidence.firstFrameMs).toBeGreaterThanOrEqual(0)
  expect(evidence.segmentLifetimeMs).toBeGreaterThanOrEqual(0)
  expect(evidence.reconnectGapMs).toBeGreaterThanOrEqual(0)
  expect(eventRequests).toBe(2)
  const eventCalls = calls.filter(call => new URL(call.url).pathname === '/events')
  expect(eventCalls.map(call => new Headers(call.init.headers).get('accept'))).toEqual([
    'text/event-stream',
    'text/event-stream',
  ])
})

test('surfaces an events connection failure without waiting for the request cap', async () => {
  const proof = proveAppHttpContract({
    appUrl: 'https://pulse--workspace.edge-staging.duet.so',
    taskTitle: 'TASK-r1',
    requestCapMs: 1_000,
    fetchImpl: async () => {
      throw new Error('edge unavailable')
    },
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await expect(Promise.race([
      proof,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('connection failure was not surfaced promptly')), 5_000)
      }),
    ])).rejects.toThrow('edge unavailable')
  } finally {
    clearTimeout(timer)
  }
})
