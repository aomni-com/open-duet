import { LANDER_ORIGIN } from '@/lib/i18n/metadata'

import { mdTwinPath } from './md-url'

/**
 * Small builders shared by every renderer, so heading depth and link shape
 * are decided once. An llms.txt consumer reads the whole corpus as one
 * document; inconsistent heading levels between a spec page and an article
 * make the hierarchy meaningless.
 */

/**
 * Shared by `/llms.txt`, `/llms-full.txt`, and every `.md` twin. All three are
 * prerendered from the same corpus, so they should not be able to disagree
 * about how long an edge may hold them.
 */
export const AGENT_TEXT_CACHE_CONTROL =
  'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400'

export function absoluteUrl(path: string): string {
  return `${LANDER_ORIGIN}${path === '/' ? '' : path}`
}

export function heading(text: string, level = 1): string {
  return `${'#'.repeat(level)} ${text}`
}

/**
 * Meta titles end in a brand suffix so a SERP result is attributable. Inside
 * a document whose own H1 is already "Duet", "Pricing — Duet" reads as a
 * scraped tag rather than a title.
 */
export function stripBrandSuffix(title: string): string {
  return title.replace(/\s*[|—-]\s*Duet\s*$/, '')
}

export function section(title: string, body: string, level = 2): string {
  return `${heading(title, level)}\n\n${body}`
}

export function faqSection(
  title: string,
  faqs: ReadonlyArray<{ q: string; a: string }>,
  level = 2,
): string {
  return section(
    title,
    faqs.map(faq => `${heading(faq.q, level + 1)}\n\n${faq.a}`).join('\n\n'),
    level,
  )
}

export function steps(items: ReadonlyArray<{ title: string; body: string }>): string {
  return items.map((item, index) => `${index + 1}. **${item.title}** — ${item.body}`).join('\n')
}

export function bullets(items: readonly string[]): string {
  return items.map(item => `- ${item}`).join('\n')
}

/**
 * Every listed page is linked at its `.md` twin, not at the page itself. The
 * reader of these documents is an AI crawler, and `app/robots.ts` allows that
 * reader `*.md` everywhere while allowing the styled pages only in the
 * editorial trees — so a link to the page is a link most of these readers are
 * not permitted to follow.
 */
export function linkList(
  items: ReadonlyArray<{ path: string; title: string; description: string }>,
): string {
  return items
    .map(item => `- [${item.title}](${absoluteUrl(mdTwinPath(item.path))}): ${item.description}`)
    .join('\n')
}
