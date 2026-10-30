import { ArrowRightIcon, ArrowUpRightIcon, CaretRightIcon } from '@phosphor-icons/react/dist/ssr'
import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { UseCasesSharedCta } from '@/components/landing/use-cases/use-cases-shared-cta'
import { getUseCaseJobs, type UseCaseJob } from '@/components/landing/use-cases/use-cases-spec'
import { Link } from '@/i18n/navigation'
import { getAlternateLocale, localeMetadata, type AppLocale } from '@/lib/i18n/locales'
import { LANDER_ORIGIN, localizedCanonical } from '@/lib/i18n/metadata'
import { safeJsonLd } from '@/lib/json-ld'

const CANONICAL_PATH = '/use-cases/by-job'
const META_COPY = {
  en: {
    title: 'AI by job — workflows your AI coworker can run | Duet',
    description:
      'Browse jobs a Duet AI coworker can help run: support, outbound, inbox triage, content, reporting, and more. Pick one workflow and start with review rules.',
  },
  'es-419': {
    title: 'AI por trabajo — workflows que tu compañero de AI puede operar | Duet',
    description:
      'Explora trabajos que un compañero de AI de Duet puede operar: soporte, outbound, inbox, contenido, reporting y más.',
  },
} satisfies Record<AppLocale, { title: string; description: string }>
// Reuse the canonical brand OG image until a /by-job-specific cover
// ships — keeps the social card on-brand without an extra asset.
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
          alt: 'Use cases by job — Duet',
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

// BreadcrumbList — Home › Use cases › By job. Emitted server-side so
// crawlers see the trail on first byte without waiting on hydration.
function ByJobBreadcrumbJsonLd({ t }: { t: T }) {
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    '@id': `${LANDER_ORIGIN}${CANONICAL_PATH}#breadcrumb`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('home'), item: LANDER_ORIGIN },
      {
        '@type': 'ListItem',
        position: 2,
        name: t('useCases'),
        item: `${LANDER_ORIGIN}/use-cases`,
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: t('byJob'),
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

// ItemList JSON-LD — explicit index of every published by-job page.
// Helps Google attribute the cluster to this hub so it can rank for
// the broader "AI by job" / "AI for small business automation"
// keyword while the children compete on their narrower jobs.
function ByJobItemListJsonLd({ jobs }: { jobs: UseCaseJob[] }) {
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${LANDER_ORIGIN}${CANONICAL_PATH}#jobs`,
    name: 'Jobs your AI coworker can help run',
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    numberOfItems: jobs.length,
    itemListElement: jobs.map((job, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: job.title,
      url: `${LANDER_ORIGIN}${CANONICAL_PATH}/${job.slug}`,
    })),
  }
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(itemList) }} />
  )
}

type T = Awaited<ReturnType<typeof getTranslations<'useCasesShell'>>>

function Breadcrumbs({ t }: { t: T }) {
  // Visible breadcrumb mirrors the BreadcrumbList JSON-LD above —
  // same labels and same hierarchy so on-page and crawler see the
  // same picture.
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-[var(--lv2-muted)]">
        <li>
          <Link className="hover:text-[var(--lv2-fg)]" href="/">
            {t('home')}
          </Link>
        </li>
        <li aria-hidden="true">
          <CaretRightIcon weight="bold" className="size-3 text-[var(--lv2-muted)]" />
        </li>
        <li>
          <Link className="hover:text-[var(--lv2-fg)]" href="/use-cases">
            {t('useCases')}
          </Link>
        </li>
        <li aria-hidden="true">
          <CaretRightIcon weight="bold" className="size-3 text-[var(--lv2-muted)]" />
        </li>
        <li aria-current="page" className="text-[var(--lv2-fg)]">
          {t('byJob')}
        </li>
      </ol>
    </nav>
  )
}

function ByJobHero({ t }: { t: T }) {
  return (
    <section
      aria-labelledby="by-job-hero-heading"
      className="relative overflow-hidden px-4 pb-16 pt-12 sm:px-6 sm:pt-20 lg:px-8 lg:pb-20 lg:pt-24"
    >
      {/* Soft brand-blue daylight wash — same recipe as the persona
          hero so the cross-axis page feels visually contiguous. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-32 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,var(--lv2-accent-soft),transparent_70%)]"
      />

      <div className="mx-auto flex max-w-4xl flex-col">
        <Breadcrumbs t={t} />

        <span className="lv2-eyebrow mt-8">{t('useCasesByJob')}</span>
        <h1
          id="by-job-hero-heading"
          className="mt-4 text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-[var(--lv2-fg)] sm:text-5xl lg:text-6xl"
          style={serifStyle}
        >
          <span className="block">{t('byJobHeroLine1')}</span>
          <span className="mt-2 block" style={serifStyle}>
            {t('byJobHeroLine2Pre')}{' '}
            <em className="italic text-[var(--lv2-accent)]">{t('byJobHeroLine2Em')}</em>
          </span>
        </h1>

        <p className="mt-6 max-w-2xl text-balance text-lg leading-relaxed text-[var(--lv2-fg-soft)]">
          {t('byJobHeroBodyPart1')}{' '}
          <Link
            className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
            href="/use-cases"
          >
            /use-cases
          </Link>{' '}
          {t('byJobHeroBodyPart2')} <em>{t('byJobHeroBodyWho')}</em> {t('byJobHeroBodyDuetHelps')}{' '}
          <em>{t('byJobHeroBodyWhat')}</em> {t('byJobHeroBodyDuetDoes')}
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <UseCasesSharedCta size="lg" halo>
            {t('hireAiCoworker')}
          </UseCasesSharedCta>
          <Link
            href="#all-jobs"
            className="group inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
          >
            {t('browseTheJobs')}
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

function ByJobGrid({ jobs, t }: { jobs: UseCaseJob[]; t: T }) {
  return (
    <section
      id="all-jobs"
      aria-labelledby="by-job-grid-heading"
      // Scroll margin offsets the sticky nav so the heading isn't
      // hidden behind the chrome when users smooth-scroll into the
      // section from the hero anchor.
      className="scroll-mt-24 bg-lv2-band-cool px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 max-w-2xl">
          <span className="lv2-eyebrow">{t('pickAJob')}</span>
          <h2
            id="by-job-grid-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {t('byJobGridHeadingLead')}{' '}
            <em className="text-[var(--lv2-accent)]">{t('byJobGridHeadingTail')}</em>
          </h2>
          <p className="mt-5 text-base leading-relaxed text-[var(--lv2-fg-soft)]">
            {t('byJobGridBody')}
          </p>
        </div>

        <ul className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {jobs.map(job => (
            <li key={job.slug}>
              <Link
                href={`/use-cases/by-job/${job.slug}`}
                className="group relative flex h-full flex-col gap-4 overflow-hidden rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-lv2-line-strong"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="lv2-eyebrow">{job.title}</span>
                  <ArrowUpRightIcon
                    weight="bold"
                    className="size-4 text-[var(--lv2-muted)] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    aria-hidden="true"
                  />
                </div>
                <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                  {job.h1}
                </h3>
                <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">{job.intro}</p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function ByJobFinalCta({ t }: { t: T }) {
  return (
    <section
      aria-labelledby="by-job-final-cta-heading"
      className="relative overflow-hidden px-4 py-24 text-center sm:px-6 sm:py-32 lg:px-8"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full bg-[radial-gradient(ellipse_at_center,var(--lv2-accent-soft),transparent_60%)]"
      />
      <div className="mx-auto max-w-3xl">
        <h2
          id="by-job-final-cta-heading"
          className="text-4xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-5xl"
          style={serifStyle}
        >
          {t('byJobFinalCtaHeadingLead')}{' '}
          <em className="text-[var(--lv2-accent)]">{t('byJobFinalCtaHeadingTail')}</em>
        </h2>
        <p className="mt-5 text-lg text-[var(--lv2-fg-soft)]">{t('byJobFinalCtaBody')}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <UseCasesSharedCta size="lg" halo magnetic>
            {t('startFree')}
          </UseCasesSharedCta>
          <Link
            href="/use-cases"
            className="rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
          >
            {t('browseByRoleInstead')}
          </Link>
        </div>
      </div>
    </section>
  )
}

/**
 * /use-cases/by-job — the cross-axis index for the use-cases tree.
 *
 * SEO target: "AI for small business automation" / "AI by job" /
 * "AI coworker tasks". Every child `/use-cases/by-job/<slug>` ranks
 * for its narrower job keyword; this page is the canonical pillar
 * that ties the cluster together and gets internal links from the
 * /use-cases hub and every persona page.
 *
 * Two JSON-LD blocks ship server-side: BreadcrumbList (Home › Use
 * cases › By job) and ItemList (every published by-job page) so
 * Google sees the index on first byte.
 */
export default async function UseCasesByJobIndexPage({
  params,
}: {
  params: Promise<{ locale: AppLocale }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const jobs = getUseCaseJobs(locale)
  const t = await getTranslations({ locale, namespace: 'useCasesShell' })

  return (
    <LandingChrome noAmbient>
      <ByJobBreadcrumbJsonLd t={t} />
      <ByJobItemListJsonLd jobs={jobs} />

      <LandingNav sticky />
      <ByJobHero t={t} />
      <ByJobGrid jobs={jobs} t={t} />
      <ByJobFinalCta t={t} />
      <LandingFooter />
    </LandingChrome>
  )
}
