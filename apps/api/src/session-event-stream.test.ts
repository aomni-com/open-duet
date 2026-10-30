import { describe, expect, test } from 'bun:test'

import type { ConvexHttpClient } from 'convex/browser'

import { CONVEX_EVENT_BUDGET_BYTES } from '@repo/contract'

import { createSessionEventStream } from './session-event-stream'

describe('session event durable tail', () => {
  test('a hint arriving during a fallback read retains its durable boundary', async () => {
    const reading = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let queries = 0
    let committed = false
    let hints!: ReadableStreamDefaultController<Uint8Array>
    const reader = createSessionEventStream({
      convex: {
        query: async (_ref: unknown, args: { afterSeq: number }) => {
          queries += 1
          const events =
            committed && args.afterSeq < 1
              ? [{ seq: 1, createdAt: 1, event: { type: 'text', text: 'previous block' } }]
              : []
          if (queries === 2) {
            reading.resolve()
            await release.promise
          }
          return {
            events,
            headSeq: events.length ? 1 : args.afterSeq,
            closed: false,
            terminal: false,
          }
        },
      } as unknown as ConvexHttpClient,
      internalKey: 'internal',
      gatewayClient: {
        openAgentSessionHints: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                hints = controller
              },
            }),
          ),
      },
      workspaceSlug: 'acme',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      afterSeq: 0,
      pollMs: 50,
    }).getReader()
    try {
      const first = reader.read()
      await reading.promise
      committed = true
      hints.enqueue(
        new TextEncoder().encode(
          'id: 1\nevent: text\ndata: {}\n\nevent: text_delta\ndata: next block\n\n',
        ),
      )
      await Bun.sleep(0)
      release.resolve()
      let frame = new TextDecoder().decode((await first).value)
      while (frame.startsWith(':')) frame = new TextDecoder().decode((await reader.read()).value)
      expect(frame).toContain('previous block')
    } finally {
      release.resolve()
      await reader.cancel()
    }
  })

  test('a durable hint boundary precedes the next blocks ephemeral delta', async () => {
    let committed = false
    const convex = {
      query: async (_ref: unknown, args: { afterSeq: number }) => ({
        events:
          committed && args.afterSeq < 1
            ? [{ seq: 1, createdAt: 1, event: { type: 'text', text: 'previous block' } }]
            : [],
        headSeq: committed ? 1 : 0,
        closed: false,
        terminal: false,
      }),
    } as unknown as ConvexHttpClient
    const reader = createSessionEventStream({
      convex,
      internalKey: 'internal',
      gatewayClient: {
        openAgentSessionHints: async () => {
          committed = true
          return new Response(
            'id: 1\nevent: text\ndata: {}\n\nevent: text_delta\ndata: next block\n\n',
          )
        },
      },
      workspaceSlug: 'acme',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      afterSeq: 0,
    }).getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('previous block')
      // Keepalives carry no event and cannot change the browser's durable cursor.
      let next = new TextDecoder().decode((await reader.read()).value)
      if (next.startsWith(':')) next = new TextDecoder().decode((await reader.read()).value)
      expect(next).toContain('next block')
    } finally {
      await reader.cancel()
    }
  })

  test('a burst of ephemeral hints does not make one durable query per frame', async () => {
    let queries = 0
    let completed = false
    const convex = {
      query: async (_ref: unknown, args: { afterSeq: number }) => {
        queries += 1
        return {
          events:
            completed && args.afterSeq < 1
              ? [{ seq: 1, createdAt: 1, event: { type: 'complete' } }]
              : [],
          headSeq: completed ? 1 : 0,
          closed: false,
          terminal: completed,
        }
      },
    } as unknown as ConvexHttpClient
    const reader = createSessionEventStream({
      convex,
      internalKey: 'internal',
      gatewayClient: hintClient('event: step\ndata: {}\n\n'.repeat(50)),
      workspaceSlug: 'acme',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      afterSeq: 0,
    }).getReader()
    try {
      for (let index = 0; index < 50; index += 1) {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: step')
      }
      expect(queries).toBeLessThanOrEqual(2)
      completed = true
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: complete')
    } finally {
      await reader.cancel()
    }
  })

  test('drains more than one page in order and ignores overlapping durable gateway frames', async () => {
    const events = Array.from({ length: 205 }, (_, index) => ({
      seq: index + 1,
      createdAt: index + 1,
      event:
        index === 99
          ? { type: 'complete', status: 'completed', result: 'prior turn' }
          : index === 204
            ? { type: 'complete', status: 'completed', result: 'done' }
            : { type: 'system', level: 'info', message: `event-${index + 1}` },
    }))
    const queries: number[] = []
    const convex = {
      query: async (_ref: unknown, args: { afterSeq: number }) => {
        queries.push(args.afterSeq)
        return {
          events: events.filter(event => event.seq > args.afterSeq).slice(0, 100),
          headSeq: events.at(-1)!.seq,
          closed: false,
          terminal: true,
        }
      },
    } as unknown as ConvexHttpClient
    const gatewayClient = hintClient('id: 150\nevent: system\ndata: {}\n\n')

    const frames = parseFrames(
      await new Response(
        createSessionEventStream({
          convex,
          internalKey: 'internal',
          gatewayClient,
          workspaceSlug: 'acme',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          afterSeq: 0,
          pollMs: 1,
        }),
      ).text(),
    )

    expect(frames.map(frame => frame.id)).toEqual(
      Array.from({ length: 205 }, (_, index) => String(index + 1)),
    )
    expect(queries.length).toBeLessThanOrEqual(Math.ceil(events.length / 100) + 1)
  })

  // The browser stamps a live frame with its own clock unless told better, and
  // a later history load replaces that with the row's clock — the same turn
  // then reads "thought for 12s" live and "9s" after a refetch. The frame
  // carries the row's clock so both readings agree.
  test('a durable frame carries the row createdAt', async () => {
    let served = false
    const convex = {
      query: async () => {
        const events = served
          ? []
          : [{ seq: 1, createdAt: 1_700_000_000_123, event: { type: 'complete' } }]
        served = true
        return { events, headSeq: 1, closed: false, terminal: true }
      },
    } as unknown as ConvexHttpClient

    const text = await new Response(
      createSessionEventStream({
        convex,
        internalKey: 'internal',
        gatewayClient: { openAgentSessionHints: async () => null },
        workspaceSlug: 'acme',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        afterSeq: 0,
        pollMs: 1,
      }),
    ).text()

    const [frame] = parseFrames(text)
    expect(JSON.parse(frame!.data!)).toEqual({
      seq: 1,
      createdAt: 1_700_000_000_123,
      event: { type: 'complete' },
    })
  })

  test('fallback polling finds a durable event that has no gateway frame', async () => {
    let queryCount = 0
    const convex = {
      query: async () => {
        queryCount += 1
        return queryCount === 1
          ? { events: [], headSeq: 0, closed: false, terminal: false }
          : queryCount === 2
            ? {
                events: [
                  {
                    seq: 1,
                    createdAt: 1,
                    event: { type: 'complete', status: 'completed', result: 'from another caller' },
                  },
                ],
                headSeq: 1,
                closed: false,
                terminal: true,
              }
            : { events: [], headSeq: 1, closed: false, terminal: true }
      },
    } as unknown as ConvexHttpClient

    const text = await new Response(
      createSessionEventStream({
        convex,
        internalKey: 'internal',
        gatewayClient: { openAgentSessionHints: async () => null },
        workspaceSlug: 'acme',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        afterSeq: 0,
        pollMs: 1,
      }),
    ).text()

    expect(parseFrames(text)).toEqual([expect.objectContaining({ id: '1', event: 'complete' })])
    expect(queryCount).toBeLessThanOrEqual(3)
  })

  // The stream opens the instant a turn is submitted, and the first hint
  // connect races the runner's spawn: an older gateway holds the SSE headers
  // until its first event, so the connect times out. That must cost one
  // fallback interval, not the whole turn — a stream that writes hints off
  // forever leaves every later event to the 15s poll.
  test('a failed hint connect is retried after the next fallback tick', async () => {
    let hintOpens = 0
    let served = false
    const convex = {
      query: async () => {
        if (served) return { events: [], headSeq: 1, closed: false, terminal: true }
        if (hintOpens < 2) return { events: [], headSeq: 0, closed: false, terminal: false }
        served = true
        return {
          events: [{ seq: 1, createdAt: 1, event: { type: 'complete', status: 'completed' } }],
          headSeq: 1,
          closed: false,
          terminal: true,
        }
      },
    } as unknown as ConvexHttpClient
    const gatewayClient = {
      openAgentSessionHints: async () => {
        hintOpens += 1
        if (hintOpens === 1) return null
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode('id: 1\nevent: complete\ndata: {"seq":1}\n\n'),
                )
              }, 20)
            },
          }),
        )
      },
    }

    const reader = createSessionEventStream({
      convex,
      internalKey: 'internal',
      gatewayClient,
      workspaceSlug: 'acme',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      afterSeq: 0,
      pollMs: 200,
    }).getReader()
    // A stream that never closes must fail the test, not hang the runner.
    const deadline = setTimeout(() => void reader.cancel(), 3_000)
    let text = ''
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        text += new TextDecoder().decode(chunk.value)
      }
    } finally {
      clearTimeout(deadline)
      await reader.cancel()
    }

    expect(parseFrames(text)).toContainEqual(
      expect.objectContaining({ id: '1', event: 'complete' }),
    )
    expect(hintOpens).toBe(2)
  })

  test('detaches an oversized incomplete hint frame and continues from Convex', async () => {
    let queryCount = 0
    let hintCancelled = false
    const convex = {
      query: async () => {
        queryCount += 1
        return queryCount < 3
          ? { events: [], headSeq: 0, closed: false, terminal: false }
          : queryCount === 3
            ? {
                events: [
                  {
                    seq: 1,
                    createdAt: 1,
                    event: { type: 'complete', status: 'completed', result: 'durable' },
                  },
                ],
                headSeq: 1,
                closed: false,
                terminal: true,
              }
            : { events: [], headSeq: 1, closed: false, terminal: true }
      },
    } as unknown as ConvexHttpClient
    const gatewayClient = {
      openAgentSessionHints: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: ' + 'x'.repeat(CONVEX_EVENT_BUDGET_BYTES + 65 * 1024),
                ),
              )
            },
            cancel() {
              hintCancelled = true
            },
          }),
        ),
    }

    const frames = parseFrames(
      await new Response(
        createSessionEventStream({
          convex,
          internalKey: 'internal',
          gatewayClient,
          workspaceSlug: 'acme',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          afterSeq: 0,
          pollMs: 1,
        }),
      ).text(),
    )

    expect(frames).toEqual([expect.objectContaining({ id: '1', event: 'complete' })])
    expect(hintCancelled).toBe(true)
  })

  test('consumer cancellation detaches the pending hint body and stops fallback queries', async () => {
    let queries = 0
    let hintCancelled = false
    const convex = {
      query: async () => {
        queries += 1
        return { events: [], headSeq: 0, closed: false, terminal: false }
      },
    } as unknown as ConvexHttpClient
    const gatewayClient = {
      openAgentSessionHints: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: async () => await new Promise<void>(() => {}),
            cancel() {
              hintCancelled = true
            },
          }),
        ),
    }
    const reader = createSessionEventStream({
      convex,
      internalKey: 'internal',
      gatewayClient,
      workspaceSlug: 'acme',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      afterSeq: 0,
      pollMs: 50,
    }).getReader()

    void reader.read()
    await Bun.sleep(1)
    await reader.cancel()
    const queriesAtCancellation = queries
    await Bun.sleep(60)
    expect(hintCancelled).toBe(true)
    expect(queries).toBe(queriesAtCancellation)
  })

  test('consumer cancellation releases a pending Convex page immediately', async () => {
    const convex = {
      query: async () => await new Promise<never>(() => {}),
    } as unknown as ConvexHttpClient
    const reader = createSessionEventStream({
      convex,
      internalKey: 'internal',
      gatewayClient: { openAgentSessionHints: async () => null },
      workspaceSlug: 'acme',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      afterSeq: 0,
      pollMs: 50,
    }).getReader()

    void reader.read()
    await Bun.sleep(1)
    await expect(
      Promise.race([
        reader.cancel().then(() => 'cancelled'),
        Bun.sleep(50).then(() => 'timed_out'),
      ]),
    ).resolves.toBe('cancelled')
  })

  test('a fallback tick emits an API keepalive only after the durable drain', async () => {
    let queries = 0
    const convex = {
      query: async () => {
        queries += 1
        return { events: [], headSeq: 0, closed: false, terminal: false }
      },
    } as unknown as ConvexHttpClient
    const reader = createSessionEventStream({
      convex,
      internalKey: 'internal',
      gatewayClient: { openAgentSessionHints: async () => null },
      workspaceSlug: 'acme',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      afterSeq: 0,
      pollMs: 1,
    }).getReader()

    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(': keepalive\n\n')
    expect(queries).toBeGreaterThanOrEqual(2)
    await reader.cancel()
  })

  test('cancellation settles a pull sleeping on fallback polling', async () => {
    const convex = {
      query: async () => ({
        events: [],
        headSeq: 0,
        closed: false,
        terminal: false,
      }),
    } as unknown as ConvexHttpClient
    const reader = createSessionEventStream({
      convex,
      internalKey: 'internal',
      gatewayClient: { openAgentSessionHints: async () => null },
      workspaceSlug: 'acme',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      afterSeq: 0,
      pollMs: 5_000,
    }).getReader()
    const pending = reader.read()
    await Bun.sleep(2)

    await reader.cancel()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })
})

function hintClient(frame: string) {
  return {
    openAgentSessionHints: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame))
          },
        }),
      ),
  }
}

function parseFrames(text: string): Array<{ id?: string; event?: string; data?: string }> {
  return text
    .trim()
    .split('\n\n')
    .filter(frame => frame.split('\n').some(line => !line.startsWith(':') && line.length > 0))
    .map(frame =>
      Object.fromEntries(
        frame
          .split('\n')
          .map(line => line.match(/^([^:]+): ?(.*)$/))
          .filter((match): match is RegExpMatchArray => match !== null)
          .map(match => [match[1]!, match[2]!]),
      ),
    )
}
