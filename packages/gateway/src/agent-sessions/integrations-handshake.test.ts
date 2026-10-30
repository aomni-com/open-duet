import { expect, test } from 'bun:test'

import {
  createIntegrationsHandshakeWarmer,
  HANDSHAKE_PROTOCOL_VERSION,
} from './integrations-handshake'

const TARGET = {
  url: 'https://ctl.test/v1/ws/acme/agent/sessions/sess_1/integrations/mcp',
  headers: { authorization: 'Bearer duet-key' },
}

type UpstreamRequest = {
  url: string
  headers: Record<string, string>
  method: string
  params: unknown
}
function upstream(sink: UpstreamRequest[]) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body)) as {
      id: number
      method: string
      params: unknown
    }
    sink.push({
      url: String(_input),
      headers: Object.fromEntries(new Headers(init?.headers)),
      method: message.method,
      params: message.params,
    })
    if (message.method === 'initialize') {
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'composio' } } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    if (message.method === 'tools/list') {
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'GMAIL_SEND' }] },
      })
    }
    return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601 } })
  }
}

test('a warmed session answers its own handshake under the runner ids and asks upstream once', async () => {
  const asked: UpstreamRequest[] = []
  const warmer = createIntegrationsHandshakeWarmer({ fetch: upstream(asked) })

  warmer.warm('sess_1', TARGET)
  const initialize = await warmer.answer(
    'sess_1',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'init-9',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {} },
    }),
  )
  const initialized = await warmer.answer(
    'sess_1',
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  )
  const list = await warmer.answer(
    'sess_1',
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
  )

  expect(await initialize!.json()).toEqual({
    jsonrpc: '2.0',
    id: 'init-9',
    result: {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'composio' },
    },
  })
  expect(initialized!.status).toBe(202)
  expect(await list!.json()).toEqual({
    jsonrpc: '2.0',
    id: 3,
    result: { tools: [{ name: 'GMAIL_SEND' }] },
  })
  expect(asked).toEqual([
    {
      url: 'https://ctl.test/v1/ws/acme/agent/sessions/sess_1/integrations/mcp',
      headers: {
        authorization: 'Bearer duet-key',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      method: 'initialize',
      params: {
        protocolVersion: HANDSHAKE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: expect.stringMatching(/\S/), version: expect.stringMatching(/\S/) },
      },
    },
    {
      url: 'https://ctl.test/v1/ws/acme/agent/sessions/sess_1/integrations/mcp',
      headers: {
        authorization: 'Bearer duet-key',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      method: 'tools/list',
      params: {},
    },
  ])
})

test('everything the exchange did not establish goes upstream', async () => {
  const warmer = createIntegrationsHandshakeWarmer({ fetch: upstream([]) })
  warmer.warm('sess_1', TARGET)

  expect(
    await warmer.answer(
      'sess_1',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'GMAIL_SEND' },
      }),
    ),
  ).toBeNull()
  expect(
    await warmer.answer(
      'sess_other',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    ),
  ).toBeNull()
  expect(await warmer.answer('sess_1', 'not json')).toBeNull()
})

test('a failed exchange leaves the runner to its own handshake', async () => {
  const failures: Array<Record<string, unknown>> = []
  const warmer = createIntegrationsHandshakeWarmer({
    fetch: async () => new Response('nope', { status: 503 }),
    log: fields => {
      failures.push(fields)
    },
  })
  warmer.warm('sess_1', TARGET)

  expect(
    await warmer.answer(
      'sess_1',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    ),
  ).toBeNull()
  expect(failures).toEqual([
    {
      event: 'integrations_handshake_failed',
      sessionId: 'sess_1',
      error: 'initialize answered 503',
    },
  ])
})

test('a later input replaces the held answers rather than serving the old turn', async () => {
  let version = 0
  const warmer = createIntegrationsHandshakeWarmer({
    fetch: async (_input, init) => {
      const message = JSON.parse(String(init?.body)) as { id: number; method: string }
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result:
          message.method === 'initialize'
            ? { protocolVersion: '2025-03-26' }
            : { tools: [{ name: `v${version}` }] },
      })
    },
  })
  version = 1
  warmer.warm('sess_1', TARGET)
  await warmer.answer('sess_1', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  version = 2
  warmer.warm('sess_1', TARGET)

  const list = await warmer.answer(
    'sess_1',
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  )
  expect(await list!.json()).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'v2' }] } })
})
