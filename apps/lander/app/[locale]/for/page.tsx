import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { VERTICALS } from '@/components/landing/for/verticals-spec'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { PrimaryCta } from '@/components/landing/landing-cta'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { Link } from '@/i18n/navigation'
import { type AppLocale } from '@/lib/i18n/locales'
import { localizedCanonical } from '@/lib/i18n/metadata'
import { productHref } from '@/src/config/origins'

const CANONICAL_PATH = '/for'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: AppLocale }>
}): Promise<Metadata> {
  const { locale } = await params
  if (locale !== 'en') return {}
  const url = localizedCanonical(CANONICAL_PATH, locale)
  const title = 'AI Coworker for Your Industry | Duet'
  const description =
    'Duet ships an AI coworker tuned for your industry. Roofers, med spas, vet practices, and more. Pick the playbook that matches your business.'
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: 'Duet',
      type: 'website',
    },
    twitter: { card: 'summary_large_image', title, description },
  }
}

export default async function ForHubPage({ params }: { params: Promise<{ locale: AppLocale }> }) {
  const { locale } = await params
  // EN-only for v1; every other locale 404s. Mirrors `dynamicParams = false`
  // on the per-vertical page so the marketing tree doesn't split canonical
  // signals while ES copy is still pending.
  if (locale !== 'en') notFound()
  setRequestLocale(locale)

  const entries = VERTICALS.map(v => ({
    slug: v.slug,
    audience: v.audience,
    eyebrow: v.eyebrow,
    blurb: v.heroSubhead,
  }))

  return (
    <LandingChrome noAmbient>
      <LandingNav sticky />
      <section className="relative isolate overflow-hidden">
        <div className="mx-auto max-w-5xl px-6 pt-28 pb-12 sm:pt-36 sm:pb-16 text-center">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-foreground/60 mb-6">
            Duet for your industry
          </p>
          <h1
            className="text-4xl sm:text-6xl font-semibold tracking-tight text-balance leading-[1.05]"
            style={serifStyle}
          >
            One AI coworker.{' '}
            <span className="italic text-foreground/85">Tuned for your trade.</span>
          </h1>
          <p className="mt-7 text-lg sm:text-xl text-foreground/70 max-w-2xl mx-auto text-balance">
            Every industry has its own playbook. Pick yours and Duet ships with the workflows,
            integrations, and voice your business already runs on.
          </p>
        </div>
      </section>
      <section className="relative">
        <div className="mx-auto max-w-6xl px-6 pb-24 sm:pb-32">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map(entry => (
              <Link
                key={entry.slug}
                href={`/for/${entry.slug}`}
                className="group relative rounded-2xl border border-foreground/10 bg-background/40 backdrop-blur-sm p-6 transition-all hover:border-foreground/25 hover:-translate-y-0.5"
              >
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-foreground/55 mb-2">
                  {entry.eyebrow}
                </p>
                <h2 className="text-xl font-semibold mb-2 text-foreground">
                  Duet for {entry.audience.toLowerCase()}
                </h2>
                <p className="text-sm text-foreground/65 leading-relaxed line-clamp-3">
                  {entry.blurb}
                </p>
                <span className="mt-5 inline-flex items-center text-sm font-medium text-foreground/80 group-hover:text-foreground">
                  See the playbook
                </span>
              </Link>
            ))}
          </div>
          <div className="mt-16 rounded-2xl border border-foreground/10 bg-background/40 backdrop-blur-sm p-8 sm:p-10 text-center">
            <h2
              className="text-2xl sm:text-3xl font-semibold tracking-tight text-balance"
              style={serifStyle}
            >
              Don’t see your industry yet?
            </h2>
            <p className="mt-3 text-base text-foreground/70 max-w-xl mx-auto">
              Duet is a general-purpose AI coworker. The industry pages are just opinionated
              starting points. Start free and tell Duet about your business; it adapts in one
              conversation.
            </p>
            <div className="mt-6 flex justify-center">
              <PrimaryCta href={productHref('/sign-in')} size="md">
                Start free
              </PrimaryCta>
            </div>
          </div>
        </div>
      </section>
      <LandingFooter />
    </LandingChrome>
  )
}
