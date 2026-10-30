import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js'

export interface McpHarness {
  client: Client
  listTools(): Promise<ListToolsResult>
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

export async function mcpHarness(server: McpServer): Promise<McpHarness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'duet-test-harness', version: '0.0.0' })

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    client,
    listTools: () => client.listTools(),
    callTool: (name, args = {}) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    async close() {
      await Promise.allSettled([client.close(), server.close()])
    },
  }
}
