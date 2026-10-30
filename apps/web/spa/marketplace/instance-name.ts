import { AgentNameSchema, type MarketplaceAgentInstallRequest } from '@repo/contract'

import { agentSlugFromName } from '../agents/create-agent'

export type MarketplaceAdditionalInstallTarget = {
  name: string
  slug: string
  path: `agents/${string}`
}

export function marketplaceAdditionalInstallTarget(
  name: string,
): MarketplaceAdditionalInstallTarget | undefined {
  const parsed = AgentNameSchema.safeParse(name)
  if (!parsed.success) return undefined
  const slug = agentSlugFromName(parsed.data, new Set())
  return { name: parsed.data, slug, path: `agents/${slug}` }
}

export function marketplaceNamedInstallRequest(
  intent: 'initial' | 'additional',
  listingId: string,
  name: string,
): MarketplaceAgentInstallRequest | undefined {
  if (intent === 'additional') {
    const target = marketplaceAdditionalInstallTarget(name)
    return target === undefined ? undefined : { listingId, name: target.name, path: target.path }
  }
  if (name === '') return { listingId }
  const parsed = AgentNameSchema.safeParse(name)
  return parsed.success ? { listingId, name: parsed.data } : undefined
}

export function nextMarketplaceInstanceName(rejectedName: string): string {
  const name = rejectedName.trim()
  const numbered = /^(.*) (\d+)$/.exec(name)
  if (numbered === null) return `${name} 2`
  return `${numbered[1]} ${Number(numbered[2]) + 1}`
}
