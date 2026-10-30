import {
  STRIPPED_UPSTREAM_RESPONSE_HEADERS,
  ComposioExecuteRequestSchema,
  allowedIntegrationRedirect,
  gatewayBlockResponse,
} from '@repo/contract'

import {
  rememberToolRouterSessionDetails,
  ToolRouterConfigNotFoundError,
  ToolRouterSessionNotReadyError,
  useComposioSession,
} from '../composio-session'
import {
  resolveComposioExecuteBaseUrl,
  resolveEdgeHost,
  resolveMcpToolResultBytes,
} from '../config'
import { forwardMcpRequest, type McpUpstreamSource } from '../mcp/proxy'
import { sessionErrorResponse } from '../session-errors'
import { sessionRequestIdentityForAuth } from '../session-principal'
import {
  fnQuery,
  readJson,
  requireWorkspaceFromKey,
  type ApiApp,
  type ApiRouteRuntime,
  type ComposioMcpProvider,
} from '../shared'
import {
  createComposioToolRouterCallbackUrl,
  verifyComposioOAuthCallbackDescriptor,
} from './composio-oauth'

export const COMPOSIO_AUTH_BYPASS_PATHS = ['/v1/integrations/composio/oauth/callback'] as const

export function registerComposioRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  provider?: ComposioMcpProvider,
): void {
  app.post('/v1/integrations/composio/execute/:toolSlug', async c => {
    const body = ComposioExecuteRequestSchema.safeParse((await readJson(c.req.raw)) ?? {})
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const workspace = requireWorkspaceFromKey(c, 'integrations', body.data.workspace)
    if ('response' in workspace) return workspace.response

    const apiKey = process.env.COMPOSIO_API_KEY
    if (!apiKey) {
      return gatewayBlockResponse({
        status: 503,
        body: {
          error: 'Composio is not configured.',
          code: 'service_unavailable',
        },
      })
    }

    const upstream = await runtime.fetchImpl(
      `${resolveComposioExecuteBaseUrl().replace(/\/+$/, '')}/tools/execute/${encodeURIComponent(c.req.param('toolSlug'))}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          arguments: body.data.arguments ?? {},
          entity_id: workspace.id,
        }),
      },
    )
    const responseHeaders = new Headers(upstream.headers)
    // fetch already decoded the vendor body; the vendor's encoding headers
    // would mislabel our plaintext stream and break strict client decoders.
    for (const name of STRIPPED_UPSTREAM_RESPONSE_HEADERS) responseHeaders.delete(name)
    const requestId = c.req.header('x-duet-request-id')
    if (requestId !== undefined) responseHeaders.set('x-duet-request-id', requestId)
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  })

  app.get('/v1/integrations/composio/oauth/callback', async c => {
    const descriptor = await verifyComposioOAuthCallbackDescriptor(
      c.req.query('nonce'),
      runtime.apiInternalKey,
      runtime.now(),
    )
    if (descriptor === null) return c.json({ error: 'invalid_oauth_nonce' }, 400)
    const requestedDestination =
      descriptor.kind === 'user-connect'
        ? descriptor.destination
        : `/w/${descriptor.workspaceSlug}/integrations`
    const destination = allowedIntegrationRedirect(requestedDestination, {
      webAppUrl: runtime.appUrl,
      workspaceSlug: descriptor.workspaceSlug,
      edgeHost: resolveEdgeHost(),
    })
    if (destination === null) return c.json({ error: 'redirect_not_allowed' }, 400)
    return c.redirect(destination, 302)
  })

  for (const method of ['post', 'get', 'delete'] as const) {
    app[method]('/v1/ws/:workspaceSlug/agent/sessions/:sessionId/integrations/mcp', async c => {
      const workspace = requireWorkspaceFromKey(c, 'integrations', c.req.param('workspaceSlug'))
      if ('response' in workspace) return workspace.response
      try {
        await runtime.convex.query(fnQuery('domains/agentSessions/model:authorizeSessionPoint'), {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          sessionId: c.req.param('sessionId'),
          identity: sessionRequestIdentityForAuth(c.get('auth')),
        })
      } catch (error) {
        return sessionErrorResponse(c, error)
      }
      if (!process.env.COMPOSIO_API_KEY) return composioUnavailable()
      try {
        if (provider === undefined) throw new Error('provider_not_configured')
        const source = composioMcpSource(runtime, provider, process.env.COMPOSIO_API_KEY, {
          workspaceId: workspace.id,
          duetSessionId: c.req.param('sessionId'),
          callbackUrl: await createComposioToolRouterCallbackUrl({
            requestUrl: c.req.url,
            workspaceSlug: workspace.slug,
            secret: runtime.apiInternalKey,
          }),
        })
        return await forwardMcpRequest(runtime.fetchImpl, c.req.raw, source, {
          maxToolResultBytes: resolveMcpToolResultBytes(),
        })
      } catch (error) {
        if (error instanceof ToolRouterConfigNotFoundError) {
          return c.json({ error: 'not_found' }, 404)
        }
        if (error instanceof ToolRouterSessionNotReadyError) return integrationSessionUnavailable()
        console.error('[composio-mcp] Failed to resolve Tool Router session', {
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        })
        return composioUnavailable()
      }
    })
  }
}

/**
 * Composio as an upstream for the shared MCP forwarder.
 *
 * The first resolve answers from the row alone — endpoint, credential, and
 * the remembered tool list — so nothing asks the provider whether the session
 * still exists. A vanished session therefore shows itself only as an upstream
 * refusal, which is what `retryable` is for: the second resolve goes through
 * the provider, replaces the session, and resets the transport. Any other
 * upstream status is the server's own answer and passes through.
 */
function composioMcpSource(
  runtime: ApiRouteRuntime,
  provider: ComposioMcpProvider,
  providerApiKey: string,
  args: { workspaceId: string; duetSessionId: string; callbackUrl: string },
): McpUpstreamSource {
  return {
    sourceId: 'composio',
    retryable: status => status === 401 || status === 403 || status === 404 || status === 410,
    async resolve(attempt) {
      const resolved = await useComposioSession(runtime, provider, args, {
        lookup: attempt === 'after-unauthorized' ? 'provider' : 'row',
      })
      return {
        url: resolved.mcpUrl,
        headers: { 'x-api-key': providerApiKey },
        resetTransportSession: resolved.resetTransportSession,
        toolsList: {
          ...(resolved.toolsList === undefined ? {} : { known: resolved.toolsList }),
          remember: result => {
            void rememberToolRouterSessionDetails(runtime, args, {
              providerSessionId: resolved.providerSessionId,
              toolsList: { permissionFingerprint: resolved.permissionFingerprint, result },
            })
          },
        },
      }
    },
  }
}

function composioUnavailable(): Response {
  return gatewayBlockResponse({
    status: 503,
    body: {
      error: 'Composio is not configured.',
      code: 'service_unavailable',
    },
  })
}

function integrationSessionUnavailable(): Response {
  return gatewayBlockResponse({
    status: 503,
    body: {
      error: 'Integration session is not ready.',
      code: 'service_unavailable',
    },
  })
}
