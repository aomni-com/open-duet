import { McpUseIntegrationInputSchema } from '@repo/contract'

import { defineMcpTool, type McpToolRegistry } from '../server'
import { jsonResult } from '../tool-results'

const JSON_HEADERS = { 'content-type': 'application/json' } as const

export function registerIntegrationTools(registry: McpToolRegistry): void {
  registry.register(
    defineMcpTool({
      name: 'use_integration',
      description: 'Call a connected workspace integration through Duet.',
      capabilities: ['integrations'],
      inputSchema: McpUseIntegrationInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:integrations`],
      rest: input => ({
        method: 'POST',
        path: `/v1/integrations/composio/execute/${encodeURIComponent(input.toolSlug)}`,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          workspace: input.workspace,
          arguments: input.arguments ?? {},
        }),
      }),
      result: jsonResult,
    }),
  )
}
