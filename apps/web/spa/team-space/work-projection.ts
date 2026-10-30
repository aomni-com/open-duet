import {
  agentResolutionCandidate,
  DEFAULT_AGENT_NAME,
  groupAppsByAgent,
  ROOT_AGENT_SCOPE,
  type Agent,
  type App,
} from '@repo/contract'

import type { WorkCollectionPhase } from './work-collection'

export type WorkApp = { app: App; ownerSlug: string; ownerName: string }

export function chatCreationPlacement(
  canUseSessions: boolean,
  phase: WorkCollectionPhase,
  itemCount: number,
): 'hidden' | 'empty-list' | 'heading' {
  if (!canUseSessions) return 'hidden'
  if (phase === 'empty') return 'empty-list'
  return phase === 'ready' && itemCount > 0 ? 'heading' : 'hidden'
}

export function projectWorkApps(
  agents: readonly Agent[],
  apps: readonly App[],
  duetName = DEFAULT_AGENT_NAME,
): WorkApp[] {
  const groups = groupAppsByAgent(agents.map(agentResolutionCandidate), apps)
  const owners = new Map(agents.map(agent => [agent.id, agent] as const))
  const projected: WorkApp[] = groups.root.map(app => ({
    app,
    ownerSlug: ROOT_AGENT_SCOPE,
    ownerName: duetName,
  }))
  for (const [agentId, ownedApps] of groups.byAgentId) {
    const owner = owners.get(agentId)
    if (owner?.slug === undefined) continue
    for (const app of ownedApps) {
      projected.push({ app, ownerSlug: owner.slug, ownerName: owner.name ?? owner.slug })
    }
  }
  return projected.sort((a, b) => b.app.updatedAt - a.app.updatedAt)
}

export function greetingForHour(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

export function greetingForDate(date: Date): 'morning' | 'afternoon' | 'evening' {
  return greetingForHour(date.getUTCHours())
}

/* ============================================================================
   Which agent groups the Work sidebar is holding open.

   A set, not a slug. It was a slug — one at a time, accordion-style — and the
   column's whole job is comparing what several owners are doing, so opening the
   second owner shut the first. Worse, the sidebar follows the address, so
   arriving at any agent-owned conversation collapsed whatever arrangement the
   reader had made.

   Both transitions below return the *same* set when nothing changes, so a
   navigation to a group that is already open does not schedule a render.
   ========================================================================= */

/** The reader asked for this group: open it if shut, shut it if open. */
export function toggleExpandedAgent(
  expanded: ReadonlySet<string>,
  agentSlug: string,
): ReadonlySet<string> {
  const next = new Set(expanded)
  if (!next.delete(agentSlug)) next.add(agentSlug)
  return next
}

/**
 * The address moved to this agent's conversation, so its group opens.
 *
 * An addition, never an assignment: the reader's other open groups are theirs,
 * and a route change is not a request to tidy them away.
 */
export function followRouteAgent(
  expanded: ReadonlySet<string>,
  agentSlug: string,
): ReadonlySet<string> {
  if (expanded.has(agentSlug)) return expanded
  return new Set(expanded).add(agentSlug)
}
