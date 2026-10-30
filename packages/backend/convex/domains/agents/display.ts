import type { Anchor } from '@repo/contract'

import type { Doc } from '../../_generated/dataModel'

/**
 * The server's one rule for what an agent row is called. A leaf module rather
 * than part of `model.ts` because the VM topology projection (anchors domain)
 * needs the same rule, and `model.ts` imports the anchors domain — the rule
 * has to sit below both. The web keeps its own presentation-side copy on
 * purpose (see apps/web/spa/agents/agent-display.ts).
 */
export function agentDisplayName(agent: Pick<Doc<'agents'>, 'name' | 'slug'>): string {
  return agent.name ?? agent.slug
}

/**
 * The row-to-wire projection for an agent, here for the same reason as the name
 * rule above: it is what every reader of an agent sees, and it must sit below
 * both `model.ts` (which owns the mutations) and `resolution.ts` (which owns the
 * path walk) without either having to import the other.
 *
 * The explicit field list — rather than a spread — is what keeps internal
 * columns out of every response.
 */
export function toAgent(agent: Doc<'agents'>, anchor: Pick<Anchor, 'path' | 'state'>) {
  return {
    id: agent._id,
    workspaceId: agent.workspaceId,
    anchorId: agent.anchorId,
    anchorPath: anchor.path,
    anchorState: anchor.state,
    slug: agent.slug,
    name: agentDisplayName(agent),
    ...(agent.icon === undefined ? {} : { icon: agent.icon }),
    ...(agent.sourceShareId === undefined ? {} : { sourceShareId: agent.sourceShareId }),
    ...(agent.sourceAgentId === undefined ? {} : { sourceAgentId: agent.sourceAgentId }),
    ...(agent.listingSubscriptionId === undefined
      ? {}
      : { listingSubscriptionId: agent.listingSubscriptionId }),
    ...(agent.disabledAt === undefined ? {} : { disabledAt: agent.disabledAt }),
    ...(agent.onboardedAt === undefined ? {} : { onboardedAt: agent.onboardedAt }),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  }
}
