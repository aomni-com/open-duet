import { v } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import { query, type QueryCtx } from '../../_generated/server'
import { effectiveSessionPrincipal, principalDenied } from '../agentAccess/policy'
import { requireWorkspaceSessionPointFromDb } from '../agentSessions/access'
import { requireApiInternalKey } from '../apiKeys/model'

/**
 * Which custom MCP servers a turn gets. The single owner of that question — the
 * gateway must not decide it, the API must not re-derive it, and nothing on the
 * VM keeps a list.
 *
 * It takes a `QueryCtx`, not a `MutationCtx`, and writes nothing. That is the
 * mechanical expression of D17: custom-server preparation is best-effort and
 * must never gate dispatch, and the cheapest way to guarantee that forever is
 * to leave no state here that a readiness check could grow around. A typo'd URL
 * costs a `warn()` inside the runner, never the user's message.
 *
 * Names only. The gateway turns each name into a Duet proxy URL and attaches
 * the workspace's own bearer, so no third-party address and no third-party
 * token ever crosses onto the VM.
 */
export async function projectMcpServerTurnLaunch(
  ctx: QueryCtx,
  args: { workspaceId: Id<'workspaces'>; agentId?: Id<'agents'> },
): Promise<Array<{ name: string }> | undefined> {
  const servers = await ctx.db
    .query('mcpServers')
    .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
    .collect()
  // Only `ready` is launchable. `needs_auth` and `reauth_required` are servers
  // waiting on a human, so shipping their names would spend a connect attempt
  // and a tool-call failure per turn to tell the user something the row already
  // says; `disconnecting` is on its way out. This is not a readiness gate — no
  // dispatch waits on it, and a server that is ready but broken still ships.
  const launchable = servers.filter(server => server.state === 'ready')
  // The common case is a workspace with no custom servers at all, and it costs
  // exactly this one empty index read: no principal resolution, no policy scan.
  if (launchable.length === 0) return undefined
  const principal = await effectiveSessionPrincipal(ctx, args.workspaceId, args.agentId)
  const policies = await ctx.db
    .query('mcpServerAgentPolicies')
    .withIndex('by_workspace_and_server', q => q.eq('workspaceId', args.workspaceId))
    .collect()
  const allowedByServer = new Map(policies.map(policy => [policy.serverId, policy.allowedAgentIds]))
  const names = launchable
    .filter(server => {
      // Absence is the third state — every agent — so a server with no policy
      // row is never asked. Only a stored list reaches the shared rule.
      const allowedAgentIds = allowedByServer.get(server._id)
      return allowedAgentIds === undefined || !principalDenied(allowedAgentIds, principal)
    })
    .map(server => server.name)
    // Sorted so two turns with the same servers produce byte-identical markers;
    // the gateway compares envelopes, and the runner's tool block is
    // prompt-cache sensitive.
    .sort((left, right) => left.localeCompare(right))
  // Omitted rather than empty, matching `integrations`: the field's absence is
  // what the gateway's fail-closed merge reads as "this turn has none".
  return names.length === 0 ? undefined : names.map(name => ({ name }))
}

/**
 * The same projection, for the one caller that has no dispatch to ride on: a
 * wake, which relaunches a sleeping session with no request behind it. The
 * gateway re-asks for both kinds of MCP server there because the launch marker
 * on its disk is as old as the sleep.
 *
 * A `query`, so the wake path cannot grow a readiness write here either.
 */
export const projectMcpServersForSession = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    duetSessionId: v.string(),
  },
  returns: v.union(v.array(v.object({ name: v.string() })), v.null()),
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const { session } = await requireWorkspaceSessionPointFromDb(ctx, {
      workspaceId: args.workspaceId,
      sessionId: args.duetSessionId,
    })
    return (
      (await projectMcpServerTurnLaunch(ctx, {
        workspaceId: args.workspaceId,
        agentId: session.agentId,
      })) ?? null
    )
  },
})
