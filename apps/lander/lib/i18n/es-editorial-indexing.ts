/**
 * `/es` editorial (blog + guides) indexing policy
 * -----------------------------------------------
 * A May 2026 DataForSEO re-audit (language_code=es) re-scored all 59
 * translated `/es/{blog,guides}` pages against real Spanish search demand.
 * Most were a literal translation of the English keyword matrix ("IA para
 * equipos de ventas") rather than how Spanish speakers actually search, earn
 * ~0 Spanish impressions, and so the tree sat in "Crawled - currently not
 * indexed". Three buckets came out of it:
 *
 *   - KEEP (default, not listed here): genuine Spanish demand. No change — the
 *     EN original keeps its `es` hreflang alternate and the page stays in the
 *     `blog-es` / `guides-es` sitemap shard.
 *   - REDIRECT (308 → EN): zero Spanish demand but real *English* demand for
 *     the same topic. The EN page is the natural ranker, so the `/es`
 *     duplicate permanently redirects into it (see `isConsolidatedEsEditorialPath`
 *     in `path-classification.ts`) and never renders. NOT noindexed — the
 *     redirect supersedes.
 *   - NOINDEX (noindex,follow): dead in both languages (or English-floor
 *     only). The es-419 variant is de-indexed via `generateMetadata` but stays
 *     crawlable so Google can read the tag — NEVER pair with a robots.txt
 *     disallow. The EN original stays indexed.
 *
 * Both REDIRECT and NOINDEX pages are pulled from the `blog-es` / `guides-es`
 * sitemap shards and have their `es` entry dropped from the EN original's
 * hreflang cluster (`isEsHreflangSuppressedSlug`), so we never advertise a
 * non-indexable alternate. Reversible by construction — nothing is deleted,
 * only annotated. `es-419` is the only non-default locale, so suppression only
 * ever drops the `es` variant; the EN original is always retained.
 */

export type EsEditorialKind = 'blog' | 'guides'

// Bucket B — 308 → EN canonical. Zero ES demand, real EN demand for the topic.
export const ES_REDIRECT_BLOG_SLUGS = [
  'claude-code-vs-cursor-vs-codex',
  'codex-vs-claude-code',
  'claude-opus-4-7-gpt-5-4-extended-thinking-duet',
] as const

export const ES_REDIRECT_GUIDE_SLUGS = [
  'ai-search-discovery-ethical-playbook',
  'claude-cowork-for-beginners',
  'claude-code-skills-complete-guide',
  'duet-ai-for-founders',
  'claude-code-vs-claude-cowork',
] as const

// Bucket C — noindex,follow. Dead in both languages (ES-TOTAL 0 and en-US ≤ 10).
export const ES_NOINDEX_BLOG_SLUGS = [
  'openclaw-vs-managed-ai-agent-platforms',
  'how-to-set-up-ai-customer-service-small-business',
  'claude-code-pricing',
  'how-to-use-ai-to-run-startup-operations-with-a-3-person-team',
  '6-best-ai-agent-builders-in-2026',
  'how-to-scrape-analyze-and-monitor-any-website',
  'how-to-set-up-a-24-7-ai-agent',
  'mcp-alternatives-code-execution-agents',
  'how-to-run-claude-code-in-the-cloud',
  'how-to-generate-branded-social-media-content-at-scale',
  'how-to-use-ai-to-write-sales-emails-that-get-replies',
  'how-to-build-client-analytics-dashboard-without-developer',
  'duet-vs-claude-for-small-business',
  'how-to-scale-marketing-agency-without-hiring',
  'how-to-use-ai-for-market-research-before-launch',
  'how-duet-builds-and-evals-context-graphs',
  'how-we-turned-github-history-into-automated-newsletter',
  'how-to-set-up-ai-sales-prospecting-startups',
] as const

export const ES_NOINDEX_GUIDE_SLUGS = [
  'beyond-claude-code-building-a-shared-skill-library',
  'how-to-cut-rekeying-in-carrier-portals',
  'how-to-build-your-ai-command-center',
  'claude-code-for-founders',
  'claude-code-playbook-building-a-skill-first-workflow-that-actually-sticks',
  'how-to-set-up-openclaw-for-your-team',
  'client-emails-renewal-follow-ups-faster-with-ai',
  'duet-vs-claude-code',
  'duet-vs-codex',
  'duet-vs-conductor',
  'duet-vs-openclaw',
  'acord-forms-commercial-quote-prep-with-ai',
  'agent-skills-101-tools-vs-mcp-vs-skills',
] as const

const REDIRECT_SLUGS: Record<EsEditorialKind, ReadonlySet<string>> = {
  blog: new Set(ES_REDIRECT_BLOG_SLUGS),
  guides: new Set(ES_REDIRECT_GUIDE_SLUGS),
}

const NOINDEX_SLUGS: Record<EsEditorialKind, ReadonlySet<string>> = {
  blog: new Set(ES_NOINDEX_BLOG_SLUGS),
  guides: new Set(ES_NOINDEX_GUIDE_SLUGS),
}

/** Bucket B: the es-419 variant 308-redirects to its EN canonical. */
export function isRedirectedEsEditorialSlug(kind: EsEditorialKind, slug: string): boolean {
  return REDIRECT_SLUGS[kind].has(slug)
}

/** Bucket C: the es-419 variant is `noindex,follow` (EN original stays indexed). */
export function isNoindexedEsEditorialSlug(kind: EsEditorialKind, slug: string): boolean {
  return NOINDEX_SLUGS[kind].has(slug)
}

/**
 * True when the es-419 variant of this editorial page must NOT advertise an
 * `es` hreflang and must be dropped from the ES sitemap shard — i.e. it's
 * either redirected (B) or noindexed (C). Only the es-419 variant is ever
 * suppressed; the EN original is always retained.
 */
export function isEsHreflangSuppressedSlug(kind: EsEditorialKind, slug: string): boolean {
  return isRedirectedEsEditorialSlug(kind, slug) || isNoindexedEsEditorialSlug(kind, slug)
}
