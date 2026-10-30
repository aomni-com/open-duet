/**
 * Centralized brand copy — single source of truth for taglines, descriptions,
 * and meta text used across the lander, OG images, sign-in page, etc.
 */

import { defaultLocale, type AppLocale } from '@/lib/i18n/locales'

export const BRAND_NAME = 'Duet'

/**
 * Locale-keyed brand tagline. The English form is the default and is
 * re-exported as `BRAND_TAGLINE` for callers that don't yet have a
 * locale in scope (layout metadata, OG images, lander). UI surfaces
 * that *do* have a locale should call `getBrandTagline(locale)` so
 * Spanish visitors see the Spanish line instead of the English one.
 */
export const BRAND_TAGLINES: Record<AppLocale, string> = {
  en: "Run your business. We'll handle the AI.",
  'es-419': 'Opera tu negocio. Nosotros nos encargamos de la AI.',
}

export function getBrandTagline(locale: AppLocale): string {
  return BRAND_TAGLINES[locale] ?? BRAND_TAGLINES[defaultLocale]
}

export const BRAND_TAGLINE = BRAND_TAGLINES[defaultLocale]

// ~155 chars — keeps Google from truncating the SERP snippet.
export const BRAND_DESCRIPTION =
  'Duet is the always-on AI hire that drafts your replies, runs the research, ships brand-perfect decks, and builds the tools to run your business.'

export const BRAND_META_TITLE = `${BRAND_NAME} — ${BRAND_TAGLINE}`

export const BRAND_DESCRIPTION_SHORT = 'The AI hire that runs your business.'

/**
 * Social handles — used for Twitter card `site` / `creator` attribution
 * and consumed by JSON-LD `sameAs`. Include the leading `@` so they can
 * be passed straight into Next.js Metadata.
 */
export const BRAND_TWITTER_HANDLE = '@duetchat'
