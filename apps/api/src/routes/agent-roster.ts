import {
  AGENT_RELATIONSHIPS,
  AgentRosterPageQuerySchema,
  isCollectionCursorError,
} from '@repo/contract'

import { createMaterializedCollectionPage } from '../collection-page'
import type { GatewayClient } from '../gateway/client'
import { requireAuthedWorkspace, type ApiApp, type ApiRouteRuntime } from '../shared'
import { resolveDefaultSessionOwner } from './default-session'

const rosterPages = createMaterializedCollectionPage('agents.reachable-roster')

/**
 * Which agents a session can address, read straight from its VM.
 *
 * The roster is the gateway's own projection — the very rows it wrote into the
 * agent's system prompt — so the compose bar's `@` picker offers exactly what
 * the agent can reach. Mirroring it into the backend would be a second owner of
 * hierarchy and lock state, and the two would disagree the moment a sync landed.
 *
 * The slug is resolved the same way a session's owner is: `root` names the drive
 * root before any lookup, and an agent that cannot be launched (disabled, or a
 * broken anchor) is a miss rather than a scope the VM is asked about.
 */
export function registerAgentRosterRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
): void {
  app.get('/v1/ws/:workspaceSlug/agents/:agentSlug/roster', async c => {
    const workspace = requireAuthedWorkspace(c, 'sessions')
    if ('response' in workspace) return workspace.response
    const query = AgentRosterPageQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)

    const owner = await resolveDefaultSessionOwner(runtime, workspace.id, c.req.param('agentSlug'))
    if (owner === null) return c.json({ error: 'not_found' }, 404)

    const result = await gatewayClient.readAgentRoster(
      workspace.slug,
      owner.kind === 'root' ? undefined : owner.agentId,
    )
    if (result instanceof Response) return result
    try {
      return c.json(
        await rosterPages.response(
          query.data,
          {
            subject: `workspace:${workspace.id}:agent:${owner.kind === 'root' ? 'root' : owner.agentId}`,
            filters: {},
            order: 'gateway relationship rank asc, slug asc',
          },
          result.rows,
          row => [AGENT_RELATIONSHIPS.indexOf(row.relationship), row.slug],
        ),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })
}
