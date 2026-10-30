import type { MetadataRoute } from 'next'

import { LANDER_ORIGIN } from '@/lib/i18n/metadata'

// Single source of truth for crawl-disallowed prefixes. Shared between the
// `*` rule and the AI-bot rules so the two cannot drift apart — historically
// they did, which produced a sitemap-vs-robots contradiction for `/from/*`
// paid-campaign landers.
//
// `/playground/*` (the visual-fixture menu) is noindexed end-to-end:
// excluded from the sitemap, disallowed here, and its layout also sets
// `robots: { index: false, follow: false }` as defense-in-depth.
const DISALLOW: string[] = ['/api/', '/l/', '/playground/']

// Marketing surfaces that are now bilingual. Each AI-bot allow block must
// list both the English and Spanish prefixes; otherwise GPTBot/ClaudeBot
// etc. only ingest English pages and the `/es/*` tree is invisible to AI
// citations.
const AI_ALLOW: string[] = [
  '/guides/',
  '/blog/',
  '/use-cases/',
  '/vs/',
  '/for/',
  // '/es/use-cases/' removed — the Spanish use-cases tree was discontinued
  // (zero Spanish search volume) and now 308s to EN; only genuinely
  // translated ES editorial (blog/guides) stays crawlable.
  '/es/guides/',
  '/es/blog/',
  // The surfaces written for these crawlers: the llms.txt index, the full
  // text behind it, and the per-page `.md` twins. They are allowed for every
  // page, not just the trees above, because the whole corpus is already
  // reviewed by the time it is rendered into markdown — and unlike the HTML
  // pages, a twin carries no navigation, no CTA, and no ad-campaign lander.
  '/llms.txt',
  '/llms-full.txt',
  '/*.md$',
]

const AI_BOTS = [
  'GPTBot',
  'ChatGPT-User',
  'PerplexityBot',
  'ClaudeBot',
  'OAI-SearchBot',
  'Google-Extended',
] as const

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: DISALLOW,
      },
      ...AI_BOTS.map(userAgent => ({
        userAgent,
        allow: AI_ALLOW,
        // Robots rules choose the longest matching path. The root disallow
        // closes the public tree by default; the longer allow prefixes open
        // only the reviewed editorial/use-case surfaces above.
        disallow: ['/', ...DISALLOW],
      })),
    ],
    sitemap: `${LANDER_ORIGIN}/sitemap.xml`,
  }
}
