import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'

import {
  safeTransportCode,
  CAPABILITIES,
  CapabilityListSchema,
  WhoamiResponseSchema,
  extractBearerToken,
  type FetchLike,
} from '@repo/contract'

import { resolveApiBaseUrl, resolveMcpPublicUrl, resolveModelGatewayUrl } from './config'
import { MCP_VERSION, trimTrailingSlash, type McpServerOptions } from './server'

// The MCP resource advertises the whole capability vocabulary; what a grant
// actually carries is capped by the requester's workspace role at consent.
// Canonicalized once so the metadata document and the WWW-Authenticate
// challenge cannot drift apart.
const SUPPORTED_SCOPES = CapabilityListSchema.parse(CAPABILITIES)

export interface McpHttpAppOptions {
  apiBaseUrl?: string
  mcpPublicUrl?: string
  modelGatewayBaseUrl?: string
  fetch?: FetchLike
}

export interface McpHttpAppDependencies {
  createServer(options: McpServerOptions): {
    connect(transport: WebStandardStreamableHTTPServerTransport): Promise<void>
  }
}

export function createMcpHttpApp(
  options: McpHttpAppOptions,
  dependencies: McpHttpAppDependencies,
): Hono {
  const app = new Hono()
  const apiBaseUrl = trimTrailingSlash(resolveApiBaseUrl(options.apiBaseUrl))
  const mcpPublicUrl = resolveMcpPublicUrl(options.mcpPublicUrl)
  const modelGatewayBaseUrl = trimTrailingSlash(resolveModelGatewayUrl(options.modelGatewayBaseUrl))
  const fetchImpl = options.fetch ?? fetch

  app.get('/healthz', c => c.json({ ok: true, version: MCP_VERSION }))
  app.get('/.well-known/oauth-protected-resource', c =>
    c.json({
      resource: mcpPublicUrl,
      authorization_servers: [apiBaseUrl],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
    }),
  )
  app.all('/', async c => {
    const bearerToken = extractBearerToken(c.req.header('authorization') ?? null)
    if (bearerToken === null) return unauthorizedResponse(mcpPublicUrl)

    let auth: Response
    try {
      auth = await fetchImpl(`${apiBaseUrl}/v1/whoami`, {
        headers: { authorization: `Bearer ${bearerToken}` },
      })
    } catch (error) {
      if (!c.req.raw.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) {
        try {
          const code = safeTransportCode(error)
          if (code) console.error('[mcp] whoami transport failure', { code })
        } catch {
          // Diagnostics must not replace the authentication failure response.
        }
      }
      return c.json({ error: 'auth_unavailable' }, 503)
    }
    if (auth.status >= 500) return c.json({ error: 'auth_unavailable' }, 502)
    if (!auth.ok) return unauthorizedResponse(mcpPublicUrl)
    const whoami = WhoamiResponseSchema.safeParse(await auth.json().catch(() => null))
    if (!whoami.success) return c.json({ error: 'auth_unavailable' }, 502)
    if (
      whoami.data.credential?.kind === 'oauth' &&
      whoami.data.credential.audience !== mcpPublicUrl
    ) {
      return unauthorizedResponse(mcpPublicUrl)
    }

    const transport = new WebStandardStreamableHTTPServerTransport()
    const server = dependencies.createServer({
      apiBaseUrl,
      modelGatewayBaseUrl,
      fetch: fetchImpl,
      bearerToken,
    })
    await server.connect(transport)
    return await transport.handleRequest(c.req.raw)
  })

  return app
}

function unauthorizedResponse(mcpPublicUrl: string): Response {
  return Response.json(
    { error: 'unauthorized' },
    {
      status: 401,
      headers: { 'WWW-Authenticate': buildBearerChallenge(mcpPublicUrl) },
    },
  )
}

function buildBearerChallenge(mcpPublicUrl: string): string {
  const resourceMetadata = new URL('.well-known/oauth-protected-resource', mcpPublicUrl).toString()
  return `Bearer resource_metadata="${resourceMetadata}", scope="${SUPPORTED_SCOPES.join(' ')}"`
}
