import { describe, expect, test } from 'bun:test'

import type { FetchLike } from '@repo/contract'

import { customMcpUpstreamSource } from './credentials'
import {
  forwardMcpRequest,
  withUpstreamTimeout,
  type McpProxyOutcome,
  type McpUpstreamSource,
  type McpUpstreamTarget,
} from './proxy'

describe('forwardMcpRequest', () => {
  test.each(['bearer', 'BEARER', 'Bearer'])(
    'connects to a case-sensitive upstream with stored OAuth token type %s',
    async tokenType => {
      const result = { jsonrpc: '2.0', id: 1, result: { tools: [] } }
      const response = await forwardMcpRequest(
        async (_input, init) =>
          new Headers(init?.headers).get('authorization') === 'Bearer oauth-access'
            ? Response.json(result)
            : new Response(null, { status: 401 }),
        new Request('https://api.duet.so/v1/ws/acme/mcp/wiki', {
          method: 'POST',
          body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        }),
        customMcpUpstreamSource({
          server: { name: 'wiki', url: 'https://upstream.example/mcp' },
          requestMethod: 'POST',
          readCredential: async () => ({ kind: 'oauth', accessToken: 'oauth-access', tokenType }),
          recordHealth: async () => undefined,
          schedule: () => {},
        }),
        { maxToolResultBytes: 1024 },
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(result)
    },
  )

  test('forwards the MCP transport headers and none of the caller credentials', async () => {
    const upstream: Request[] = []
    const response = await forwardMcpRequest(
      recordingFetch(upstream, async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} })),
      new Request('https://api.duet.so/v1/ws/acme/mcp/wiki', {
        method: 'POST',
        headers: {
          authorization: 'Bearer duet-workspace-key',
          cookie: 'duet_session=secret',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-session-id': 'transport_1',
          'mcp-protocol-version': '2025-06-18',
          'last-event-id': '42',
          'x-unrelated': 'nope',
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      }),
      staticSource({ url: 'https://upstream.example/mcp', headers: { 'x-api-key': 'upstream' } }),
      { maxToolResultBytes: 1024 },
    )

    expect(response.status).toBe(200)
    expect(upstream).toHaveLength(1)
    const forwarded = upstream[0]!
    expect(forwarded.url).toBe('https://upstream.example/mcp')
    expect(forwarded.method).toBe('POST')
    expect(forwarded.headers.get('accept')).toBe('application/json, text/event-stream')
    expect(forwarded.headers.get('content-type')).toBe('application/json')
    expect(forwarded.headers.get('mcp-session-id')).toBe('transport_1')
    expect(forwarded.headers.get('mcp-protocol-version')).toBe('2025-06-18')
    expect(forwarded.headers.get('last-event-id')).toBe('42')
    expect(forwarded.headers.get('x-api-key')).toBe('upstream')
    expect(forwarded.headers.get('authorization')).toBeNull()
    expect(forwarded.headers.get('cookie')).toBeNull()
    expect(forwarded.headers.get('x-unrelated')).toBeNull()
    expect(await forwarded.text()).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  })

  test('releases each SSE frame as it lands instead of waiting for the stream to end', async () => {
    // The standalone GET stream an MCP client opens for server-initiated
    // messages never ends. A proxy that buffers hangs it until the function
    // times out, so this asserts the frame arrives while upstream is still open.
    const upstream = new TransformStream<Uint8Array, Uint8Array>()
    const writer = upstream.writable.getWriter()
    const encoder = new TextEncoder()

    const response = await forwardMcpRequest(
      async () =>
        new Response(upstream.readable, { headers: { 'content-type': 'text/event-stream' } }),
      new Request('https://api.duet.so/v1/ws/acme/mcp/wiki', { method: 'GET' }),
      staticSource({ url: 'https://upstream.example/mcp', headers: {} }),
      { maxToolResultBytes: 1024 },
    )

    await writer.write(encoder.encode('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n'))
    const reader = response.body!.getReader()
    const first = await reader.read()

    expect(new TextDecoder().decode(first.value)).toBe(
      'event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n',
    )
    await writer.close()
    await reader.cancel()
  })

  test('caps one oversized frame mid-stream and reports it once the stream ends', async () => {
    const outcomes: { status: number; cappedFrom?: number }[] = []
    const huge = 'h'.repeat(4000)
    const stream = [
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"tiny"}]}}\n\n',
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: huge }] },
      })}\n\n`,
    ]

    const response = await forwardMcpRequest(
      async () =>
        new Response(stream.join(''), { headers: { 'content-type': 'text/event-stream' } }),
      new Request('https://api.duet.so/v1/ws/acme/mcp/wiki', { method: 'POST', body: '{}' }),
      staticSource(
        { url: 'https://upstream.example/mcp', headers: {} },
        { settled: outcome => void outcomes.push(outcome) },
      ),
      { maxToolResultBytes: 512 },
    )
    const text = await response.text()

    expect(text.startsWith(stream[0]!)).toBe(true)
    expect(text).toContain('of 4000 bytes')
    expect(text.length).toBeLessThan(2000)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe(200)
    expect(outcomes[0]!.cappedFrom).toBeGreaterThan(4000)
  })

  test('stops an upstream that streams on without ever closing a frame', async () => {
    // The cap can only work on a whole frame, so the buffer holding a partial
    // one is bounded by nothing else. A 512-byte cap puts the ceiling at 40 KiB.
    const outcomes: McpProxyOutcome[] = []
    const chunk = new TextEncoder().encode(`event: message\ndata: ${'x'.repeat(4_000)}`)
    let sent = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1
        if (sent > 100) return controller.close()
        controller.enqueue(chunk.slice())
      },
    })

    const response = await forwardMcpRequest(
      async () => new Response(endless, { headers: { 'content-type': 'text/event-stream' } }),
      new Request('https://api.duet.so/v1/ws/acme/mcp/wiki', { method: 'POST', body: '{}' }),
      staticSource(
        { url: 'https://upstream.example/mcp', headers: {} },
        { settled: outcome => void outcomes.push(outcome) },
      ),
      { maxToolResultBytes: 512 },
    )

    await expect(response.text()).rejects.toThrow('frame')
    // It stopped reading rather than draining what the server wanted to send.
    expect(sent).toBeLessThan(20)
    expect(outcomes).toEqual([{ status: 200, failure: 'oversized_frame' }])
  })

  test('refuses a JSON body past the same ceiling before buffering all of it', async () => {
    const outcomes: McpProxyOutcome[] = []
    const response = await forwardMcpRequest(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: 'y'.repeat(60_000) } }),
          {
            headers: { 'content-type': 'application/json' },
          },
        ),
      new Request('https://api.duet.so/v1/ws/acme/mcp/wiki', { method: 'POST', body: '{}' }),
      staticSource(
        { url: 'https://upstream.example/mcp', headers: {} },
        { settled: outcome => void outcomes.push(outcome) },
      ),
      { maxToolResultBytes: 512 },
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'upstream_response_too_large' })
    expect(outcomes).toEqual([{ status: 200, failure: 'oversized_frame' }])
  })

  test('retries once against the re-resolved target and drops the stale transport session', async () => {
    const upstream: Request[] = []
    const attempts: string[] = []
    const response = await forwardMcpRequest(
      recordingFetch(upstream, async request =>
        request.url.endsWith('/refreshed')
          ? Response.json({ jsonrpc: '2.0', id: 1, result: {} })
          : new Response('unauthorized', { status: 401 }),
      ),
      new Request('https://api.duet.so/v1/ws/acme/mcp/wiki', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'transport_stale' },
        body: '{"jsonrpc":"2.0","id":1}',
      }),
      {
        sourceId: 'test-source',
        resolve: async attempt => {
          attempts.push(attempt)
          return attempt === 'first'
            ? { url: 'https://upstream.example/stale', headers: {} }
            : {
                url: 'https://upstream.example/refreshed',
                headers: {},
                resetTransportSession: true,
              }
        },
        retryable: status => status === 401,
      },
      { maxToolResultBytes: 1024 },
    )

    expect(attempts).toEqual(['first', 'after-unauthorized'])
    expect(response.status).toBe(200)
    expect(upstream.map(request => request.url)).toEqual([
      'https://upstream.example/stale',
      'https://upstream.example/refreshed',
    ])
    expect(upstream[0]!.headers.get('mcp-session-id')).toBe('transport_stale')
    expect(upstream[1]!.headers.get('mcp-session-id')).toBeNull()
    expect(await upstream[1]!.text()).toBe('{"jsonrpc":"2.0","id":1}')
  })

  test('reports an unreachable upstream to the source and still raises it to the caller', async () => {
    const outcomes: McpProxyOutcome[] = []

    const attempt = forwardMcpRequest(
      async () => {
        throw new Error('connect ECONNREFUSED')
      },
      new Request('https://api.duet.so/v1/ws/acme/mcp/wiki', { method: 'POST', body: '{}' }),
      staticSource(
        { url: 'https://upstream.example/mcp', headers: {} },
        { settled: outcome => void outcomes.push(outcome) },
      ),
      { maxToolResultBytes: 1024 },
    )

    await expect(attempt).rejects.toThrow('connect ECONNREFUSED')
    expect(outcomes).toEqual([
      { status: 502, failure: 'unreachable', error: 'connect ECONNREFUSED' },
    ])
  })

  test('sheds the upstream encoding headers a decoded body no longer describes', async () => {
    const response = await forwardMcpRequest(
      async () =>
        new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
          status: 502,
          statusText: 'Bad Gateway',
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': '9999',
            'mcp-session-id': 'upstream_1',
          },
        }),
      new Request('https://api.duet.so/v1/ws/acme/mcp/wiki', { method: 'POST', body: '{}' }),
      staticSource({ url: 'https://upstream.example/mcp', headers: {} }),
      { maxToolResultBytes: 1024 },
    )

    expect(response.status).toBe(502)
    expect(response.statusText).toBe('Bad Gateway')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('mcp-session-id')).toBe('upstream_1')
  })
})

describe('withUpstreamTimeout', () => {
  test('answers 504 when an upstream never sends its headers', async () => {
    const timed = withUpstreamTimeout(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      10,
    )

    const response = await timed('https://upstream.example/mcp')

    // A fast, unambiguous failure instead of a stall. The runner connects its
    // servers one at a time against the SDK's 60s per-request default, so a
    // silent server otherwise costs a minute of every turn start, twice.
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: 'upstream_timeout' })
  })

  test('lets a stream stay silent once its headers are in', async () => {
    // The deadline is time-to-first-byte, not the life of the stream: the
    // standalone SSE channel is silent for as long as the server has nothing
    // to say, and killing it would break the transport it exists to carry.
    const body = new TransformStream<Uint8Array, Uint8Array>()
    const timed = withUpstreamTimeout(async () => new Response(body.readable), 10)

    const response = await timed('https://upstream.example/mcp')
    await new Promise(resolve => setTimeout(resolve, 40))
    const reading = response.text()
    const writer = body.writable.getWriter()
    await writer.write(new TextEncoder().encode('late'))
    await writer.close()

    expect(response.status).toBe(200)
    expect(await reading).toBe('late')
  })
})

function staticSource(
  target: McpUpstreamTarget,
  overrides: Partial<McpUpstreamSource> = {},
): McpUpstreamSource {
  return { sourceId: 'test-source', resolve: async () => target, ...overrides }
}

function recordingFetch(
  sink: Request[],
  respond: (request: Request) => Promise<Response>,
): FetchLike {
  return async (input, init) => {
    const request = new Request(input as string, init)
    sink.push(request.clone())
    return await respond(request)
  }
}
