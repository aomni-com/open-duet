import {
  agentIsLaunchable,
  agentResolutionCandidate,
  MAX_AGENTS_PER_WORKSPACE,
  resolveNearestAgent,
  type AgentResolutionCandidate,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { toAgent } from './display'

type ResolvedAgent = { agent: Doc<'agents'>; view: ReturnType<typeof toAgent> }

/**
 * The one walk from a drive path to the agent whose folder contains it. Every
 * caller that asks "whose agent is this?" — session attribution from a cwd, an
 * onboarding app asking which agent it belongs to — comes through here, because
 * a second walk beside this one is a second answer: nearest-by-depth, path
 * normalization, and launch eligibility are all decisions, and two copies of
 * them agree only until one is edited.
 */
export async function resolveAgentForPath(
  ctx: QueryCtx | MutationCtx,
  args: { workspaceId: Id<'workspaces'>; path: string },
): Promise<ResolvedAgent | null> {
  // Bounded read: never scan unboundedly at session creation. The mutation-side
  // MAX_AGENTS invariant keeps this take from ever truncating real data.
  const agents = await ctx.db
    .query('agents')
    .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
    .take(MAX_AGENTS_PER_WORKSPACE + 1)
  if (agents.length > MAX_AGENTS_PER_WORKSPACE) throw new Error('Workspace agent limit exceeded')
  // The eligibility rule and the candidate rename both live in @repo/contract;
  // this path shares them rather than re-deriving them.
  const candidates: Array<AgentResolutionCandidate & ResolvedAgent> = []
  for (const agent of agents) {
    const anchor = await ctx.db.get(agent.anchorId)
    if (anchor === null) continue
    const view = toAgent(agent, anchor)
    if (!agentIsLaunchable(view)) continue
    candidates.push({ ...agentResolutionCandidate(view), agent, view })
  }
  const resolved = resolveNearestAgent(args.path, candidates)
  return resolved === null ? null : { agent: resolved.agent, view: resolved.view }
}

export async function resolveSessionAgent(
  ctx: QueryCtx | MutationCtx,
  args: { workspaceId: Id<'workspaces'>; cwd?: string },
): Promise<{ agentId: Id<'agents'>; agentName: string } | null> {
  if (args.cwd === undefined) return null
  const resolved = await resolveAgentForPath(ctx, {
    workspaceId: args.workspaceId,
    path: args.cwd,
  })
  return resolved === null ? null : { agentId: resolved.agent._id, agentName: resolved.view.name }
}
