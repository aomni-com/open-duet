import { getAllVerticalSlugs } from '@/components/landing/for/verticals-spec'
import { getUseCaseJobs, getUseCasePersonas } from '@/components/landing/use-cases/use-cases-spec'
import { getComparison } from '@/components/landing/vs/vs-spec'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { getShardEntries, SHARD_IDS } from '@/lib/seo/sitemap-shards'

/**
 * Which body source owns a page's copy. The renderer dispatches on this, and
 * `/llms.txt` groups its index by it.
 */
export type LlmsRouteKind =
  | 'overview'
  | 'editorial'
  | 'vertical'
  | 'use-case'
  | 'comparison'
  | 'marketing'

export type LlmsRoute = {
  /** Public English path, e.g. `/guides/foo`. Never locale-prefixed. */
  path: string
  kind: LlmsRouteKind
}

/**
 * `/install` is the one agent-facing page deliberately kept out of the
 * sitemap (it is a CLI pairing runbook, not a search surface), so it is the
 * single hand-added entry. Everything else is derived.
 */
const UNSITEMAPPED_PATHS = ['/install'] as const

let routesCache: LlmsRoute[] | undefined

/**
 * The pages the agent-readable surfaces cover.
 *
 * Derived from the sitemap shards rather than re-listed, because the shards
 * are already the curated answer to "which English URLs are real, indexable
 * content" — they exclude the noindexed trees (`/vs/*`, blog tags and
 * categories, `/from/*` ad landers) and the discontinued Spanish marketing
 * tree on purpose. Re-enumerating here would create a second owner that
 * drifts silently: an llms.txt is only useful if it agrees with the site.
 *
 * Spanish is excluded outright. Untranslated `/es` pages render the English
 * body under a Spanish URL (see `getPostsFromDirectory`), so emitting twins
 * would file English prose under `/es` — the exact duplicate an llms.txt
 * consumer has no way to detect.
 */
export async function getLlmsRoutes(): Promise<LlmsRoute[]> {
  if (routesCache !== undefined) return routesCache
  const paths = new Set<string>(UNSITEMAPPED_PATHS)
  for (const id of SHARD_IDS) {
    for (const entry of await getShardEntries(id)) {
      const path = entry.url.slice(LANDER_ORIGIN.length)
      if (path === '/es' || path.startsWith('/es/')) continue
      paths.add(path)
    }
  }
  routesCache = [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map(path => ({ path, kind: classify(path) }))
  return routesCache
}

/**
 * Membership is asked of the specs themselves, not inferred from the URL
 * shape, so a hand-built page that merely resembles a config-driven tree
 * never gets sent to a renderer with nothing to read.
 */
function classify(path: string): LlmsRouteKind {
  if (path === '/') return 'overview'
  if (/^\/(?:blog|guides)\/[^/]+$/.test(path)) return 'editorial'

  const vertical = /^\/for\/([^/]+)$/.exec(path)?.[1]
  if (vertical !== undefined && getAllVerticalSlugs().includes(vertical)) return 'vertical'

  const useCase = /^\/use-cases\/(.+)$/.exec(path)?.[1]
  if (useCase !== undefined && isRenderableUseCase(useCase)) return 'use-case'

  const comparison = /^\/vs\/([^/]+)$/.exec(path)?.[1]
  if (comparison !== undefined && getComparison(comparison) !== undefined) return 'comparison'

  return 'marketing'
}

function isRenderableUseCase(suffix: string): boolean {
  const [head, tail] = suffix.split('/')
  if (head === 'by-job') {
    return tail !== undefined && getUseCaseJobs().some(job => job.slug === tail)
  }
  const persona = getUseCasePersonas().find(candidate => candidate.slug === head)
  if (persona === undefined) return false
  return tail === undefined || persona.leaves.some(leaf => leaf.slug === tail)
}
