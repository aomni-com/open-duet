import {
  McpAddAgentNoteInputSchema,
  McpListAgentSessionsInputSchema,
  McpRunAgentInputSchema,
} from '@repo/contract'

import { defineMcpTool, type McpToolRegistry } from '../server'
import { jsonResult } from '../tool-results'

const JSON_HEADERS = { 'content-type': 'application/json' } as const

export function registerAgentTools(registry: McpToolRegistry): void {
  registry.register(
    defineMcpTool({
      name: 'run_agent',
      description: 'Run a Duet agent turn in a workspace.',
      capabilities: ['sessions'],
      inputSchema: McpRunAgentInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:sessions`],
      rest: input => ({
        method: 'POST',
        path: `/v1/ws/${input.workspace}/agent/sessions`,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          prompt: input.prompt,
          ...(input.images === undefined || input.images.length === 0
            ? {}
            : { images: input.images }),
        }),
      }),
      result: jsonResult,
    }),
  )
  registry.register(
    defineMcpTool({
      name: 'list_agent_sessions',
      description: 'List Duet agent sessions in a workspace.',
      capabilities: ['sessions'],
      inputSchema: McpListAgentSessionsInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:sessions`],
      rest: input => {
        const params = new URLSearchParams()
        if (input.cursor !== undefined) params.set('cursor', input.cursor)
        if (input.limit !== undefined) params.set('limit', String(input.limit))
        const query = params.toString()
        return {
          method: 'GET',
          path: `/v1/ws/${input.workspace}/agent/sessions${query.length > 0 ? `?${query}` : ''}`,
        }
      },
      result: jsonResult,
    }),
  )
  registry.register(
    defineMcpTool({
      name: 'add_agent_note',
      description: 'Add a queued note to a Duet agent session without waking the runner.',
      capabilities: ['sessions'],
      inputSchema: McpAddAgentNoteInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:sessions`],
      rest: input => ({
        method: 'POST',
        path: `/v1/ws/${input.workspace}/agent/sessions/${encodeURIComponent(input.sessionId)}/note`,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          note: input.note,
          ...(input.images === undefined || input.images.length === 0
            ? {}
            : { images: input.images }),
          // Forwarded rather than dropped: a note may be files alone, and one
          // stripped of them on the way is an empty note the API refuses.
          ...(input.attachments === undefined || input.attachments.length === 0
            ? {}
            : { attachments: input.attachments }),
        }),
      }),
      result: jsonResult,
    }),
  )
}
