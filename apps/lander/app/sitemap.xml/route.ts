import { buildSitemapIndexXml } from '@/lib/seo/sitemap-index'
import { SHARD_IDS } from '@/lib/seo/sitemap-shards'

/**
 * Sitemap index at `/sitemap.xml`.
 *
 * We serve the sitemap ourselves via explicit route handlers — this index
 * plus `app/sitemap/[id]/route.ts` for each shard's `<urlset>` — instead of
 * Next's `generateSitemaps` metadata convention. On Next 15.5.9 that
 * convention's auto-emitted `/sitemap.xml` index returns a 500 in production,
 * and keeping it alongside our own index route makes both resolve to
 * `/sitemap.xml` (a duplicate-page warning). The public sitemap origin has a
 * single route owner here, and robots.ts advertises it.
 *
 * Built from `SHARD_IDS` — the same source of truth `getShardEntries` uses —
 * so the index can never list a shard the `[id]` route won't serve.
 *
 * Static by construction: no request data is read, so Next renders this at
 * build time alongside the shards.
 */
export const dynamic = 'force-static'

export function GET(): Response {
  return new Response(buildSitemapIndexXml(SHARD_IDS), {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  })
}
