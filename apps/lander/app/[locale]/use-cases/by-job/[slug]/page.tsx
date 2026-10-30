import { ArrowRightIcon, ArrowUpRightIcon, CaretRightIcon } from '@phosphor-icons/react/dist/ssr'
import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { UseCasesSharedCta } from '@/components/landing/use-cases/use-cases-shared-cta'
import {
  getAllJobParams,
  getRelatedLeavesForJob,
  getRelatedPersonasForJob,
  getUseCaseJob,
  type UseCaseJob,
  type UseCasePersona,
  type UseCasePersonaLeaf,
} from '@/components/landing/use-cases/use-cases-spec'
import { Link } from '@/i18n/navigation'
import { getAlternateLocale, localeMetadata, type AppLocale } from '@/lib/i18n/locales'
import { LANDER_ORIGIN, localizedCanonical } from '@/lib/i18n/metadata'
import { safeJsonLd } from '@/lib/json-ld'

const OG_IMAGE = `${LANDER_ORIGIN}/landing/duet-lander-image.jpg`

type JobPageParams = {
  locale: AppLocale
  slug: string
}

type JobPageProps = {
  // Next 15 ships params as a Promise to support dynamic streaming.
  params: Promise<JobPageParams>
}

/**
 * Pre-render every published by-job slug at build time. The job set
 * is small and stable enough that fully static beats ISR — crawlers
 * get instant HTML, and adding a new job is just a spec change + a
 * rebuild.
 */
export function generateStaticParams(): JobPageParams[] {
  return getAllJobParams().flatMap(({ slug }) => [
    { locale: 'en' as const, slug },
    { locale: 'es-419' as const, slug },
  ])
}

export async function generateMetadata({ params }: JobPageProps): Promise<Metadata> {
  const { locale, slug } = await params
  setRequestLocale(locale)
  const job = getUseCaseJob(slug, locale)
  if (!job) return {}
  const canonical = localizedCanonical(`/use-cases/by-job/${job.slug}`, locale)
  return {
    title: job.metaTitle,
    description: job.metaDescription,
    // Spanish variant discontinued — `/es/...` now 308s to EN
    // (isDiscontinuedEsMarketingPath), so no `es` hreflang alternate.
    alternates: {
      canonical,
    },
    openGraph: {
      title: job.metaTitle,
      description: job.metaDescription,
      url: canonical,
      type: 'article',
      locale: localeMetadata[locale].ogLocale,
      alternateLocale: [localeMetadata[getAlternateLocale(locale)].ogLocale],
      images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: `Duet — ${job.title}` }],
    },
    twitter: {
      card: 'summary_large_image',
      title: job.metaTitle,
      description: job.metaDescription,
      images: [OG_IMAGE],
    },
  }
}

export default async function UseCaseByJobPage({ params }: JobPageProps) {
  const { locale, slug } = await params
  setRequestLocale(locale)
  const job = getUseCaseJob(slug, locale)
  if (!job) notFound()

  const relatedPersonas = getRelatedPersonasForJob(job, locale)
  const relatedLeaves = getRelatedLeavesForJob(job, locale)
  const t = await getTranslations({ locale, namespace: 'useCasesShell' })

  return (
    <LandingChrome noAmbient>
      {/* JSON-LD — BreadcrumbList + HowTo + FAQPage. Inlined here
          (rather than going through `<UseCasesJsonLd>`) because the
          by-job pages carry richer structured data than the hub /
          persona pages and don't share the same shape. */}
      <JobJsonLd job={job} locale={locale} />

      <LandingNav sticky />

      <article>
        {/* HERO + BREADCRUMBS */}
        <section
          aria-labelledby="job-hero-heading"
          className="relative overflow-hidden px-4 pb-16 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pb-20 lg:pt-20"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-32 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,var(--lv2-accent-soft),transparent_70%)]"
          />

          <div className="mx-auto flex max-w-4xl flex-col">
            <Breadcrumbs job={job} t={t} />

            <span className="lv2-eyebrow mt-8">
              {t('byJob')} · {job.title}
            </span>
            <h1
              id="job-hero-heading"
              className="mt-4 text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-[var(--lv2-fg)] sm:text-5xl lg:text-6xl"
              style={serifStyle}
            >
              {job.h1}
            </h1>

            <p className="mt-6 max-w-2xl text-balance text-lg leading-relaxed text-[var(--lv2-fg-soft)]">
              {job.intro}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <UseCasesSharedCta size="lg" halo>
                {t('hireAiCoworker')}
              </UseCasesSharedCta>
              <Link
                href="/use-cases/by-job"
                className="group inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
              >
                {t('browseAllJobs')}
                <ArrowRightIcon
                  weight="bold"
                  className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
            </div>
          </div>
        </section>

        {/* WORKFLOW — the HowTo schema bait. Visible numbered steps
            mirror the structured data we emit in the head. */}
        <section
          aria-labelledby="job-workflow-heading"
          className="bg-lv2-band-cool relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
        >
          <div className="mx-auto max-w-4xl">
            <div className="mb-12 max-w-2xl">
              <span className="lv2-eyebrow">{t('theWorkflow')}</span>
              <h2
                id="job-workflow-heading"
                className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
                style={serifStyle}
              >
                {t('workflowHeadingLead')}{' '}
                <em className="text-[var(--lv2-accent)]">{t('workflowHeadingTail')}</em>
              </h2>
            </div>

            <ol className="flex flex-col gap-4">
              {job.jobSteps.map(step => (
                <li
                  key={step.step}
                  className="flex gap-5 rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card"
                >
                  <span aria-hidden="true" className="lv2-numeral shrink-0 text-4xl leading-none">
                    {String(step.step).padStart(2, '0')}
                  </span>
                  <div className="flex flex-col gap-2">
                    <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                      {step.title}
                    </h3>
                    <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* WORKS FOR THESE PERSONAS — the cross-axis bridge back into
            the persona tree. Hidden if the job's spec entry doesn't
            list any related personas. */}
        {relatedPersonas.length > 0 ? <PersonaRail personas={relatedPersonas} t={t} /> : null}

        {/* RELATED PERSONA-LEAVES — second cross-axis rail. Only
            renders when at least one persona-leaf pair resolves
            cleanly so the section never looks half-built. */}
        {relatedLeaves.length > 0 ? <LeavesRail leaves={relatedLeaves} t={t} /> : null}

        {/* FAQ */}
        <section aria-labelledby="job-faq-heading" className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="mx-auto max-w-3xl">
            <div className="mb-10">
              <span className="lv2-eyebrow">{t('faq')}</span>
              <h2
                id="job-faq-heading"
                className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
                style={serifStyle}
              >
                {t('jobFaqHeadingLead')}{' '}
                <em className="text-[var(--lv2-muted)]">{t('jobFaqHeadingTail')}</em>
              </h2>
            </div>

            <div className="divide-y divide-[var(--lv2-line)]">
              {job.faqs.map(faq => (
                <details key={faq.q} className="group py-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                    <h3 className="text-base font-semibold leading-snug text-[var(--lv2-fg)] sm:text-lg">
                      {faq.q}
                    </h3>
                    <span
                      aria-hidden="true"
                      className="grid size-7 shrink-0 place-items-center rounded-full border border-lv2-line text-[var(--lv2-fg-soft)] transition-transform duration-200 group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-[var(--lv2-fg-soft)] sm:text-base">
                    {faq.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* FINAL CTA */}
        <section
          aria-labelledby="job-final-cta-heading"
          className="relative overflow-hidden px-4 py-24 text-center sm:px-6 sm:py-32 lg:px-8"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full bg-[radial-gradient(ellipse_at_center,var(--lv2-accent-soft),transparent_60%)]"
          />
          <div className="mx-auto max-w-3xl">
            <h2
              id="job-final-cta-heading"
              className="text-4xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-5xl"
              style={serifStyle}
            >
              {t('jobFinalCtaHeadingLead')}{' '}
              <em className="text-[var(--lv2-accent)]">{job.title.toLowerCase()}</em>{' '}
              {t('jobFinalCtaHeadingTail')}
            </h2>
            <p className="mt-5 text-lg text-[var(--lv2-fg-soft)]">{t('ctaPersonaBody')}</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <UseCasesSharedCta size="lg" halo magnetic>
                {t('startFree')}
              </UseCasesSharedCta>
              <Link
                href="/pricing"
                className="rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
              >
                {t('seePricing')}
              </Link>
            </div>
          </div>
        </section>
      </article>

      <LandingFooter />
    </LandingChrome>
  )
}

/* --------------------------- subcomponents --------------------------- */

type T = Awaited<ReturnType<typeof getTranslations<'useCasesShell'>>>

function Breadcrumbs({ job, t }: { job: UseCaseJob; t: T }) {
  // Visible breadcrumb mirrors the BreadcrumbList JSON-LD shipped in
  // the head — same labels, same hierarchy, so on-page and crawler
  // see the same picture.
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
        <li>
          <Link className="hover:text-[var(--lv2-fg)]" href="/use-cases/by-job">
            {t('byJob')}
          </Link>
        </li>
        <li aria-hidden="true">
          <CaretRightIcon weight="bold" className="size-3 text-[var(--lv2-muted)]" />
        </li>
        <li aria-current="page" className="text-[var(--lv2-fg)]">
          {job.title}
        </li>
      </ol>
    </nav>
  )
}

function PersonaRail({ personas, t }: { personas: UseCasePersona[]; t: T }) {
  // The "works for these personas" rail — the cross-axis bridge from
  // the job tree back into the persona tree. Keeps the cluster
  // internally linked so crawlers walk both axes from any leaf.
  return (
    <section
      aria-labelledby="job-personas-heading"
      className="bg-lv2-band-warm relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 max-w-2xl">
          <span className="lv2-eyebrow">{t('worksFor')}</span>
          <h2
            id="job-personas-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {t('thisJobFitsLead')}{' '}
            <em className="text-[var(--lv2-accent)]">{t('thisJobFitsTail')}</em>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-[var(--lv2-fg-soft)]">
            {t('thisJobFitsBody')}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {personas.map(persona => (
            <Link
              key={persona.slug}
              href={`/use-cases/${persona.slug}`}
              className="group flex flex-col gap-3 rounded-2xl border border-lv2-line bg-lv2-surface p-6 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-lv2-line-strong"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="lv2-eyebrow">{persona.shortName}</span>
                <ArrowUpRightIcon
                  weight="bold"
                  className="size-4 text-[var(--lv2-muted)] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                  aria-hidden="true"
                />
              </div>
              <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                {persona.name}
              </h3>
              <p className="text-sm text-[var(--lv2-muted)]">{persona.primaryKeyword}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}

function LeavesRail({
  leaves,
  t,
}: {
  leaves: Array<{ persona: UseCasePersona; leaf: UseCasePersonaLeaf }>
  t: T
}) {
  // Cross-axis persona-leaf rail — drills the reader from the job
  // axis directly into the deepest long-tail pages on the persona
  // axis, which is where high-intent "AI for X" searches often convert.
  return (
    <section aria-labelledby="job-leaves-heading" className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <h2
          id="job-leaves-heading"
          className="mb-8 text-2xl font-semibold tracking-tight text-[var(--lv2-fg)] sm:text-3xl"
          style={serifStyle}
        >
          {t('longTailPlaybooksLead')}{' '}
          <em className="text-[var(--lv2-muted)]">{t('longTailPlaybooksTail')}</em>
        </h2>

        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {leaves.map(({ persona, leaf }) => (
            <li key={`${persona.slug}/${leaf.slug}`}>
              <Link
                href={`/use-cases/${persona.slug}/${leaf.slug}`}
                className="group flex h-full flex-col gap-3 rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-lv2-line-strong"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="lv2-eyebrow">{persona.shortName}</span>
                  <ArrowUpRightIcon
                    weight="bold"
                    className="size-4 text-[var(--lv2-muted)] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    aria-hidden="true"
                  />
                </div>
                <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                  {leaf.title}
                </h3>
                <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">{leaf.intro}</p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function JobJsonLd({ job, locale }: { job: UseCaseJob; locale: AppLocale }) {
  const canonical = localizedCanonical(`/use-cases/by-job/${job.slug}`, locale)

  // BreadcrumbList — Home › Use cases › By job › {job}. Matches the
  // visible breadcrumb at the top of the page exactly so on-page
  // and crawler see the same trail.
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    '@id': `${canonical}#breadcrumb`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: LANDER_ORIGIN },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Use cases',
        item: `${LANDER_ORIGIN}/use-cases`,
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: 'By job',
        item: `${LANDER_ORIGIN}/use-cases/by-job`,
      },
      { '@type': 'ListItem', position: 4, name: job.title, item: canonical },
    ],
  }

  // HowTo — the headline schema we want on every by-job page. The
  // `step.text` field carries the body paragraph so AI Overviews can
  // pull the actual instruction text, not just the title.
  const howTo = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    '@id': `${canonical}#howto`,
    name: job.h1,
    description: job.intro,
    step: job.jobSteps.map(s => ({
      '@type': 'HowToStep',
      position: s.step,
      name: s.title,
      text: s.body,
    })),
  }

  const faqPage = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${canonical}#faq`,
    mainEntity: job.faqs.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  }

  return (
    <>
      {/* safeJsonLd escapes `<` to `\u003c` per Next.js docs so any
          future answer/step text containing `</script>` can't break
          out of the surrounding tag. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(howTo) }} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqPage) }}
      />
    </>
  )
}
