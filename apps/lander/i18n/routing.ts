import { defineRouting } from 'next-intl/routing'

import { DUET_LOCALES, type DuetLocale } from '@repo/web-locale'

export const locales = DUET_LOCALES
export type AppLocale = DuetLocale
export const defaultLocale: AppLocale = 'en'

export const localeLabels: Record<AppLocale, string> = {
  en: 'English',
  'es-419': 'Español',
}

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: {
    mode: 'as-needed',
    prefixes: { 'es-419': '/es' },
  },
  // Locale is driven purely by URL prefix. No `Accept-Language` redirects
  // (which would fragment AI-citation attribution by sending Spanish-
  // accept-language crawlers from canonical English URLs to /es/*), and
  // no locale cookie write on every response (any Set-Cookie
  // forces Vercel to mark the response uncacheable, killing the
  // marketing CDN). Explicit locale switches persist through the shared
  // browser cookie contract instead.
  localeDetection: false,
  localeCookie: false,
})
