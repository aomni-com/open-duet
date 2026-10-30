import fs from 'fs'
import path from 'path'

import type { MetadataRoute } from 'next'

import { VERTICALS } from '@/components/landing/for/verticals-spec'
import { getUseCaseJobs, getUseCasePersonas } from '@/components/landing/use-cases/use-cases-spec'
import { getComparisons } from '@/components/landing/vs/vs-spec'
import { getAllGuides, getAllPosts, getTranslatedLocalesForPost } from '@/lib/blog/content'
import { isEsHreflangSuppressedSlug } from '@/lib/i18n/es-editorial-indexing'
import { defaultLocale, locales, localeMetadata, type AppLocale } from '@/lib/i18n/locales'
import { localizedCanonical } from '@/lib/i18n/metadata'

/**
 * Sitemap sharding strategy
 * -------------------------
 * Until May 2026 the sitemap was ONE flat manifest with ~280 URLs, every
 * static entry stamped with `new Date()` so each build looked like every
 * page on the site had been edited that day. After the Spanish localisation
 * went live (~120 new `/es/*` URLs landing in a single week), Google's
 * crawler did exactly what we should have expected: it stalled. Search
 * Console showed a 20.1% index rate, 170 URLs in `Unknown`, and the
 * `/es/*` tree sitting at 98% non-indexed for over 40 days.
 *
 * We now split the manifest into purpose-scoped shards Google can crawl on
 * independent schedules:
 *   - `core` (homepage, marketing hubs, legal, EN /for/* landers)
 *   - `blog-en`, `guides-en` — primary EN content
 *   - `blog-es`, `guides-es` — secondary, lower priority
 *   - `use-cases` — programmatic cluster, changes as a unit
 *
 * (The former `marketing-es` shard — Spanish `/for/*` landers — was removed
 * when the zero-volume ES marketing tree was discontinued; those URLs now
 * 308 to their EN canonical instead of being indexed.)
 *
 * Combined with honest `lastModified` values (real file mtime / content
 * updatedAt instead of "now"), this gives Googlebot the signal it actually
 * needs to prioritise: which URLs changed, which buckets matter most, and
 * which can wait.
 *
 * Serving model: we own both `/sitemap.xml` (the `<sitemapindex>`, via
 * `app/sitemap.xml/route.ts`) and `/sitemap/<id>.xml` (each shard's
 * `<urlset>`, via `app/sitemap/[id]/route.ts`). We deliberately do NOT use
 * Next's `generateSitemaps` metadata convention: on 15.5.9 it also claims
 * `/sitemap.xml` and 500s there, and having both the convention and our own
 * index route resolve to `/sitemap.xml` triggers a duplicate-page warning.
 * Explicit route handlers give us one unambiguous owner per URL.
 */

// Single source of truth for shard ids. The `ShardId` union, the index
// route, and the `getShardEntries` dispatch switch all derive from this —
// so adding a shard means adding one entry here and a `case` in the switch
// (which TypeScript enforces).
export const SHARD_IDS = [
  'core',
  'blog-en',
  'blog-es',
  'guides-en',
  'guides-es',
  'use-cases',
  'vs',
  // 'marketing-es' removed — the Spanish programmatic marketing tree
  // (use-cases / vs / for) was discontinued after a keyword audit found
  // ~0 Spanish search volume; those /es/* URLs now 308 to EN (see
  // `isDiscontinuedEsMarketingPath`), so they must not appear in the sitemap.
] as const
export type ShardId = (typeof SHARD_IDS)[number]

// Per-locale priority decay. We want Google to spend its crawl budget on
// EN first while the ES tree is still building authority — so every
// non-default-locale URL has its priority multiplied by this factor.
// This is a soft hint, not a directive, but combined with sharding it
// helps Google build a sane crawl queue.
const LOCALE_PRIORITY_WEIGHT: Record<AppLocale, number> = {
  en: 1.0,
  'es-419': 0.6,
}

// One stable build timestamp shared by every "static" entry that doesn't
// have a real content date. Using `new Date()` per entry made every
// rebuild look like a sitewide edit; using one shared value at least
// keeps the noise consistent across one deploy.
const BUILD_TIME = resolveBuildTime(process.env.DUET_PUBLIC_BUILD_TIME)

function resolveBuildTime(value: string | undefined): Date {
  if (value === undefined) return new Date()
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) throw new Error('DUET_PUBLIC_BUILD_TIME must be an ISO date')
  return parsed
}

function adjustPriority(base: number, locale: AppLocale): number {
  return Math.max(0.1, Math.round(base * LOCALE_PRIORITY_WEIGHT[locale] * 10) / 10)
}

/**
 * Build the per-entry `alternates.languages` map serialised as
 * `<xhtml:link rel="alternate" hreflang>` annotations. Includes an
 * `x-default` pointing at the default-locale URL. Returns undefined when
 * a URL has no alternates (single-locale pages) so we don't emit a lone
 * self-referential hreflang.
 */
function hreflangAlternates(
  pathname: string,
  includedLocales: readonly AppLocale[],
): { languages: Record<string, string> } | undefined {
  if (includedLocales.length < 2) return undefined
  const languages: Record<string, string> = {}
  for (const locale of includedLocales) {
    languages[localeMetadata[locale].hreflang] = localizedCanonical(pathname, locale)
  }
  languages['x-default'] = localizedCanonical(pathname, defaultLocale)
  return { languages }
}

type Route = {
  path: string
  lastModified: Date
}

function discoverPages(dir: string, baseRoute: string): Route[] {
  const routes: Route[] = []
  if (!fs.existsSync(dir)) return routes
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Skip dynamic-segment directories (e.g. `[vertical]`) — emitting
      // the literal `/for/[vertical]` URL pollutes the sitemap and the
      // real slugs come from their config spec instead (see
      // `verticalLandingRoutes` below for the `/for/[vertical]` case).
      if (entry.name.startsWith('[')) continue
      routes.push(...discoverPages(path.join(dir, entry.name), `${baseRoute}/${entry.name}`))
    } else if (entry.name === 'page.tsx' || entry.name === 'page.ts') {
      const stat = fs.statSync(path.join(dir, entry.name))
      routes.push({
        path: baseRoute,
        // Baseline builds pin a source-commit clock so a clean checkout, a file
        // move, and an identical second build cannot manufacture SEO changes.
        // Ordinary deployments retain the content file's real mtime.
        lastModified: process.env.DUET_PUBLIC_BUILD_TIME === undefined ? stat.mtime : BUILD_TIME,
      })
    }
  }
  return routes
}

// Concrete `/for/<slug>` entries for the config-driven verticals. The
// dynamic `[vertical]/page.tsx` route would never appear in the disk
// walk above (its directory is filtered out), so we enumerate from the
// spec instead. EN-only — ES translations are a follow-up and the
// dynamic route is gated to EN via `generateStaticParams` + `dynamicParams = false`.
function verticalLandingRoutes(): Route[] {
  return VERTICALS.map(v => ({
    path: `/for/${v.slug}`,
    lastModified: new Date(v.lastUpdated),
  }))
}

// Memoised — the EN core shard reads the `[locale]/for/*` lander list to
// emit the auto-discovered EN landers; caching avoids rescanning the disk
// per sitemap request and keeps the result stable if a file is touched
// mid-request.
let landingPageRoutesCache: Route[] | undefined
function getLandingPageRoutes(): Route[] {
  if (landingPageRoutesCache) return landingPageRoutesCache
  const appDir = path.resolve(process.cwd(), 'app')
  landingPageRoutesCache = discoverPages(path.join(appDir, '[locale]', 'for'), '/for')
  return landingPageRoutesCache
}

function staticEntry(
  pathname: string,
  priority: number,
  changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'],
  includedLocales: readonly AppLocale[] = locales,
  lastModified: Date = BUILD_TIME,
): MetadataRoute.Sitemap {
  const alternates = hreflangAlternates(pathname, includedLocales)
  return includedLocales.map(locale => ({
    url: localizedCanonical(pathname, locale),
    lastModified,
    changeFrequency,
    priority: adjustPriority(priority, locale),
    ...(alternates ? { alternates } : {}),
  }))
}

function contentEntry(
  kind: 'blog' | 'guides',
  slug: string,
  date: string | Date,
  priority: number,
  changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'],
  onlyLocale?: AppLocale,
): MetadataRoute.Sitemap {
  const translatedLocales = getTranslatedLocalesForPost(kind, slug)
  // `/es` editorial pages we've 308'd to EN (Bucket B) or noindexed (Bucket C)
  // drop out of the ES sitemap shard AND out of the hreflang cluster, so we
  // never advertise a non-indexable alternate. Suppression only ever removes
  // the es-419 variant; the EN original is always retained.
  const indexableLocales = isEsHreflangSuppressedSlug(kind, slug)
    ? translatedLocales.filter(l => l === defaultLocale)
    : translatedLocales
  const includedLocales = onlyLocale
    ? indexableLocales.filter(l => l === onlyLocale)
    : indexableLocales
  if (includedLocales.length === 0) return []
  const alternates = hreflangAlternates(`/${kind}/${slug}`, indexableLocales)
  return includedLocales.map(locale => ({
    url: localizedCanonical(`/${kind}/${slug}`, locale),
    lastModified: date,
    changeFrequency,
    priority: adjustPriority(priority, locale),
    ...(alternates ? { alternates } : {}),
  }))
}

function coreShard(): MetadataRoute.Sitemap {
  // EN-only auto-discovered marketing landers (hand-built `/for/*` pages)
  // ride in the core shard alongside the homepage and pricing — same
  // authority signal, small + stable + EN-only.
  const enLanderEntries = [...getLandingPageRoutes(), ...verticalLandingRoutes()].flatMap(route =>
    staticEntry(route.path, 0.8, 'monthly', [defaultLocale], route.lastModified),
  )
  return [
    ...staticEntry('/', 1.0, 'weekly'),
    ...staticEntry('/blog', 0.9, 'daily'),
    ...staticEntry('/guides', 0.9, 'weekly'),
    ...staticEntry('/pricing', 0.9, 'monthly', [defaultLocale]),
    ...staticEntry('/terms', 0.3, 'yearly', [defaultLocale]),
    ...staticEntry('/privacy-policy', 0.3, 'yearly', [defaultLocale]),
    ...staticEntry('/data-protection', 0.3, 'yearly', [defaultLocale]),
    ...enLanderEntries,
  ]
}

function blogShard(locale: AppLocale): MetadataRoute.Sitemap {
  const posts = getAllPosts(defaultLocale)
  return posts.flatMap(post =>
    contentEntry('blog', post.slug, post.updatedAt ?? post.date, 0.8, 'weekly', locale),
  )
}

function guidesShard(locale: AppLocale): MetadataRoute.Sitemap {
  const guides = getAllGuides(defaultLocale)
  return guides.flatMap(guide =>
    contentEntry('guides', guide.slug, guide.updatedAt ?? guide.date, 0.9, 'monthly', locale),
  )
}

// Newest `lastUpdated` in a programmatic cluster. Used as the `lastmod`
// for the cluster's hub page so the hub looks fresh whenever any leaf
// has been edited. Inputs are ISO `YYYY-MM-DD` strings, so lexicographic
// sort matches chronological order.
function latestUpdatedDate(
  entries: ReadonlyArray<{ lastUpdated: string }>,
  fallback: string,
): Date {
  const newest =
    entries
      .map(e => e.lastUpdated)
      .sort()
      .at(-1) ?? fallback
  return new Date(newest)
}

function useCasesShard(): MetadataRoute.Sitemap {
  // EN-only. The Spanish use-cases tree was discontinued (~0 Spanish search
  // volume; the /es/use-cases/* URLs now 308 to EN), so emit only the
  // default-locale URLs and no hreflang `es` alternates.
  const personas = getUseCasePersonas()
  const jobs = getUseCaseJobs()
  const latestPersonaUpdated = latestUpdatedDate(personas, '2026-05-18')
  const latestJobUpdated = latestUpdatedDate(jobs, '2026-05-18')
  const enOnly = [defaultLocale]
  return [
    ...staticEntry('/use-cases', 0.9, 'monthly', enOnly, latestPersonaUpdated),
    ...personas.flatMap(persona =>
      staticEntry(
        `/use-cases/${persona.slug}`,
        0.8,
        'monthly',
        enOnly,
        new Date(persona.lastUpdated),
      ),
    ),
    ...personas.flatMap(persona =>
      persona.leaves.flatMap(leaf =>
        staticEntry(
          `/use-cases/${persona.slug}/${leaf.slug}`,
          0.6,
          'monthly',
          enOnly,
          new Date(leaf.lastUpdated),
        ),
      ),
    ),
    ...staticEntry('/use-cases/by-job', 0.8, 'weekly', enOnly, latestJobUpdated),
    ...jobs.flatMap(job =>
      staticEntry(
        `/use-cases/by-job/${job.slug}`,
        0.7,
        'monthly',
        enOnly,
        new Date(job.lastUpdated),
      ),
    ),
  ]
}

function vsShard(): MetadataRoute.Sitemap {
  // EN-only, like use-cases: the Spanish /vs tree is discontinued and 308s
  // to EN, so no `es` alternates are advertised.
  const comparisons = getComparisons()
  const enOnly = [defaultLocale]
  return [
    ...staticEntry('/vs', 0.8, 'monthly', enOnly, latestUpdatedDate(comparisons, '2026-05-19')),
    ...comparisons.flatMap(comparison =>
      staticEntry(
        `/vs/${comparison.slug}`,
        0.7,
        'monthly',
        enOnly,
        new Date(comparison.lastUpdated),
      ),
    ),
  ]
}

// marketingEsShard removed — it only ever emitted the Spanish `/for/*`
// landers, which are part of the discontinued zero-volume ES marketing
// tree (those URLs now 308 to EN). EN `/for/*` landers still ship in the
// core shard via `getLandingPageRoutes()` + `verticalLandingRoutes()`.
//
// Tag and category pages are intentionally absent from every shard —
// they're noindexed at the route level (`robots: { index: false, follow:
// true }`) and we want them out of the sitemap so they don't compete for
// crawl budget with the canonical post URLs.

// Resolve a single shard's `<urlset>` entries. Exhaustive over `ShardId`,
// so the type checker fails the build if a shard id is added to
// `SHARD_IDS` without a matching case here.
export async function getShardEntries(id: ShardId): Promise<MetadataRoute.Sitemap> {
  switch (id) {
    case 'core':
      return coreShard()
    case 'blog-en':
      return blogShard('en')
    case 'blog-es':
      return blogShard('es-419')
    case 'guides-en':
      return guidesShard('en')
    case 'guides-es':
      return guidesShard('es-419')
    case 'vs':
      return vsShard()
    case 'use-cases':
      return useCasesShard()
  }
}
