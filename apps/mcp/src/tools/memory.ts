import { McpMemoryAddInputSchema, McpMemorySearchInputSchema } from '@repo/contract'

import { defineMcpTool, type McpToolRegistry } from '../server'
import { jsonResult } from '../tool-results'

const JSON_HEADERS = { 'content-type': 'application/json' } as const

export function registerMemoryTools(registry: McpToolRegistry): void {
  registry.register(
    defineMcpTool({
      name: 'memory_add',
      description: 'Add a memory to a Duet workspace.',
      capabilities: ['memory'],
      inputSchema: McpMemoryAddInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:memory`],
      rest: input => ({
        method: 'POST',
        path: `/v1/ws/${input.workspace}/memories`,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          content: input.content,
          source: input.source,
        }),
      }),
      result: jsonResult,
    }),
  )
  registry.register(
    defineMcpTool({
      name: 'memory_search',
      description: 'Search memories in a Duet workspace.',
      capabilities: ['memory'],
      inputSchema: McpMemorySearchInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:memory`],
      rest: input => {
        const params = new URLSearchParams({ q: input.query })
        if (input.limit !== undefined) params.set('limit', String(input.limit))
        return {
          method: 'GET',
          path: `/v1/ws/${input.workspace}/memories/search?${params.toString()}`,
        }
      },
      result: jsonResult,
    }),
  )
}
