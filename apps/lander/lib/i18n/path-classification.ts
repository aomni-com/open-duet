import { isRedirectedEsEditorialSlug, type EsEditorialKind } from './es-editorial-indexing'

const PUBLIC_FILE = /\.[^/]+$/

// Consolidated `/es` editorial duplicates (Bucket B): zero Spanish search
// demand but real English demand for the topic, so the EN page is the natural
// ranker. A May 2026 DataForSEO re-audit flagged these exact 8
// `/es/{blog,guides}/<slug>` pages; we 308 each to its English canonical and
// drop its `es` hreflang (see `es-editorial-indexing.ts` for the slug lists
// and the full bucket rationale). Single-segment `<slug>` so hub/category/tag
// paths like `/es/blog/category/<x>` never match.
export function isConsolidatedEsEditorialPath(pathname: string): boolean {
  const match = /^\/es\/(blog|guides)\/([^/]+)\/?$/.exec(pathname)
  const kind = match?.[1]
  const slug = match?.[2]
  if (!kind || !slug) return false
  return isRedirectedEsEditorialSlug(kind as EsEditorialKind, slug)
}

// Spanish marketing clusters we've discontinued. A May 2026 keyword audit
// (DataForSEO, MX/ES/US/CO/AR) found every term these pages target sits at
// ~0 Spanish search volume — they were a literal translation of the English
// keyword matrix ("AI para equipos de ventas") rather than how Spanish
// speakers actually search ("agente de IA", "IA para pymes"). Google
// responded predictably: the whole `/es/*` programmatic tree sat in
// "Crawled - currently not indexed". Rather than keep a few hundred
// non-indexing duplicate-intent pages diluting sitewide quality, we 308 them
// to their English canonical so any residual signal consolidates onto EN.
// `/es/for/*` (verticals + hub) is already EN-only via `dynamicParams` /
// `notFound()`, but the prefix is matched here too so any ES `/for` URL folds in.
export function isDiscontinuedEsMarketingPath(pathname: string): boolean {
  return /^\/es\/(?:use-cases|vs|for)(?:\/|$)/.test(pathname)
}

export function publicRedirectTarget(pathname: string): string | null {
  if (!isDiscontinuedEsMarketingPath(pathname) && !isConsolidatedEsEditorialPath(pathname)) {
    return null
  }
  return pathname.replace(/^\/es(?=\/)/, '') || '/'
}

export function shouldBypassI18n(pathname: string): boolean {
  return (
    pathname.startsWith('/api/') ||
    pathname === '/playground' ||
    pathname.startsWith('/playground/') ||
    pathname === '/install' ||
    pathname === '/install.txt' ||
    pathname === '/llms.txt' ||
    pathname === '/llms-full.txt' ||
    pathname.startsWith('/_next/static') ||
    pathname.startsWith('/_next/image') ||
    pathname === '/favicon.ico' ||
    pathname === '/sitemap.xml' ||
    // Sitemap shards live at /sitemap/<id>.xml (app/sitemap/[id]/route.ts); bypass
    // intl rewrites so the route isn't locale-prefixed.
    pathname.startsWith('/sitemap/') ||
    pathname === '/robots.txt' ||
    PUBLIC_FILE.test(pathname)
  )
}
