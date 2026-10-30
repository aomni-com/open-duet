import {
  agentResolutionCandidate,
  groupAppsByAgent,
  ROOT_AGENT_SCOPE,
  type Agent,
  type App,
} from '@repo/contract'

import { agentsMapUrl } from '../drive/agents-map-url'

// The Drive and app-domain inventory open the same app subject. Containment
// stays with the contract owner; this owner only builds that subject's URL.
export function appProductUrl(
  workspaceSlug: string,
  app: Pick<App, 'anchorPath' | 'slug'>,
  agents: readonly Pick<Agent, 'id' | 'slug' | 'anchorId' | 'anchorPath'>[],
) {
  const groups = groupAppsByAgent(agents.map(agentResolutionCandidate), [app])
  const owner = [...groups.byAgentId.entries()].find(([, owned]) => owned.length > 0)?.[0]
  const agentSlug = agents.find(candidate => candidate.id === owner)?.slug ?? ROOT_AGENT_SCOPE
  return agentsMapUrl(workspaceSlug, {
    kind: 'agent',
    agentSlug,
    card: { kind: 'app', appSlug: app.slug },
  })
}
