import { expect, test } from 'bun:test'

import type { Agent, MarketplaceAgentSubscription } from '@repo/contract'

import {
  marketplaceListingInstances,
  marketplaceUnreadAcknowledgements,
} from './instance-projection'

test('projects every live installed agent for one listing by subscription agent id', () => {
  const portalSubscription = subscription(
    'sub-portal',
    'listing-web',
    'agent-portal',
    'agents/customer-portal',
  )
  const marketingSubscription = subscription(
    'sub-marketing',
    'listing-web',
    'agent-marketing',
    'agents/marketing-site',
  )
  const subscriptions: MarketplaceAgentSubscription[] = [
    portalSubscription,
    marketingSubscription,
    subscription('sub-other', 'listing-other', 'agent-other', 'agents/other'),
  ]
  const portalAgent = agent('agent-portal', 'customer-portal', 'Customer Portal')
  const marketingAgent = agent('agent-marketing', 'marketing-site', 'Marketing Site')
  const agents: Agent[] = [
    portalAgent,
    marketingAgent,
    agent('agent-other', 'other', 'Other Publisher'),
  ]

  expect(marketplaceListingInstances('listing-web', subscriptions, agents)).toEqual({
    instances: [
      {
        subscription: portalSubscription,
        agent: portalAgent,
        displayName: 'Customer Portal',
        health: 'ready',
      },
      {
        subscription: marketingSubscription,
        agent: marketingAgent,
        displayName: 'Marketing Site',
        health: 'ready',
      },
    ],
    installedCount: 2,
    issueCount: 0,
    hasUnreadUpdate: false,
  })
})

test('projects instance health and listing issue/update summaries independently', () => {
  const failed = {
    ...subscription('sub-failed', 'listing-web', 'agent-failed', 'agents/failed'),
    state: 'error' as const,
    appliedEtag: 'etag-2',
    acknowledgedEtag: 'etag-1',
  }
  const unread = {
    ...subscription('sub-unread', 'listing-web', 'agent-unread', 'agents/unread'),
    appliedEtag: 'etag-2',
    acknowledgedEtag: 'etag-1',
  }
  const detached = {
    ...subscription('sub-detached', 'listing-web', 'agent-detached', 'agents/detached'),
    state: 'detached' as const,
  }

  expect(marketplaceListingInstances('listing-web', [failed, unread, detached], [])).toEqual({
    instances: [
      {
        subscription: failed,
        agent: undefined,
        displayName: 'website-builder',
        health: 'needs-attention',
      },
      {
        subscription: unread,
        agent: undefined,
        displayName: 'website-builder',
        health: 'ready',
      },
    ],
    installedCount: 2,
    issueCount: 1,
    hasUnreadUpdate: true,
  })
})

test('selects every unread revision once while allowing a later etag', () => {
  const first = {
    ...subscription('sub-first', 'listing-web', 'agent-first', 'agents/first'),
    appliedEtag: 'etag-2',
    acknowledgedEtag: 'etag-1',
  }
  const second = {
    ...subscription('sub-second', 'listing-web', 'agent-second', 'agents/second'),
    appliedEtag: 'etag-4',
  }
  const read = {
    ...subscription('sub-read', 'listing-web', 'agent-read', 'agents/read'),
    appliedEtag: 'etag-1',
    acknowledgedEtag: 'etag-1',
  }
  const projection = marketplaceListingInstances('listing-web', [first, second, read], [])

  expect(marketplaceUnreadAcknowledgements(projection.instances, new Set())).toEqual([
    { key: 'sub-first:etag-2', subscriptionId: 'sub-first' },
    { key: 'sub-second:etag-4', subscriptionId: 'sub-second' },
  ])
  expect(
    marketplaceUnreadAcknowledgements(
      projection.instances,
      new Set(['sub-first:etag-2', 'sub-second:etag-4']),
    ),
  ).toEqual([])

  const later = marketplaceListingInstances(
    'listing-web',
    [{ ...first, appliedEtag: 'etag-3' }, second],
    [],
  )
  expect(marketplaceUnreadAcknowledgements(later.instances, new Set(['sub-first:etag-2']))).toEqual(
    [
      { key: 'sub-first:etag-3', subscriptionId: 'sub-first' },
      { key: 'sub-second:etag-4', subscriptionId: 'sub-second' },
    ],
  )
})

function subscription(
  id: string,
  listingId: string,
  agentId: string,
  path: string,
): MarketplaceAgentSubscription {
  return {
    id,
    listingId,
    agentId,
    anchorId: `anchor-${id}`,
    agentName: 'website-builder',
    path,
    mode: 'subscribe',
    state: 'active',
  }
}

function agent(id: string, slug: string, name?: string): Agent {
  return {
    id,
    workspaceId: 'workspace-acme',
    anchorId: `anchor-${id}`,
    anchorPath: `agents/${slug}`,
    anchorState: 'active',
    slug,
    name,
    createdAt: 1,
    updatedAt: 1,
  }
}
