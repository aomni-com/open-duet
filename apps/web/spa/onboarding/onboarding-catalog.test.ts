import { expect, test } from 'bun:test'

import type { MarketplaceListingSummary } from '@repo/contract'

import { partitionCatalog } from './onboarding-catalog'
import type { RecommendationsState } from './onboarding-flow'

function listing(agentName: string): MarketplaceListingSummary {
  return {
    id: `listing-${agentName}`,
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName,
    title: agentName,
    summary: `${agentName} summary`,
    skills: [],
    tags: [],
    appNames: [],
    installs: 0,
    availability: 'available',
  }
}

function readyRecommendations(
  picks: readonly { agentName: string; reason: string }[],
): RecommendationsState {
  return { status: 'ready', purpose: 'Goal: grow my business.', items: picks }
}

test('partitionCatalog splits recommended picks in recommendation order', () => {
  const catalog = {
    status: 'ready',
    agents: [listing('alpha'), listing('bravo'), listing('charlie'), listing('delta')],
  } as const
  const { recommended, rest } = partitionCatalog(
    catalog,
    readyRecommendations([
      { agentName: 'delta', reason: 'Closest fit for your outreach goal.' },
      { agentName: 'bravo', reason: 'Covers the follow-up you named.' },
    ]),
  )

  expect(recommended).toEqual([
    { listing: catalog.agents[3]!, reason: 'Closest fit for your outreach goal.' },
    { listing: catalog.agents[1]!, reason: 'Covers the follow-up you named.' },
  ])
  expect(rest).toEqual([catalog.agents[0]!, catalog.agents[2]!])
})

test('partitionCatalog leaves the catalog whole until both sides are ready', () => {
  const agents = [listing('alpha'), listing('bravo')]
  const picks = [{ agentName: 'alpha', reason: 'Fits.' }]

  const pending = partitionCatalog(
    { status: 'ready', agents },
    { status: 'pending', purpose: 'Goal: grow my business.', items: [] },
  )
  expect(pending).toEqual({ recommended: [], rest: agents })

  const catalogNotReady = partitionCatalog(
    { status: 'loading', agents: [] },
    readyRecommendations(picks),
  )
  expect(catalogNotReady).toEqual({ recommended: [], rest: [] })
})

test('partitionCatalog collapses the whole rail when a pick has left the catalog', () => {
  const agents = [listing('alpha'), listing('bravo')]

  const partitioned = partitionCatalog(
    { status: 'ready', agents },
    readyRecommendations([
      { agentName: 'alpha', reason: 'Fits the goal you named.' },
      { agentName: 'unpublished', reason: 'Was withdrawn a second ago.' },
    ]),
  )

  expect(partitioned).toEqual({ recommended: [], rest: agents })
})
