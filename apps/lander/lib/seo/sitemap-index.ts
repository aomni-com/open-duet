import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import type { ShardId } from '@/lib/seo/sitemap-shards'

// Builds the `<sitemapindex>` served at `/sitemap.xml`. Kept out of the
// route handler itself because Next only allows route-field exports (GET,
// dynamic, …) from a `route.ts`. Derives entirely from the shard ids passed
// in (SHARD_IDS), so the index can never drift from the shards served at
// `/sitemap/<id>.xml`.

export function buildSitemapIndexXml(ids: readonly ShardId[]): string {
  const entries = ids
    .map(id => `  <sitemap>\n    <loc>${LANDER_ORIGIN}/sitemap/${id}.xml</loc>\n  </sitemap>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`
}
