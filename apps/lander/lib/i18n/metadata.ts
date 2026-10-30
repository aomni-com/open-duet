import type { Metadata } from 'next'

import { BRAND_NAME, BRAND_TWITTER_HANDLE } from '@/lib/brand-copy'
import { resolveConfiguredLanderOrigin } from '@/src/config/origins'

import { type AppLocale, defaultLocale, localeMetadata, localizePath } from './locales'

export const LANDER_ORIGIN = resolveConfiguredLanderOrigin()

export type LocalizedMetadataInput = {
  locale: AppLocale
  path: string
  title: string
  description: string
  image?: string
  type?: 'website' | 'article'
  translatedLocales?: AppLocale[]
  noIndex?: boolean
}

function absoluteUrl(path: string): string {
  if (path.startsWith('http')) return path
  return `${LANDER_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`
}

export function localizedCanonical(path: string, locale: AppLocale): string {
  return absoluteUrl(localizePath(path, locale))
}

export function buildLocalizedMetadata({
  locale,
  path,
  title,
  description,
  image = '/landing/duet-lander-image.jpg',
  type = 'website',
  translatedLocales = [defaultLocale, 'es-419'],
  noIndex,
}: LocalizedMetadataInput): Metadata {
  const url = localizedCanonical(path, locale)
  const imageUrl = absoluteUrl(image)

  return {
    title,
    description,
    alternates: {
      canonical: url,
      languages: {
        ...Object.fromEntries(
          translatedLocales.map(l => [localeMetadata[l].hreflang, localizedCanonical(path, l)]),
        ),
        // x-default points crawlers at the default-locale URL when no
        // language matches the user — Google's recommended catch-all.
        'x-default': localizedCanonical(path, defaultLocale),
      },
    },
    robots: noIndex ? { index: false, follow: false } : undefined,
    openGraph: {
      title,
      description,
      url,
      siteName: BRAND_NAME,
      type,
      locale: localeMetadata[locale].ogLocale,
      alternateLocale: translatedLocales
        .filter(l => l !== locale)
        .map(l => localeMetadata[l].ogLocale),
      images: [{ url: imageUrl, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      site: BRAND_TWITTER_HANDLE,
      creator: BRAND_TWITTER_HANDLE,
      images: [imageUrl],
    },
  }
}
