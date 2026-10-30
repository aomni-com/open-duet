import { describe, expect, test } from 'bun:test'

import { SHARD_IDS, getShardEntries } from '../lib/seo/sitemap-shards'
import { PUBLIC_ROUTE_MANIFEST } from './public-route-manifest'

/**
 * The lander lineup: one indexed lander at `/`, and every other whole-page
 * pitch under `/l/<slug>`, noindexed.
 *
 * These assert the *lineup*, not the copy: which whole-page pitches the site
 * serves, and that the indexed/noindexed split stays consistent across the
 * route manifest and the sitemap. A page that drifts between the two is the
 * failure this catches — an indexed URL missing from the sitemap, or a
 * campaign lander leaking into it.
 */

const CAMPAIGN_LANDERS = [
  '/l/agent-cloud',
  '/l/business',
  '/l/file-sharing',
  '/l/platform',
  '/l/sell',
  '/l/team',
] as const

/** Deleted with no redirect: their pitch now lives at `/` or under `/l/`. */
const RETIRED_PRODUCT_PAGES = ['/agent-cloud', '/app-hosting', '/file-sharing'] as const

describe('lander lineup', () => {
  test('every whole-page pitch is either the main lander or a /l/ campaign lander', () => {
    const campaignPaths = PUBLIC_ROUTE_MANIFEST.filter(route => route.publicPath.startsWith('/l/'))
    expect(campaignPaths.map(route => route.publicPath).sort()).toEqual([...CAMPAIGN_LANDERS])
    // A `/l/` page that the manifest calls marketing would be sitemapped by
    // the gates that read this kind.
    expect(campaignPaths.every(route => route.kind === 'campaign')).toBe(true)
  })

  test('the retired product pages are gone from the public route manifest', () => {
    const paths = new Set(PUBLIC_ROUTE_MANIFEST.map(route => route.publicPath))
    for (const retired of RETIRED_PRODUCT_PAGES) {
      expect(paths.has(retired)).toBe(false)
      expect(paths.has(`/es${retired}`)).toBe(false)
    }
  })

  test('no campaign lander or retired product page is advertised in a sitemap', async () => {
    const urls: string[] = []
    for (const id of SHARD_IDS) {
      for (const entry of await getShardEntries(id)) urls.push(entry.url)
    }
    const paths = urls.map(url => new URL(url).pathname)
    expect(paths.filter(pathname => pathname.startsWith('/l/'))).toEqual([])
    for (const retired of RETIRED_PRODUCT_PAGES) {
      expect(paths).not.toContain(retired)
    }
    // The main lander stays indexed and sitemapped.
    expect(paths).toContain('/')
  })
})
