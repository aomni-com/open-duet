import {
  DesktopFocusRequestSchema,
  DesktopSessionRequestSchema,
  DesktopSessionResponseSchema,
  FocusBrowserOwnerResultSchema,
  ROOT_AGENT_SCOPE,
  WORKSPACE_ARCHIVED_ERROR,
  WORKSPACE_PAUSED_ERROR,
  WORKSPACE_PROVISIONING_ERROR,
  WORKSPACE_UNHEALTHY_ERROR,
  type Agent,
} from '@repo/contract'

import { type GatewayRequestError, type GatewayClient } from '../gateway/client'
import { requireMemberWorkspaceWithScope, type ApiApp, type ApiContext } from '../shared'

/** Public issuance and observation for the VM's one shared desktop. */
export interface DesktopAgentLookup {
  idBySlug(workspaceId: string, slug: string): Promise<string | null>
  list(workspaceId: string): Promise<Array<Pick<Agent, 'id' | 'slug' | 'name'>>>
}

export function registerDesktopRoutes(
  app: ApiApp,
  gatewayClient: GatewayClient,
  agents: DesktopAgentLookup,
): void {
  app.post('/v1/ws/:workspaceSlug/desktop/session', async c => {
    applyCredentialResponseHeaders(c)
    const workspace = requireMemberWorkspaceWithScope(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const body = DesktopSessionRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)

    const result = await gatewayClient.mintDesktopGrant(workspace.slug, body.data.embedOrigin)
    if ('error' in result) return desktopGatewayError(c, result.error)
    return c.json(DesktopSessionResponseSchema.parse(result))
  })

  app.get('/v1/ws/:workspaceSlug/desktop/status', async c => {
    applyCredentialResponseHeaders(c)
    const workspace = requireMemberWorkspaceWithScope(c, 'sessions')
    if ('response' in workspace) return workspace.response

    const result = await gatewayClient.readDesktopStatus(workspace.slug)
    if ('error' in result) return desktopGatewayError(c, result.error)
    if (!result.owners.some(owner => owner.owner.kind === 'agent')) return c.json(result)
    const presentations = new Map((await agents.list(workspace.id)).map(agent => [agent.id, agent]))
    return c.json({
      ...result,
      owners: result.owners.map(owner => {
        if (owner.owner.kind === 'root') return owner
        const presentation = presentations.get(owner.owner.agentId)
        return presentation === undefined
          ? owner
          : { ...owner, agentSlug: presentation.slug, agentName: presentation.name }
      }),
    })
  })

  app.post('/v1/ws/:workspaceSlug/agents/:agentSlug/desktop/focus', async c => {
    const workspace = requireMemberWorkspaceWithScope(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const body = DesktopFocusRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const slug = c.req.param('agentSlug')
    const owner =
      slug === ROOT_AGENT_SCOPE
        ? { kind: 'root' as const }
        : await agents
            .idBySlug(workspace.id, slug)
            .then(agentId => (agentId === null ? null : { kind: 'agent' as const, agentId }))
    if (owner === null) return c.json({ error: 'not_found' }, 404)
    const result = await gatewayClient.focusDesktopOwner(workspace.slug, owner, body.data.requestId)
    if ('error' in result) return desktopGatewayError(c, result.error)
    return c.json(FocusBrowserOwnerResultSchema.parse(result))
  })
}

function applyCredentialResponseHeaders(c: ApiContext): void {
  // The desktop token is browser-held in a URL because neither navigation nor
  // WebSocket APIs can attach our bearer header. Never retain it or forward its
  // credential-bearing URL as a referrer.
  c.header('cache-control', 'private, no-store')
  c.header('referrer-policy', 'no-referrer')
}

function desktopGatewayError(c: ApiContext, error: GatewayRequestError): Response {
  if (error === 'not_found') return c.json({ error: 'not_found' }, 404)
  if (error === WORKSPACE_PAUSED_ERROR) return c.json({ error: WORKSPACE_PAUSED_ERROR }, 402)
  if (error === WORKSPACE_PROVISIONING_ERROR) {
    return c.json({ error: WORKSPACE_PROVISIONING_ERROR }, 409)
  }
  if (error === WORKSPACE_UNHEALTHY_ERROR) {
    return c.json({ error: WORKSPACE_UNHEALTHY_ERROR }, 503)
  }
  if (error === WORKSPACE_ARCHIVED_ERROR) {
    return c.json({ error: WORKSPACE_ARCHIVED_ERROR }, 410)
  }
  if (error === 'desktop_unavailable') {
    c.header('retry-after', '1')
    return c.json({ error: 'desktop_unavailable' }, 503)
  }
  return c.json({ error: 'desktop_gateway_failed' }, 502)
}
