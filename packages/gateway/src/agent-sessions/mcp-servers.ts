import {
  INTEGRATIONS_MCP_SERVER_NAME,
  McpServerTurnLaunchSchema,
  type GatewayRunnerInputRequest,
  type McpServersConfig,
} from '@repo/contract'

/**
 * Turns the launch marker's server *names* into the addresses and credential a
 * runner can actually use.
 *
 * The split is deliberate: only the control plane knows which servers exist and
 * what they are called, and only the gateway knows how this VM reaches `ctl` and
 * what bearer it holds — `DUET_API_KEY` comes from the VM's model credentials
 * and the API cannot mint it. So the marker carries names, this builds URLs, and
 * no third-party address and no third-party token ever crosses onto the VM.
 *
 * The two URL shapes differ because the two lifecycles do. Composio's provider
 * session is conversation-scoped, so its proxy is addressed per session. A
 * custom server has no conversation — it is a workspace-level registration — so
 * its proxy is addressed per workspace and the same URL serves every session.
 */
export function buildMcpServersConfig(args: {
  apiUrl: string
  workspaceSlug: string
  sessionId: string
  apiKey: string
  launch: Pick<GatewayRunnerInputRequest['launch'], 'integrations' | 'mcpServers'>
  /**
   * This gateway's own origin. When given, the integrations server is
   * addressed here rather than at ctl: the gateway performs the opening
   * exchange itself while the runner boots and forwards the rest, so the
   * runner's handshake is a loopback instead of three tunnel round trips.
   */
  localBaseUrl?: string
}): McpServersConfig | null {
  const headers = { authorization: `Bearer ${args.apiKey}` }
  const slug = encodeURIComponent(args.workspaceSlug)
  const entry = (path: string, base = args.apiUrl) => ({
    type: 'http' as const,
    url: new URL(path, base).toString(),
    headers,
  })
  const servers: McpServersConfig = {}
  if (args.launch.integrations !== undefined) {
    servers[INTEGRATIONS_MCP_SERVER_NAME] =
      args.localBaseUrl === undefined
        ? integrationsProxyTarget(args)
        : entry(
            `/v1/agent/sessions/${encodeURIComponent(args.sessionId)}/integrations/mcp`,
            args.localBaseUrl,
          )
  }
  // The marker survives a reload through a parser that re-validates four fields
  // by name, so by the time it arrives here it is untyped. A malformed one is a
  // crash class rather than a trust question — one trust domain inside the VM —
  // and the turn is worth more than its custom tools, so drop and spawn.
  const mcpServers = McpServerTurnLaunchSchema.safeParse(args.launch.mcpServers)
  if (mcpServers.success) {
    for (const server of mcpServers.data) {
      servers[server.name] = entry(`/v1/ws/${slug}/mcp/${encodeURIComponent(server.name)}`)
    }
  }
  return Object.keys(servers).length === 0 ? null : servers
}

/** Where the integrations server lives at ctl, and what it takes to speak to it. */
export function integrationsProxyTarget(args: {
  apiUrl: string
  workspaceSlug: string
  sessionId: string
  apiKey: string
}): { type: 'http'; url: string; headers: Record<string, string> } {
  return {
    type: 'http',
    url: new URL(
      `/v1/ws/${encodeURIComponent(args.workspaceSlug)}/agent/sessions/${encodeURIComponent(args.sessionId)}/integrations/mcp`,
      args.apiUrl,
    ).toString(),
    headers: { authorization: `Bearer ${args.apiKey}` },
  }
}
