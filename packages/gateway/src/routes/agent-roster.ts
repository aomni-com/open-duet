import { Hono } from 'hono'

import type { GatewayAgentRosterResponse, GatewayAgentConfig } from '@repo/contract'

import {
  readReachableAgentRoster,
  type AgentRosterRow,
  type AgentRosterScope,
} from '../agents/agent-roster-view'

export interface AgentRosterRouteOptions {
  /** `undefined` while no roster has arrived — never flatten it to an empty one. */
  agents: () => readonly GatewayAgentConfig[] | undefined
  refresh: () => Promise<void>
  driveDir: string
}

/**
 * The colleagues a session can already reach, read by the compose bar's `@`
 * picker — the same rows the agent's own `your-agents.md` carries.
 *
 * This route computes nothing. Hierarchy, the lock verdict, the relationship
 * and the order all belong to `readReachableAgentRoster`, so the picker and the
 * prompt can never describe two different rosters; the route's whole job is to
 * pick the scope out of the request and serialize one projection.
 *
 * `agentId` names whose roster to read; absent means the drive root, which is
 * an owner like any agent. The status carries the distinction the projection
 * makes with `undefined`: 503 when nothing has synced yet (transient — ask
 * again), 404 when the roster simply does not carry that agent (disabled, or
 * the roster is stale). Neither may arrive as an empty list, which is a real
 * answer a brand-new workspace deserves.
 */
export function createAgentRosterRoutes(options: AgentRosterRouteOptions): Hono {
  const app = new Hono()

  app.post('/refresh', async c => {
    await options.refresh()
    return c.json({ ok: true })
  })

  app.get('/', c => {
    const agentId = c.req.query('agentId')
    const scope: AgentRosterScope =
      agentId === undefined || agentId.length === 0 ? { kind: 'root' } : { kind: 'agent', agentId }
    const members = options.agents()
    const roster = readReachableAgentRoster({ members, scope, driveDir: options.driveDir })
    if (roster === undefined) {
      return members === undefined
        ? c.json({ error: 'roster_unavailable' }, 503)
        : c.json({ error: 'not_found' }, 404)
    }

    // `anchorPath` is the gateway's word for it and `path` is the wire's; only
    // the drive root, which may be a self or a parent row, has neither.
    const body: GatewayAgentRosterResponse = {
      rows: roster.rows.map((row: AgentRosterRow) => ({
        slug: row.slug,
        name: row.name,
        locked: row.locked,
        relationship: row.relationship,
        ...(row.anchorPath === undefined ? {} : { path: row.anchorPath }),
      })),
    }
    return c.json(body)
  })

  return app
}
