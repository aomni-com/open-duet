import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { safeJsonLd } from '@/lib/json-ld'

import type { UseCasePersonaFaq } from './use-cases-spec'

type UseCasesJsonLdProps = {
  /** Persona slug — used to compose the canonical URL and the
   * BreadcrumbList @id. Use the literal `'index'` for the hub page. */
  slug: string
  /** Human-readable name for the breadcrumb leaf. */
  name: string
  /** FAQ pairs — when present we emit FAQPage. The hub page leaves
   * this empty so only the breadcrumb script ships. */
  faqs?: UseCasePersonaFaq[]
}

/**
 * Renders the JSON-LD scripts for any /use-cases surface in one place.
 * Centralizing it avoids the "FAQ schema added on one page, missing on
 * the next" drift the comparison-page SEO sweep just cleaned up
 * (PR #1217). Scripts are dropped server-side so crawlers see them on
 * first byte without waiting for hydration.
 */
export function UseCasesJsonLd({ slug, name, faqs }: UseCasesJsonLdProps) {
  const url = slug === 'index' ? `${LANDER_ORIGIN}/use-cases` : `${LANDER_ORIGIN}/use-cases/${slug}`

  // BreadcrumbList — Home › Use cases › {persona}. The hub page
  // truncates after the second crumb so Google doesn't render a
  // dangling third item.
  const breadcrumbItems = [
    {
      '@type': 'ListItem',
      position: 1,
      name: 'Home',
      item: LANDER_ORIGIN,
    },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Use cases',
      item: `${LANDER_ORIGIN}/use-cases`,
    },
  ]
  if (slug !== 'index') {
    breadcrumbItems.push({
      '@type': 'ListItem',
      position: 3,
      name,
      item: url,
    })
  }

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    '@id': `${url}#breadcrumb`,
    itemListElement: breadcrumbItems,
  }

  // FAQPage — only emitted when the persona ships a real FAQ section,
  // so the hub page stays clean (it doesn't have answers to surface).
  const faqPage =
    faqs && faqs.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          '@id': `${url}#faq`,
          mainEntity: faqs.map(f => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: {
              '@type': 'Answer',
              text: f.a,
            },
          })),
        }
      : null

  return (
    <>
      <script
        type="application/ld+json"
        // safeJsonLd escapes `<` to `\u003c` per Next.js docs so any
        // future answer text containing `</script>` can't break out of
        // the surrounding tag.
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      {faqPage ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(faqPage) }}
        />
      ) : null}
    </>
  )
}
