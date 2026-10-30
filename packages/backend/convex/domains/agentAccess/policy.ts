import { v } from 'convex/values'

import { ROOT_AGENT_SCOPE } from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'

/**
 * One principal a per-agent access policy may name.
 *
 * Default Duet is the stable `root` scope rather than an id, because it has no
 * agent row to point at; everything else is a durable agent id rather than a
 * name, slug, or path, so renaming an agent never rewrites a policy.
 */
export const agentPrincipalValidator = v.union(v.literal(ROOT_AGENT_SCOPE), v.id('agents'))

/**
 * Who a turn acts as, for per-agent access decisions.
 *
 * A session with no agent is default Duet, which is `root`. A session whose
 * agent row is gone — deleted, or belonging to another workspace — resolves to
 * `undefined`, which is not a principal at all and therefore matches no stored
 * list. That is deliberate: agent lifecycle must not become coupled to access
 * policy, so a dangling id loses access rather than inheriting anyone's.
 */
export async function effectiveSessionPrincipal(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  agentId?: Id<'agents'>,
): Promise<typeof ROOT_AGENT_SCOPE | Id<'agents'> | undefined> {
  if (agentId === undefined) return ROOT_AGENT_SCOPE
  const agent = await ctx.db.get(agentId)
  return agent !== null && agent.workspaceId === workspaceId ? agentId : undefined
}

/**
 * The three-state per-agent rule, in one implementation.
 *
 * A stored policy has two of the three states: an empty list is **Nobody**, and
 * a non-empty list is **exactly those** principals. The third state — **All** —
 * is the absence of a row, so it is expressed by never calling this: a resource
 * with no policy row is never asked. Conflating absence with an empty list
 * would either silently revoke existing access or make "Nobody" impossible,
 * which is why the two must not share a code path.
 *
 * Takes the list rather than the row so both policy tables — Composio toolkits
 * keyed by slug, custom MCP servers keyed by id — can use it without either
 * one's row shape becoming the other's dependency.
 */
export function principalDenied(
  allowedAgentIds: readonly string[],
  principal: string | undefined,
): boolean {
  return principal === undefined || !allowedAgentIds.includes(principal)
}
