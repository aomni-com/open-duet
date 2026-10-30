import { describe, expect, test } from 'bun:test'

import type { MarketplaceCatalogResponse, MarketplaceListingSummary } from '@repo/contract'

import { collectOpaquePages, loadAllMarketplaceCatalog } from './staging-live-pagination.ts'

describe('collectOpaquePages', () => {
  test('continues through short and empty pages until the terminal cursor', async () => {
    const seen: Array<string | null> = []
    const pages = new Map([
      [null, { items: ['newest'], nextCursor: 'page-2' }],
      ['page-2', { items: [], nextCursor: 'page-3' }],
      ['page-3', { items: ['oldest'], nextCursor: null }],
    ])

    const items = await collectOpaquePages(async cursor => {
      seen.push(cursor)
      return pages.get(cursor)!
    })

    expect(seen).toEqual([null, 'page-2', 'page-3'])
    expect(items).toEqual(['newest', 'oldest'])
  })

  test('rejects a continuation cursor that cannot advance the walk', async () => {
    let requests = 0

    await expect(
      collectOpaquePages(async cursor => {
        requests += 1
        if (requests > 3) throw new Error('test sentinel: the walk kept spinning')
        return { items: [cursor ?? 'first'], nextCursor: 'stuck' }
      }),
    ).rejects.toThrow('collection walk returned a repeated continuation cursor')

    expect(requests).toBe(2)
  })

  test('rejects an endless stream of unique continuation cursors', async () => {
    let requests = 0

    await expect(
      collectOpaquePages(async () => {
        requests += 1
        if (requests > 2_000) throw new Error('test sentinel: the walk exceeded any safe ceiling')
        return { items: [], nextCursor: `unique-${requests}` }
      }),
    ).rejects.toThrow('collection walk exceeded its page safety ceiling')

    expect(requests).toBeLessThanOrEqual(2_000)
  })
})

describe('collectMarketplaceCatalog', () => {
  test('preserves first-page metadata while collecting every opaque page', async () => {
    const seen: Array<string | null> = []
    const listing = (id: string): MarketplaceListingSummary => ({
      id,
      publisherSlug: 'fixture-publisher',
      verifiedPublisher: true,
      agentName: id,
      title: `Listing ${id}`,
      summary: `Summary ${id}`,
      skills: [],
      tags: [],
      appNames: [],
      installs: 0,
      availability: 'available',
    })
    const pages = new Map<string | null, MarketplaceCatalogResponse>([
      [
        null,
        { items: [listing('first')], nextCursor: 'opaque-2', meta: { canPublishListings: false } },
      ],
      ['opaque-2', { items: [], nextCursor: 'opaque-3', meta: { canPublishListings: true } }],
      [
        'opaque-3',
        { items: [listing('last')], nextCursor: null, meta: { canPublishListings: true } },
      ],
    ])
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.headers.get('authorization') !== 'Bearer fixture-token') {
          return new Response('Unauthorized', { status: 401 })
        }
        if (url.pathname !== '/catalog' || url.searchParams.get('limit') !== '100') {
          return new Response('Wrong collection request', { status: 400 })
        }
        const cursor = url.searchParams.get('cursor')
        seen.push(cursor)
        const page = pages.get(cursor)
        return page === undefined
          ? new Response('Unknown cursor', { status: 400 })
          : Response.json(page)
      },
    })
    try {
      const catalog = await loadAllMarketplaceCatalog(
        new URL('/catalog?cursor=stale', server.url).toString(),
        'fixture-token',
        'fixture catalog',
      )
      expect(seen).toEqual([null, 'opaque-2', 'opaque-3'])
      expect(catalog.items).toEqual([listing('first'), listing('last')])
      expect(catalog.meta).toEqual({ canPublishListings: false })
      expect(catalog.nextCursor).toBeNull()
    } finally {
      await server.stop(true)
    }
  })
})
