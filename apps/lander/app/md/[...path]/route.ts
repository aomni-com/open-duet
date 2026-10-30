import { AGENT_TEXT_CACHE_CONTROL } from '@/lib/llms/markdown'
import { mdSegmentsToPath, pathToMdSegments } from '@/lib/llms/md-url'
import { getLlmsPage, getLlmsPages } from '@/lib/llms/pages'

/**
 * The per-page markdown twins.
 *
 * These are reached as `/<route>.md`; `proxy.ts` rewrites that to `/md/<route>`
 * so the twins live in their own segment instead of a root catch-all that
 * would compete with the localized page tree for every URL on the site.
 *
 * `generateStaticParams` prerenders exactly the published pages, and the
 * handler 404s anything else. It deliberately does NOT set
 * `dynamicParams = false`: an unmatched param makes Next treat this route as
 * not matching at all and fall through to `app/[locale]/...`, which then
 * renders the requested twin as a page with `md` as its locale. That 500s
 * inside the landing specs rather than 404ing.
 */
export const dynamic = 'force-static'

export async function generateStaticParams(): Promise<Array<{ path: string[] }>> {
  return (await getLlmsPages()).map(page => ({ path: pathToMdSegments(page.path) }))
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params
  const page = await getLlmsPage(mdSegmentsToPath(path))
  if (page === null) return new Response('Not found', { status: 404 })

  return new Response(page.markdown, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': AGENT_TEXT_CACHE_CONTROL,
    },
  })
}
