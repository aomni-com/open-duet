import type { Agent } from '@repo/contract'
import { agentIsLaunchable, ROOT_AGENT_SCOPE } from '@repo/contract'

import { agentsMapUrl } from '../drive/agents-map-url'
import { workSessionUrl } from '../team-space/work-destination'

/**
 * Which agent slug a session answers to on the map.
 *
 * A session's summary carries its owner as an id (`agent` is `{id, name}`),
 * and every map address speaks slugs — this is the one place the two are
 * joined. No owner at all is the drive root, which needs no list to say so;
 * an owner the list has not loaded, or no longer holds, stays `undefined`
 * rather than being guessed into somebody else's agent.
 */
export function sessionOwnerSlug(
  agent: { id: string } | undefined,
  agents: readonly { id: string; slug: string }[] | undefined,
): string | undefined {
  if (agent === undefined) return ROOT_AGENT_SCOPE
  return agents?.find(candidate => candidate.id === agent.id)?.slug
}

/**
 * The address a session link resolves to, or `undefined` while the owner is
 * still unresolved.
 *
 * An ordinary session lands in **Work**, which is the surface that holds the
 * conversations an owner's own chat is not. It used to land on a jobs dialog
 * over Build's canvas; that dialog is gone, and with it Build's answer for a
 * session address — so a link that still went there would land on the agent and
 * quietly drop the session it named. The same rule the lineage chip already
 * followed (`sessionLineageChip`), for the same reason: Work access does not
 * imply Build access, so a link to a conversation must not require Build.
 *
 * An onboarding session lands on the agent itself: those conversations are
 * excluded from every list by design, so Work would truthfully report it
 * missing — and the agent's own surface is where a locked agent already mounts
 * it.
 */
export function sessionMapHref(
  workspaceSlug: string,
  session: {
    id: string
    agent?: { id: string }
    onboarding?: boolean
  },
  agents: readonly { id: string; slug: string }[] | undefined,
): string | undefined {
  const agentSlug = sessionOwnerSlug(session.agent, agents)
  if (agentSlug === undefined) return undefined
  return session.onboarding === true
    ? agentsMapUrl(workspaceSlug, { kind: 'agent', agentSlug, card: { kind: 'default' } })
    : workSessionUrl(workspaceSlug, agentSlug, session.id)
}

/* ============================================================================
   The one owner a session surface is MOUNTED on — the other direction from
   the helpers above, which name the owner of an existing session. A surface
   is handed its owner by the host: the drive root under the reserved `root`
   scope, or one agent by slug. Everything on the surface — the create cwd,
   the suggested first message, the empty chat's identity — is that owner's;
   choosing who to talk to is the map's job, never the composer's.
   ========================================================================= */

export type SessionOwner = { kind: 'root' } | { kind: 'agent'; agent: Agent }

export type SessionOwnerResolution =
  | { status: 'ready'; owner: SessionOwner }
  | { status: 'unavailable' }

/**
 * The agent whose config is needed to finish resolving one mounted session
 * owner. Root and unavailable scopes need none.
 */
export function sessionOwnerConfigAgent(resolution: SessionOwnerResolution): Agent | undefined {
  return resolution.status === 'ready' && resolution.owner.kind === 'agent'
    ? resolution.owner.agent
    : undefined
}

/**
 * Resolve the host's requested scope to an owner. An absent or root scope is
 * the drive root; a launchable, unlocked agent slug is that agent; anything
 * else — unknown, disabled, broken, or still locked behind onboarding — is an
 * explicit unavailable state that must never silently fall back to a root
 * session.
 */
export function resolveSessionOwner(
  agents: readonly Agent[],
  requested: string | null | undefined,
  lockedAgentIds: ReadonlySet<string> = new Set(),
): SessionOwnerResolution {
  if (
    requested === undefined ||
    requested === null ||
    requested === '' ||
    requested === ROOT_AGENT_SCOPE
  ) {
    return { status: 'ready', owner: { kind: 'root' } }
  }
  const agent = agents.find(candidate => candidate.slug === requested)
  return agent === undefined || !agentIsLaunchable(agent) || lockedAgentIds.has(agent.id)
    ? { status: 'unavailable' }
    : { status: 'ready', owner: { kind: 'agent', agent } }
}
