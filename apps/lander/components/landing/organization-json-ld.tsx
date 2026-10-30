/**
 * Organization JSON-LD emitted on every page via the root layout.
 *
 * Why this lives at the layout level (and not just the home page):
 * Google needs a stable Organization entity to disambiguate "Duet"
 * from collisions with the dating app and other brands. Surfacing
 * the Organization schema on every URL — instead of only `/` —
 * makes that entity easier to attach to any page that ranks first,
 * which is especially important for the new `/use-cases/*` and
 * `/vs/*` clusters where AI Overviews tend to enter the site.
 *
 * Note: the lander home page also emits a richer
 * `@graph` with SoftwareApplication + Offer for rich-result eligibility.
 * Both blocks share the same `@id` (`${LANDER_ORIGIN}/#organization`),
 * so search engines deduplicate them into a single Organization node.
 *
 * The description and `sameAs` are read from the homepage's own sources, so
 * the brand entity tells the same story on every URL.
 */

import { HOME_COPY } from '@/components/landing/landers/home-copy'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { safeJsonLd } from '@/lib/json-ld'
import { ORGANIZATION_SAME_AS } from '@/lib/seo/home-json-ld'

export const ORGANIZATION_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${LANDER_ORIGIN}/#organization`,
  name: 'Duet',
  alternateName: ['Duet AI'],
  url: LANDER_ORIGIN,
  logo: `${LANDER_ORIGIN}/icons/icon-512.png`,
  description: HOME_COPY.en.description,
  sameAs: ORGANIZATION_SAME_AS,
}

export function OrganizationJsonLd() {
  return (
    <script
      type="application/ld+json"
      // safeJsonLd escapes `<` to `\u003c` per Next.js docs so a future
      // schema field containing `</script>` can never break out of the
      // surrounding tag.
      dangerouslySetInnerHTML={{ __html: safeJsonLd(ORGANIZATION_JSON_LD) }}
      // PostHog's bootloader prepends its own `<script>` to `<body>`
      // during `posthog.init()` in instrumentation-client.ts, which
      // shifts the position React expects for this node and trips a
      // dev-only hydration mismatch warning. The script is identical
      // on server and client; it's just the sibling order PostHog
      // mutates pre-hydration, so suppressing the warning here is safe.
      suppressHydrationWarning
    />
  )
}
