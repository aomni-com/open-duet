import { ArrowRight } from '@phosphor-icons/react/dist/ssr'
import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'

import { ThemedImage } from '@/components/blog/themed-image'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFinalCta } from '@/components/landing/landing-final-cta'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { RevealItem, SectionReveal } from '@/components/landing/section-reveal'
import { Link } from '@/i18n/navigation'
import { getAllGuides } from '@/lib/blog/content'
import { generateGuidesCollectionJsonLd } from '@/lib/blog/seo'
import type { Post } from '@/lib/blog/types'
import type { AppLocale } from '@/lib/i18n/locales'
import { buildLocalizedMetadata } from '@/lib/i18n/metadata'
import { listingCopy } from '@/lib/i18n/page-copy'

type Props = { params: Promise<{ locale: AppLocale }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params
  const copy = listingCopy.guides[locale]
  return buildLocalizedMetadata({
    locale,
    path: '/guides',
    title: copy.title,
    description: copy.description,
  })
}

export default async function GuidesPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = listingCopy.guides[locale]
  const guides = getAllGuides(locale)
  const collectionJsonLd = generateGuidesCollectionJsonLd(guides, locale)

  return (
    <LandingChrome noAmbient>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }}
      />
      <LandingNav sticky />
      <main className="mx-auto max-w-6xl px-4 pb-12 pt-16 sm:px-6 md:pt-24">
        <SectionReveal className="mb-16 max-w-3xl">
          <RevealItem>
            <p className="mb-5 text-[11px] uppercase tracking-[0.3em] text-white/55">
              {copy.eyebrow}
            </p>
          </RevealItem>
          <RevealItem>
            <h1
              className="mb-5 text-5xl font-normal leading-[1] tracking-[-1.5px] text-white md:text-7xl"
              style={serifStyle}
            >
              {copy.headingLead} <em className="not-italic text-white/70">{copy.headingTrail}</em>
            </h1>
          </RevealItem>
          <RevealItem>
            <p className="text-lg leading-relaxed text-white/75">{copy.body}</p>
          </RevealItem>
        </SectionReveal>

        {guides.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-white/65">{copy.empty}</p>
          </div>
        ) : (
          <div className="space-y-8">
            <div className="grid gap-6 md:grid-cols-2">
              {guides.slice(0, 2).map(guide => (
                <GuideCard key={guide.slug} guide={guide} featured label={copy.label} />
              ))}
            </div>
            {guides.length > 2 && (
              <div className="grid gap-6 md:grid-cols-2">
                {guides.slice(2).map(guide => (
                  <GuideCard key={guide.slug} guide={guide} label={copy.label} />
                ))}
              </div>
            )}
          </div>
        )}
      </main>
      <LandingFinalCta
        serifStyle={serifStyle}
        headingLead={copy.ctaLead}
        headingTrail={copy.ctaTrail}
        description={copy.ctaDescription}
        primaryLabel={copy.primary}
        secondary={{ label: copy.secondary, href: '/blog' }}
      />
      <LandingFooter />
    </LandingChrome>
  )
}

function GuideCard({ guide, featured, label }: { guide: Post; featured?: boolean; label: string }) {
  return (
    <Link
      href={`/guides/${guide.slug}`}
      className="liquid-glass group block overflow-hidden rounded-3xl transition-transform duration-300 hover:-translate-y-0.5"
    >
      {guide.image && (
        <div className="relative aspect-[1200/630] w-full overflow-hidden">
          <ThemedImage
            src={guide.image}
            alt={guide.title}
            fill
            className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(to top, color-mix(in oklab, var(--lv2-bg) 70%, transparent), transparent 60%)',
            }}
          />
        </div>
      )}
      <div className="p-7">
        <div className="mb-4 flex items-center gap-2">
          <span className="rounded-full border border-[hsl(214_65%_50%/0.3)] bg-[hsl(214_65%_50%/0.12)] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[hsl(214_65%_50%)]">
            {label}
          </span>
          <span className="text-xs text-white/55">{guide.readingTime}</span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h2
              className={`mb-2 font-normal leading-[1.1] tracking-[-0.5px] text-white ${featured ? 'text-2xl md:text-3xl' : 'text-xl'}`}
              style={serifStyle}
            >
              {guide.title}
            </h2>
            <p className="line-clamp-2 text-sm text-white/70">{guide.description}</p>
          </div>
          <ArrowRight
            className="mt-1 h-5 w-5 shrink-0 text-white/55 transition-all group-hover:translate-x-1 group-hover:text-white"
            weight="bold"
          />
        </div>
      </div>
    </Link>
  )
}
