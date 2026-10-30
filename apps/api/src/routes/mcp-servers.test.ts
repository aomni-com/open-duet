import { describe, expect, test } from 'bun:test'

import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { Hono } from 'hono'

import { hashApiKey, MAX_MCP_SERVERS_PER_WORKSPACE, type FetchLike } from '@repo/contract'
import { createFakeOAuthIssuer, FAKE_OAUTH_ISSUER_MOUNT_PATH } from '@repo/fake-oauth-issuer'

import {
  duetMcpClientMetadataDocument,
  MCP_CLIENT_METADATA_PATH,
  MCP_OAUTH_CALLBACK_PATH,
} from '../mcp/registration'
import type { ApiVariables } from '../shared'
import { registerMcpServerRoutes } from './mcp-servers'

const SERVER_URL = 'https://mcp.example.test/mcp'

const resolveHost = async (hostname: string) =>
  hostname === 'mcp.example.test' ? ['203.0.113.10'] : ['203.0.113.11']

interface Tool {
  name: string
  inputSchema: Record<string, unknown>
}

function tool(name: string): Tool {
  return { name, inputSchema: { type: 'object', properties: {} } }
}

/** A no-auth streamable-HTTP MCP server, framed the way real ones answer. */
function mcpServer(tools: Tool[] = [tool('search')]): FetchLike {
  return async (input, init) => {
    const request = new Request(String(input), init as RequestInit)
    if (request.method === 'GET') return new Response(null, { status: 405 })
    const message = (await request.json()) as { id?: number; method: string }
    if (message.id === undefined) return new Response(null, { status: 202 })
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'example', version: '1.0.0' },
          }
        : { tools }
    return new Response(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
}

describe('custom MCP server lifecycle', () => {
  test('probes without writing anything, and reports the per-turn cost', async () => {
    const convex = new InMemoryMcpServers()
    const app = testApp(mcpServer([tool('search'), tool('fetch')]), convex)

    const response = await app.request('/v1/ws/acme/mcp-servers/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deepwiki', url: SERVER_URL }),
    })

    expect(response.status).toBe(200)
    const probe = (await response.json()) as { auth: string; toolCount: number }
    expect(probe.auth).toBe('none')
    expect(probe.toolCount).toBe(2)
    expect(convex.servers).toEqual([])
  })

  test('adds a server the probe reached, carrying the probe’s measurements onto the row', async () => {
    const convex = new InMemoryMcpServers()
    const app = testApp(mcpServer([tool('search'), tool('fetch')]), convex)

    const response = await app.request('/v1/ws/acme/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deepwiki', url: SERVER_URL, label: 'DeepWiki' }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      name: 'deepwiki',
      label: 'DeepWiki',
      url: SERVER_URL,
      authKind: 'none',
      state: 'ready',
      toolCount: 2,
    })
    expect(convex.servers.map(server => server.name)).toEqual(['deepwiki'])
  })

  test('refuses a name that would collide with the runner’s encoding or Composio', async () => {
    const convex = new InMemoryMcpServers()
    const app = testApp(mcpServer(), convex)
    const add = async (name: string) =>
      await app.request('/v1/ws/acme/mcp-servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, url: SERVER_URL }),
      })

    // `my__server__TOOL` has two readings, so the timeline could not decode it.
    expect((await add('my__server')).status).toBe(400)
    // `McpServersConfig` is a Record: this name would silently displace the
    // Composio entry rather than collide with it.
    expect((await add('integrations')).status).toBe(400)
    expect((await add('a space')).status).toBe(400)
    expect(convex.servers).toEqual([])
  })

  test('refuses a duplicate name and the workspace cap without touching the upstream', async () => {
    const convex = new InMemoryMcpServers()
    const app = testApp(mcpServer(), convex)
    const add = async (name: string) =>
      await app.request('/v1/ws/acme/mcp-servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, url: SERVER_URL }),
      })

    expect((await add('deepwiki')).status).toBe(201)
    const duplicate = await add('deepwiki')
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'duplicate_name' })

    for (let index = 1; index < MAX_MCP_SERVERS_PER_WORKSPACE; index += 1) {
      expect((await add(`server-${index}`)).status).toBe(201)
    }
    const overflowing = await add('one-too-many')
    expect(overflowing.status).toBe(409)
    expect(await overflowing.json()).toEqual({ error: 'server_limit' })
    expect(convex.servers).toHaveLength(MAX_MCP_SERVERS_PER_WORKSPACE)
  })

  test('leaves no row behind when the probe fails', async () => {
    const convex = new InMemoryMcpServers()
    const unreachable = testApp(async () => new Response('down', { status: 502 }), convex)

    const response = await unreachable.request('/v1/ws/acme/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deepwiki', url: SERVER_URL }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'server_unreachable' })
    expect(convex.servers).toEqual([])
  })

  test('will not fetch a private address, at add time or across a redirect', async () => {
    const convex = new InMemoryMcpServers()
    const reached: string[] = []
    const redirecting: FetchLike = async input => {
      reached.push(String(input))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data' },
      })
    }
    const app = testApp(redirecting, convex)

    const direct = await app.request('/v1/ws/acme/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'metadata', url: 'https://169.254.169.254/mcp' }),
    })
    expect(direct.status).toBe(400)
    expect(await direct.json()).toEqual({ error: 'url_not_allowed' })
    // Refused before any packet left: the guard runs ahead of the fetch.
    expect(reached).toEqual([])

    const viaRedirect = await app.request('/v1/ws/acme/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sneaky', url: SERVER_URL }),
    })
    expect(viaRedirect.status).toBe(400)
    expect(await viaRedirect.json()).toEqual({ error: 'url_not_allowed' })
    expect(reached).toEqual([SERVER_URL])
    expect(convex.servers).toEqual([])
  })

  test('stores a pasted token where no response can reach it', async () => {
    const convex = new InMemoryMcpServers()
    const seen: Array<string | null> = []
    const authenticated: FetchLike = async (input, init) => {
      const request = new Request(String(input), init as RequestInit)
      seen.push(request.headers.get('authorization'))
      return await mcpServer()(input, init)
    }
    const app = testApp(authenticated, convex)

    const added = await app.request('/v1/ws/acme/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'ticketing',
        url: SERVER_URL,
        auth: { kind: 'static', token: 'paste-me' },
      }),
    })

    expect(added.status).toBe(201)
    expect(seen).toContain('Bearer paste-me')
    // A pasted static token is ready at once: unlike OAuth there is no round
    // trip left for a human to make.
    expect(await added.text()).not.toContain('paste-me')
    expect(convex.credentials).toEqual([
      { serverName: 'ticketing', kind: 'static', accessToken: 'paste-me' },
    ])

    const listed = await app.request('/v1/ws/acme/mcp-servers')
    expect(listed.status).toBe(200)
    const body = await listed.text()
    expect(body).not.toContain('paste-me')
    expect(JSON.parse(body)).toEqual({
      items: [
        {
          name: 'ticketing',
          label: 'ticketing',
          url: SERVER_URL,
          authKind: 'static',
          state: 'ready',
          toolCount: 1,
          estimatedPromptBytes: expect.any(Number),
          droppedToolNames: [],
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      ],
      nextCursor: null,
    })
  })

  test('refuses the credential the server did not ask for, in either direction', async () => {
    const convex = new InMemoryMcpServers()
    const challenging: FetchLike = async () =>
      new Response('unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="mcp"' },
      })

    const asNoAuth = await testApp(challenging, convex).request('/v1/ws/acme/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'linear', url: SERVER_URL, auth: { kind: 'none' } }),
    })
    expect(asNoAuth.status).toBe(400)
    expect(await asNoAuth.json()).toEqual({ error: 'auth_required' })

    const asOauth = await testApp(mcpServer(), convex).request('/v1/ws/acme/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deepwiki', url: SERVER_URL, auth: { kind: 'oauth' } }),
    })
    expect(asOauth.status).toBe(400)
    expect(await asOauth.json()).toEqual({ error: 'auth_not_required' })
    expect(convex.servers).toEqual([])
  })

  test('scopes a server to agents and back to every agent through one route', async () => {
    const convex = new InMemoryMcpServers()
    const app = testApp(mcpServer(), convex)
    await app.request('/v1/ws/acme/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deepwiki', url: SERVER_URL }),
    })

    const scoped = await app.request('/v1/ws/acme/mcp-servers/deepwiki/agent-policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedAgentIds: ['agent_1'] }),
    })
    expect(scoped.status).toBe(200)
    expect(await scoped.json()).toEqual({ name: 'deepwiki', allowedAgentIds: ['agent_1'] })

    // Absent is the third state — every agent — and clearing must reach it,
    // not an empty list, which means nobody.
    const cleared = await app.request('/v1/ws/acme/mcp-servers/deepwiki/agent-policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ name: 'deepwiki' })
    expect(convex.policies).toEqual([])

    const missing = await app.request('/v1/ws/acme/mcp-servers/nothing-here/agent-policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(missing.status).toBe(404)
  })

  test('removes a server idempotently and takes its credential with it', async () => {
    const convex = new InMemoryMcpServers()
    const upstream: Request[] = []
    const app = testApp(recording(upstream, mcpServer()), convex)
    await app.request('/v1/ws/acme/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'ticketing',
        url: SERVER_URL,
        auth: { kind: 'static', token: 'paste-me' },
      }),
    })
    upstream.length = 0

    const removed = await app.request('/v1/ws/acme/mcp-servers/ticketing', { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({
      name: 'ticketing',
      removed: true,
      // A pasted token has no discovered revocation endpoint, and a PAT is the
      // user's to revoke where it was issued. Duet attempts nothing.
      revoked: 'not_supported',
      registration: 'not_supported',
    })
    expect(upstream).toEqual([])
    expect(convex.credentials).toEqual([])

    // Re-running a removal is not an error; it is the same end state.
    const again = await app.request('/v1/ws/acme/mcp-servers/ticketing', { method: 'DELETE' })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({
      name: 'ticketing',
      removed: false,
      revoked: 'not_supported',
      registration: 'not_supported',
    })
  })

  test('answers a caller without the integrations capability before reaching Convex', async () => {
    const convex = new InMemoryMcpServers()
    const app = testApp(mcpServer(), convex, { ...authFixture(), scopes: [] })

    const response = await app.request('/v1/ws/acme/mcp-servers')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'insufficient_scope',
      scope: 'ws:acme:integrations',
    })
  })
})

describe('custom MCP server proxy', () => {
  test.each([
    { method: 'GET', status: 405, errorCode: undefined },
    { method: 'DELETE', status: 405, errorCode: undefined },
    { method: 'POST', status: 405, errorCode: 'upstream_error' },
    { method: 'GET', status: 401, errorCode: 'unauthorized' },
    { method: 'GET', status: 500, errorCode: 'upstream_error' },
  ])(
    'health distinguishes optional transport refusals: $method $status',
    async ({ method, status, errorCode }) => {
      const convex = new InMemoryMcpServers()
      const background = backgroundWork()
      const healthy = testApp(mcpServer(), convex, authFixture(), {
        waitUntil: background.waitUntil,
      })
      await addServer(healthy, 'deepwiki')
      const success = await healthy.request('/v1/ws/acme/mcp/deepwiki', {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      })
      await success.text()
      await background.settle()

      const app = testApp(async () => new Response(null, { status }), convex, authFixture(), {
        waitUntil: background.waitUntil,
      })
      const response = await app.request('/v1/ws/acme/mcp/deepwiki', { method })
      await response.text()
      await background.settle()

      expect(response.status).toBe(status)
      expect(convex.health).toEqual([
        { serverName: 'deepwiki', outcome: 'success' },
        ...(errorCode === undefined
          ? []
          : [{ serverName: 'deepwiki', outcome: 'error', errorCode }]),
      ])
    },
  )

  test('attaches the stored credential and forwards MCP bytes both ways', async () => {
    const convex = new InMemoryMcpServers()
    const upstream: Request[] = []
    const app = testApp(recording(upstream, mcpServer()), convex)
    await addServer(app, 'ticketing', { kind: 'static', token: 'paste-me' })
    upstream.length = 0

    const response = await app.request('/v1/ws/acme/mcp/ticketing', {
      method: 'POST',
      headers: {
        // The runner's own Duet credential. It authorizes THIS hop and must
        // never be the one the third party sees.
        authorization: 'Bearer duet-workspace-key',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'transport_1',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"tools"')
    expect(upstream).toHaveLength(1)
    const forwarded = upstream[0]!
    expect(forwarded.url).toBe(SERVER_URL)
    expect(forwarded.headers.get('authorization')).toBe('Bearer paste-me')
    expect(forwarded.headers.get('mcp-session-id')).toBe('transport_1')
    expect(await forwarded.text()).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  })

  test('answers a server this workspace never registered with 404, not an outage', async () => {
    const convex = new InMemoryMcpServers()
    const upstream: Request[] = []
    const app = testApp(recording(upstream, mcpServer()), convex)

    const response = await app.request('/v1/ws/acme/mcp/nothing-here', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })

    // 503 would read as "Duet is down" and have the runner retry a server that
    // does not exist.
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
    expect(upstream).toEqual([])
    expect(convex.health).toEqual([])
  })

  test('records health off the request’s critical path, not during it', async () => {
    const convex = new InMemoryMcpServers()
    const background = backgroundWork()
    const app = testApp(mcpServer(), convex, authFixture(), { waitUntil: background.waitUntil })
    await addServer(app, 'deepwiki')
    // A health write that has not come back yet. The tool call must not be
    // waiting on it: these writes land in the same `mcpServers` index range
    // every dispatch in this workspace reads, so one on the critical path sets
    // the proxy against the agent's own turns — exactly when it is busiest.
    let landed = () => {}
    convex.blockHealth = new Promise<void>(resolve => {
      landed = resolve
    })

    const response = await app.request('/v1/ws/acme/mcp/deepwiki', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('"tools"')
    expect(convex.health).toEqual([])
    expect(background.pending).toBe(1)

    landed()
    await background.settle()
    expect(convex.health).toEqual([{ serverName: 'deepwiki', outcome: 'success' }])
  })

  test('passes an upstream failure through and records what kind it was', async () => {
    const convex = new InMemoryMcpServers()
    const background = backgroundWork()
    // The probe at add time reaches a working server; the proxied call does
    // not, so the two legs run against two upstreams over one set of rows.
    await addServer(testApp(mcpServer(), convex), 'deepwiki')
    const app = testApp(
      async () => new Response('upstream exploded', { status: 500 }),
      convex,
      authFixture(),
      { waitUntil: background.waitUntil },
    )

    const response = await app.request('/v1/ws/acme/mcp/deepwiki', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
    await response.text()
    await background.settle()

    expect(response.status).toBe(500)
    expect(convex.health).toEqual([
      { serverName: 'deepwiki', outcome: 'error', errorCode: 'upstream_error' },
    ])
  })

  test('records a rejected credential as unauthorized, and never the body that came with it', async () => {
    const convex = new InMemoryMcpServers()
    const background = backgroundWork()
    await addServer(testApp(mcpServer(), convex), 'ticketing', {
      kind: 'static',
      token: 'paste-me',
    })
    const app = testApp(
      async () => new Response('token "paste-me" is expired', { status: 401 }),
      convex,
      authFixture(),
      { waitUntil: background.waitUntil },
    )

    const response = await app.request('/v1/ws/acme/mcp/ticketing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
    await response.text()
    await background.settle()

    // A code, never a body: an upstream error body can quote the very
    // credential the separate credential table exists to protect.
    expect(convex.health).toEqual([
      { serverName: 'ticketing', outcome: 'error', errorCode: 'unauthorized' },
    ])
    expect(JSON.stringify(convex.health)).not.toContain('paste-me')
  })

  test('caps an oversized tool result on this path too, from the one owner', async () => {
    const convex = new InMemoryMcpServers()
    const background = backgroundWork()
    await addServer(testApp(mcpServer(), convex), 'deepwiki')
    // Slice 00 measured a real 1.3 MB result from an ordinary public server, so
    // this is the shape of a normal call, not an attack.
    const huge = 'x'.repeat(400_000)
    const app = testApp(
      async () =>
        new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: huge }], structuredContent: { text: huge } },
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      convex,
      authFixture(),
      { waitUntil: background.waitUntil },
    )

    const response = await app.request('/v1/ws/acme/mcp/deepwiki', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    })
    const body = await response.text()
    await background.settle()

    expect(response.status).toBe(200)
    // Still a parseable frame — the cap rewrites `result`, it never cuts bytes.
    expect(body.length).toBeLessThan(huge.length)
    expect(body).toContain('of 400000 bytes')
    expect(convex.health).toEqual([
      { serverName: 'deepwiki', outcome: 'error', errorCode: 'result_too_large' },
    ])
  })

  test('gives up on a silent upstream in seconds rather than the SDK’s minute', async () => {
    const convex = new InMemoryMcpServers()
    const background = backgroundWork()
    await addServer(testApp(mcpServer(), convex), 'deepwiki')
    // A server that accepts the connection and then says nothing. The runner
    // connects its servers serially with a 60s per-request timeout, so every
    // turn start would pay 60s on `connect` plus 60s on `listTools` for this
    // one server.
    const silent: FetchLike = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const app = testApp(silent, convex, authFixture(), {
      waitUntil: background.waitUntil,
      upstreamTimeoutMs: 20,
    })

    const response = await app.request('/v1/ws/acme/mcp/deepwiki', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
    await response.text()
    await background.settle()

    expect(response.status).toBe(504)
    expect(convex.health).toEqual([
      { serverName: 'deepwiki', outcome: 'error', errorCode: 'timeout' },
    ])
  })

  test('turns a dead upstream into a 502 and records it as unreachable', async () => {
    const convex = new InMemoryMcpServers()
    const background = backgroundWork()
    await addServer(testApp(mcpServer(), convex), 'deepwiki')
    const app = testApp(
      async () => {
        throw new Error('connect ECONNREFUSED')
      },
      convex,
      authFixture(),
      { waitUntil: background.waitUntil },
    )

    const response = await app.request('/v1/ws/acme/mcp/deepwiki', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
    await background.settle()

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'upstream_unreachable' })
    expect(convex.health).toEqual([
      { serverName: 'deepwiki', outcome: 'error', errorCode: 'unreachable' },
    ])
  })

  test('answers Reconnect on a refused grant without sending a byte upstream', async () => {
    const convex = new InMemoryMcpServers()
    const upstream: Request[] = []
    const background = backgroundWork()
    const app = testApp(recording(upstream, mcpServer()), convex, authFixture(), {
      waitUntil: background.waitUntil,
    })
    await addServer(app, 'deepwiki', { kind: 'static', token: 'pasted-token' })
    upstream.length = 0
    // The mark a terminal refresh failure leaves. Only a connect clears it.
    convex.credentials[0]!.invalidAt = 5_000

    const response = await app.request('/v1/ws/acme/mcp/deepwiki', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
    await background.settle()

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'reauth_required' })
    // The refusal has already been paid for once. Spending an upstream round
    // trip — or a token-endpoint call — to be told again is the cost this
    // short-circuit exists to avoid.
    expect(upstream).toEqual([])
    expect(convex.health).toEqual([
      { serverName: 'deepwiki', outcome: 'error', errorCode: 'reauth_required' },
    ])
  })

  test('works in a deployment that has no Composio key at all', async () => {
    const composioKey = process.env.COMPOSIO_API_KEY
    delete process.env.COMPOSIO_API_KEY
    try {
      const convex = new InMemoryMcpServers()
      const app = testApp(mcpServer(), convex)
      await addServer(app, 'deepwiki')

      const response = await app.request('/v1/ws/acme/mcp/deepwiki', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      })

      // The Composio transport next door answers 503 without this key. A custom
      // server has no Composio in it anywhere, and a copied key check here
      // would recreate L1's dead configuration in the route.
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('"tools"')
    } finally {
      if (composioKey !== undefined) process.env.COMPOSIO_API_KEY = composioKey
    }
  })
})

/**
 * The whole consent round trip, against the fake issuer slice 14 built: a real
 * RFC 9728 challenge, a real consent page, real PKCE, and an `iss` on the
 * authorization response that no third-party server tested actually emits.
 */
describe('custom MCP server consent', () => {
  test('connect, approve, callback: tokens land and the row goes live', async () => {
    const { app, convex, issuer } = consentApp()
    expect(issuerRequests(issuer, '/token')).toEqual([])
    await addOAuthServer(app)

    const authorizeUrl = await connect(app)
    const redirected = await approve(issuer, authorizeUrl)
    const callback = await app.request(callbackPath(redirected))

    expect(callback.status).toBe(302)
    // A top-level navigation back to a Duet page — never a rendered consent
    // screen and never an iframe, which most third parties refuse outright.
    expect(callback.headers.get('location')).toBe('https://app.duet.so/w/acme/integrations')
    expect(convex.credentials).toEqual([
      {
        serverName: 'linear',
        kind: 'oauth',
        accessToken: expect.stringMatching(/^fake-oauth-access-/) as unknown as string,
        refreshToken: expect.stringMatching(/^fake-oauth-refresh-/) as unknown as string,
        // RFC 8707, recorded at mint because slice 10 must send the SAME
        // audience on refresh.
        resource: OAUTH_SERVER_URL,
        authorizationServer: MOUNT_URL,
      },
    ])
    expect(convex.servers.map(server => server.state)).toEqual(['ready'])
    // Redeemed, so the row is gone and the code cannot be spent twice.
    expect(convex.authorizations).toEqual([])
    // The counterpart to the `iss` refusals below, which assert this list is
    // EMPTY: exactly one exchange happens, and only when the check passed.
    expect(issuerRequests(issuer, '/token')).toHaveLength(1)
    // RFC 8707 wants the audience on BOTH requests, and the same one twice —
    // the authorize URL carries it (asserted below) and so does this.
    expect(issuerRequests(issuer, '/token')[0]?.body).toMatchObject({
      resource: OAUTH_SERVER_URL,
      grant_type: 'authorization_code',
    })
  })

  test('the descriptor IS the state, and only its hash is stored', async () => {
    const { app, convex } = consentApp()
    await addOAuthServer(app)

    const authorizeUrl = new URL(await connect(app))

    const state = authorizeUrl.searchParams.get('state') ?? ''
    expect(state.length).toBeGreaterThan(0)
    // No second query parameter invented beside `state`: Duet builds this URL,
    // so the slot the protocol reserves is the one used.
    expect(authorizeUrl.searchParams.get('nonce')).toBeNull()
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizeUrl.searchParams.get('resource')).toBe(OAUTH_SERVER_URL)
    const pending = convex.authorizations[0]!
    // `state` lands in the authorization server's logs and the browser's
    // history, so the row holds a hash of it and nothing else.
    expect(pending.hashedState).not.toBe(state)
    expect(pending.hashedState).toBe(await hashApiKey(state))
    expect(JSON.stringify(convex.authorizations)).not.toContain(state)
    expect(pending.expectedIssuer).toBe(MOUNT_URL)
  })

  test('an iss the issuer did not sign is refused before the code is spent', async () => {
    const { app, convex, issuer } = consentApp()
    await addOAuthServer(app)
    const redirected = await approve(issuer, await connect(app))

    const tampered = new URL(redirected)
    tampered.searchParams.set('iss', 'https://evil.test')
    // Attacker-supplied error text rides along; none of it may be acted on.
    tampered.searchParams.set('error_description', 'Session expired, retry at evil.test')
    const callback = await app.request(callbackPath(tampered.toString()))

    expect(callback.status).toBe(400)
    expect(await callback.json()).toEqual({ error: 'issuer_mismatch' })
    // The code never reached a token endpoint, so nothing was stored and the
    // server is still waiting for a human.
    expect(convex.credentials).toEqual([])
    expect(convex.servers.map(server => server.state)).toEqual(['needs_auth'])
    expect(issuerRequests(issuer, '/token')).toEqual([])
  })

  /**
   * Also the guard on the strip-mode trap. The issuer advertises
   * `authorization_response_iss_parameter_supported`, and the SDK's parsed
   * metadata drops it — so anyone who switches this branch to read from the
   * parsed object turns this refusal into a 302.
   */
  test('an issuer that advertises iss support must send one', async () => {
    const { app, convex, issuer } = consentApp()
    await addOAuthServer(app)
    const redirected = new URL(await approve(issuer, await connect(app)))
    redirected.searchParams.delete('iss')

    const callback = await app.request(callbackPath(redirected.toString()))

    expect(callback.status).toBe(400)
    expect(await callback.json()).toEqual({ error: 'issuer_missing' })
    expect(convex.credentials).toEqual([])
  })

  test('a replayed callback finds nothing, and a tampered state is not a state', async () => {
    const { app, convex, issuer } = consentApp()
    await addOAuthServer(app)
    const redirected = await approve(issuer, await connect(app))

    expect((await app.request(callbackPath(redirected))).status).toBe(302)
    const replayed = await app.request(callbackPath(redirected))

    expect(replayed.status).toBe(400)
    expect(await replayed.json()).toEqual({ error: 'authorization_not_found' })
    // One grant, from one approval: the replay wrote nothing on top of it.
    expect(convex.credentials).toHaveLength(1)

    const forged = new URL(redirected)
    forged.searchParams.set('state', `${forged.searchParams.get('state')}x`)
    const tampered = await app.request(callbackPath(forged.toString()))
    expect(tampered.status).toBe(400)
    expect(await tampered.json()).toEqual({ error: 'invalid_state' })
  })

  test('refuses to consent into a redirect that is not a Duet page', async () => {
    const { app, convex } = consentApp()
    await addOAuthServer(app)

    const response = await app.request('/v1/ws/acme/mcp-servers/linear/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirectTo: 'https://evil.test/steal' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'redirect_not_allowed' })
    // Refused before a single byte went to the third party.
    expect(convex.authorizations).toEqual([])
  })

  test('refuses when the two copies of the destination disagree', async () => {
    const { app, convex, issuer } = consentApp()
    await addOAuthServer(app)
    const redirected = await approve(issuer, await connect(app))
    // The state and the row carry the same destination, written together. If
    // they ever disagree the halves came from different attempts — and the
    // redirect is the one thing this callback does that a human then trusts.
    convex.authorizations[0]!.redirectTo = 'https://app.duet.so/w/acme/settings'

    const callback = await app.request(callbackPath(redirected))

    expect(callback.status).toBe(400)
    expect(await callback.json()).toEqual({ error: 'redirect_not_allowed' })
    // Refused before the code was spent: a refusal that exchanges first leaves
    // a grant on the third party that nobody in Duet asked for.
    expect(issuerRequests(issuer, '/token')).toEqual([])
    expect(convex.credentials).toEqual([])
  })

  test('a denial is reported in Duet’s words, not the authorization server’s', async () => {
    const { app, convex, issuer } = consentApp()
    await addOAuthServer(app)
    const denied = await approve(issuer, await connect(app), 'deny')

    const callback = await app.request(callbackPath(denied))

    expect(callback.status).toBe(400)
    expect(await callback.json()).toEqual({ error: 'authorization_denied' })
    expect(convex.credentials).toEqual([])
  })

  test('reuses the registration the authorize leg used instead of minting a second', async () => {
    // No `clientMetadataFetch`, so the issuer advertises no CIMD and D7 falls
    // through to the DCR branch — the cold path, and the only one that can
    // leave a client behind on somebody else's server.
    const { app, convex, issuer } = consentApp({ cimd: false })
    await addOAuthServer(app)
    const redirected = await approve(issuer, await connect(app))

    const callback = await app.request(callbackPath(redirected))

    expect(callback.status).toBe(302)
    expect(convex.registrations).toHaveLength(1)
    // One POST /register for the whole round trip. A callback that resolved
    // registration the way the authorize leg does would mint a second client
    // mid-flow, and the code would be redeemed by a client that never asked
    // for it.
    expect(issuerRequests(issuer, '/register')).toHaveLength(1)
    expect(convex.credentials[0]).toMatchObject({
      registrationId: convex.registrations[0]!.id,
    })
  })

  test('refuses connect on a server that never asked for consent', async () => {
    const app = testApp(mcpServer(), new InMemoryMcpServers())
    await addServer(app, 'deepwiki')

    const response = await app.request('/v1/ws/acme/mcp-servers/deepwiki/connect', {
      method: 'POST',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'auth_not_required' })
  })

  test('the callback carries no Duet credential, so it is rate limited instead', async () => {
    const { app, convex } = consentApp()
    convex.rateLimited = true

    const response = await app.request(`${MCP_OAUTH_CALLBACK_PATH}?state=whatever`)

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('42')
  })
})

test('publishes one stable client id metadata document, unauthenticated', async () => {
  const app = testApp(mcpServer(), new InMemoryMcpServers())

  const response = await app.request(MCP_CLIENT_METADATA_PATH)

  expect(response.status).toBe(200)
  // D24: the document names the URL it is served from, because that URL IS
  // Duet's `client_id` — an authorization server resolves one from the other.
  expect(await response.json()).toEqual({
    client_id: `https://api.duet.test${MCP_CLIENT_METADATA_PATH}`,
    client_name: 'Duet',
    client_uri: 'https://duet.so',
    redirect_uris: ['https://api.duet.test/v1/mcp-servers/oauth/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })
})

describe('custom MCP server disconnect', () => {
  test('deletes the credential even when the revocation endpoint refuses', async () => {
    const attempted: Array<Record<string, string>> = []
    const fixture = consentApp({
      fault: request => {
        if (!request.url.endsWith('/revoke')) return undefined
        attempted.push({ method: request.method })
        return Response.json({ error: 'server_error' }, { status: 500 })
      },
    })
    const { app, convex } = fixture
    await consented(fixture)

    const removed = await app.request('/v1/ws/acme/mcp-servers/linear', { method: 'DELETE' })

    expect(removed.status).toBe(200)
    // Recorded as failed, and the row goes anyway: Duet never keeps a token it
    // has been told to forget, whatever the authorization server answered.
    expect(await removed.json()).toEqual({
      name: 'linear',
      removed: true,
      revoked: 'failed',
      // CIMD: Duet's `client_id` is a URL it publishes, so there is no
      // registration anywhere to delete. D18's orphan problem never arises.
      registration: 'not_supported',
    })
    expect(attempted).toHaveLength(2)
    expect(convex.credentials).toEqual([])
    expect(convex.servers).toEqual([])
  })

  test('keeps a shared registration until the last server behind it goes', async () => {
    // The DCR branch: no CIMD, so this workspace really does hold a client
    // registration on the third party — the only case with anything to delete.
    const fixture = consentApp({ cimd: false })
    const { app, convex, issuer } = fixture
    await consented(fixture, 'linear')
    await consented(fixture, 'linear_two', `${OAUTH_SERVER_URL}?tenant=two`)
    // D18: one registration for the pair, not one each.
    expect(convex.registrations).toHaveLength(1)

    const first = await app.request('/v1/ws/acme/mcp-servers/linear', { method: 'DELETE' })

    expect(await first.json()).toMatchObject({ removed: true, registration: 'retained' })
    // Deleting it here would have broken the server still using it, so the
    // question is asked of `by_registration` rather than of a stored count.
    expect(convex.registrations).toHaveLength(1)
    expect(issuer.requests.filter(entry => entry.method === 'DELETE')).toEqual([])

    const second = await app.request('/v1/ws/acme/mcp-servers/linear_two', { method: 'DELETE' })

    expect(await second.json()).toMatchObject({ removed: true, registration: 'deleted' })
    expect(convex.registrations).toEqual([])
    expect(issuer.requests.filter(entry => entry.method === 'DELETE')).toHaveLength(1)
  })

  test('a refused registration delete keeps the row, and the next connect reuses it', async () => {
    const fixture = consentApp({
      cimd: false,
      fault: request =>
        request.method === 'DELETE'
          ? Response.json({ error: 'server_error' }, { status: 503 })
          : undefined,
    })
    const { app, convex, issuer } = fixture
    await consented(fixture)

    const removed = await app.request('/v1/ws/acme/mcp-servers/linear', { method: 'DELETE' })

    expect(await removed.json()).toMatchObject({ removed: true, registration: 'retained' })
    // Kept, with what happened on it — and deliberately NOT tombstoned.
    expect(convex.registrations).toMatchObject([
      { deleteFailedAt: 1_000, deleteFailedReason: 'http_503' },
    ])

    await consented(fixture)

    // The surviving row is the point: a second registration here would be a
    // second orphan on the third party, minted by the cleanup that failed to
    // remove the first.
    expect(convex.registrations).toHaveLength(1)
    expect(issuerRequests(issuer, '/register')).toHaveLength(1)
  })

  test('sends the refresh token then the access token, and claims nothing from a 200', async () => {
    const fixture = consentApp()
    const { app, convex, issuer } = fixture
    await consented(fixture)
    const granted = convex.credentials[0]!

    const removed = await app.request('/v1/ws/acme/mcp-servers/linear', { method: 'DELETE' })

    // RFC 7009 §2.2 makes this 200 mandatory for a token the server never
    // heard of, and the fixture — like the endpoint Linear, Notion and Sentry
    // advertise — forgets nothing. `revoked` is the ATTEMPT, and the wire
    // vocabulary is all a caller is ever given to say about it.
    expect(await removed.json()).toMatchObject({ revoked: 'revoked' })
    expect(issuerRequests(issuer, '/revoke').map(entry => entry.body)).toEqual([
      {
        token: granted.refreshToken!,
        // Revoking the refresh token is defined to take its access tokens with
        // it, so it goes first — and the access token is still sent after, on
        // the principle that "defined to" is not "observed to".
        token_type_hint: 'refresh_token',
        // A public client authenticates by naming itself in the body, and
        // Duet's CIMD `client_id` is the URL of the document it publishes.
        client_id: `https://api.duet.test${MCP_CLIENT_METADATA_PATH}`,
      },
      {
        token: granted.accessToken,
        token_type_hint: 'access_token',
        client_id: `https://api.duet.test${MCP_CLIENT_METADATA_PATH}`,
      },
    ])
  })
})

const ISSUER_ORIGIN = 'https://issuer.test'
const MOUNT_URL = `${ISSUER_ORIGIN}${FAKE_OAUTH_ISSUER_MOUNT_PATH}`
const OAUTH_SERVER_URL = `${MOUNT_URL}/mcp`

/**
 * The app wired to slice 14's issuer, path-mounted exactly as `apps/api` mounts
 * it: requests outside the mount get the API's own 404, which is what the SDK's
 * first two discovery candidates hit.
 */
function consentApp(
  options: {
    cimd?: boolean
    /**
     * Answers instead of the issuer. The fixture cannot refuse anything on its
     * own — it revokes nothing and forgets nothing — so a disconnect test that
     * needs a refusal supplies it here.
     */
    fault?: (request: Request) => Response | undefined
  } = {},
) {
  const issuer = createFakeOAuthIssuer(
    options.cimd === false ? {} : { clientMetadataFetch: servedClientMetadata },
  )
  const fetchImpl: FetchLike = async (input, init) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.origin !== ISSUER_ORIGIN || !url.pathname.startsWith(FAKE_OAUTH_ISSUER_MOUNT_PATH)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const faulted = options.fault?.(request)
    if (faulted !== undefined) return faulted
    return await issuer.fetch(request)
  }
  const convex = new InMemoryMcpServers()
  return { app: testApp(fetchImpl, convex), convex, issuer }
}

/** The document `apps/api` serves at Duet's `client_id` URL, as the issuer sees it. */
async function servedClientMetadata(url: string): Promise<Response> {
  const expected = `https://api.duet.test${MCP_CLIENT_METADATA_PATH}`
  if (url !== expected) return new Response(null, { status: 404 })
  return Response.json(duetMcpClientMetadataDocument('https://api.duet.test'))
}

async function addOAuthServer(
  app: Hono<{ Variables: ApiVariables }>,
  name = 'linear',
  url = OAUTH_SERVER_URL,
): Promise<void> {
  const response = await app.request('/v1/ws/acme/mcp-servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, url, auth: { kind: 'oauth' } }),
  })
  if (response.status !== 201) throw new Error(`fixture add failed: ${response.status}`)
}

async function connect(app: Hono<{ Variables: ApiVariables }>, name = 'linear'): Promise<string> {
  const response = await app.request(`/v1/ws/acme/mcp-servers/${name}/connect`, { method: 'POST' })
  if (response.status !== 200) throw new Error(`connect failed: ${await response.text()}`)
  return ((await response.json()) as { authorizeUrl: string }).authorizeUrl
}

/** A server with a live grant on it: added, connected, approved, called back. */
async function consented(
  fixture: ReturnType<typeof consentApp>,
  name = 'linear',
  url = OAUTH_SERVER_URL,
): Promise<void> {
  await addOAuthServer(fixture.app, name, url)
  const redirected = await approve(fixture.issuer, await connect(fixture.app, name))
  const callback = await fixture.app.request(callbackPath(redirected))
  if (callback.status !== 302) throw new Error(`fixture consent failed: ${await callback.text()}`)
}

/** The human's half: load the consent page, press a button, follow the 302. */
async function approve(
  issuer: ReturnType<typeof createFakeOAuthIssuer>,
  authorizeUrl: string,
  decision: 'approve' | 'deny' = 'approve',
): Promise<string> {
  const html = await (await issuer.fetch(authorizeUrl)).text()
  const submitted = new URL(decodeEntities(/<form[^>]*action="([^"]+)"/.exec(html)?.[1] ?? ''))
  for (const [, name, value] of html.matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
  )) {
    submitted.searchParams.set(decodeEntities(name ?? ''), decodeEntities(value ?? ''))
  }
  submitted.searchParams.set('decision', decision)
  const redirected = await issuer.fetch(submitted.toString())
  return redirected.headers.get('location') ?? ''
}

/**
 * The issuer records the path it was CALLED with, and here that path still
 * carries the mount prefix — matching it exactly would silently match nothing.
 */
function issuerRequests(issuer: ReturnType<typeof createFakeOAuthIssuer>, path: string) {
  return issuer.requests.filter(entry => entry.path === `${FAKE_OAUTH_ISSUER_MOUNT_PATH}${path}`)
}

function callbackPath(location: string): string {
  const url = new URL(location)
  if (url.pathname !== MCP_OAUTH_CALLBACK_PATH) {
    throw new Error(`the issuer redirected somewhere unexpected: ${location}`)
  }
  return `${url.pathname}${url.search}`
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

async function addServer(
  app: Hono<{ Variables: ApiVariables }>,
  name: string,
  auth?: { kind: string; token?: string },
): Promise<void> {
  const response = await app.request('/v1/ws/acme/mcp-servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, url: SERVER_URL, ...(auth === undefined ? {} : { auth }) }),
  })
  if (response.status !== 201) throw new Error(`fixture add failed: ${response.status}`)
}

function recording(sink: Request[], fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    sink.push(new Request(String(input), init as RequestInit))
    return await fetchImpl(input, init)
  }
}

function testApp(
  fetchImpl: FetchLike,
  convex: InMemoryMcpServers,
  auth = authFixture(),
  options: { waitUntil?: (promise: Promise<unknown>) => void; upstreamTimeoutMs?: number } = {},
) {
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  registerMcpServerRoutes(
    app,
    {
      convex: convex as never,
      internalKey: 'internal-secret',
      apiInternalKey: 'internal-secret',
      fetchImpl,
      now: () => 1_000,
      appUrl: 'https://app.duet.so',
      officialHubOwnerEmail: 'official-owner@example.test',
      officialHubBaseUrl: 'https://edge.example.test',
    },
    { resolveHost, apiUrl: 'https://api.duet.test', ...options },
  )
  return app
}

/**
 * `waitUntil`, held rather than run: the point of the health rail is that
 * nothing it schedules happens before the response is returned, so the test
 * has to be able to look at the world in between.
 */
function backgroundWork() {
  const scheduled: Array<Promise<unknown>> = []
  return {
    waitUntil: (promise: Promise<unknown>) => void scheduled.push(promise),
    get pending() {
      return scheduled.length
    },
    async settle() {
      await Promise.all(scheduled.splice(0, scheduled.length))
    },
  }
}

function authFixture(): ApiVariables['auth'] {
  return {
    credentialKind: 'user',
    user: { id: 'user_1', email: 'owner@example.com' },
    workspaces: [
      {
        id: 'workspace_1',
        slug: 'acme',
        name: 'Acme',
        status: 'active',
        servicingStatus: 'active',
        onboardedAt: 1,
        role: 'owner',
        billingUserId: 'user_1',
        // Required on every workspace summary: it describes the workspace's
        // payer, not the reader. See specs/done/agent-signin.
        funding: { plan: 'pro', active: true },
        creditRecovery: null,
        defaultTier: { effective: 'balanced' },
      },
    ],
    scopes: ['ws:acme:integrations'],
    versions: { api: 1 },
  }
}

interface StoredServer {
  id: string
  name: string
  label: string
  url: string
  authKind: 'none' | 'oauth' | 'static'
  state: string
  toolCount?: number
  estimatedPromptBytes?: number
  droppedToolNames?: string[]
  createdAt: number
  updatedAt: number
}

/**
 * The Convex functions slice 04 shipped, in memory: the same names, the same
 * argument shapes, and the same `ConvexError` codes the real ones raise. It
 * stands in for the deployment, not for the route's own logic.
 */
class InMemoryMcpServers {
  readonly servers: StoredServer[] = []
  readonly policies: Array<{ serverName: string; allowedAgentIds: string[] }> = []
  readonly credentials: Array<{
    serverName: string
    kind: string
    accessToken: string
    refreshToken?: string
    resource?: string
    authorizationServer?: string
    registrationId?: string
    /** Set by the test that proves a refused grant never reaches an upstream. */
    invalidAt?: number
  }> = []
  readonly health: Array<{ serverName: string; outcome: string; errorCode?: string }> = []
  readonly authorizations: StoredAuthorization[] = []
  readonly registrations: StoredRegistration[] = []
  /** Held health write, so a test can look at the world while one is in flight. */
  blockHealth?: Promise<void>
  /** Flipped by the test that proves the unauthenticated callback is limited. */
  rateLimited = false
  private nextId = 1

  async query(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
    return await this.call(getFunctionName(reference as never), args)
  }

  async mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
    return await this.call(getFunctionName(reference as never), args)
  }

  private async call(operation: string, args: Record<string, unknown>): Promise<unknown> {
    if (args.internalKey !== 'internal-secret') throw new Error('unauthorized convex call')
    const name = String(args.name)
    if (operation.endsWith(':registerMcpServer')) {
      if (this.servers.some(server => server.name === name)) throw convexError('duplicate_name')
      if (this.servers.length >= MAX_MCP_SERVERS_PER_WORKSPACE) throw convexError('server_limit')
      const server: StoredServer = {
        id: `server_${this.nextId++}`,
        name,
        label: (args.label as string | undefined) ?? name,
        url: String(args.url),
        authKind: args.authKind as StoredServer['authKind'],
        state: args.authKind === 'oauth' ? 'needs_auth' : 'ready',
        toolCount: args.toolCount as number | undefined,
        estimatedPromptBytes: args.estimatedPromptBytes as number | undefined,
        droppedToolNames: args.droppedToolNames as string[] | undefined,
        createdAt: 1_000,
        updatedAt: 1_000,
      }
      this.servers.push(server)
      return server
    }
    if (operation.endsWith(':listMcpServers')) {
      return this.servers.map(server => ({
        ...server,
        // Deliberately leaky: rows here carry a field no response may. The
        // route parses through the wire schema rather than spreading, and this
        // is what proves it — otherwise the invariant only holds until someone
        // adds a column.
        accessToken: this.credentials.find(row => row.serverName === server.name)?.accessToken,
        allowedAgentIds: this.policies.find(policy => policy.serverName === server.name)
          ?.allowedAgentIds,
      }))
    }
    if (operation.endsWith(':deleteMcpServer')) {
      const index = this.servers.findIndex(server => server.name === name)
      if (index < 0) return { name, removed: false }
      this.servers.splice(index, 1)
      this.drop(this.credentials, name)
      this.drop(this.policies, name)
      return { name, removed: true }
    }
    if (operation.endsWith(':setMcpServerAgentPolicy')) {
      const allowedAgentIds = args.allowedAgentIds as string[]
      this.requireServer(name)
      this.drop(this.policies, name)
      this.policies.push({ serverName: name, allowedAgentIds })
      return { name, allowedAgentIds }
    }
    if (operation.endsWith(':clearMcpServerAgentPolicy')) {
      this.requireServer(name)
      this.drop(this.policies, name)
      return { name }
    }
    if (operation.endsWith(':getMcpServer')) {
      return this.servers.find(server => server.name === name) ?? null
    }
    if (operation.endsWith(':readMcpServerCredential')) {
      const server = this.servers.find(candidate => candidate.id === args.serverId)
      const credential =
        server === undefined
          ? undefined
          : this.credentials.find(row => row.serverName === server.name)
      return credential === undefined
        ? null
        : {
            generation: 1,
            kind: credential.kind,
            accessToken: credential.accessToken,
            tokenType: 'Bearer',
            hasRefreshToken: credential.refreshToken !== undefined,
            invalidAt: credential.invalidAt,
          }
    }
    if (operation.endsWith(':recordMcpServerHealth')) {
      if (this.blockHealth !== undefined) await this.blockHealth
      this.health.push({
        serverName: name,
        outcome: String(args.outcome),
        ...(args.errorCode === undefined ? {} : { errorCode: String(args.errorCode) }),
      })
      return { recorded: true }
    }
    if (operation.endsWith(':storeMcpServerCredential')) {
      const server = this.servers.find(candidate => candidate.id === args.serverId)
      if (server === undefined) throw convexError('server_not_found')
      this.credentials.push({
        serverName: server.name,
        kind: String(args.kind),
        accessToken: String(args.accessToken),
        ...present(args, 'refreshToken', 'resource', 'authorizationServer', 'registrationId'),
      })
      return { status: 'stored', generation: 1 }
    }
    if (operation.endsWith(':setMcpServerState')) {
      const server = this.servers.find(candidate => candidate.id === args.serverId)
      if (server === undefined) throw convexError('server_not_found')
      server.state = String(args.state)
      return server
    }
    if (operation.endsWith(':startMcpOAuthAuthorization')) {
      this.authorizations.push({
        serverId: String(args.serverId),
        workspaceId: String(args.workspaceId),
        hashedState: String(args.hashedState),
        codeVerifier: String(args.codeVerifier),
        authorizationServer: String(args.authorizationServer),
        expectedIssuer: String(args.expectedIssuer),
        resource: args.resource as string | undefined,
        redirectTo: String(args.redirectTo),
        expiresAt: Number(args.expiresAt),
      })
      return { started: true }
    }
    if (operation.endsWith(':claimMcpOAuthAuthorization')) {
      const index = this.authorizations.findIndex(row => row.hashedState === args.hashedState)
      if (index < 0) return null
      const pending = this.authorizations[index]!
      if (pending.expiresAt <= Number(args.now)) {
        this.authorizations.splice(index, 1)
        return null
      }
      if (pending.serverId !== args.serverId) return null
      this.authorizations.splice(index, 1)
      const server = this.servers.find(candidate => candidate.id === pending.serverId)
      if (server === undefined) return null
      return { ...pending, server: { name: server.name, url: server.url } }
    }
    if (operation.endsWith(':getMcpClientRegistration')) {
      return (
        this.registrations.find(row => row.authorizationServer === args.authorizationServer) ?? null
      )
    }
    if (operation.endsWith(':storeMcpClientRegistration')) {
      const existing = this.registrations.find(
        row => row.authorizationServer === args.authorizationServer,
      )
      if (existing !== undefined) return { status: 'exists', registration: existing }
      const registration: StoredRegistration = {
        id: `registration_${this.nextId++}`,
        authorizationServer: String(args.authorizationServer),
        clientId: String(args.clientId),
        // RFC 7592, kept because they are the only way to delete the client
        // upstream — the whole reason Duet issues the DCR POST itself.
        ...present(args, 'registrationClientUri', 'registrationAccessToken'),
      }
      this.registrations.push(registration)
      return { status: 'adopted', registration }
    }
    if (operation.endsWith(':beginMcpServerDisconnect')) {
      const server = this.servers.find(candidate => candidate.name === name)
      if (server === undefined) return null
      server.state = 'disconnecting'
      const credential = this.credentials.find(row => row.serverName === name)
      const registration =
        credential?.registrationId === undefined
          ? undefined
          : this.registrations.find(row => row.id === credential.registrationId)
      return {
        server: { id: server.id, name: server.name, authKind: server.authKind },
        credential:
          credential === undefined
            ? null
            : {
                kind: credential.kind,
                accessToken: credential.accessToken,
                ...(credential.refreshToken === undefined
                  ? {}
                  : { refreshToken: credential.refreshToken }),
                ...(credential.authorizationServer === undefined
                  ? {}
                  : { authorizationServer: credential.authorizationServer }),
              },
        registration: registration ?? null,
      }
    }
    if (operation.endsWith(':dropMcpServerCredential')) {
      const server = this.servers.find(candidate => candidate.id === args.serverId)
      const index =
        server === undefined
          ? -1
          : this.credentials.findIndex(row => row.serverName === server.name)
      if (index < 0) return { deleted: false, registration: 'none' }
      const credential = this.credentials.splice(index, 1)[0]!
      if (credential.registrationId === undefined) return { deleted: true, registration: 'none' }
      // The truth is an index read, never a stored refcount: `by_registration`
      // after the delete says whether anything still holds this client.
      const shared = this.credentials.some(row => row.registrationId === credential.registrationId)
      return { deleted: true, registration: shared ? 'shared' : 'orphaned' }
    }
    if (operation.endsWith(':finishMcpServerDisconnect')) {
      const registration = this.registrations.find(row => row.id === args.registrationId)
      if (registration !== undefined) {
        if (args.registrationDelete === 'deleted') {
          this.registrations.splice(this.registrations.indexOf(registration), 1)
        } else if (args.registrationDelete === 'failed') {
          registration.deleteFailedAt = Number(args.now ?? 0)
          registration.deleteFailedReason = String(args.reason)
        }
      }
      const index = this.servers.findIndex(candidate => candidate.name === name)
      if (index < 0) return { name, removed: false }
      this.servers.splice(index, 1)
      this.drop(this.credentials, name)
      this.drop(this.policies, name)
      return { name, removed: true }
    }
    if (operation.endsWith(':consumePreAuthRateLimit')) {
      return this.rateLimited
        ? { ok: false, retryAfterSeconds: 42 }
        : { ok: true, remaining: 1, resetAt: 2_000 }
    }
    throw new Error(`unexpected convex call: ${operation}`)
  }

  private requireServer(name: string): StoredServer {
    const server = this.servers.find(candidate => candidate.name === name)
    if (server === undefined) throw convexError('server_not_found')
    return server
  }

  private drop(rows: Array<{ serverName: string }>, name: string): void {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index]!.serverName === name) rows.splice(index, 1)
    }
  }
}

/** The real error type, so the route's own mapping is what gets exercised. */
function convexError(code: string): ConvexError<{ error: string }> {
  return new ConvexError({ error: code })
}

interface StoredRegistration {
  id: string
  authorizationServer: string
  clientId: string
  registrationClientUri?: string
  registrationAccessToken?: string
  deleteFailedAt?: number
  deleteFailedReason?: string
}

interface StoredAuthorization {
  serverId: string
  workspaceId: string
  hashedState: string
  codeVerifier: string
  authorizationServer: string
  expectedIssuer: string
  resource?: string
  redirectTo: string
  expiresAt: number
}

/**
 * Convex argument validators are closed objects, so an absent field and an
 * explicit `undefined` are different calls. This keeps the stub's rows shaped
 * like the arguments that actually arrived.
 */
function present(args: Record<string, unknown>, ...names: string[]): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const name of names) {
    if (args[name] !== undefined) fields[name] = String(args[name])
  }
  return fields
}
