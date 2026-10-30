import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'

import { HOME_COPY } from '@/components/landing/landers/home-copy'
import { HomeLanding } from '@/components/landing/landers/home-landing'
import type { AppLocale } from '@/lib/i18n/locales'
import { buildLocalizedMetadata } from '@/lib/i18n/metadata'
import { safeJsonLd } from '@/lib/json-ld'
import { homeJsonLd } from '@/lib/seo/home-json-ld'

type Props = { params: Promise<{ locale: AppLocale }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params
  const copy = HOME_COPY[locale]
  return buildLocalizedMetadata({
    locale,
    path: '/',
    title: copy.title,
    description: copy.description,
  })
}

/** The homepage is the main lander in every locale: one page, one promise,
 * with the copy chosen by the URL. */
export default async function Home({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(homeJsonLd(locale)) }}
      />
      <HomeLanding locale={locale} />
    </>
  )
}
