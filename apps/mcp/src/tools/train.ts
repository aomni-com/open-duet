import { McpTrainStartInputSchema } from '@repo/contract'

import { defineMcpTool, type McpToolRegistry } from '../server'
import { jsonResult } from '../tool-results'

const JSON_HEADERS = { 'content-type': 'application/json' } as const

export function registerTrainTools(registry: McpToolRegistry): void {
  registry.register(
    defineMcpTool({
      name: 'train_start',
      description: 'Start an asynchronous training job from staged, URL, or drive sources.',
      capabilities: ['memory'],
      inputSchema: McpTrainStartInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:memory`],
      rest: input => {
        const body = {
          ...(input.urls === undefined ? {} : { urls: input.urls }),
          ...(input.driveFiles === undefined ? {} : { driveFiles: input.driveFiles }),
        }
        return {
          method: 'POST',
          path: `/v1/ws/${input.workspace}/train`,
          ...(Object.keys(body).length === 0
            ? {}
            : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
        }
      },
      result: jsonResult,
    }),
  )
}
