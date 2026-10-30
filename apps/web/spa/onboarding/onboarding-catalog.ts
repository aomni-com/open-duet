import type { MarketplaceListingSummary } from '@repo/contract'

import type { CatalogState, RecommendationsState } from './onboarding-flow'

/**
 * Splits the verified catalog into the "picked for you" rail and the rest,
 * joining recommendations to listings by `agentName`. Until both sides are
 * ready, or if the catalog changed under a recommendation, the catalog stays
 * whole and unordered.
 */
export function partitionCatalog(
  catalog: CatalogState,
  recommendations: RecommendationsState,
): {
  recommended: readonly { listing: MarketplaceListingSummary; reason: string }[]
  rest: readonly MarketplaceListingSummary[]
} {
  if (catalog.status !== 'ready' || recommendations.status !== 'ready') {
    return { recommended: [], rest: catalog.agents }
  }
  const byName = new Map(catalog.agents.map(agent => [agent.agentName, agent]))
  const recommended = recommendations.items.flatMap(item => {
    const listing = byName.get(item.agentName)
    return listing === undefined ? [] : [{ listing, reason: item.reason }]
  })
  // A short rail is the same broken-looking half-answer the four-or-none wire
  // rule exists to prevent, so an unmatched pick collapses the whole rail.
  if (recommended.length !== recommendations.items.length) {
    return { recommended: [], rest: catalog.agents }
  }
  const recommendedNames = new Set(recommended.map(pick => pick.listing.agentName))
  return {
    recommended,
    rest: catalog.agents.filter(agent => !recommendedNames.has(agent.agentName)),
  }
}
