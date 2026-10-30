import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { LandingChrome } from '@/components/landing/landing-chrome'
import { UseCasesPersonaPage } from '@/components/landing/use-cases/use-cases-persona-page'
import { getUseCasePersona } from '@/components/landing/use-cases/use-cases-spec'
import { localeMetadata, type AppLocale } from '@/lib/i18n/locales'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'

const SLUG = 'small-businesses'
const CANONICAL_PATH = `/use-cases/${SLUG}`
// Reuse the canonical brand OG image so the social card always has a
// known-good fallback; per-persona OG art can replace this later
// without changing the metadata wiring.
const OG_IMAGE = `${LANDER_ORIGIN}/landing/duet-lander-image.jpg`

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: AppLocale }>
}): Promise<Metadata> {
  const { locale } = await params
  const url = `${LANDER_ORIGIN}${localeMetadata[locale].pathPrefix}${CANONICAL_PATH}`
  const persona = getUseCasePersona(SLUG, locale)

  return persona
    ? {
        title: persona.metaTitle,
        description: persona.metaDescription,
        keywords: [persona.primaryKeyword, ...persona.secondaryKeywords],
        // Spanish variant discontinued — `/es/...` now 308s to EN
        // (isDiscontinuedEsMarketingPath), so no `es` hreflang alternate.
        alternates: {
          canonical: url,
        },
        openGraph: {
          title: persona.metaTitle,
          description: persona.metaDescription,
          url,
          type: 'website',
          locale: localeMetadata[locale].ogLocale,
          images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: `Duet — ${persona.name}` }],
        },
        twitter: {
          card: 'summary_large_image',
          title: persona.metaTitle,
          description: persona.metaDescription,
          images: [OG_IMAGE],
        },
      }
    : {}
}

export default async function SmallBusinessesUseCasesPage({
  params,
}: {
  params: Promise<{ locale: AppLocale }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  // notFound throws if the slug fell out of the spec — keeps the route
  // honest if someone deletes a persona without touching the routes.
  const persona = getUseCasePersona(SLUG, locale)
  if (!persona) notFound()
  return (
    <LandingChrome noAmbient>
      <UseCasesPersonaPage persona={persona} locale={locale} />
    </LandingChrome>
  )
}
