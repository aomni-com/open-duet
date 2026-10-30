import {
  MarketplaceCatalogResponseSchema,
  SessionHistoryPageSchema,
  SessionListPageSchema,
  type MarketplaceCatalogResponse,
  type SessionInitialHistorySnapshot,
  type SessionListItem,
} from '@repo/contract'

import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { apiJson, bearer } from './staging-live-http.ts'

export type OpaquePage<Item> = {
  items: Item[]
  nextCursor: string | null
}

// A focused staging journey should never need 100,000 collection rows (1,000
// public pages at the 100-row harness limit). Keep a remote cursor bug bounded
// even when every bad cursor is unique, without imposing a product collection
// limit on the API itself.
const EXHAUSTIVE_COLLECTION_PAGE_CEILING = 1_000

/**
 * Exhaust a public collection without mistaking a short or empty page for the
 * end. Session discovery can legitimately subtract every scanned candidate;
 * only a null cursor means the walk is complete.
 */
export async function collectOpaquePages<Item>(
  loadPage: (cursor: string | null) => Promise<OpaquePage<Item>>,
): Promise<Item[]> {
  const items: Item[] = []
  const requestedCursors = new Set<string | null>()
  let cursor: string | null = null
  do {
    if (requestedCursors.size >= EXHAUSTIVE_COLLECTION_PAGE_CEILING) {
      throw new Error('collection walk exceeded its page safety ceiling')
    }
    requestedCursors.add(cursor)
    const page = await loadPage(cursor)
    items.push(...page.items)
    if (page.nextCursor !== null && requestedCursors.has(page.nextCursor)) {
      throw new Error('collection walk returned a repeated continuation cursor')
    }
    cursor = page.nextCursor
  } while (cursor !== null)
  return items
}

export async function collectMarketplaceCatalog(
  loadPage: (cursor: string | null) => Promise<MarketplaceCatalogResponse>,
): Promise<MarketplaceCatalogResponse> {
  let firstPage: MarketplaceCatalogResponse | undefined
  const items = await collectOpaquePages(async cursor => {
    const page = await loadPage(cursor)
    firstPage ??= page
    return page
  })
  if (firstPage === undefined) throw new Error('marketplace catalog did not return a first page')
  return { ...firstPage, items, nextCursor: null }
}

/** A harness assertion model: complete durable history, oldest event first. */
export type ChronologicalSessionHistory = SessionInitialHistorySnapshot

function pageUrl(url: string, cursor: string | null): string {
  const target = new URL(url)
  target.searchParams.set('limit', '100')
  if (cursor === null) target.searchParams.delete('cursor')
  else target.searchParams.set('cursor', cursor)
  return target.toString()
}

export async function loadAllMarketplaceCatalog(
  url: string,
  token: string,
  label: string,
  artifacts?: StagingArtifactCollector,
): Promise<MarketplaceCatalogResponse> {
  return await collectMarketplaceCatalog(async cursor =>
    MarketplaceCatalogResponseSchema.parse(
      await apiJson(pageUrl(url, cursor), { headers: bearer(token) }, 200, label, artifacts),
    ),
  )
}

export async function loadAllSessionListItems(
  url: string,
  token: string,
  label: string,
  artifacts?: StagingArtifactCollector,
): Promise<SessionListItem[]> {
  return await collectOpaquePages(async cursor =>
    SessionListPageSchema.parse(
      await apiJson(pageUrl(url, cursor), { headers: bearer(token) }, 200, label, artifacts),
    ),
  )
}

export async function loadChronologicalSessionHistory(
  url: string,
  token: string,
  label: string,
  artifacts?: StagingArtifactCollector,
): Promise<ChronologicalSessionHistory> {
  const target = new URL(url)
  target.searchParams.set('order', 'asc')
  const events = await collectOpaquePages(async cursor =>
    SessionHistoryPageSchema.parse(
      await apiJson(
        pageUrl(target.toString(), cursor),
        { headers: bearer(token) },
        200,
        label,
        artifacts,
      ),
    ),
  )
  return { events }
}
