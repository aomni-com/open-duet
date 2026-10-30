import { afterEach, describe, expect, test } from 'bun:test'

import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { Hono } from 'hono'

import {
  IntegrationConnectionListSchema,
  MAX_INTEGRATION_CONNECTION_ID_UTF8_BYTES,
  X_DUET_GATEWAY_CODE_HEADER,
  X_DUET_GATEWAY_HEADER,
} from '@repo/contract'

import { resolveMcpToolResultBytes } from '../config'
import { createApiApp } from '../index'
import type { ApiVariables, ComposioMcpProvider } from '../shared'
import { registerComposioRoutes } from './composio'
import {
  createComposioToolRouterCallbackUrl,
  createComposioUserConnectCallbackUrl,
  verifyComposioOAuthCallbackDescriptor,
} from './composio-oauth'
import { registerIntegrationRoutes } from './integrations'

const originalComposioApiKey = process.env.COMPOSIO_API_KEY

afterEach(() => {
  if (originalComposioApiKey === undefined) delete process.env.COMPOSIO_API_KEY
  else process.env.COMPOSIO_API_KEY = originalComposioApiKey
})

describe('integration connection pages', () => {
  test('decorates only the unique toolkits present on the current provider page', async () => {
    const policyReads: Array<{ operation: string; args: Record<string, unknown> }> = []
    const app = new Hono<{ Variables: ApiVariables }>()
    app.use('*', async (c, next) => {
      c.set('auth', authFixture())
      await next()
    })
    registerIntegrationRoutes(
      app,
      testRuntime(async () => Response.json({ ok: true }), 1_000, {
        mutation: async () => {
          throw new Error('unexpected mutation')
        },
        query: async (reference, args) => {
          const operation = getFunctionName(reference as never)
          policyReads.push({ operation, args })
          return [{ integration: 'github', allowedAgentIds: [] }]
        },
      }),
      {
        listCatalog: async () => ({ items: [], nextCursor: null }),
        listConnections: async () => ({
          items: [
            {
              id: 'github-1',
              integration: 'github',
              status: 'active',
              connectedAt: 1,
              updatedAt: 1,
            },
            {
              id: 'gmail-1',
              integration: 'gmail',
              status: 'active',
              connectedAt: 2,
              updatedAt: 2,
            },
            {
              id: 'github-2',
              integration: 'github',
              status: 'active',
              connectedAt: 3,
              updatedAt: 3,
            },
          ],
          nextCursor: 'provider-page-2',
        }),
        getConnection: async () => undefined,
        beginConnection: async () => ({ authorizeUrl: 'https://provider.example/authorize' }),
        disconnect: async () => undefined,
      },
    )

    const response = await app.request('/v1/ws/acme/integrations/connections?limit=3')

    expect(response.status).toBe(200)
    const page = IntegrationConnectionListSchema.parse(await response.json())
    expect(page.items.map(item => [item.id, item.allowedAgentIds])).toEqual([
      ['github-1', []],
      ['gmail-1', undefined],
      ['github-2', []],
    ])
    expect(policyReads).toEqual([
      {
        operation: 'domains/integrations/model:integrationAgentPoliciesForToolkits',
        args: {
          internalKey: 'internal-secret',
          workspaceId: 'workspace_1',
          toolkitSlugs: ['github', 'gmail'],
        },
      },
    ])
  })

  test('rejects an oversized provider page before supporting policy reads', async () => {
    let policyReads = 0
    const app = new Hono<{ Variables: ApiVariables }>()
    app.use('*', async (c, next) => {
      c.set('auth', authFixture())
      await next()
    })
    registerIntegrationRoutes(
      app,
      testRuntime(async () => Response.json({ ok: true }), 1_000, {
        mutation: async () => {
          throw new Error('unexpected mutation')
        },
        query: async () => {
          policyReads += 1
          return []
        },
      }),
      {
        listCatalog: async () => ({ items: [], nextCursor: null }),
        listConnections: async () => ({
          items: Array.from({ length: 101 }, (_, index) => ({
            id: `github-${index}`,
            integration: 'github',
            status: 'active' as const,
            connectedAt: index,
            updatedAt: index,
          })),
          nextCursor: null,
        }),
        getConnection: async () => undefined,
        beginConnection: async () => ({ authorizeUrl: 'https://provider.example/authorize' }),
        disconnect: async () => undefined,
      },
    )

    const response = await app.request('/v1/ws/acme/integrations/connections?limit=100')

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'integration_provider_failed' })
    expect(policyReads).toBe(0)
  })

  test('disconnects a workspace connection the provider never labelled', async () => {
    const disconnects: string[] = []
    const app = new Hono<{ Variables: ApiVariables }>()
    app.use('*', async (c, next) => {
      c.set('auth', authFixture())
      await next()
    })
    registerIntegrationRoutes(
      app,
      testRuntime(async () => Response.json({ ok: true }), 1_000, {
        mutation: async () => {
          throw new Error('unexpected mutation')
        },
        query: async () => [],
      }),
      {
        listCatalog: async () => ({ items: [], nextCursor: null }),
        listConnections: async () => ({ items: [], nextCursor: null }),
        /* An account this workspace owns that carries no Duet-written label:
           every connection made before labelling existed, and every one the
           agent makes for itself through the provider's own connect flow. The
           provider scopes the lookup, so the label never comes into it. */
        getConnection: async args =>
          args.workspaceId === 'workspace_1' && args.providerConnectionId === 'ca_unlabelled'
            ? {
                id: 'ca_unlabelled',
                integration: 'gmail',
                status: 'active' as const,
                connectedAt: 0,
                updatedAt: 0,
              }
            : undefined,
        beginConnection: async () => ({ authorizeUrl: 'https://provider.example/authorize' }),
        disconnect: async args => {
          disconnects.push(args.providerConnectionId)
        },
      },
    )

    const response = await app.request('/v1/ws/acme/integrations/connections/ca_unlabelled', {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'ca_unlabelled', disconnected: true })
    expect(disconnects).toEqual(['ca_unlabelled'])
  })

  test('refuses to disconnect a connection the provider does not place in this workspace', async () => {
    const disconnects: string[] = []
    const app = new Hono<{ Variables: ApiVariables }>()
    app.use('*', async (c, next) => {
      c.set('auth', authFixture())
      await next()
    })
    registerIntegrationRoutes(
      app,
      testRuntime(async () => Response.json({ ok: true }), 1_000, {
        mutation: async () => {
          throw new Error('unexpected mutation')
        },
        query: async () => [],
      }),
      {
        listCatalog: async () => ({ items: [], nextCursor: null }),
        listConnections: async () => ({ items: [], nextCursor: null }),
        // Scoped to the caller's workspace, so another tenant's id resolves to
        // nothing here exactly as it does in the list.
        getConnection: async () => undefined,
        beginConnection: async () => ({ authorizeUrl: 'https://provider.example/authorize' }),
        disconnect: async args => {
          disconnects.push(args.providerConnectionId)
        },
      },
    )

    const response = await app.request('/v1/ws/acme/integrations/connections/ca_other_tenant', {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'ca_other_tenant', disconnected: false })
    expect(disconnects).toEqual([])
  })

  test('rejects an oversized connection identity before provider lookup', async () => {
    let lookups = 0
    const app = new Hono<{ Variables: ApiVariables }>()
    app.use('*', async (c, next) => {
      c.set('auth', authFixture())
      await next()
    })
    registerIntegrationRoutes(
      app,
      testRuntime(async () => Response.json({ ok: true }), 1_000, {
        mutation: async () => {
          throw new Error('unexpected mutation')
        },
        query: async () => [],
      }),
      {
        listCatalog: async () => ({ items: [], nextCursor: null }),
        listConnections: async () => ({ items: [], nextCursor: null }),
        getConnection: async () => {
          lookups += 1
          return undefined
        },
        beginConnection: async () => ({ authorizeUrl: 'https://provider.example/authorize' }),
        disconnect: async () => undefined,
      },
    )

    const response = await app.request(
      `/v1/ws/acme/integrations/connections/${'x'.repeat(MAX_INTEGRATION_CONNECTION_ID_UTF8_BYTES + 1)}`,
      { method: 'DELETE' },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
    expect(lookups).toBe(0)
  })
})

describe('Composio execute proxy', () => {
  test('overwrites caller entity_id with the workspace granted by the API key', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const upstreamRequests: Request[] = []
    const app = testApp(async (input, init) => {
      const request = new Request(input, init)
      upstreamRequests.push(request)
      return Response.json({ ok: true })
    })

    const response = await app.request('/v1/integrations/composio/execute/GMAIL_SEND_EMAIL', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        arguments: { to: 'team@example.com' },
        entity_id: 'caller-controlled',
      }),
    })

    expect(response.status).toBe(200)
    expect(upstreamRequests).toHaveLength(1)
    expect(await upstreamRequests[0]!.json()).toEqual({
      arguments: { to: 'team@example.com' },
      entity_id: 'workspace_1',
    })
  })

  test('streams vendor failures unmarked and echoes the Duet request id', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const app = testApp(
      async () =>
        new Response('vendor says no', {
          status: 422,
          statusText: 'Unprocessable Content',
          headers: { 'content-type': 'text/plain', 'x-vendor': 'composio' },
        }),
    )

    const response = await app.request('/v1/integrations/composio/execute/GMAIL_SEND_EMAIL', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-duet-request-id': 'request_123' },
      body: '{}',
    })

    expect(response.status).toBe(422)
    expect(response.statusText).toBe('Unprocessable Content')
    expect(await response.text()).toBe('vendor says no')
    expect(response.headers.get('x-vendor')).toBe('composio')
    expect(response.headers.get('x-duet-gateway')).toBeNull()
    expect(response.headers.get('x-duet-request-id')).toBe('request_123')
  })

  test('a decoded upstream body sheds its stale encoding headers', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const app = testApp(
      async () =>
        new Response(JSON.stringify({ successful: true, data: { text: 'big scrape' } }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            // Server-side fetch decompresses the body but keeps the vendor's
            // original headers; forwarding them mislabels our plaintext body.
            'content-encoding': 'gzip',
            'content-length': '123',
          },
        }),
    )
    const response = await app.request('/v1/integrations/composio/execute/FIRECRAWL_SCRAPE', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arguments: { url: 'https://example.com' } }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(((await response.json()) as { successful: boolean }).successful).toBe(true)
  })

  test('accepts an empty body and sends empty arguments', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    let upstreamBody: unknown
    const app = testApp(async (input, init) => {
      upstreamBody = await new Request(input, init).json()
      return Response.json({ ok: true })
    })

    const response = await app.request('/v1/integrations/composio/execute/GMAIL_GET_PROFILE', {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual({ arguments: {}, entity_id: 'workspace_1' })
  })

  test('marks an unset Composio key as a Duet service-unavailable block', async () => {
    delete process.env.COMPOSIO_API_KEY
    const response = await testApp(async () => {
      throw new Error('unset key must block before fetch')
    }).request('/v1/integrations/composio/execute/GMAIL_GET_PROFILE', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Composio is not configured.',
      code: 'service_unavailable',
    })
    expect(response.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(response.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('service_unavailable')
  })

  test('requires an explicit granted workspace when the key is ambiguous', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const auth = authFixture()
    auth.workspaces.push({
      id: 'workspace_2',
      slug: 'beta',
      name: 'Beta',
      status: 'active',
      servicingStatus: 'active',
      onboardedAt: 1,
      role: 'owner',
      billingUserId: 'user_1',
      funding: { plan: null, active: true },
      creditRecovery: null,
      defaultTier: { effective: 'balanced' },
    })
    auth.scopes.push('ws:beta:integrations')
    const upstreamEntities: string[] = []
    const app = testApp(
      async (input, init) => {
        upstreamEntities.push(String((await new Request(input, init).json()).entity_id))
        return Response.json({ ok: true })
      },
      1_000,
      auth,
    )

    const ambiguous = await app.request('/v1/integrations/composio/execute/GMAIL_GET_PROFILE', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(ambiguous.status).toBe(403)
    expect(ambiguous.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('workspace_ambiguous')

    const selected = await app.request('/v1/integrations/composio/execute/GMAIL_GET_PROFILE', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'beta' }),
    })
    expect(selected.status).toBe(200)
    expect(upstreamEntities).toEqual(['workspace_2'])
  })
})

describe('Composio MCP proxy', () => {
  test('authorizes every MCP method before resolving or calling an upstream session', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const ledger = new InMemoryToolRouterLedger()
    ledger.add('session_hidden', 'workspace_1', [])
    ledger.denyAccess('session_hidden')
    let providerCalls = 0
    let upstreamCalls = 0
    const app = testApp(
      async () => {
        upstreamCalls += 1
        return Response.json({ ok: true })
      },
      1_000,
      authFixture(),
      {
        ledger,
        useToolRouterSession: async () => {
          providerCalls += 1
          throw new Error('hidden session must not reach the provider')
        },
      },
    )

    for (const method of ['POST', 'GET', 'DELETE']) {
      const response = await app.request(
        '/v1/ws/acme/agent/sessions/session_hidden/integrations/mcp',
        { method },
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }
    expect(providerCalls).toBe(0)
    expect(upstreamCalls).toBe(0)
  })

  // Every runner spawn opens with `initialize` then `tools/list`, serially,
  // and each round trip through here cost ~0.9s on staging — two Convex
  // reads, a provider lookup and the upstream call — for an answer that only
  // changes when the session's permissions do. That handshake was the single
  // largest slice of a turn's time to first token.
  test("a learned tools/list is answered here under the request's own id", async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    let upstreamCalls = 0
    // Real tool schemas carry `$schema`, which a stored document may not hold
    // as a field name; the list has to survive that on its way to the row.
    const tools = [
      { name: 'GMAIL_SEND', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#' } },
    ]
    const app = readyMcpApp(async () => {
      upstreamCalls += 1
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const list = (id: number) =>
      app.request('/v1/ws/acme/agent/sessions/session_1/integrations/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer duet-workspace-key',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
      })

    const first = await list(1)
    expect(first.status).toBe(200)
    expect(first.headers.get('x-duet-mcp-cache')).toBe('learned')
    expect(await first.text()).toContain('"GMAIL_SEND"')
    expect(upstreamCalls).toBe(1)

    const second = await list(7)
    expect(second.status).toBe(200)
    expect(second.headers.get('x-duet-mcp-cache')).toBe('hit')
    expect(await second.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { tools } })
    expect(upstreamCalls).toBe(1)
  })

  test('a row that carries its endpoint never consults the provider', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    let providerLookups = 0
    const ledger = new InMemoryToolRouterLedger()
    ledger.add('session_1', 'workspace_1', [])
    ledger.prepareProvider('session_1', 'provider-session-1', 'https://composio.example/mcp')
    const upstreamRequests: Request[] = []
    const app = testApp(
      async (input, init) => {
        upstreamRequests.push(new Request(input, init))
        return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
          headers: { 'content-type': 'application/json' },
        })
      },
      1_000,
      authFixture(),
      {
        ledger,
        useToolRouterSession: async () => {
          providerLookups += 1
          throw new Error('the row already knows this session')
        },
      },
    )
    const initialize = () =>
      app.request('/v1/ws/acme/agent/sessions/session_1/integrations/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer duet-workspace-key', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      })

    expect((await initialize()).status).toBe(200)
    expect((await initialize()).status).toBe(200)
    expect(providerLookups).toBe(0)
    expect(upstreamRequests.map(request => request.url)).toEqual([
      'https://composio.example/mcp',
      'https://composio.example/mcp',
    ])
    expect(upstreamRequests[0]!.headers.get('x-api-key')).toBe('composio-secret')
  })

  test('a row that predates its endpoint learns it from the first provider lookup', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    let providerLookups = 0
    const ledger = new InMemoryToolRouterLedger()
    ledger.add('session_1', 'workspace_1', [])
    ledger.prepareProvider('session_1', 'provider-session-1')
    const app = testApp(
      async () =>
        new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
          headers: { 'content-type': 'application/json' },
        }),
      1_000,
      authFixture(),
      {
        ledger,
        useToolRouterSession: async ({ providerSessionId }) => {
          providerLookups += 1
          return {
            providerSessionId,
            mcp: { type: 'http', url: 'https://composio.example/learned', headers: {} },
          }
        },
      },
    )
    const initialize = () =>
      app.request('/v1/ws/acme/agent/sessions/session_1/integrations/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer duet-workspace-key', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      })

    expect((await initialize()).status).toBe(200)
    expect((await initialize()).status).toBe(200)
    expect(providerLookups).toBe(1)
  })

  test('forwards streamable HTTP through the workspace session without exposing caller auth', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const upstreamRequests: Request[] = []
    const app = readyMcpApp(async (input, init) => {
      upstreamRequests.push(new Request(input, init))
      return new Response('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n', {
        headers: {
          'content-type': 'text/event-stream',
          'mcp-session-id': 'mcp_session_1',
        },
      })
    })

    const response = await app.request('/v1/ws/acme/agent/sessions/session_1/integrations/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer duet-workspace-key',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': 'mcp_session_0',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('mcp-session-id')).toBe('mcp_session_1')
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]!.url).toBe('https://composio.example/tool-router/mcp')
    expect(upstreamRequests[0]!.method).toBe('POST')
    expect(upstreamRequests[0]!.headers.get('authorization')).toBeNull()
    expect(upstreamRequests[0]!.headers.get('x-api-key')).toBe('composio-secret')
    expect(upstreamRequests[0]!.headers.get('accept')).toBe('application/json, text/event-stream')
    expect(upstreamRequests[0]!.headers.get('content-type')).toBe('application/json')
    expect(upstreamRequests[0]!.headers.get('mcp-session-id')).toBe('mcp_session_0')
    expect(await upstreamRequests[0]!.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
  })

  test('forwards the protocol version and resume cursor a strict server needs', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const upstreamRequests: Request[] = []
    const app = readyMcpApp(async (input, init) => {
      upstreamRequests.push(new Request(input, init))
      return new Response('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const response = await app.request('/v1/ws/acme/agent/sessions/session_1/integrations/mcp', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        'last-event-id': 'event_17',
      },
    })

    expect(response.status).toBe(200)
    expect(upstreamRequests[0]!.headers.get('mcp-protocol-version')).toBe('2025-06-18')
    expect(upstreamRequests[0]!.headers.get('last-event-id')).toBe('event_17')
  })

  test('passes an ordinary tool result through untouched and cuts a runaway one', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const toolResult = (text: string) =>
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text }], structuredContent: { markdown: text } },
      })}\n\n`
    const call = async (text: string) => {
      const app = readyMcpApp(
        async () =>
          new Response(toolResult(text), { headers: { 'content-type': 'text/event-stream' } }),
      )
      return await (
        await app.request('/v1/ws/acme/agent/sessions/session_1/integrations/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }),
        })
      ).text()
    }

    const ordinary = 'a tool result of the size real servers actually return'
    expect(await call(ordinary)).toBe(toolResult(ordinary))

    // 1.3 MB in one call is what a real public MCP server returned for an
    // ordinary request; unbudgeted it blows the context window outright.
    const runaway = await call('r'.repeat(1_300_000))
    expect(runaway).toContain('of 1300000 bytes')
    expect(runaway).toContain('narrow the query')
    expect(runaway.startsWith('event: message\ndata: ')).toBe(true)
    const message = JSON.parse(runaway.slice('event: message\ndata: '.length).trimEnd()) as {
      result: { structuredContent?: unknown }
    }
    expect(message).not.toHaveProperty('result.structuredContent')
    expect(Buffer.byteLength(JSON.stringify(message.result), 'utf8')).toBeLessThanOrEqual(
      resolveMcpToolResultBytes(),
    )
  })

  test('rejects an unknown or not-yet-prepared Duet session without creating upstream state', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const ledger = new InMemoryToolRouterLedger()
    ledger.add('session-unready', 'workspace_1', [])

    const app = testApp(async () => Response.json({ ok: true }), 1_000, authFixture(), {
      ledger,
      useToolRouterSession: async () => {
        throw new Error('MCP proxy must not create or recover provider sessions')
      },
    })

    expect(
      (
        await app.request('/v1/ws/acme/agent/sessions/session-missing/integrations/mcp', {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await app.request('/v1/ws/acme/agent/sessions/session-unready/integrations/mcp', {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(503)
  })

  test('silently replaces a vanished provider session and continues the MCP request', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const ledger = new InMemoryToolRouterLedger()
    ledger.add('session_1', 'workspace_1', ['github'])
    ledger.prepareProvider('session_1', 'provider-session-gone')
    const creates: string[][] = []
    const upstreamRequests: Request[] = []
    const app = testApp(
      async (input, init) => {
        upstreamRequests.push(new Request(input, init))
        return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
      },
      1_000,
      authFixture(),
      {
        ledger,
        composioMcpProvider: {
          async createToolRouterSession(args) {
            creates.push([...args.disabledToolkitSlugs])
            return {
              providerSessionId: 'provider-session-replacement',
              mcp: {
                type: 'http',
                url: 'https://composio.example/tool-router/replacement',
                headers: { 'x-api-key': 'replacement-key' },
              },
            }
          },
          async useToolRouterSession({ providerSessionId }) {
            if (providerSessionId === 'provider-session-gone') {
              throw Object.assign(new Error('provider session not found'), { status: 404 })
            }
            if (providerSessionId === 'provider-session-replacement') {
              return {
                providerSessionId,
                mcp: {
                  type: 'http',
                  url: 'https://composio.example/tool-router/replacement',
                  headers: { 'x-api-key': 'replacement-key' },
                },
              }
            }
            throw new Error(`unexpected provider session: ${providerSessionId}`)
          },
          async updateToolRouterSession() {
            throw new Error('unexpected permission update')
          },
          async deleteToolRouterSession() {
            throw new Error('the vanished provider session is already gone')
          },
        },
      },
    )

    const response = await app.request('/v1/ws/acme/agent/sessions/session_1/integrations/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': 'transport-session-from-vanished-provider',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
    expect(creates).toEqual([['github']])
    expect(ledger.providerSessionId('session_1')).toBe('provider-session-replacement')
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]!.url).toBe('https://composio.example/tool-router/replacement')
    expect(upstreamRequests[0]!.headers.get('x-api-key')).toBe('composio-secret')
    expect(upstreamRequests[0]!.headers.get('mcp-session-id')).toBeNull()
  })

  // Once the row answers on its own, nothing asks the provider whether the
  // session still exists — so a vanished one can only show itself as the
  // endpoint refusing. That refusal has to become the replacement, not the
  // runner's answer.
  test('an endpoint that refuses the row is replaced through the provider and retried', async () => {
    process.env.COMPOSIO_API_KEY = 'composio-secret'
    const ledger = new InMemoryToolRouterLedger()
    ledger.add('session_1', 'workspace_1', [])
    ledger.prepareProvider('session_1', 'provider-session-gone', 'https://composio.example/gone')
    const upstreamRequests: Request[] = []
    const app = testApp(
      async (input, init) => {
        const request = new Request(input, init)
        upstreamRequests.push(request)
        return request.url.endsWith('/gone')
          ? Response.json({ error: 'session not found' }, { status: 404 })
          : Response.json({ jsonrpc: '2.0', id: 1, result: {} })
      },
      1_000,
      authFixture(),
      {
        ledger,
        composioMcpProvider: {
          async createToolRouterSession() {
            return {
              providerSessionId: 'provider-session-replacement',
              mcp: { type: 'http', url: 'https://composio.example/replacement', headers: {} },
            }
          },
          async useToolRouterSession({ providerSessionId }) {
            if (providerSessionId === 'provider-session-gone') {
              throw Object.assign(new Error('provider session not found'), { status: 404 })
            }
            return {
              providerSessionId,
              mcp: { type: 'http', url: 'https://composio.example/replacement', headers: {} },
            }
          },
          async updateToolRouterSession() {
            throw new Error('unexpected permission update')
          },
          async deleteToolRouterSession() {
            throw new Error('the vanished provider session is already gone')
          },
        },
      },
    )

    const response = await app.request('/v1/ws/acme/agent/sessions/session_1/integrations/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'transport-from-gone' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })

    expect(response.status).toBe(200)
    expect(upstreamRequests.map(request => request.url)).toEqual([
      'https://composio.example/gone',
      'https://composio.example/replacement',
    ])
    expect(upstreamRequests[1]!.headers.get('mcp-session-id')).toBeNull()
    expect(ledger.providerSessionId('session_1')).toBe('provider-session-replacement')
  })
})

describe('Composio OAuth callback', () => {
  test('is the one narrowly bypassed Composio path', async () => {
    const app = createApiApp({
      convexUrl: 'http://127.0.0.1:1',
      internalKey: 'internal-secret',
    })

    expect((await app.request('/v1/integrations/composio/oauth/callback')).status).toBe(400)
    expect((await app.request('/v1/integrations/composio/oauth/callback/extra')).status).toBe(401)
  })

  test('round-trips both accepted redirect classes through the signed callback', async () => {
    let providerCallbackUrl: string | undefined
    const app = testApp(async () => Response.json({ ok: true }))
    registerIntegrationRoutes(
      app,
      testRuntime(async () => Response.json({ ok: true })),
      {
        listCatalog: async () => ({ items: [], nextCursor: null }),
        listConnections: async () => ({ items: [], nextCursor: null }),
        getConnection: async () => undefined,
        beginConnection: async args => {
          providerCallbackUrl = args.callbackUrl
          return { authorizeUrl: 'https://provider.example/authorize' }
        },
        disconnect: async () => undefined,
      },
    )

    const cases = [
      {
        redirectTo: '/w/acme/computer/integrations?caller=ignored',
        destination: 'https://app.duet.so/w/acme/computer/integrations',
      },
      {
        redirectTo: 'https://canvas--acme.edge.duet.so/oauth/complete?caller=ignored#done',
        destination: 'https://canvas--acme.edge.duet.so/oauth/complete',
      },
    ]

    for (const redirectCase of cases) {
      const connect = await app.request('/v1/ws/acme/integrations/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ integration: 'gmail', redirectTo: redirectCase.redirectTo }),
      })

      expect(connect.status).toBe(200)
      const callback = new URL(providerCallbackUrl!)
      expect(callback.origin).toBe('http://localhost')
      expect(callback.pathname).toBe('/v1/integrations/composio/oauth/callback')
      expect(
        await verifyComposioOAuthCallbackDescriptor(
          callback.searchParams.get('nonce') ?? undefined,
          'internal-secret',
          1_000,
        ),
      ).toEqual({
        version: 1,
        kind: 'user-connect',
        workspaceSlug: 'acme',
        destination: redirectCase.destination,
        expiresAt: 601_000,
      })

      callback.searchParams.set('code', 'provider-secret')
      callback.searchParams.set('redirectTo', 'https://evil.example/steal')
      const returned = await app.request(callback)

      expect(returned.status).toBe(302)
      expect(returned.headers.get('location')).toBe(redirectCase.destination)
    }
  })

  test('rejects tampered, expired, and off-allowlist callback nonces', async () => {
    const valid = new URL(
      await createComposioUserConnectCallbackUrl({
        requestUrl: 'https://api.duet.so/v1/ws/acme/integrations/connect',
        workspaceSlug: 'acme',
        destination: 'https://app.duet.so/w/acme/computer/integrations',
        secret: 'internal-secret',
        now: 1_000,
      }),
    )
    const tampered = new URL(valid)
    tampered.searchParams.set('nonce', `${tampered.searchParams.get('nonce')}x`)
    expect((await testApp(async () => Response.json({})).request(tampered)).status).toBe(400)

    const expiredApp = testApp(async () => Response.json({}), 10 * 60 * 1_000 + 1_001)
    expect((await expiredApp.request(valid)).status).toBe(400)

    const offAllowlist = new URL(
      await createComposioUserConnectCallbackUrl({
        requestUrl: 'https://api.duet.so/v1/ws/acme/integrations/connect',
        workspaceSlug: 'acme',
        destination: 'https://evil.example/steal',
        secret: 'internal-secret',
        now: 1_000,
      }),
    )
    const rejected = await testApp(async () => Response.json({})).request(offAllowlist)
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: 'redirect_not_allowed' })
  })

  test('keeps the Tool Router return descriptor valid without expiry and derives its destination', async () => {
    const callback = new URL(
      await createComposioToolRouterCallbackUrl({
        requestUrl: 'https://api.duet.so/v1/ws/acme/agent/sessions/session_1/integrations/mcp',
        workspaceSlug: 'acme',
        secret: 'internal-secret',
      }),
    )

    expect(
      await verifyComposioOAuthCallbackDescriptor(
        callback.searchParams.get('nonce') ?? undefined,
        'internal-secret',
        365 * 24 * 60 * 60 * 1_000,
      ),
    ).toEqual({
      version: 1,
      kind: 'tool-router',
      workspaceSlug: 'acme',
    })

    callback.searchParams.set('redirectTo', 'https://evil.example/steal')
    const returned = await testApp(async () => Response.json({})).request(callback)
    expect(returned.status).toBe(302)
    /* The address the SPA actually serves. `computer/` left the product's
       address space with the URL map, and this fallback is the one producer of
       the path that did not follow — an agent-initiated connect landed the
       reader on the not-found route. */
    expect(returned.headers.get('location')).toBe('https://app.duet.so/w/acme/integrations')
  })

  test('rejects the legacy unversioned callback payload even with a valid signature', async () => {
    const callback = new URL('https://api.duet.so/v1/integrations/composio/oauth/callback')
    callback.searchParams.set(
      'nonce',
      await signedTestNonce(
        {
          workspaceSlug: 'acme',
          destination: 'https://app.duet.so/w/acme/computer/integrations',
          expiresAt: 601_000,
        },
        'internal-secret',
      ),
    )

    const response = await testApp(async () => Response.json({})).request(callback)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_oauth_nonce' })
  })
})

async function signedTestNonce(payload: object, secret: string): Promise<string> {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload))
  return `${encodedPayload}.${Buffer.from(signature).toString('base64url')}`
}

function testApp(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  now: number | (() => number) = 1_000,
  auth = authFixture(),
  options: {
    ledger?: InMemoryToolRouterLedger
    useToolRouterSession?: ComposioMcpProvider['useToolRouterSession']
    composioMcpProvider?: ComposioMcpProvider
  } = {},
) {
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  const ledger = options.ledger ?? new InMemoryToolRouterLedger()
  registerComposioRoutes(
    app,
    testRuntime(fetchImpl, now, ledger),
    options.composioMcpProvider ?? {
      createToolRouterSession: async () => {
        throw new Error('unexpected Tool Router creation')
      },
      useToolRouterSession:
        options.useToolRouterSession ??
        (async () => {
          throw new Error('unexpected Tool Router rehydrate')
        }),
      updateToolRouterSession: async () => {
        throw new Error('unexpected Tool Router update')
      },
      deleteToolRouterSession: async () => {
        throw new Error('unexpected Tool Router deletion')
      },
    },
  )
  return app
}

/** A workspace whose Tool Router session is already prepared and dispatchable. */
function readyMcpApp(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const ledger = new InMemoryToolRouterLedger()
  ledger.add('session_1', 'workspace_1', [])
  ledger.prepareProvider(
    'session_1',
    'provider-session-1',
    'https://composio.example/tool-router/mcp',
  )
  return testApp(fetchImpl, 1_000, authFixture(), {
    ledger,
    useToolRouterSession: async ({ providerSessionId }) => ({
      providerSessionId,
      mcp: {
        type: 'http',
        url: 'https://composio.example/tool-router/mcp',
        headers: { 'x-api-key': 'raw-org-key' },
      },
    }),
  })
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
        funding: { plan: null, active: true },
        creditRecovery: null,
        defaultTier: { effective: 'balanced' },
      },
    ],
    scopes: ['ws:acme:integrations'],
    versions: { api: 1 },
  }
}

function testRuntime(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  now: number | (() => number) = 1_000,
  convex: {
    mutation: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>
    query: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>
  } = new InMemoryToolRouterLedger(),
) {
  return {
    convex: convex as never,
    internalKey: 'internal-secret',
    apiInternalKey: 'internal-secret',
    fetchImpl,
    now: typeof now === 'function' ? now : () => now,
    appUrl: 'https://app.duet.so',
    officialHubOwnerEmail: 'official-owner@example.test',
    officialHubBaseUrl: 'https://edge.example.test',
  }
}

class InMemoryToolRouterLedger {
  private readonly deniedSessionIds = new Set<string>()
  private readonly configs = new Map<
    string,
    {
      workspaceId: string
      duetSessionId: string
      permissionFingerprint: string
      disabledToolkitSlugs: string[]
      providerSessionId?: string
      appliedPermissionFingerprint?: string
      mcpUrl?: string
      toolsList?: { providerSessionId: string; permissionFingerprint: string; resultJson: string }
    }
  >()

  add(duetSessionId: string, workspaceId: string, disabledToolkitSlugs: string[]): void {
    this.configs.set(duetSessionId, {
      workspaceId,
      duetSessionId,
      permissionFingerprint: permissionFingerprint(disabledToolkitSlugs),
      disabledToolkitSlugs,
    })
  }

  denyAccess(duetSessionId: string): void {
    this.deniedSessionIds.add(duetSessionId)
  }

  prepareProvider(duetSessionId: string, providerSessionId: string, mcpUrl?: string): void {
    const config = this.configs.get(duetSessionId)
    if (config === undefined) throw new Error('missing test config')
    config.providerSessionId = providerSessionId
    config.appliedPermissionFingerprint = config.permissionFingerprint
    config.mcpUrl = mcpUrl
  }

  providerSessionId(duetSessionId: string): string | undefined {
    return this.configs.get(duetSessionId)?.providerSessionId
  }

  async query(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
    const operation = getFunctionName(reference as never)
    if (operation.endsWith(':authorizeSessionPoint')) {
      const sessionId = String(args.sessionId)
      if (this.deniedSessionIds.has(sessionId)) throw new ConvexError({ error: 'not_found' })
      const config = this.configs.get(sessionId)
      if (config === undefined || config.workspaceId !== args.workspaceId) {
        throw new ConvexError({ error: 'not_found' })
      }
      return { ok: true }
    }
    return await this.mutation(reference, args)
  }

  async mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
    const operation = getFunctionName(reference as never)
    const config = this.configs.get(String(args.duetSessionId))
    if (config === undefined || config.workspaceId !== args.workspaceId) {
      return { status: 'not_found' }
    }
    if (operation.endsWith(':getToolRouterSession')) {
      return { status: 'found', ...config }
    }
    if (operation.endsWith(':adoptToolRouterSession')) {
      if ((config.providerSessionId ?? null) !== args.expectedProviderSessionId) {
        return { status: 'changed' }
      }
      config.providerSessionId = String(args.providerSessionId)
      config.mcpUrl = typeof args.mcpUrl === 'string' ? args.mcpUrl : undefined
      config.toolsList = undefined
      const applied = config.permissionFingerprint === args.permissionFingerprint
      config.appliedPermissionFingerprint = applied ? config.permissionFingerprint : undefined
      return { status: 'adopted', applied }
    }
    if (operation.endsWith(':rememberToolRouterSessionDetails')) {
      const providerSessionId = args.providerSessionId
      if (typeof providerSessionId !== 'string' || config.providerSessionId !== providerSessionId)
        return { remembered: false }
      if (typeof args.mcpUrl === 'string') config.mcpUrl = args.mcpUrl
      if (args.toolsList !== undefined) {
        const lesson = args.toolsList as { permissionFingerprint: string; resultJson: string }
        // Convex refuses a field name starting with `$`; a nested tool schema
        // would be one. The lesson must arrive already serialized.
        if (typeof lesson.resultJson !== 'string') throw new Error('tools list must be a string')
        config.toolsList = { providerSessionId, ...lesson }
      }
      return { remembered: true }
    }
    throw new Error(`unexpected test mutation: ${operation}`)
  }
}

function permissionFingerprint(disabledToolkitSlugs: string[]): string {
  return `permissions:${disabledToolkitSlugs.join(',')}`
}
