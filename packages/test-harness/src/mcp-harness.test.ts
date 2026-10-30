import { describe, expect, test } from 'bun:test'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { mcpHarness } from './mcp-harness.ts'

describe('mcpHarness', () => {
  test('connects a real MCP client, lists tools, and calls a tool', async () => {
    const server = new McpServer({ name: 'duet-test-server', version: '0.0.0' })
    server.registerTool('echo', { description: 'Echo a pinned response.' }, () => ({
      content: [{ type: 'text', text: 'mcp-harness-ok' }],
    }))

    const harness = await mcpHarness(server)
    try {
      const tools = await harness.listTools()
      expect(tools.tools.map(tool => tool.name)).toContain('echo')

      const result = await harness.callTool('echo')
      expect(result.content).toEqual([{ type: 'text', text: 'mcp-harness-ok' }])
    } finally {
      await harness.close()
    }
  })
})
