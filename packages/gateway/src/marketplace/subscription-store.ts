import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MarketplaceLastErrorCodeSchema, VmDesiredMarketplaceAgentsSchema } from '@repo/contract'

import { writeAtomicJson } from '../atomic-json'
import type { UpstreamManifest } from './materializer'

export const MARKETPLACE_SUBSCRIPTIONS_FILE = 'marketplace-subscriptions.json'

export interface StoredMarketplaceAgentSubscription {
  subscriptionId: string
  agentName: string
  listingId: string
  sourceUrl: string
  path: string
  anchorId: string
  etag?: string
  /**
   * The control plane's opaque content token as it stood at the last successful
   * NETWORK pull. Compared only against the currently projected token — never
   * against `etag`, which lives in a different value space.
   */
  pulledRevision?: string
  manifest: UpstreamManifest
  /** When the network last revalidated this subscription against its publisher. */
  lastRevalidatedAt?: number
  /** When the drive was last reconciled onto the cached snapshot. Needs no network. */
  lastConvergedAt?: number
  lastErrorCode?: string
  lastErrorAt?: number
}

export interface MarketplaceAgentSubscriptionStore {
  current(): StoredMarketplaceAgentSubscription[]
  replace(subscriptions: StoredMarketplaceAgentSubscription[]): void
}

export function createMarketplaceAgentSubscriptionStore(
  stateDir: string,
): MarketplaceAgentSubscriptionStore {
  const path = join(stateDir, MARKETPLACE_SUBSCRIPTIONS_FILE)
  let subscriptions = readSubscriptions(path)

  return {
    current: () => structuredClone(subscriptions),
    replace(next) {
      const validated = parseSubscriptions(next)
      if (validated === null) throw new Error('Invalid marketplace subscription state')
      writeAtomicJson(path, validated)
      subscriptions = structuredClone(validated)
    },
  }
}

function readSubscriptions(path: string): StoredMarketplaceAgentSubscription[] {
  try {
    return parseSubscriptions(JSON.parse(readFileSync(path, 'utf8'))) ?? []
  } catch {
    return []
  }
}

function parseSubscriptions(value: unknown): StoredMarketplaceAgentSubscription[] | null {
  if (!Array.isArray(value)) return null
  const parsed: StoredMarketplaceAgentSubscription[] = []
  const subscriptionIds = new Set<string>()
  const paths = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return null
    if (
      typeof item.subscriptionId !== 'string' ||
      item.subscriptionId.length === 0 ||
      typeof item.agentName !== 'string' ||
      item.agentName.length === 0 ||
      typeof item.sourceUrl !== 'string' ||
      item.sourceUrl.length === 0 ||
      typeof item.listingId !== 'string' ||
      item.listingId.length === 0 ||
      typeof item.path !== 'string' ||
      item.path.length === 0 ||
      typeof item.anchorId !== 'string' ||
      item.anchorId.length === 0 ||
      (item.etag !== undefined && (typeof item.etag !== 'string' || item.etag.length === 0)) ||
      (item.pulledRevision !== undefined &&
        (typeof item.pulledRevision !== 'string' || item.pulledRevision.length === 0)) ||
      !isTimestamp(item.lastRevalidatedAt) ||
      !isTimestamp(item.lastConvergedAt) ||
      !isTimestamp(item.lastAppliedAt) ||
      (item.lastErrorCode !== undefined &&
        !MarketplaceLastErrorCodeSchema.safeParse(item.lastErrorCode).success) ||
      !isManifest(item.manifest)
    ) {
      return null
    }
    const desiredIdentity = VmDesiredMarketplaceAgentsSchema.safeParse({
      subscriptions: [
        {
          subscriptionId: item.subscriptionId,
          // Per subscription now, not per payload — the whole point of the
          // wire change. Leaving these at the top level makes every persisted
          // row fail to parse and the puller silently restart from empty.
          listingId: item.listingId,
          sourceUrl: item.sourceUrl,
          agentName: item.agentName,
          path: item.path,
          anchorId: item.anchorId,
          mode: 'subscribe',
        },
      ],
    })
    if (!desiredIdentity.success) return null
    if (subscriptionIds.has(item.subscriptionId) || paths.has(item.path)) return null
    subscriptionIds.add(item.subscriptionId)
    paths.add(item.path)
    // A state file written before the two jobs were split carries one
    // `lastAppliedAt`, because revalidating and converging were one event. It
    // seeds both clocks and is then dropped, so the file upgrades in place on
    // the first write — and a downgraded release ignores the keys it lost.
    const { lastAppliedAt, ...rest } = item
    const lastRevalidatedAt = (item.lastRevalidatedAt ?? lastAppliedAt) as number | undefined
    const lastConvergedAt = (item.lastConvergedAt ?? lastAppliedAt) as number | undefined
    parsed.push({
      ...(rest as unknown as StoredMarketplaceAgentSubscription),
      ...(lastRevalidatedAt === undefined ? {} : { lastRevalidatedAt }),
      ...(lastConvergedAt === undefined ? {} : { lastConvergedAt }),
    })
  }
  return structuredClone(parsed)
}

function isTimestamp(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isManifest(value: unknown): value is UpstreamManifest {
  if (!isRecord(value) || !isRecord(value.files)) return false
  return Object.values(value.files).every(
    file => isRecord(file) && typeof file.sha256 === 'string' && /^[a-f\d]{64}$/.test(file.sha256),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
