import { getShardEntries, SHARD_IDS, type ShardId } from '@/lib/seo/sitemap-shards'
import { buildUrlsetXml } from '@/lib/seo/sitemap-xml'

/**
 * One sitemap shard's `<urlset>` at `/sitemap/<id>.xml` (e.g.
 * `/sitemap/core.xml`). Replaces Next's `generateSitemaps` metadata
 * convention so the framework no longer also (brokenly) owns `/sitemap.xml`
 * — see `app/sitemap.xml/route.ts`. URLs are unchanged: the index still
 * points here at the same `.xml` paths Google has already crawled.
 *
 * Static by construction: pre-rendered at build for every shard id, and
 * `dynamicParams = false` makes any other `/sitemap/*` path a 404.
 */
export const dynamic = 'force-static'
export const dynamicParams = false

export function generateStaticParams(): Array<{ id: string }> {
  // The dynamic segment carries the `.xml` suffix (`core.xml`), matching the
  // URLs the index lists and the framework convention used to serve.
  return SHARD_IDS.map(id => ({ id: `${id}.xml` }))
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const shardId = id.replace(/\.xml$/, '')
  if (!(SHARD_IDS as readonly string[]).includes(shardId)) {
    return new Response('Not found', { status: 404 })
  }
  const entries = await getShardEntries(shardId as ShardId)
  return new Response(buildUrlsetXml(entries), {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  })
}
