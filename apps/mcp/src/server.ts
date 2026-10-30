import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'

import {
  APPROVED_MODELS,
  type ApprovedModelCatalog,
  type Capability,
  type FetchLike,
} from '@repo/contract'

import { resolveApiBaseUrl, resolveModelGatewayUrl } from './config'
import { internalToolError, toolErrorFromApi } from './tool-results'

export const MCP_VERSION = '0.1.0-slice10'

export interface McpServerOptions {
  apiBaseUrl?: string
  modelGatewayBaseUrl?: string
  approvedModelCatalog?: ApprovedModelCatalog
  fetch?: FetchLike
  bearerToken: string
}

type McpToolSchema<TInput extends Record<string, unknown>> = z.ZodType<TInput>

export interface McpRestRequest {
  method: 'GET' | 'PUT' | 'POST'
  path: string
  headers?: Record<string, string>
  body?: string
}

export interface McpToolContext {
  apiBaseUrl: string
  modelGatewayBaseUrl: string
  approvedModelCatalog: ApprovedModelCatalog
  bearerToken: string
  fetch: FetchLike
}

export interface McpToolDefinition<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string
  description: string
  capabilities: readonly [Capability, ...Capability[]]
  inputSchema: McpToolSchema<TInput>
  scopeRequirements(input: TInput): readonly [string, ...string[]]
  rest?: (input: TInput) => McpRestRequest
  result?: (response: Response) => Promise<CallToolResult>
  execute?: (input: TInput, context: McpToolContext) => Promise<CallToolResult>
}

export class McpToolRegistry {
  readonly tools = new Map<string, McpToolDefinition>()

  register<TInput extends Record<string, unknown>>(definition: McpToolDefinition<TInput>): void {
    if (this.tools.has(definition.name))
      throw new Error(`MCP tool already registered: ${definition.name}`)
    this.tools.set(definition.name, definition as McpToolDefinition)
  }

  list(): McpToolDefinition[] {
    return [...this.tools.values()]
  }
}

export function defineMcpTool<TInput extends Record<string, unknown>>(
  definition: McpToolDefinition<TInput>,
): McpToolDefinition<TInput> {
  return definition
}

export function createMcpServer(options: McpServerOptions, registry: McpToolRegistry): McpServer {
  const server = new McpServer({ name: 'duet-mcp', version: MCP_VERSION })
  const apiBaseUrl = trimTrailingSlash(resolveApiBaseUrl(options.apiBaseUrl))
  const modelGatewayBaseUrl = trimTrailingSlash(resolveModelGatewayUrl(options.modelGatewayBaseUrl))
  const fetchImpl = options.fetch ?? fetch

  for (const tool of registry.list()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        _meta: {
          'duet/requiredCapabilities': tool.capabilities,
        },
      },
      async input => {
        if (tool.execute !== undefined) {
          return await tool.execute(input, {
            apiBaseUrl,
            modelGatewayBaseUrl,
            approvedModelCatalog: options.approvedModelCatalog ?? APPROVED_MODELS,
            bearerToken: options.bearerToken,
            fetch: fetchImpl,
          })
        }
        if (tool.rest === undefined || tool.result === undefined) {
          return internalToolError('tool_not_configured', tool.scopeRequirements(input))
        }
        const request = tool.rest(input)
        const response = await fetchImpl(`${apiBaseUrl}${request.path}`, {
          method: request.method,
          headers: {
            authorization: `Bearer ${options.bearerToken}`,
            ...request.headers,
          },
          body: request.body,
        })
        if (!response.ok) return await toolErrorFromApi(response, tool.scopeRequirements(input))
        return await tool.result(response)
      },
    )
  }

  return server
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '')
}
