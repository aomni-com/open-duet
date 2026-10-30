import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { renderCampaignLander } from '@/components/landing/campaign/campaign-render-map'
import { getAllCampaignSlugs, getCampaignLander } from '@/components/landing/campaign/campaign-spec'
import { type AppLocale } from '@/lib/i18n/locales'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'

type Props = { params: Promise<{ locale: AppLocale; slug: string }> }

/**
 * Campaign landers: EN-only, noindexed alternate main landers for paid and
 * targeted traffic. `dynamicParams = false` makes any other locale or slug a
 * 404 instead of serving English copy under a mismatched URL.
 */
export const dynamicParams = false

export function generateStaticParams(): { locale: AppLocale; slug: string }[] {
  return getAllCampaignSlugs().map(slug => ({ locale: 'en' as AppLocale, slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const lander = getCampaignLander(slug)
  if (!lander) return {}
  return {
    title: lander.metaTitle,
    description: lander.metaDescription,
    robots: { index: false, follow: true },
    alternates: { canonical: `${LANDER_ORIGIN}/l/${lander.slug}` },
    openGraph: {
      title: lander.metaTitle,
      description: lander.metaDescription,
      type: 'website',
    },
  }
}

export default async function CampaignLanderPage({ params }: Props) {
  const { locale, slug } = await params
  setRequestLocale(locale)
  const lander = getCampaignLander(slug)
  if (!lander) notFound()
  return renderCampaignLander(lander)
}
