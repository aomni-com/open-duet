import type { Agent, AgentIdentity } from '@repo/contract'

import { agentDisplayName } from '../agents/agent-display'
import type { SessionAgentIdentity } from './session-message'

type SessionAgentProfile = Pick<Agent, 'id' | 'slug' | 'name' | 'anchorPath' | 'icon' | 'updatedAt'>

/** The identity a live profile presents: its display name over its slug-keyed avatar. */
export function agentIdentityFromProfile(
  profile: SessionAgentProfile,
  workspaceSlug: string,
): SessionAgentIdentity {
  return {
    name: agentDisplayName(profile),
    avatarKey: profile.slug,
    profile,
    workspaceSlug,
  }
}

/**
 * Who a session's agent is on screen — the name beside its messages and in the
 * compose bar's status line.
 *
 * A session row stamps its agent's name at creation and never hears about a
 * rename, so the live profile is the name's owner whenever the agent still
 * exists; the stamped name only speaks for an agent the list no longer holds.
 * Before the snapshot exists, the pending create's cwd is the only agent
 * identity there is.
 */
export function sessionAgentIdentity(args: {
  snapshotAgent: AgentIdentity | undefined
  pendingCwd: string | undefined
  agents: readonly SessionAgentProfile[]
  workspaceSlug: string
}): SessionAgentIdentity | undefined {
  const { snapshotAgent, pendingCwd, agents, workspaceSlug } = args
  if (snapshotAgent !== undefined) {
    const profile = agents.find(candidate => candidate.id === snapshotAgent.id)
    return {
      name: profile === undefined ? snapshotAgent.name : agentDisplayName(profile),
      avatarKey: profile?.slug ?? snapshotAgent.name,
      profile,
      workspaceSlug,
    }
  }
  if (pendingCwd === undefined) return undefined
  const profile = agents.find(candidate => candidate.anchorPath === pendingCwd)
  if (profile === undefined) return undefined
  return agentIdentityFromProfile(profile, workspaceSlug)
}
