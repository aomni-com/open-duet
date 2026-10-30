import type { GrantPayload } from './grants'

/**
 * A small real MCP server behind the fake issuer's OAuth. It answers over
 * `text/event-stream` because that is the framing every real server measured in
 * slice 00 used — including for `initialize` and `tools/list`. A JSON-only
 * fixture would let a client's SSE handling pass in test and fail in
 * production.
 *
 * It is stateless: no session id is issued, so the client never sends one back
 * and never asks to terminate one.
 */
export const FAKE_MCP_SERVER_NAME = 'duet-fake-mcp'
export const FAKE_MCP_OVERSIZED_TOOL = 'oversized_document'
/** Comfortably past the 128 KiB proxy cap, in the content block alone. */
export const FAKE_MCP_OVERSIZED_BYTES = 192 * 1024

const LATEST_PROTOCOL_VERSION = '2025-11-25'
const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]

const TOOLS = [
  {
    name: 'echo',
    description: 'Returns the message it was given.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'whoami',
    description: 'Returns the account the bearer token belongs to.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: FAKE_MCP_OVERSIZED_TOOL,
    description: 'Returns a deliberately oversized document, duplicated into structured content.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { document: { type: 'string' } },
      required: ['document'],
    },
  },
]

export function mcpChallenge(baseUrl: string): Response {
  return Response.json(
    { error: 'unauthorized' },
    {
      status: 401,
      headers: {
        'www-authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="mcp:tools"`,
      },
    },
  )
}

export function handleMcp(request: Request, message: unknown, grant: GrantPayload): Response {
  if (request.method !== 'POST') {
    // The spec lets a server decline the optional server-to-client GET stream.
    return Response.json({ error: 'method_not_allowed' }, { status: 405 })
  }
  const messages = Array.isArray(message) ? message : [message]
  const responses = messages
    .map(entry => respond(entry, grant))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
  if (responses.length === 0) return new Response(null, { status: 202 })
  return new Response(
    responses.map(entry => `event: message\ndata: ${JSON.stringify(entry)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

function respond(message: unknown, grant: GrantPayload): Record<string, unknown> | undefined {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const request = message as Record<string, unknown>
  const id = request.id
  if (id === undefined) return undefined // a notification: acknowledged with 202
  const method = typeof request.method === 'string' ? request.method : ''
  const params = isRecord(request.params) ? request.params : {}

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
    return result(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: FAKE_MCP_SERVER_NAME, version: '1.0.0' },
    })
  }
  if (method === 'ping') return result(id, {})
  if (method === 'tools/list') return result(id, { tools: TOOLS })
  if (method === 'tools/call') return result(id, callTool(params, grant))
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  }
}

function callTool(params: Record<string, unknown>, grant: GrantPayload): Record<string, unknown> {
  const args = isRecord(params.arguments) ? params.arguments : {}
  if (params.name === 'echo') {
    const message = typeof args.message === 'string' ? args.message : ''
    return { content: [{ type: 'text', text: `echo: ${message}` }] }
  }
  if (params.name === 'whoami') {
    return { content: [{ type: 'text', text: accountId(grant) }] }
  }
  if (params.name === FAKE_MCP_OVERSIZED_TOOL) {
    const document = oversizedDocument()
    // Real servers duplicate their payload into structuredContent — the probe
    // measured a 688 KB content block copied almost byte for byte. A client
    // that caps results should be able to halve this at zero information cost.
    return { content: [{ type: 'text', text: document }], structuredContent: { document } }
  }
  return {
    content: [{ type: 'text', text: `Unknown tool: ${String(params.name)}` }],
    isError: true,
  }
}

function oversizedDocument(): string {
  const line = 'the fake MCP server returns more bytes than any caller should accept. '
  return line
    .repeat(Math.ceil(FAKE_MCP_OVERSIZED_BYTES / line.length))
    .slice(0, FAKE_MCP_OVERSIZED_BYTES)
}

function accountId(grant: GrantPayload): string {
  return `fake-account-mcp-${grant.flowId.slice(0, 8)}`
}

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
