import { createMcpHttpApp as createHttpApp, type McpHttpAppOptions } from './http'
import {
  McpToolRegistry,
  createMcpServer as createServer,
  defineMcpTool,
  type McpRestRequest,
  type McpServerOptions,
  type McpToolContext,
  type McpToolDefinition,
} from './server'
import { registerAgentTools } from './tools/agent'
import { registerFileTools } from './tools/files'
import { registerIntegrationTools } from './tools/integrations'
import { registerMediaTools } from './tools/media'
import { registerMemoryTools } from './tools/memory'
import { registerTrainTools } from './tools/train'

export {
  McpToolRegistry,
  defineMcpTool,
  type McpHttpAppOptions,
  type McpRestRequest,
  type McpServerOptions,
  type McpToolContext,
  type McpToolDefinition,
}

export function createMcpToolRegistry(
  registerExtra?: (registry: McpToolRegistry) => void,
): McpToolRegistry {
  const registry = new McpToolRegistry()
  registerFileTools(registry)
  registerMemoryTools(registry)
  registerTrainTools(registry)
  registerAgentTools(registry)
  registerMediaTools(registry)
  registerIntegrationTools(registry)
  registerExtra?.(registry)
  return registry
}

export function createMcpServer(options: McpServerOptions, registry = createMcpToolRegistry()) {
  return createServer(options, registry)
}

export function createMcpHttpApp(options: McpHttpAppOptions = {}) {
  return createHttpApp(options, {
    createServer: serverOptions => createMcpServer(serverOptions),
  })
}

// Vercel function config: opt into response streaming (SSE endpoints buffer otherwise).
export const config = { supportsResponseStreaming: true }

export default {
  fetch: createMcpHttpApp().fetch,
}
