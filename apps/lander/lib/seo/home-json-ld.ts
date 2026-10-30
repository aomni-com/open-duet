import { HOME_COPY } from '@/components/landing/landers/home-copy'
import { BRAND_NAME } from '@/lib/brand-copy'
import type { AppLocale } from '@/lib/i18n/locales'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { PUBLIC_SUBSCRIPTION_PLANS, SUPPORT_EMAIL } from '@/lib/public-site-config'

/** Verified social profiles, shared with the site-wide Organization block so
 * the entity's `sameAs` cannot drift between pages. */
export const ORGANIZATION_SAME_AS = [
  'https://www.linkedin.com/company/duet-so',
  'https://github.com/aomni-com',
  'https://x.com/duetchat',
] as const

/**
 * The homepage's JSON-LD graph: the brand (Organization, SoftwareApplication,
 * WebSite) and the page itself (WebPage, FAQPage), all read from the same
 * copy the page renders so the structured data cannot tell a different story.
 *
 * The offer is the plan range from the contract, linked to the pricing page.
 * The homepage advertises the self-serve trial through the same copy used by
 * the rendered page, while plan details remain owned by the contract.
 */
export function homeJsonLd(locale: AppLocale) {
  const copy = HOME_COPY[locale]
  const inLanguage = locale === 'es-419' ? 'es-419' : 'en-US'
  const home = locale === 'es-419' ? `${LANDER_ORIGIN}/es` : LANDER_ORIGIN
  const prices = PUBLIC_SUBSCRIPTION_PLANS.map(plan => Number(plan.monthlyPrice.slice(1)))

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${LANDER_ORIGIN}/#organization`,
        name: BRAND_NAME,
        url: LANDER_ORIGIN,
        logo: {
          '@type': 'ImageObject',
          url: `${LANDER_ORIGIN}/icons/icon-512.png`,
          width: 512,
          height: 512,
        },
        description: copy.description,
        foundingDate: '2024',
        email: SUPPORT_EMAIL,
        sameAs: ORGANIZATION_SAME_AS,
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${LANDER_ORIGIN}/#software`,
        name: BRAND_NAME,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, iOS, Android',
        description: copy.description,
        url: LANDER_ORIGIN,
        image: `${LANDER_ORIGIN}/landing/duet-lander-image.jpg`,
        publisher: { '@id': `${LANDER_ORIGIN}/#organization` },
        featureList: copy.featureList,
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency: 'USD',
          lowPrice: String(Math.min(...prices)),
          highPrice: String(Math.max(...prices)),
          offerCount: prices.length,
          url: `${home}/pricing`,
        },
      },
      {
        '@type': 'WebSite',
        '@id': `${LANDER_ORIGIN}/#website`,
        name: BRAND_NAME,
        alternateName: 'Duet by Aomni',
        url: LANDER_ORIGIN,
        inLanguage,
        publisher: { '@id': `${LANDER_ORIGIN}/#organization` },
      },
      {
        '@type': 'WebPage',
        '@id': `${home}/#webpage`,
        url: home,
        name: copy.title,
        description: copy.description,
        inLanguage,
        isPartOf: { '@id': `${LANDER_ORIGIN}/#website` },
        about: { '@id': `${LANDER_ORIGIN}/#software` },
        primaryImageOfPage: `${LANDER_ORIGIN}/landing/duet-lander-image.jpg`,
      },
      {
        '@type': 'FAQPage',
        '@id': `${home}/#faq`,
        inLanguage,
        mainEntity: copy.faq.items.map(({ q, a }) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a },
        })),
      },
    ],
  }
}
