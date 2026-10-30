import { describe, expect, test } from 'bun:test'

import {
  INTEGRATIONS_MCP_SERVER_NAME,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_NAME_SEPARATOR,
  McpAddAgentNoteInputSchema,
  McpGenerateMediaInputSchema,
  McpListAgentSessionsInputSchema,
  McpServerNameSchema,
  McpServerUrlSchema,
  McpTrainStartInputSchema,
  namespacedToolName,
  splitNamespacedToolName,
} from './index'

describe('mcp input schemas', () => {
  test('agent session list validates workspace slugs and optional paging', () => {
    expect(
      McpListAgentSessionsInputSchema.safeParse({
        workspace: 'agent-workspace',
        cursor: 'cursor:1',
        limit: 25,
      }).success,
    ).toBe(true)
    expect(
      McpListAgentSessionsInputSchema.safeParse({ workspace: 'Agent_Workspace' }).success,
    ).toBe(false)
  })

  test('agent notes require a nonempty note capped at 16 KiB', () => {
    expect(
      McpAddAgentNoteInputSchema.safeParse({
        workspace: 'agent-workspace',
        sessionId: 'sess_123',
        note: 'keep this context queued',
      }).success,
    ).toBe(true)
    expect(
      McpAddAgentNoteInputSchema.safeParse({
        workspace: 'agent-workspace',
        sessionId: 'sess_123',
        note: '',
      }).success,
    ).toBe(false)
    expect(
      McpAddAgentNoteInputSchema.safeParse({
        workspace: 'agent-workspace',
        sessionId: 'sess_123',
        note: 'x'.repeat(16 * 1024 + 1),
      }).success,
    ).toBe(false)
  })

  test('train start refuses byte-bearing fields while tolerating unknown ones', () => {
    expect(
      McpTrainStartInputSchema.parse({
        workspace: 'agent-workspace',
        urls: ['https://example.com/guide'],
        driveFiles: ['reports/q2.pdf'],
      }),
    ).toEqual({
      workspace: 'agent-workspace',
      urls: ['https://example.com/guide'],
      driveFiles: ['reports/q2.pdf'],
    })

    // Byte-bearing fields are refused, not dropped: a caller that sends
    // `content` believes it uploaded something, and starting a train run over
    // material that never arrived is worse than an error.
    for (const input of [
      { workspace: 'agent-workspace', files: [] },
      { workspace: 'agent-workspace', content: 'raw file bytes' },
      { workspace: 'agent-workspace', encoding: 'base64' },
    ]) {
      expect(McpTrainStartInputSchema.safeParse(input).success).toBe(false)
    }

    // An unknown field the facade simply does not know is still tolerated — the
    // deny-list is specific, not a return to rejecting everything unfamiliar.
    expect(McpTrainStartInputSchema.parse({ workspace: 'agent-workspace', futureKnob: 1 })).toEqual(
      { workspace: 'agent-workspace' },
    )
  })

  test('media generation accepts optional role ids for image and video but hard-cuts audio', () => {
    expect(
      McpGenerateMediaInputSchema.parse({
        workspace: 'agent-workspace',
        model: 'fixture-role',
        prompt: 'draw a diagram',
      }),
    ).toEqual({
      workspace: 'agent-workspace',
      kind: 'image',
      model: 'fixture-role',
      prompt: 'draw a diagram',
    })
    expect(
      McpGenerateMediaInputSchema.safeParse({
        workspace: 'agent-workspace',
        kind: 'video',
        prompt: 'animate a diagram',
      }).success,
    ).toBe(true)
    expect(
      McpGenerateMediaInputSchema.safeParse({
        workspace: 'agent-workspace',
        kind: 'audio',
        prompt: 'read a diagram',
      }).success,
    ).toBe(false)
  })
})

describe('mcp server naming', () => {
  test('accepts the grammar a tool-name prefix can carry', () => {
    for (const name of ['deepwiki', 'acme_internal', 'acme-internal', 'a', 'A1', 'x'.repeat(48)]) {
      expect(McpServerNameSchema.safeParse(name).success, name).toBe(true)
    }
    for (const name of ['', 'x'.repeat(49), 'has space', 'has.dot', 'has/slash', 'ünïcode']) {
      expect(McpServerNameSchema.safeParse(name).success, name).toBe(false)
    }
  })

  // `_` is legal but `__` is not: the name is joined to the tool with `__`, so
  // `my__server__TOOL` would have two valid decodings and the codec below could
  // not be the single owner of the mapping.
  test('refuses a name containing the separator even though single underscores pass', () => {
    expect(McpServerNameSchema.safeParse('my_server').success).toBe(true)
    expect(McpServerNameSchema.safeParse('my__server').success).toBe(false)
    expect(McpServerNameSchema.safeParse('__lead').success).toBe(false)
    expect(McpServerNameSchema.safeParse('trail__').success).toBe(false)
  })

  // McpServersConfig is a Record keyed by server name, so a custom server named
  // `integrations` would silently displace the Composio entry rather than
  // collide with it.
  test('reserves the Composio entry name', () => {
    expect(McpServerNameSchema.safeParse(INTEGRATIONS_MCP_SERVER_NAME).success).toBe(false)
    expect(McpServerNameSchema.safeParse('integrations-eu').success).toBe(true)
  })

  test('requires an https server url', () => {
    expect(McpServerUrlSchema.safeParse('https://mcp.example.com/mcp').success).toBe(true)
    expect(McpServerUrlSchema.safeParse('http://mcp.example.com/mcp').success).toBe(false)
    expect(McpServerUrlSchema.safeParse('ftp://mcp.example.com/mcp').success).toBe(false)
    expect(McpServerUrlSchema.safeParse('mcp.example.com/mcp').success).toBe(false)
    expect(McpServerUrlSchema.safeParse('').success).toBe(false)
  })
})

describe('namespaced tool name codec', () => {
  test('round-trips every name the grammar allows', () => {
    for (const [server, tool] of [
      ['deepwiki', 'search'],
      ['acme_internal', 'search_orders'],
      ['acme-internal', 'search-orders'],
      [INTEGRATIONS_MCP_SERVER_NAME, 'COMPOSIO_REMOTE_WORKBENCH'],
      ['x'.repeat(48), 'y'],
    ] as const) {
      const encoded = namespacedToolName(server, tool)
      expect(encoded).toBe(`${server}${MCP_TOOL_NAME_SEPARATOR}${tool}`)
      expect(splitNamespacedToolName(encoded)).toEqual({ server, tool })
    }
  })

  test('splits on the first separator so a tool name may contain one too', () => {
    expect(splitNamespacedToolName('acme__search__orders')).toEqual({
      server: 'acme',
      tool: 'search__orders',
    })
    expect(splitNamespacedToolName('a_b__c_d')).toEqual({ server: 'a_b', tool: 'c_d' })
  })

  test('decodes a name at the 128-char ceiling and refuses one past it', () => {
    const server = 'x'.repeat(48)
    const tool = 'y'.repeat(MCP_TOOL_NAME_MAX - server.length - MCP_TOOL_NAME_SEPARATOR.length)
    const encoded = namespacedToolName(server, tool)
    expect(encoded).toHaveLength(MCP_TOOL_NAME_MAX)
    expect(splitNamespacedToolName(encoded)).toEqual({ server, tool })
    expect(splitNamespacedToolName(namespacedToolName(server, `${tool}z`))).toBeNull()
  })

  test('returns null for anything the encoder could not have produced', () => {
    for (const candidate of [
      'bare_tool_name',
      '__leading',
      'trailing__',
      '__',
      '',
      `${'x'.repeat(49)}__tool`,
      'server__has space',
      'has space__tool',
    ]) {
      expect(splitNamespacedToolName(candidate), candidate).toBeNull()
    }
  })
})
