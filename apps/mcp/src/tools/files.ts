import {
  McpFileHistoryInputSchema,
  McpFileSeenByInputSchema,
  McpListFilesInputSchema,
  McpReadFileInputSchema,
  McpWriteFileInputSchema,
  isTextLikeDriveResource,
} from '@repo/contract'

import { createFileResource, toResourceLink } from '../file-resources'
import { defineMcpTool, type McpToolRegistry } from '../server'
import { jsonResult, toolErrorFromApi } from '../tool-results'

export function registerFileTools(registry: McpToolRegistry): void {
  registry.register(
    defineMcpTool({
      name: 'list_files',
      description: 'List files in a Duet workspace directory.',
      capabilities: ['files:read'],
      inputSchema: McpListFilesInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:files:read`],
      rest: input => {
        const path = input.path ?? ''
        const params = new URLSearchParams({ list: '1' })
        if (input.cursor !== undefined) params.set('cursor', input.cursor)
        if (input.limit !== undefined) params.set('limit', String(input.limit))
        return {
          method: 'GET',
          path: `/v1/ws/${input.workspace}/files${path.length > 0 ? `/${encodeDrivePath(path)}` : ''}?${params}`,
        }
      },
      result: jsonResult,
    }),
  )
  registry.register(
    defineMcpTool({
      name: 'read_file',
      description: 'Read a file from a Duet workspace.',
      capabilities: ['files:read'],
      inputSchema: McpReadFileInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:files:read`],
      execute: async (input, context) => {
        const requiredScopes = [`ws:${input.workspace}:files:read`]
        const created = await createFileResource(
          context,
          input.workspace,
          input.path,
          requiredScopes,
        )
        if (!created.ok) return created.result

        const link = toResourceLink(created.resource)
        if (!isTextLikeDriveResource(created.resource)) {
          return { content: [link] }
        }

        const response = await context.fetch(
          `${context.apiBaseUrl}/v1/ws/${input.workspace}/files/${encodeDrivePath(input.path)}`,
          { headers: { authorization: `Bearer ${context.bearerToken}` } },
        )
        if (!response.ok) return await toolErrorFromApi(response, requiredScopes)

        const decodedText = textContentFromBytes(new Uint8Array(await response.arrayBuffer()))
        return decodedText === null
          ? { content: [link] }
          : { content: [{ type: 'text', text: decodedText }, link] }
      },
    }),
  )
  registry.register(
    defineMcpTool({
      name: 'write_file',
      description: 'Write a file into a Duet workspace.',
      capabilities: ['files:write'],
      inputSchema: McpWriteFileInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:files:write`],
      rest: input => ({
        method: 'PUT',
        path: `/v1/ws/${input.workspace}/files/${encodeDrivePath(input.path)}`,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          ...(input.ifMatch === undefined ? {} : { 'if-match': input.ifMatch }),
        },
        body: input.content,
      }),
      result: jsonResult,
    }),
  )
  registry.register(
    defineMcpTool({
      name: 'file_history',
      description:
        'Attributed event history for one Duet workspace file, in sequence order (who wrote, read, renamed, or deleted it, and when).',
      capabilities: ['files:read'],
      inputSchema: McpFileHistoryInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:files:read`],
      rest: input => {
        const params = new URLSearchParams({ path: input.path })
        if (input.cursor !== undefined) params.set('cursor', input.cursor)
        if (input.limit !== undefined) params.set('limit', String(input.limit))
        if (input.includeReads !== undefined) params.set('reads', input.includeReads ? '1' : '0')
        return {
          method: 'GET',
          path: `/v1/ws/${input.workspace}/file-activity?${params}`,
        }
      },
      result: jsonResult,
    }),
  )
  registry.register(
    defineMcpTool({
      name: 'file_seen_by',
      description:
        'Every actor that read or wrote one Duet workspace file, most recently active first.',
      capabilities: ['files:read'],
      inputSchema: McpFileSeenByInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:files:read`],
      rest: input => {
        const params = new URLSearchParams({ path: input.path })
        if (input.cursor !== undefined) params.set('cursor', input.cursor)
        if (input.limit !== undefined) params.set('limit', String(input.limit))
        return {
          method: 'GET',
          path: `/v1/ws/${input.workspace}/file-activity/seen-by?${params}`,
        }
      },
      result: jsonResult,
    }),
  )
}

function encodeDrivePath(path: string): string {
  return path
    .split('/')
    .filter(part => part.length > 0)
    .map(part => encodeURIComponent(part))
    .join('/')
}

function textContentFromBytes(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
