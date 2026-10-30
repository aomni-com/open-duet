import { CheckCircleIcon } from '@phosphor-icons/react/dist/ssr'
import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'
import Image from 'next/image'
import { notFound } from 'next/navigation'

import { cn } from '@repo/ui/lib/utils'

import { LandingComposeMock } from '@/components/landing/for/landing-compose-mock'
import {
  getAllVerticalSlugs,
  getVertical,
  type VerticalSpec,
} from '@/components/landing/for/verticals-spec'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { PrimaryCta } from '@/components/landing/landing-cta'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { LandingNavFrost } from '@/components/landing/landing-nav-frost'
import { serifStyle } from '@/components/landing/landing-styles'
import { Link } from '@/i18n/navigation'
import { type AppLocale } from '@/lib/i18n/locales'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { localizedCanonical } from '@/lib/i18n/metadata'
import { safeJsonLd } from '@/lib/json-ld'
import { productHref } from '@/src/config/origins'

const OG_IMAGE = `${LANDER_ORIGIN}/landing/duet-lander-image.jpg`

type Params = { locale: AppLocale; vertical: string }
type Props = { params: Promise<Params> }

/**
 * Pre-render every config-driven vertical at build time. The set is
 * small and stable, and these pages have to be edge-cacheable for SEO,
 * so fully static beats ISR. EN only for v1; ES rollout is a follow-up
 * that just needs ES copy on each spec entry.
 *
 * `dynamicParams = false` so any request that isn't in the pre-rendered
 * set (e.g. `/es/for/roofers` while ES copy doesn't exist yet, or a
 * mistyped slug like `/for/roofer`) returns 404 instead of dynamically
 * rendering English copy under a Spanish canonical, which would split
 * canonical signals across locales.
 */
export const dynamicParams = false

export function generateStaticParams(): Params[] {
  return getAllVerticalSlugs().map(vertical => ({ locale: 'en' as const, vertical }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, vertical } = await params
  const spec = getVertical(vertical)
  if (!spec) return {}
  const canonical = localizedCanonical(`/for/${spec.slug}`, locale)
  return {
    title: spec.metaTitle,
    description: spec.metaDescription,
    alternates: { canonical },
    openGraph: {
      title: spec.metaTitle,
      description: spec.metaDescription,
      url: canonical,
      siteName: 'Duet',
      type: 'website',
      images: [{ url: OG_IMAGE }],
    },
    twitter: {
      card: 'summary_large_image',
      title: spec.metaTitle,
      description: spec.metaDescription,
      images: [OG_IMAGE],
    },
  }
}

export default async function VerticalLandingPage({ params }: Props) {
  const { locale, vertical } = await params
  setRequestLocale(locale)
  const spec = getVertical(vertical)
  if (!spec) notFound()

  const signupHref = productHref(`/sign-in?vertical=${spec.slug}`)

  return (
    <LandingChrome noAmbient>
      <FaqJsonLd spec={spec} locale={locale} />
      <LandingNavFrost>
        <LandingNav />
      </LandingNavFrost>
      <Hero spec={spec} signupHref={signupHref} />
      <Outcomes spec={spec} />
      <Kickoff spec={spec} signupHref={signupHref} />
      <Faqs spec={spec} />
      <FinalCta spec={spec} signupHref={signupHref} />
      <LandingFooter />
    </LandingChrome>
  )
}

function Hero({ spec, signupHref }: { spec: VerticalSpec; signupHref: string }) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-7xl px-6 pt-16 pb-20 sm:pt-20 sm:pb-24 lg:pt-24 lg:pb-28">
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
          {/* Left: copy + CTAs */}
          <div>
            <p
              className={cn(
                'text-sm font-medium uppercase tracking-[0.18em] mb-6',
                spec.accent.eyebrow,
              )}
            >
              {spec.eyebrow}
            </p>
            <h1
              className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight text-balance leading-[1.05]"
              style={serifStyle}
            >
              {spec.heroLead}{' '}
              <span className="block italic text-foreground/85">{spec.heroHighlight}</span>
            </h1>
            <p className="mt-7 text-base sm:text-lg text-foreground/70 max-w-xl text-balance">
              {spec.heroSubhead}
            </p>
            <div className="mt-9 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              {/* Sized just one notch above the nav's "Start free" pill
                  so the hero CTA reads as the same button family but
                  carries a touch more visual weight in the hero. */}
              <PrimaryCta href={signupHref} size="sm" className="px-7 py-3 text-[15px]">
                Start free
              </PrimaryCta>
              <Link
                href="/use-cases"
                className="text-sm font-medium text-foreground/70 hover:text-foreground transition-colors"
              >
                Read all use cases
              </Link>
            </div>
            <p className="mt-5 text-xs text-foreground/50">
              Free to start. No credit card required.
            </p>
          </div>

          {/* Right: hero image card. Falls back to an accent-tinted gradient
              for verticals without a scene image yet. The aspect ratio is
              per-vertical (from `spec.heroImage.aspect`) so each vertical's
              source ratio (wide 16:10 for roofers, 1:1 for med-spas and vet)
              is preserved without cropping the subject. */}
          <div
            className={cn(
              'relative overflow-hidden rounded-3xl border border-foreground/5 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.25)]',
              spec.heroImage?.aspect ?? 'aspect-[16/10]',
              !spec.heroImage && 'bg-background/40',
            )}
          >
            {spec.heroImage ? (
              <Image
                src={spec.heroImage.src}
                alt={spec.heroImage.alt}
                fill
                priority
                sizes="(min-width: 1024px) 50vw, 100vw"
                className="object-cover"
              />
            ) : (
              <div
                aria-hidden="true"
                className={cn('absolute inset-0 bg-gradient-to-br opacity-90', spec.accent.glow)}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function Outcomes({ spec }: { spec: VerticalSpec }) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-7xl px-6 py-20 sm:py-28">
        <div className="max-w-2xl mb-12">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-foreground/60 mb-3">
            What it does
          </p>
          <h2
            className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-balance"
            style={serifStyle}
          >
            The work {spec.audience.toLowerCase()} hand off to Duet.
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {spec.outcomes.map(outcome => {
            const Icon = outcome.Icon
            return (
              <div
                key={outcome.title}
                className="group relative rounded-2xl border border-foreground/10 bg-background/40 backdrop-blur-sm p-6 transition-colors hover:border-foreground/20"
              >
                <Icon
                  weight="duotone"
                  className="size-7 text-foreground/80 mb-4"
                  aria-hidden="true"
                />
                <h3 className="text-base font-semibold mb-2 text-foreground">{outcome.title}</h3>
                <p className="text-sm text-foreground/65 leading-relaxed">{outcome.body}</p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function Kickoff({ spec, signupHref }: { spec: VerticalSpec; signupHref: string }) {
  return (
    // Tinted band gives this section visual separation from the
    // neutral sections above and below. `bg-lv2-band-cool` is the same
    // landing token used by MeetDuet on the home page.
    <section className="relative bg-lv2-band-cool">
      <div className="mx-auto max-w-4xl px-6 py-20 sm:py-28">
        <div className="text-center mb-10">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-foreground/60 mb-4">
            Day one
          </p>
          <h2
            className="text-3xl sm:text-4xl lg:text-5xl italic font-normal tracking-tight text-balance text-foreground"
            style={serifStyle}
          >
            What should we automate today?
          </h2>
        </div>
        <LandingComposeMock value={spec.kickoffPrompt} signupHref={signupHref} />
      </div>
    </section>
  )
}

function Faqs({ spec }: { spec: VerticalSpec }) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-3xl px-6 py-20 sm:py-28">
        <div className="text-center mb-10">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-foreground/60 mb-3">
            FAQ
          </p>
          <h2
            className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-balance"
            style={serifStyle}
          >
            Questions {spec.audience.toLowerCase()} ask first.
          </h2>
        </div>
        <div className="divide-y divide-foreground/10 border-y border-foreground/10">
          {spec.faqs.map(faq => (
            <details key={faq.q} className="group py-5 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 text-base font-medium text-foreground">
                {faq.q}
                <span
                  aria-hidden="true"
                  className="mt-1 inline-block transition-transform group-open:rotate-45 text-foreground/50"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm text-foreground/70 leading-relaxed">{faq.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

function FinalCta({ spec, signupHref }: { spec: VerticalSpec; signupHref: string }) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-4xl px-6 py-24 sm:py-32 text-center">
        <h2
          className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-balance"
          style={serifStyle}
        >
          Hire an AI coworker for your{' '}
          <span className="italic text-foreground/85">{spec.audience.toLowerCase()}</span> this
          week.
        </h2>
        <p className="mt-5 text-base sm:text-lg text-foreground/70 max-w-xl mx-auto">
          One workspace. One teammate. The work compounds from day one.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
          {/* Matches the hero "Start free" pill (size="sm" with the same
              padding/text override) so the page's two primary CTAs read
              as one button at one scale. */}
          <PrimaryCta href={signupHref} size="sm" className="px-7 py-3 text-[15px]">
            Start free
          </PrimaryCta>
        </div>
        <ul className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-foreground/55">
          {['Free to start', 'No credit card', 'Cancel anytime'].map(item => (
            <li key={item} className="inline-flex items-center gap-1.5">
              <CheckCircleIcon weight="fill" className="size-3.5" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/**
 * FAQPage JSON-LD. Google AI Overview and Perplexity actively cite FAQ
 * schema for "AI for X" queries, so this is the highest-leverage
 * structured data on the page.
 */
function FaqJsonLd({ spec, locale }: { spec: VerticalSpec; locale: AppLocale }) {
  const payload = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${localizedCanonical(`/for/${spec.slug}`, locale)}#faq`,
    mainEntity: spec.faqs.map(faq => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: { '@type': 'Answer', text: faq.a },
    })),
  }
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: safeJsonLd(payload) }}
    />
  )
}
