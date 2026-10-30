import { expect, test } from 'bun:test'

import { buildMcpServersConfig } from './mcp-servers'

const ambient = {
  apiUrl: 'https://api.duet.test',
  workspaceSlug: 'acme',
  sessionId: 'sess_1',
  apiKey: 'duet_sk_key',
}

test('every server this turn gets is addressed at ctl and bears the workspace key', () => {
  expect(
    buildMcpServersConfig({
      ...ambient,
      launch: { integrations: true, mcpServers: [{ name: 'notes' }, { name: 'tickets' }] },
    }),
  ).toEqual({
    // Composio's provider session is conversation-scoped, so its URL carries
    // the session; a custom server has no such thing and is workspace-scoped.
    integrations: {
      type: 'http',
      url: 'https://api.duet.test/v1/ws/acme/agent/sessions/sess_1/integrations/mcp',
      headers: { authorization: 'Bearer duet_sk_key' },
    },
    notes: {
      type: 'http',
      url: 'https://api.duet.test/v1/ws/acme/mcp/notes',
      headers: { authorization: 'Bearer duet_sk_key' },
    },
    tickets: {
      type: 'http',
      url: 'https://api.duet.test/v1/ws/acme/mcp/tickets',
      headers: { authorization: 'Bearer duet_sk_key' },
    },
  })
})

// The runner's opening exchange with the integrations server was three tunnel
// round trips before the model was asked anything. Addressed at this gateway,
// the exchange is a loopback the gateway already has the answers to — while a
// custom server, which the gateway does not stand in for, stays at ctl.
test('the integrations server is addressed at this gateway when it has a local origin', () => {
  expect(
    buildMcpServersConfig({
      ...ambient,
      launch: { integrations: true, mcpServers: [{ name: 'notes' }] },
      localBaseUrl: 'http://127.0.0.1:3000',
    }),
  ).toEqual({
    integrations: {
      type: 'http',
      url: 'http://127.0.0.1:3000/v1/agent/sessions/sess_1/integrations/mcp',
      headers: { authorization: 'Bearer duet_sk_key' },
    },
    notes: {
      type: 'http',
      url: 'https://api.duet.test/v1/ws/acme/mcp/notes',
      headers: { authorization: 'Bearer duet_sk_key' },
    },
  })
})

// L1's bite: the gateway used to bail whenever `integrations` was absent, so a
// workspace with custom servers and no Composio connection got no MCP at all.
test('custom servers arrive without Composio, and Composio arrives without them', () => {
  expect(
    buildMcpServersConfig({ ...ambient, launch: { mcpServers: [{ name: 'notes' }] } }),
  ).toEqual({
    notes: {
      type: 'http',
      url: 'https://api.duet.test/v1/ws/acme/mcp/notes',
      headers: { authorization: 'Bearer duet_sk_key' },
    },
  })
  expect(buildMcpServersConfig({ ...ambient, launch: { integrations: true } })).toEqual({
    integrations: {
      type: 'http',
      url: 'https://api.duet.test/v1/ws/acme/agent/sessions/sess_1/integrations/mcp',
      headers: { authorization: 'Bearer duet_sk_key' },
    },
  })
})

test('a turn with no servers gets no config at all rather than an empty map', () => {
  expect(buildMcpServersConfig({ ...ambient, launch: {} })).toBeNull()
  expect(buildMcpServersConfig({ ...ambient, launch: { mcpServers: [] } })).toBeNull()
})

// The launch marker is re-read from the VM's disk by a parser that re-validates
// four fields by name, so this one arrives untyped. Dropping it costs the turn
// its custom tools; trusting it crashes the spawn.
test('a persisted marker that is not a server list is dropped, not spread', () => {
  for (const mcpServers of ['notes', [{ name: 'has spaces' }], [{ nome: 'notes' }], [{}], 3]) {
    expect(
      buildMcpServersConfig({
        ...ambient,
        launch: { integrations: true, mcpServers } as never,
      }),
    ).toEqual({
      integrations: {
        type: 'http',
        url: 'https://api.duet.test/v1/ws/acme/agent/sessions/sess_1/integrations/mcp',
        headers: { authorization: 'Bearer duet_sk_key' },
      },
    })
  }
})

// `McpServersConfig` is a Record, so a server named `integrations` would not
// collide with the Composio entry — it would silently replace it. Registration
// refuses the name; this is the second lock, on the value that reaches spawn.
test('a marker naming the reserved server cannot displace the Composio entry', () => {
  expect(
    buildMcpServersConfig({
      ...ambient,
      launch: {
        integrations: true,
        mcpServers: [{ name: 'integrations' }] as never,
      },
    })?.integrations?.url,
  ).toBe('https://api.duet.test/v1/ws/acme/agent/sessions/sess_1/integrations/mcp')
})

test('slug and session identifiers are escaped into the path', () => {
  expect(
    buildMcpServersConfig({
      ...ambient,
      workspaceSlug: 'a c/me',
      sessionId: 'sess/1',
      launch: { integrations: true, mcpServers: [{ name: 'notes' }] },
    }),
  ).toMatchObject({
    integrations: {
      url: 'https://api.duet.test/v1/ws/a%20c%2Fme/agent/sessions/sess%2F1/integrations/mcp',
    },
    notes: { url: 'https://api.duet.test/v1/ws/a%20c%2Fme/mcp/notes' },
  })
})
