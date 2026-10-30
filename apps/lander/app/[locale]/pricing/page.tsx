import { Brain, Cloud, Database, Plugs } from '@phosphor-icons/react/dist/ssr'
import type { Metadata } from 'next'
import { useTranslations } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'

import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFinalCta } from '@/components/landing/landing-final-cta'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { PricingFaq } from '@/components/landing/pricing/pricing-faq'
import { PricingTiers } from '@/components/landing/pricing/pricing-tiers'
import { Link } from '@/i18n/navigation'
import type { AppLocale } from '@/lib/i18n/locales'
import { buildLocalizedMetadata } from '@/lib/i18n/metadata'
import { pricingCopy } from '@/lib/i18n/page-copy'
import { TRIAL_DAYS } from '@/lib/public-site-config'
import { productHref } from '@/src/config/origins'

type Props = { params: Promise<{ locale: AppLocale }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params
  const copy = pricingCopy[locale]
  return buildLocalizedMetadata({
    locale,
    path: '/pricing',
    title: copy.title,
    description: copy.description,
  })
}

function Hero({ locale }: { locale: AppLocale }) {
  const copy = pricingCopy[locale]
  const t = useTranslations('pricingPage')
  const trustStrip = [
    { icon: Cloud, label: t('trustStrip.privateCloud') },
    { icon: Brain, label: t('trustStrip.models') },
    { icon: Database, label: t('trustStrip.dataEnrichment') },
    { icon: Plugs, label: t('trustStrip.integrations') },
  ]
  return (
    <section className="relative z-10 px-6 pb-14 pt-24 text-center md:pt-32">
      <p
        className="animate-fade-rise mx-auto mb-8 text-lg italic text-white/85 sm:text-xl md:text-2xl"
        style={serifStyle}
      >
        {copy.eyebrow}
      </p>
      <h1
        className="mx-auto max-w-5xl text-5xl font-normal leading-[0.95] tracking-[-2px] text-white sm:text-7xl md:text-8xl"
        style={serifStyle}
      >
        <span className="mask-sweep">{copy.h1Lead}</span>
        <span className="mask-sweep mask-sweep-2 text-white/70">{copy.h1Trail}</span>
      </h1>
      <p className="animate-fade-rise-delay mx-auto mt-8 max-w-xl text-base leading-relaxed text-white/80 sm:text-lg">
        {copy.subhead}
      </p>

      <div className="animate-fade-rise-delay-2 mt-10 flex flex-wrap items-center justify-center gap-2">
        {trustStrip.map(item => {
          const Icon = item.icon
          return (
            <div
              key={item.label}
              className="liquid-glass inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-white/75"
            >
              <Icon className="size-3.5 text-white/65" weight="duotone" />
              <span>{item.label}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Tiers() {
  const t = useTranslations('pricingPage')
  return (
    <>
      <section className="relative z-10 px-4 pb-10 sm:px-6 lg:px-8">
        <div className="liquid-glass mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 rounded-3xl p-7 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-[0.28em] text-white/60">
              {t('trial.eyebrow')}
            </p>
            <h2 className="mt-2 text-2xl text-white sm:text-3xl" style={serifStyle}>
              {t('trial.heading', { days: TRIAL_DAYS })}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/70">
              {t('trial.body')}
            </p>
          </div>
          <a
            href={productHref('/sign-in?from=pricing')}
            className="shrink-0 whitespace-nowrap rounded-full bg-[hsl(214_65%_50%)] px-5 py-3 text-sm font-medium text-white hover:bg-[hsl(214_70%_44%)]"
          >
            {t('trial.cta')}
          </a>
        </div>
      </section>

      <PricingTiers signupHref={productHref('/sign-in?from=pricing')} />

      <section className="relative z-10 px-4 pb-24 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-5 border-t border-white/10 pt-8 sm:flex-row sm:items-center">
          <div>
            <p className="text-[10px] uppercase tracking-[0.28em] text-white/55">
              {t('enterprise.eyebrow')}
            </p>
            <h2 className="mt-2 text-2xl text-white" style={serifStyle}>
              {t('enterprise.heading')}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/70">
              {t('enterprise.body')}
            </p>
          </div>
          <a
            className="text-sm text-white underline decoration-white/30 underline-offset-4"
            href="mailto:duet@duet.so?subject=Duet%20Enterprise"
          >
            {t('enterprise.cta')} →
          </a>
        </div>
      </section>
    </>
  )
}

/* ── Comparisons ───────────────────────────────────────────────────────
   Three side-by-side comparison cards with teal accent edges — richer
   than the plain pill row it replaces. */
function Comparisons() {
  const t = useTranslations('pricingPage')
  const links = [
    {
      label: 'Claude Code',
      href: '/guides/duet-vs-claude-code',
      hint: t('comparisons.claudeCodeHint'),
    },
    {
      label: 'OpenClaw',
      href: '/guides/duet-vs-openclaw',
      hint: t('comparisons.openClawHint'),
    },
    {
      label: 'Codex',
      href: '/guides/duet-vs-codex',
      hint: t('comparisons.codexHint'),
    },
  ]
  return (
    <section className="border-t border-white/10 px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <p className="mb-4 text-[11px] uppercase tracking-[0.3em] text-white/55">
            {t('comparisons.eyebrow')}
          </p>
          <h2
            className="text-4xl font-normal leading-[1.05] tracking-[-0.75px] text-white sm:text-5xl"
            style={serifStyle}
          >
            {t('comparisons.headingLead')}{' '}
            <em className="not-italic text-white/70">{t('comparisons.headingTrail')}</em>
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {links.map(l => (
            <Link
              key={l.href}
              href={l.href}
              className="liquid-glass group relative flex flex-col justify-between rounded-3xl p-6 transition-transform duration-300 hover:-translate-y-0.5"
            >
              <div
                aria-hidden="true"
                className="bg-lv2-accent absolute left-6 top-6 h-1 w-10 rounded-full transition-all duration-300 group-hover:w-16"
              />
              <div className="mt-8">
                <p className="text-[10px] uppercase tracking-[0.25em] text-white/55">
                  {t('comparisons.duetVs')}
                </p>
                <h3
                  className="mt-2 text-2xl font-normal tracking-[-0.5px] text-white"
                  style={serifStyle}
                >
                  {l.label}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-white/70">{l.hint}</p>
              </div>
              <span className="mt-6 inline-flex items-center gap-1.5 text-sm text-white/85 transition-colors group-hover:text-white">
                {t('comparisons.readComparison')}
                <span className="transition-transform duration-300 group-hover:translate-x-1">
                  →
                </span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}

function FinalCta() {
  const t = useTranslations('pricingPage')
  return (
    <LandingFinalCta
      serifStyle={serifStyle}
      headingLead={t('finalCta.headingLead')}
      headingTrail={t('finalCta.headingTrail')}
      description={t('finalCta.description', { days: TRIAL_DAYS })}
      primaryLabel={t('finalCta.primaryLabel')}
      secondary={null}
    />
  )
}

export default async function PricingPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)

  return (
    <LandingChrome noAmbient>
      <LandingNav sticky />
      <Hero locale={locale} />
      <Tiers />
      <Comparisons />
      <PricingFaq />
      <FinalCta />
      <LandingFooter />
    </LandingChrome>
  )
}
