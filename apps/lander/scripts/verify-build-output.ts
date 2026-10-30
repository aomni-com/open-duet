import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { isDiscontinuedEsMarketingPath } from '../lib/i18n/path-classification'
import { mdRoutePath } from '../lib/llms/md-url'
import { getLlmsPages } from '../lib/llms/pages'
import { resolveConfiguredLanderOrigin } from '../src/config/origins'
import { PUBLIC_ROUTE_MANIFEST } from '../src/public-route-manifest'

const buildRoot = path.resolve(import.meta.dir, '../.next')
const prerender = JSON.parse(
  await readFile(path.join(buildRoot, 'prerender-manifest.json'), 'utf8'),
) as { routes: Record<string, unknown> }

const prerendered = new Set(Object.keys(prerender.routes))
const landerOrigin = resolveConfiguredLanderOrigin()
const missing = PUBLIC_ROUTE_MANIFEST.filter(route => !prerendered.has(route.prerenderPath))
if (missing.length > 0) {
  throw new Error(
    `Public routes lost static rendering:\n${missing
      .map(route => `${route.publicPath} (${route.prerenderPath})`)
      .join('\n')}`,
  )
}

const declaredPrerenders = new Set(PUBLIC_ROUTE_MANIFEST.map(route => route.prerenderPath))
const undeclaredPublicRoutes = [...prerendered]
  .filter(
    route =>
      (route === '/en' ||
        route.startsWith('/en/') ||
        route === '/es-419' ||
        route.startsWith('/es-419/') ||
        route.startsWith('/from/')) &&
      !declaredPrerenders.has(route),
  )
  .sort()
if (undeclaredPublicRoutes.length > 0) {
  throw new Error(
    `Prerendered public routes missing from allowlist:\n${undeclaredPublicRoutes.join('\n')}`,
  )
}

for (const route of [
  '/public-route-manifest.json',
  '/robots.txt',
  '/sitemap.xml',
  '/sitemap/core.xml',
  '/sitemap/blog-en.xml',
  '/sitemap/blog-es.xml',
  '/sitemap/guides-en.xml',
  '/sitemap/guides-es.xml',
  '/sitemap/use-cases.xml',
  '/install',
  '/llms.txt',
  '/llms-full.txt',
]) {
  if (!prerendered.has(route)) throw new Error(`Static public route is missing: ${route}`)
}

// Every page the index advertises must have its markdown twin baked into the
// build. A twin that falls through to the page tree does not 404 — it renders
// `/md/<route>` as a localized page with `md` as the locale, which throws
// inside the landing specs and serves a 500 where the site meant "no such
// page".
const missingTwins = (await getLlmsPages())
  .map(page => mdRoutePath(page.path))
  .filter(route => !prerendered.has(route))
if (missingTwins.length > 0) {
  throw new Error(`Markdown twins lost static rendering:\n${missingTwins.join('\n')}`)
}

for (const route of PUBLIC_ROUTE_MANIFEST) {
  const htmlPath = `server/app${route.prerenderPath}.html`
  const absolutePath = path.join(buildRoot, htmlPath)
  const bytes = (await stat(absolutePath)).size
  if (bytes < 2_000) throw new Error(`Prerendered HTML is unexpectedly empty: ${htmlPath}`)

  const html = await readFile(absolutePath, 'utf8')
  if (isDiscontinuedEsMarketingPath(route.publicPath)) {
    // Proxy owns the deployed 308 before this internal artifact is served.
    // Some legacy segments prerender a not-found shell while bespoke pages
    // retain a full fallback, so only existence is an invariant here.
    continue
  }
  if (!html.includes('<html lang="en"')) {
    throw new Error(`${route.publicPath} lost its static root document language`)
  }
  if (
    route.prerenderPath.startsWith('/es-419') &&
    !html.includes('document.documentElement.lang="es-419"')
  ) {
    throw new Error(`${route.publicPath} lost its prerendered Spanish language handoff`)
  }
  const spanishAlternateIndex = html.indexOf('rel="alternate" hrefLang="es"')
  const localeDetectionIndex = html.indexOf("sessionStorage.getItem('locale-detected')")
  if (
    spanishAlternateIndex !== -1 &&
    (localeDetectionIndex === -1 || spanishAlternateIndex > localeDetectionIndex)
  ) {
    throw new Error(`${route.publicPath} locale detection runs before its Spanish alternate`)
  }
  const meaningfulText = html
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/&(?:[a-z]+|#\d+);/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
  if (meaningfulText.length < 100) {
    throw new Error(`${route.publicPath} lost meaningful no-JavaScript HTML`)
  }
  if (/<p\b[^>]*>\s*<a\b[^>]*>\s*<p\b/i.test(html)) {
    throw new Error(`${route.publicPath} contains invalid nested paragraph link markup`)
  }
  if (route.publicPath === '/' && !html.includes('href="/es"')) {
    throw new Error('English home lost its static Spanish language switch')
  }

  const publicLinks = extractPublicMetadataLinks(html)
  for (const link of publicLinks) {
    if (!link.href.startsWith(landerOrigin)) {
      throw new Error(`${route.publicPath} advertises a non-lander ${link.rel}: ${link.href}`)
    }
  }
  if (route.kind === 'marketing' || route.kind === 'editorial') {
    const canonical = publicLinks.find(link => link.rel === 'canonical')
    if (canonical === undefined) throw new Error(`${route.publicPath} lost its canonical link`)
    // Consolidated Spanish URLs redirect in proxy before this internal
    // prerender is served. The artifact itself remains self-canonical so a
    // deployment can never emit a cross-owner URL if middleware is bypassed.
    const expectedPath = route.publicPath
    const expectedCanonical = `${landerOrigin}${expectedPath === '/' ? '' : expectedPath}`
    if (canonical.href !== expectedCanonical) {
      throw new Error(
        `${route.publicPath} canonical drifted: expected ${expectedCanonical}, received ${canonical.href}`,
      )
    }
  }
}

console.log(
  `Verified all ${PUBLIC_ROUTE_MANIFEST.length} public pages, locale handoff, canonical ownership, metadata origins, and no-JavaScript HTML.`,
)

function extractPublicMetadataLinks(html: string): Array<{ rel: string; href: string }> {
  return [...html.matchAll(/<link\b[^>]*>/gi)].flatMap(match => {
    const tag = match[0]
    const rel = tag.match(/\brel="([^"]+)"/i)?.[1]
    const href = tag.match(/\bhref="([^"]+)"/i)?.[1]
    if ((rel !== 'canonical' && rel !== 'alternate') || href === undefined) return []
    return [{ rel, href }]
  })
}
