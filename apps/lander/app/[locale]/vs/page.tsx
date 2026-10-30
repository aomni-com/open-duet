import { ArrowRightIcon, ArrowUpRightIcon, CaretRightIcon } from '@phosphor-icons/react/dist/ssr'
import type { Metadata } from 'next'
import { useTranslations } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'

import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { UseCasesSharedCta } from '@/components/landing/use-cases/use-cases-shared-cta'
import {
  getComparisons,
  type Comparison,
  type ComparisonGroup,
} from '@/components/landing/vs/vs-spec'
import { Link } from '@/i18n/navigation'
import { getAlternateLocale, localeMetadata, type AppLocale } from '@/lib/i18n/locales'
import { LANDER_ORIGIN, localizedCanonical } from '@/lib/i18n/metadata'
import { safeJsonLd } from '@/lib/json-ld'

const CANONICAL_PATH = '/vs'
const META_COPY = {
  en: {
    title: 'Duet Alternatives & Comparisons | Duet',
    description:
      'Honest comparisons of Duet vs Lovable, Claude Code, Replit, Cursor, and other AI tools — so you can choose the right tool for the job.',
  },
  'es-419': {
    title: 'Alternativas y comparativas de Duet | Duet',
    description:
      'Comparativas honestas de Duet vs Lovable, Claude Code, Replit, Cursor y otras herramientas de AI para elegir la herramienta correcta.',
  },
} satisfies Record<AppLocale, { title: string; description: string }>
// Reuse the canonical brand OG image until the /vs hub gets a
// purpose-built cover. Keeps Slack / Twitter / iMessage unfurls
// on-brand without spinning up another asset.
const OG_IMAGE = `${LANDER_ORIGIN}/landing/duet-lander-image.jpg`

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: AppLocale }>
}): Promise<Metadata> {
  const { locale } = await params
  const copy = META_COPY[locale]
  const url = localizedCanonical(CANONICAL_PATH, locale)
  return {
    title: copy.title,
    description: copy.description,
    // Spanish variant discontinued — `/es/...` now 308s to EN
    // (isDiscontinuedEsMarketingPath), so no `es` hreflang alternate.
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: copy.title,
      description: copy.description,
      url,
      siteName: 'Duet',
      type: 'website',
      locale: localeMetadata[locale].ogLocale,
      alternateLocale: [localeMetadata[getAlternateLocale(locale)].ogLocale],
      images: [
        {
          url: OG_IMAGE,
          width: 1200,
          height: 630,
          alt: 'Duet vs the alternatives — Duet',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: copy.title,
      description: copy.description,
      images: [OG_IMAGE],
    },
  }
}

// Hub groupings — these mirror the three H2s called out in the
// comparison template (build + run, coding agents, business AI).
const GROUP_LABELS: Record<AppLocale, Record<ComparisonGroup, string>> = {
  en: {
    'build-and-run': 'Build + Run tools',
    'coding-agents': 'AI coding agents',
    'business-ai': 'Business AI platforms',
  },
  'es-419': {
    'build-and-run': 'Herramientas Build + Run',
    'coding-agents': 'Agentes de código con AI',
    'business-ai': 'Plataformas de AI para negocios',
  },
}

// Map each *published* comparison to its hub group. Doing this here
// (instead of on the Comparison type itself) keeps the comparison
// spec focused on the page payload, and the hub stays free to
// re-shuffle groupings without touching the spec.
const PUBLISHED_GROUPS: Record<string, ComparisonGroup> = {
  lovable: 'build-and-run',
  replit: 'build-and-run',
  v0: 'build-and-run',
  bolt: 'build-and-run',
  'claude-code': 'coding-agents',
  cursor: 'coding-agents',
  codex: 'coding-agents',
  'anthropic-small-business': 'business-ai',
}

function ComparisonHubBreadcrumbJsonLd() {
  // BreadcrumbList — Home › Compare. Emitted server-side so crawlers
  // see the trail on first byte without waiting on hydration.
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    '@id': `${LANDER_ORIGIN}${CANONICAL_PATH}#breadcrumb`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: LANDER_ORIGIN },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Compare',
        item: `${LANDER_ORIGIN}${CANONICAL_PATH}`,
      },
    ],
  }
  return (
    <script
      type="application/ld+json"
      // safeJsonLd escapes `<` to `\u003c` per Next.js docs so any
      // future field containing `</script>` can't break out of the
      // surrounding tag.
      dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
    />
  )
}

function ComparisonHubItemListJsonLd({ comparisons }: { comparisons: Comparison[] }) {
  // ItemList — every comparison shown on the hub is published and
  // crawlable. No non-linked future cards are emitted.
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${LANDER_ORIGIN}${CANONICAL_PATH}#comparisons`,
    name: 'Duet comparison pages',
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    numberOfItems: comparisons.length,
    itemListElement: comparisons.map((c, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: `Duet vs ${c.competitor}`,
      url: `${LANDER_ORIGIN}${CANONICAL_PATH}/${c.slug}`,
    })),
  }
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(itemList) }} />
  )
}

function Breadcrumbs() {
  // Visible breadcrumb mirrors the BreadcrumbList JSON-LD shipped
  // above — same labels, same hierarchy.
  const t = useTranslations('vsShell')
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-[var(--lv2-muted)]">
        <li>
          <Link className="hover:text-[var(--lv2-fg)]" href="/">
            {t('breadcrumbHome')}
          </Link>
        </li>
        <li aria-hidden="true">
          <CaretRightIcon weight="bold" className="size-3 text-[var(--lv2-muted)]" />
        </li>
        <li aria-current="page" className="text-[var(--lv2-fg)]">
          {t('breadcrumbCompare')}
        </li>
      </ol>
    </nav>
  )
}

function HubHero() {
  const t = useTranslations('vsShell.hub')
  return (
    <section
      aria-labelledby="vs-hero-heading"
      className="relative overflow-hidden px-4 pb-16 pt-12 sm:px-6 sm:pt-20 lg:px-8 lg:pb-20 lg:pt-24"
    >
      {/* Soft brand-blue daylight wash — matches the /use-cases hub
          so the cross-cluster pages feel visually contiguous. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-32 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,var(--lv2-accent-soft),transparent_70%)]"
      />

      <div className="mx-auto flex max-w-4xl flex-col">
        <Breadcrumbs />

        <span className="lv2-eyebrow mt-8">{t('eyebrow')}</span>
        <h1
          id="vs-hero-heading"
          className="mt-4 text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-[var(--lv2-fg)] sm:text-5xl lg:text-6xl"
          style={serifStyle}
        >
          <span className="block">{t('headingLead')}</span>
          <span className="mt-2 block" style={serifStyle}>
            <em className="italic text-[var(--lv2-accent)]">{t('headingTrail')}</em>
          </span>
        </h1>

        <p className="mt-6 max-w-2xl text-balance text-lg leading-relaxed text-[var(--lv2-fg-soft)]">
          {t('body')}
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <UseCasesSharedCta size="lg" halo>
            {t('primaryCta')}
          </UseCasesSharedCta>
          <Link
            href="#all-comparisons"
            className="group inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
          >
            {t('browseCta')}
            <ArrowRightIcon
              weight="bold"
              className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </div>
      </div>
    </section>
  )
}

function PublishedCard({ comparison, locale }: { comparison: Comparison; locale: AppLocale }) {
  const t = useTranslations('vsShell.hub')
  const dateLocale = locale === 'es-419' ? 'es-419' : 'en-US'
  const updatedDate = new Date(comparison.lastUpdated).toLocaleDateString(dateLocale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  return (
    <li>
      <Link
        href={`/vs/${comparison.slug}`}
        className="group relative flex h-full flex-col gap-4 overflow-hidden rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-lv2-line-strong"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="lv2-eyebrow">
            {t('cardEyebrow', { competitor: comparison.competitor })}
          </span>
          <ArrowUpRightIcon
            weight="bold"
            className="size-4 text-[var(--lv2-muted)] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            aria-hidden="true"
          />
        </div>
        <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
          {comparison.h1}
        </h3>
        <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">
          {comparison.verdict.tldr}
        </p>
        <p className="mt-auto text-xs text-[var(--lv2-muted)]">
          {t('cardUpdated', { date: updatedDate })}
        </p>
      </Link>
    </li>
  )
}

function ComparisonGrid({ comparisons, locale }: { comparisons: Comparison[]; locale: AppLocale }) {
  // Group every published comparison under the topical H2 it belongs to.
  // Every card below is a real link.
  const t = useTranslations('vsShell.hub')
  const sections: Array<{
    group: ComparisonGroup
    published: Comparison[]
  }> = (Object.keys(GROUP_LABELS[locale]) as ComparisonGroup[]).map(group => ({
    group,
    published: comparisons.filter(c => PUBLISHED_GROUPS[c.slug] === group),
  }))

  return (
    <section
      id="all-comparisons"
      aria-labelledby="vs-grid-heading"
      // Scroll margin offsets the sticky nav so the heading is not
      // hidden behind the chrome when users smooth-scroll into the
      // section from the hero anchor.
      className="scroll-mt-24 bg-lv2-band-cool px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 max-w-2xl">
          <span className="lv2-eyebrow">{t('gridEyebrow')}</span>
          <h2
            id="vs-grid-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {t('gridHeadingLead')}{' '}
            <em className="text-[var(--lv2-accent)]">{t('gridHeadingTrail')}</em>
          </h2>
          <p className="mt-5 text-base leading-relaxed text-[var(--lv2-fg-soft)]">
            {t('gridBody')}
          </p>
        </div>

        <div className="flex flex-col gap-14">
          {sections.map(section => {
            if (section.published.length === 0) return null
            return (
              <div key={section.group}>
                <h3
                  className="mb-6 text-xl font-semibold tracking-tight text-[var(--lv2-fg)] sm:text-2xl"
                  style={serifStyle}
                >
                  {GROUP_LABELS[locale][section.group]}
                </h3>
                <ul className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
                  {section.published.map(c => (
                    <PublishedCard key={c.slug} comparison={c} locale={locale} />
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function HubFinalCta() {
  const t = useTranslations('vsShell.hub')
  return (
    <section
      aria-labelledby="vs-final-cta-heading"
      className="relative overflow-hidden px-4 py-24 text-center sm:px-6 sm:py-32 lg:px-8"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full bg-[radial-gradient(ellipse_at_center,var(--lv2-accent-soft),transparent_60%)]"
      />
      <div className="mx-auto max-w-3xl">
        <h2
          id="vs-final-cta-heading"
          className="text-4xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-5xl"
          style={serifStyle}
        >
          {t('finalHeadingLead')}{' '}
          <em className="text-[var(--lv2-accent)]">{t('finalHeadingTrail')}</em>
        </h2>
        <p className="mt-5 text-lg text-[var(--lv2-fg-soft)]">{t('finalBody')}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <UseCasesSharedCta size="lg" halo magnetic>
            {t('finalPrimary')}
          </UseCasesSharedCta>
          <Link
            href="/use-cases"
            className="rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
          >
            {t('finalSecondary')}
          </Link>
        </div>
      </div>
    </section>
  )
}

/**
 * /vs — the comparison hub.
 *
 * Acts as the topical-authority sink for the comparison cluster.
 * Lists every published `/vs/<slug>` page. There are no
 * future cards on the hub: every visible card is a real crawlable
 * link and appears in the ItemList JSON-LD.
 *
 * Two JSON-LD blocks ship server-side: BreadcrumbList (Home ›
 * Compare) and ItemList (every published comparison) so Google sees
 * the cluster index on first byte.
 */
export default async function VsHubPage({ params }: { params: Promise<{ locale: AppLocale }> }) {
  const { locale } = await params
  setRequestLocale(locale)
  const comparisons = getComparisons(locale)

  return (
    <LandingChrome noAmbient>
      <ComparisonHubBreadcrumbJsonLd />
      <ComparisonHubItemListJsonLd comparisons={comparisons} />

      <LandingNav sticky />
      <HubHero />
      <ComparisonGrid comparisons={comparisons} locale={locale} />
      <HubFinalCta />
      <LandingFooter />
    </LandingChrome>
  )
}
