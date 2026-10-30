import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import * as AgentSchemas from '../agent/index'
import * as McpSchemas from '../mcp/index'
import * as McpServerSchemas from './index'
import {
  AddMcpServerRequestSchema,
  McpServerListSchema,
  McpServerProbeRequestSchema,
  McpServerProbeSchema,
  McpServerSchema,
  MAX_MCP_DROPPED_TOOL_NAME_UTF8_BYTES,
  MAX_MCP_DROPPED_TOOL_NAMES,
  RemoveMcpServerResponseSchema,
  SetMcpServerAgentPolicyRequestSchema,
  McpServerAgentPolicyResponseSchema,
} from './index'

const server = {
  name: 'deepwiki',
  label: 'DeepWiki',
  url: 'https://mcp.deepwiki.com/mcp',
  authKind: 'none' as const,
  state: 'ready' as const,
  toolCount: 3,
  estimatedPromptBytes: 1_842,
  droppedToolNames: ['a_very_long_tool_name'],
  lastSuccessAt: 1_755_400_000_000,
  createdAt: 1_755_300_000_000,
  updatedAt: 1_755_400_000_000,
}

describe('mcp server wire schemas', () => {
  test('round-trips a listed server and its per-turn cost estimate', () => {
    expect(McpServerSchema.parse(server)).toEqual(server)
    expect(McpServerListSchema.parse({ items: [server], nextCursor: null })).toEqual({
      items: [server],
      nextCursor: null,
    })
    expect(McpServerListSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    })
  })

  test('carries a failure as a closed code, never an upstream body', () => {
    const failing = {
      ...server,
      state: 'reauth_required' as const,
      lastErrorAt: 1_755_400_500_000,
      lastErrorCode: 'reauth_required' as const,
    }
    expect(McpServerSchema.parse(failing)).toEqual(failing)
    expect(
      McpServerSchema.safeParse({ ...server, lastErrorCode: '401 Unauthorized: bearer sk-live-…' })
        .success,
    ).toBe(false)
  })

  test('holds registration to the name grammar and https at the add boundary', () => {
    const request = {
      name: 'deepwiki',
      url: 'https://mcp.deepwiki.com/mcp',
      label: 'DeepWiki',
      auth: { kind: 'none' as const },
    }
    expect(AddMcpServerRequestSchema.parse(request)).toEqual(request)
    expect(AddMcpServerRequestSchema.parse({ name: 'deepwiki', url: request.url })).toEqual({
      name: 'deepwiki',
      url: request.url,
    })

    for (const bad of [
      { ...request, name: 'my__server' },
      { ...request, name: 'integrations' },
      { ...request, name: 'x'.repeat(49) },
      { ...request, url: 'http://mcp.deepwiki.com/mcp' },
      // `static` without the token it exists to carry is not a static server.
      { ...request, auth: { kind: 'static' as const } },
    ]) {
      expect(AddMcpServerRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  test('takes a pasted token on the way in, and nothing else beside it', () => {
    expect(
      AddMcpServerRequestSchema.parse({
        name: 'ticketing',
        url: 'https://mcp.example.test/mcp',
        auth: { kind: 'static', token: 'paste-me' },
      }).auth,
    ).toEqual({ kind: 'static', token: 'paste-me' })

    // No user-entered expiry, ever: Duet cannot know when a pasted token dies,
    // so a stored guess would be a lie the product then acted on. The health
    // signal is the expiry story instead.
    expect(
      AddMcpServerRequestSchema.parse({
        name: 'ticketing',
        url: 'https://mcp.example.test/mcp',
        auth: { kind: 'static', token: 'paste-me', expiresAt: 1_755_400_000_000 },
      }).auth,
    ).toEqual({ kind: 'static', token: 'paste-me' })

    expect(
      AddMcpServerRequestSchema.safeParse({
        name: 'ticketing',
        url: 'https://mcp.example.test/mcp',
        auth: { kind: 'static', token: '' },
      }).success,
    ).toBe(false)
  })

  test('probes with the same identity the row will carry', () => {
    expect(
      McpServerProbeRequestSchema.parse({
        name: 'deepwiki',
        url: 'https://mcp.deepwiki.com/mcp',
        auth: { kind: 'oauth' },
      }),
    ).toEqual({ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', auth: { kind: 'oauth' } })

    const probe = {
      auth: 'oauth' as const,
      toolCount: 12,
      estimatedPromptBytes: 9_120,
      droppedToolNames: [],
      registrationSupported: true,
    }
    expect(McpServerProbeSchema.parse(probe)).toEqual(probe)
    expect(
      McpServerProbeSchema.parse({ auth: 'none', toolCount: 0, estimatedPromptBytes: 2 }),
    ).toEqual({ auth: 'none', toolCount: 0, estimatedPromptBytes: 2 })
  })

  test('bounds persisted dropped-tool probe metadata', () => {
    const droppedToolNames = Array.from(
      { length: MAX_MCP_DROPPED_TOOL_NAMES },
      (_, index) =>
        `${index}-${'x'.repeat(MAX_MCP_DROPPED_TOOL_NAME_UTF8_BYTES - String(index).length - 1)}`,
    )
    const probe = { auth: 'none' as const, toolCount: 0, estimatedPromptBytes: 2, droppedToolNames }
    expect(McpServerProbeSchema.parse(probe)).toEqual(probe)
    expect(
      McpServerProbeSchema.safeParse({ ...probe, droppedToolNames: [...droppedToolNames, 'extra'] })
        .success,
    ).toBe(false)
    expect(
      McpServerProbeSchema.safeParse({
        ...probe,
        droppedToolNames: [`${'x'.repeat(MAX_MCP_DROPPED_TOOL_NAME_UTF8_BYTES - 3)}🚀`],
      }).success,
    ).toBe(false)
  })

  test('scopes a server to agents by the same three-state rule as a toolkit', () => {
    expect(SetMcpServerAgentPolicyRequestSchema.parse({ allowedAgentIds: ['agent_1'] })).toEqual({
      allowedAgentIds: ['agent_1'],
    })
    // Absent means every agent; empty means none. Both are real states.
    expect(SetMcpServerAgentPolicyRequestSchema.parse({})).toEqual({})
    expect(SetMcpServerAgentPolicyRequestSchema.parse({ allowedAgentIds: [] })).toEqual({
      allowedAgentIds: [],
    })
    expect(
      McpServerAgentPolicyResponseSchema.parse({ name: 'deepwiki', allowedAgentIds: ['agent_1'] }),
    ).toEqual({ name: 'deepwiki', allowedAgentIds: ['agent_1'] })
    // A removal always says what it attempted upstream. `revoked` is the
    // ATTEMPT, never a claim that the third party forgot anything: RFC 7009
    // §2.2 makes a 200 mandatory for a token nobody recognizes.
    expect(
      RemoveMcpServerResponseSchema.parse({
        name: 'deepwiki',
        removed: true,
        revoked: 'not_supported',
        registration: 'retained',
      }),
    ).toEqual({
      name: 'deepwiki',
      removed: true,
      revoked: 'not_supported',
      registration: 'retained',
    })
  })

  test('strips unknown fields so a version-skewed reader cannot be fed extras', () => {
    expect(
      AddMcpServerRequestSchema.parse({
        name: 'deepwiki',
        url: 'https://mcp.deepwiki.com/mcp',
        unexpected: true,
      }),
    ).toEqual({ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' })
    expect('unexpected' in McpServerSchema.parse({ ...server, unexpected: true })).toBe(false)
  })

  // The credential invariant, mechanically. Custom servers hold third-party
  // tokens; none of them may reach a wire schema. The one allowlisted exception
  // in the whole feature is the static-token paste on the ADD REQUEST, which
  // slice 05 adds — it is named here so a second one is a deliberate edit.
  test('exposes no credential-shaped field in any mcp wire schema', () => {
    const allowedSecretFields = new Set([
      // Pre-existing and unrelated to MCP: Duet's own short-lived grant for
      // uploading bytes straight to a workspace VM (`VmUploadGrantSchema`),
      // which the attachment-upload session hands back. No third-party
      // credential rides it.
      // The whole feature's single allowlisted secret: one pasted token, on the
      // way IN only. Three paths, one field — `McpServerRequestAuthSchema`'s
      // `static` branch, reached directly and through the two request schemas
      // that embed it. The probe carries it because a token has to be tried
      // before a row is written; nothing hands it back out.
      'McpServerRequestAuthSchema.oneOf[2].token',
      'McpServerProbeRequestSchema.properties.auth.oneOf[2].token',
      'AddMcpServerRequestSchema.properties.auth.oneOf[2].token',
    ])
    const violations = new Set<string>()

    for (const schemaModule of [McpServerSchemas, McpSchemas, AgentSchemas]) {
      for (const [schemaName, value] of Object.entries(schemaModule)) {
        if (!schemaName.endsWith('Schema') || !(value instanceof z.ZodType)) continue
        for (const io of ['input', 'output'] as const) {
          const jsonSchema = z.toJSONSchema(value, { unrepresentable: 'any', io })
          walkJsonSchema(jsonSchema, schemaName, (path, field) => {
            if (isCredentialShaped(field) && !allowedSecretFields.has(path)) violations.add(path)
          })
        }
      }
    }

    expect([...violations]).toEqual([])
  })
})

function isCredentialShaped(field: string): boolean {
  const name = field.toLowerCase()
  if (['access', 'refresh', 'token', 'secret', 'credential', 'password'].includes(name)) return true
  return ['token', 'secret', 'credential', 'password'].some(root => name.endsWith(root))
}

function walkJsonSchema(
  value: unknown,
  path: string,
  visitField: (path: string, field: string) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJsonSchema(item, `${path}[${index}]`, visitField))
    return
  }
  if (value === null || typeof value !== 'object') return

  const record = value as Record<string, unknown>
  const properties = record.properties
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const field of Object.keys(properties as Record<string, unknown>)) {
      visitField(`${path}.${field}`, field)
    }
  }
  for (const [key, child] of Object.entries(record)) {
    walkJsonSchema(child, `${path}.${key}`, visitField)
  }
}
