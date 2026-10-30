import { describe, expect, test } from 'bun:test'

import {
  MAX_MCP_DROPPED_TOOL_NAME_UTF8_BYTES,
  MAX_MCP_DROPPED_TOOL_NAMES,
  MCP_TOOL_NAME_MAX,
  type FetchLike,
} from '@repo/contract'

import { McpProbeFailure, probeMcpServer } from './probe'

const SERVER_URL = 'https://mcp.example.test/mcp'

const resolveHost = async (hostname: string) =>
  hostname === 'mcp.example.test' || hostname === 'auth.example.test'
    ? ['203.0.113.10']
    : ['203.0.113.11']

interface Tool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** Every real server sends an input schema; a fixture without one is not one. */
function tool(name: string, description?: string): Tool {
  return {
    name,
    ...(description === undefined ? {} : { description }),
    inputSchema: { type: 'object', properties: {} },
  }
}

/**
 * A streamable-HTTP MCP server small enough to read, answering the way slice
 * 00 measured real ones: `text/event-stream` for every JSON-RPC response,
 * including `initialize` and `tools/list`.
 */
function mcpServer(options: { tools: Tool[]; requiredHeader?: [string, string] }): {
  fetchImpl: FetchLike
  requests: Request[]
} {
  const requests: Request[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    const request = new Request(String(input), init as RequestInit)
    requests.push(request.clone())
    if (request.method === 'GET') return new Response(null, { status: 405 })
    const [name, value] = options.requiredHeader ?? []
    if (name !== undefined && request.headers.get(name) !== value) {
      return new Response('nope', { status: 401 })
    }
    const message = (await request.json()) as { id?: number; method: string }
    if (message.id === undefined) return new Response(null, { status: 202 })
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'example', version: '1.0.0' },
          }
        : { tools: options.tools }
    return new Response(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`,
      { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' } },
    )
  }
  return { fetchImpl, requests }
}

async function failureOf(act: () => Promise<unknown>): Promise<string> {
  try {
    await act()
  } catch (error) {
    if (error instanceof McpProbeFailure) return error.code
    throw error
  }
  return 'succeeded'
}

describe('MCP server probe', () => {
  test('measures what the tools block will cost this workspace per turn', async () => {
    const tools = [
      tool('read_wiki_structure', 'List every documentation topic this repository has'),
      tool('ask_question'),
    ]
    const { fetchImpl } = mcpServer({ tools })

    const probe = await probeMcpServer({
      name: 'deepwiki',
      url: SERVER_URL,
      auth: { kind: 'none' },
      fetchImpl,
      resolveHost,
    })

    expect(probe.auth).toBe('none')
    expect(probe.toolCount).toBe(2)
    expect(probe.droppedToolNames).toEqual([])
    // The number the row promises to show is the serialized tools block, not a
    // guess derived from the count: two tools of very different sizes must not
    // measure the same.
    expect(probe.estimatedPromptBytes).toBe(Buffer.byteLength(JSON.stringify(tools), 'utf8'))
  })

  test('drops the tools whose namespaced name cannot fit, and says which', async () => {
    // The ceiling applies to `name__tool`, so the same server drops different
    // tools under a shorter server name — which is why the probe takes one.
    const fits = 'a'.repeat(MCP_TOOL_NAME_MAX - 'ticketing'.length - 2)
    const tools = [tool(fits), tool(`${fits}b`)]
    const { fetchImpl } = mcpServer({ tools })

    const probe = await probeMcpServer({
      name: 'ticketing',
      url: SERVER_URL,
      auth: { kind: 'none' },
      fetchImpl,
      resolveHost,
    })

    expect(probe.droppedToolNames).toEqual([`${fits}b`])
    expect(probe.toolCount).toBe(1)
    // A dropped tool never reaches the model, so it must not be billed for.
    expect(probe.estimatedPromptBytes).toBe(Buffer.byteLength(JSON.stringify([tool(fits)])))
  })

  test('bounds the third-party casualty list before it can reach persistence', async () => {
    const giantName = '🚀'.repeat(MAX_MCP_DROPPED_TOOL_NAME_UTF8_BYTES)
    const tools = Array.from({ length: MAX_MCP_DROPPED_TOOL_NAMES + 5 }, (_, index) =>
      tool(`${index}-${giantName}`),
    )
    const { fetchImpl } = mcpServer({ tools })

    const probe = await probeMcpServer({
      name: 'ticketing',
      url: SERVER_URL,
      auth: { kind: 'none' },
      fetchImpl,
      resolveHost,
    })

    expect(probe.droppedToolNames).toHaveLength(MAX_MCP_DROPPED_TOOL_NAMES)
    expect(
      probe.droppedToolNames.every(
        name => Buffer.byteLength(name, 'utf8') <= MAX_MCP_DROPPED_TOOL_NAME_UTF8_BYTES,
      ),
    ).toBe(true)
  })

  test('sends a pasted token, and reports a rejected one as a credential failure', async () => {
    const accepting = mcpServer({
      tools: [tool('search')],
      requiredHeader: ['authorization', 'Bearer paste-me'],
    })

    const probe = await probeMcpServer({
      name: 'ticketing',
      url: SERVER_URL,
      auth: { kind: 'static', token: 'paste-me' },
      fetchImpl: accepting.fetchImpl,
      resolveHost,
    })
    // A server that accepts the pasted token issues no challenge, so what it
    // reports is the challenge it did not make: `none`.
    expect(probe.auth).toBe('none')
    expect(probe.toolCount).toBe(1)

    const rejecting = mcpServer({
      tools: [],
      requiredHeader: ['authorization', 'Bearer something-else'],
    })
    expect(
      await failureOf(() =>
        probeMcpServer({
          name: 'ticketing',
          url: SERVER_URL,
          auth: { kind: 'static', token: 'paste-me' },
          fetchImpl: rejecting.fetchImpl,
          resolveHost,
        }),
      ),
    ).toBe('unauthorized')
  })

  test('reads an OAuth challenge as CIMD-or-DCR, never DCR alone', async () => {
    const withMetadata = (metadata: Record<string, unknown>): FetchLike => {
      return async (input, init) => {
        const request = new Request(String(input), init as RequestInit)
        const url = new URL(request.url)
        if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
          return Response.json({
            resource: SERVER_URL,
            authorization_servers: ['https://auth.example.test'],
            scopes_supported: ['mcp:read', 'mcp:write'],
          })
        }
        if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
          return Response.json({
            issuer: 'https://auth.example.test',
            authorization_endpoint: 'https://auth.example.test/authorize',
            token_endpoint: 'https://auth.example.test/token',
            response_types_supported: ['code'],
            ...metadata,
          })
        }
        if (url.origin === 'https://auth.example.test') return new Response(null, { status: 404 })
        return new Response('unauthorized', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="mcp:read"',
          },
        })
      }
    }

    const probeWith = async (metadata: Record<string, unknown>) =>
      await probeMcpServer({
        name: 'linear',
        url: SERVER_URL,
        auth: { kind: 'oauth' },
        fetchImpl: withMetadata(metadata),
        resolveHost,
      })

    // Every OAuth-capable server slice 00 tested advertises CIMD, so a
    // DCR-shaped reading would refuse OAuth on servers Duet can connect to.
    const cimdOnly = await probeWith({ client_id_metadata_document_supported: true })
    expect(cimdOnly.auth).toBe('oauth')
    expect(cimdOnly.registrationSupported).toBe(true)
    // The challenge's own scope wins over the resource metadata's list.
    expect(cimdOnly.scope).toBe('mcp:read')
    // Nothing was listed, so nothing may be claimed about the per-turn cost.
    expect(cimdOnly.toolCount).toBe(0)
    expect(cimdOnly.estimatedPromptBytes).toBe(0)

    expect(
      (await probeWith({ registration_endpoint: 'https://auth.example.test/register' }))
        .registrationSupported,
    ).toBe(true)
    // Neither way in: D7's refusal branch, which GitHub Copilot's server is a
    // live example of.
    expect((await probeWith({})).registrationSupported).toBe(false)
  })

  test('refuses to leave the control plane for a private address', async () => {
    const { fetchImpl, requests } = mcpServer({ tools: [] })
    expect(
      await failureOf(() =>
        probeMcpServer({
          name: 'internal',
          url: 'https://169.254.169.254/mcp',
          auth: { kind: 'none' },
          fetchImpl,
          resolveHost,
        }),
      ),
    ).toBe('blocked')
    expect(requests).toEqual([])
  })

  test('reports an unreachable server as unreachable, not as a no-auth server', async () => {
    expect(
      await failureOf(() =>
        probeMcpServer({
          name: 'gone',
          url: SERVER_URL,
          auth: { kind: 'none' },
          fetchImpl: async () => new Response('nope', { status: 502 }),
          resolveHost,
        }),
      ),
    ).toBe('unreachable')
  })
})
