import type { Agent, MarketplaceAgentSubscription } from '@repo/contract'

export type MarketplaceInstanceHealth = 'installing' | 'ready' | 'needs-attention'

export type MarketplaceListingInstance = {
  subscription: MarketplaceAgentSubscription
  agent: Agent | undefined
  displayName: string
  health: MarketplaceInstanceHealth
}

export type MarketplaceListingInstances = {
  instances: MarketplaceListingInstance[]
  installedCount: number
  issueCount: number
  hasUnreadUpdate: boolean
}

export function marketplaceListingInstances(
  listingId: string,
  subscriptions: readonly MarketplaceAgentSubscription[],
  agents: readonly Agent[],
): MarketplaceListingInstances {
  const agentsById = new Map(agents.map(agent => [agent.id, agent]))
  const instances = subscriptions
    .filter(
      subscription => subscription.listingId === listingId && subscription.state !== 'detached',
    )
    .map(subscription => {
      const agent =
        subscription.agentId === undefined ? undefined : agentsById.get(subscription.agentId)
      return {
        subscription,
        agent,
        displayName: agent?.name ?? agent?.slug ?? subscription.agentName,
        health: instanceHealth(subscription),
      }
    })

  return {
    instances,
    installedCount: instances.length,
    issueCount: instances.filter(instance => instance.health === 'needs-attention').length,
    hasUnreadUpdate: instances.some(instance =>
      marketplaceSubscriptionHasUpdate(instance.subscription),
    ),
  }
}

export function marketplaceUnreadAcknowledgements(
  instances: readonly MarketplaceListingInstance[],
  attempted: ReadonlySet<string>,
): Array<{ key: string; subscriptionId: string }> {
  return instances.flatMap(({ subscription }) => {
    if (
      subscription.appliedEtag === undefined ||
      subscription.appliedEtag === subscription.acknowledgedEtag
    )
      return []
    const key = `${subscription.id}:${subscription.appliedEtag}`
    return attempted.has(key) ? [] : [{ key, subscriptionId: subscription.id }]
  })
}

function instanceHealth(subscription: MarketplaceAgentSubscription): MarketplaceInstanceHealth {
  switch (subscription.state) {
    case 'installing':
      return 'installing'
    case 'active':
      return 'ready'
    case 'error':
      return 'needs-attention'
    case 'detached':
      throw new Error('Detached subscriptions are excluded before health projection')
  }
}

function marketplaceSubscriptionHasUpdate(
  subscription: Pick<MarketplaceAgentSubscription, 'appliedEtag' | 'acknowledgedEtag'>,
): boolean {
  return (
    subscription.appliedEtag !== undefined &&
    subscription.appliedEtag !== subscription.acknowledgedEtag
  )
}
