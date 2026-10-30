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
  getAllPersonaLeafParams,
  getUseCaseLeaf,
  getUseCasePersona,
  type UseCasePersona,
  type UseCasePersonaLeaf,
} from '@/components/landing/use-cases/use-cases-spec'
import { Link } from '@/i18n/navigation'
import { getAlternateLocale, localeMetadata, type AppLocale } from '@/lib/i18n/locales'
import { LANDER_ORIGIN, localizedCanonical } from '@/lib/i18n/metadata'
import { safeJsonLd } from '@/lib/json-ld'

const OG_IMAGE = `${LANDER_ORIGIN}/landing/duet-lander-image.jpg`

type LeafPageParams = {
  locale: AppLocale
  persona: string
  leaf: string
}

type LeafPageProps = {
  // Next 15 ships params as a Promise to support dynamic streaming.
  params: Promise<LeafPageParams>
}

/**
 * Pre-render every published (persona, leaf) tuple at build time. The
 * leaf set is small and stable enough that fully static beats ISR \u2014
 * crawlers get instant HTML, and adding a new leaf is just a spec
 * change + a rebuild.
 */
export function generateStaticParams(): LeafPageParams[] {
  return getAllPersonaLeafParams().flatMap(({ persona, leaf }) => [
    { locale: 'en' as const, persona, leaf },
    { locale: 'es-419' as const, persona, leaf },
  ])
}

export async function generateMetadata({ params }: LeafPageProps): Promise<Metadata> {
  const { locale, persona: personaSlug, leaf: leafSlug } = await params
  setRequestLocale(locale)
  const resolved = getUseCaseLeaf(personaSlug, leafSlug, locale)
  if (!resolved) return {}
  const { persona, leaf } = resolved
  const canonical = localizedCanonical(`/use-cases/${persona.slug}/${leaf.slug}`, locale)
  return {
    title: leaf.metaTitle,
    description: leaf.metaDescription,
    keywords: [persona.primaryKeyword, ...persona.secondaryKeywords],
    // Spanish variant discontinued — `/es/...` now 308s to EN
    // (isDiscontinuedEsMarketingPath), so no `es` hreflang alternate.
    alternates: {
      canonical,
    },
    openGraph: {
      title: leaf.metaTitle,
      description: leaf.metaDescription,
      url: canonical,
      type: 'article',
      locale: localeMetadata[locale].ogLocale,
      alternateLocale: [localeMetadata[getAlternateLocale(locale)].ogLocale],
      images: [
        {
          url: OG_IMAGE,
          width: 1200,
          height: 630,
          alt: `Duet \u2014 ${leaf.title}`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: leaf.metaTitle,
      description: leaf.metaDescription,
      images: [OG_IMAGE],
    },
  }
}

export default async function UseCaseLeafPage({ params }: LeafPageProps) {
  const { locale, persona: personaSlug, leaf: leafSlug } = await params
  setRequestLocale(locale)
  const resolved = getUseCaseLeaf(personaSlug, leafSlug, locale)
  if (!resolved) notFound()
  const { persona, leaf } = resolved
  const t = await getTranslations({ locale, namespace: 'useCasesShell' })

  return (
    <LandingChrome noAmbient>
      {/* JSON-LD \u2014 BreadcrumbList + HowTo + FAQPage. Inlined here
          instead of going through the shared <UseCasesJsonLd> helper
          because leaves carry richer structured data (HowTo) than the
          hub/persona pages. */}
      <LeafJsonLd persona={persona} leaf={leaf} locale={locale} />

      <LandingNav sticky />

      <article>
        {/* HERO + BREADCRUMBS */}
        <section
          aria-labelledby="leaf-hero-heading"
          className="relative overflow-hidden px-4 pb-16 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pb-20 lg:pt-20"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-32 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,var(--lv2-accent-soft),transparent_70%)]"
          />

          <div className="mx-auto flex max-w-4xl flex-col">
            <Breadcrumbs persona={persona} leaf={leaf} t={t} />

            <span className="lv2-eyebrow mt-8">
              {persona.shortName} · {t('useCase')}
            </span>

            <h1
              id="leaf-hero-heading"
              className="mt-4 text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-[var(--lv2-fg)] sm:text-5xl lg:text-6xl"
              style={serifStyle}
            >
              {leaf.h1}
            </h1>

            <p className="mt-6 max-w-2xl text-balance text-lg leading-relaxed text-[var(--lv2-fg-soft)]">
              {leaf.intro}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <UseCasesSharedCta size="lg" halo>
                {t('tryThisUseCase')}
              </UseCasesSharedCta>
              <Link
                href={`/use-cases/${persona.slug}`}
                className="group inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
              >
                {t('moreFor', { persona: persona.shortName.toLowerCase() })}
                <ArrowRightIcon
                  weight="bold"
                  className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
            </div>
          </div>
        </section>

        {/* WORKFLOW \u2014 the HowTo schema bait. Visible numbered steps
            mirror the structured data we emit in the head. */}
        <section
          aria-labelledby="leaf-workflow-heading"
          className="bg-lv2-band-cool relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
        >
          <div className="mx-auto max-w-4xl">
            <div className="mb-12 max-w-2xl">
              <span className="lv2-eyebrow">{t('theWorkflow')}</span>
              <h2
                id="leaf-workflow-heading"
                className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
                style={serifStyle}
              >
                {t('leafWorkflowHeadingLead')}{' '}
                <em className="text-[var(--lv2-accent)]">{t('leafWorkflowHeadingTail')}</em>
              </h2>
            </div>

            <ol className="flex flex-col gap-4">
              {leaf.workflowSteps.map(step => (
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

        {/* FAQ */}
        <section aria-labelledby="leaf-faq-heading" className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="mx-auto max-w-3xl">
            <div className="mb-10">
              <span className="lv2-eyebrow">{t('faq')}</span>
              <h2
                id="leaf-faq-heading"
                className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
                style={serifStyle}
              >
                {t('leafFaqHeadingLead')}{' '}
                <em className="text-[var(--lv2-muted)]">{t('leafFaqHeadingTail')}</em>
              </h2>
            </div>

            <div className="divide-y divide-[var(--lv2-line)]">
              {leaf.faqs.map(faq => (
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

        {/* RELATED RAILS \u2014 by-job (cross-axis) + sibling personas. */}
        <RelatedRails persona={persona} leaf={leaf} t={t} locale={locale} />

        {/* FINAL CTA */}
        <section
          aria-labelledby="leaf-final-cta-heading"
          className="relative overflow-hidden px-4 py-24 text-center sm:px-6 sm:py-32 lg:px-8"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full bg-[radial-gradient(ellipse_at_center,var(--lv2-accent-soft),transparent_60%)]"
          />
          <div className="mx-auto max-w-3xl">
            <h2
              id="leaf-final-cta-heading"
              className="text-4xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-5xl"
              style={serifStyle}
            >
              {t('leafFinalCtaHeadingLead')}{' '}
              <em className="text-[var(--lv2-accent)]">{t('leafFinalCtaHeadingMid')}</em>{' '}
              {t('leafFinalCtaHeadingTail')}
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

function Breadcrumbs({
  persona,
  leaf,
  t,
}: {
  persona: UseCasePersona
  leaf: UseCasePersonaLeaf
  t: T
}) {
  // Visible breadcrumb mirrors the BreadcrumbList JSON-LD shipped in
  // the head \u2014 same labels, same hierarchy, so on-page and crawler
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
          <Link className="hover:text-[var(--lv2-fg)]" href={`/use-cases/${persona.slug}`}>
            {persona.shortName}
          </Link>
        </li>
        <li aria-hidden="true">
          <CaretRightIcon weight="bold" className="size-3 text-[var(--lv2-muted)]" />
        </li>
        <li aria-current="page" className="text-[var(--lv2-fg)]">
          {leaf.title}
        </li>
      </ol>
    </nav>
  )
}

function RelatedRails({
  persona,
  leaf,
  t,
  locale,
}: {
  persona: UseCasePersona
  leaf: UseCasePersonaLeaf
  t: T
  locale: AppLocale
}) {
  // Cross-axis rail to /by-job/* leaves \u2014 hidden until the by-job
  // branch ships, but the data is already there so a single PR turns
  // it on. Sibling-leaf rail uses other leaves under the same persona
  // when present so the reader has somewhere lateral to go.
  const siblingLeaves = persona.leaves.filter(l => l.slug !== leaf.slug)
  const hasJobs = leaf.relatedJobs.length > 0
  const hasSiblings = siblingLeaves.length > 0

  if (!hasJobs && !hasSiblings) return null

  return (
    <section
      aria-labelledby="leaf-related-heading"
      className="bg-lv2-band-warm relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-5xl">
        <h2
          id="leaf-related-heading"
          className="mb-8 text-2xl font-semibold tracking-tight text-[var(--lv2-fg)] sm:text-3xl"
          style={serifStyle}
        >
          {t('leafKeepGoingLead')}{' '}
          <em className="text-[var(--lv2-muted)]">{t('leafKeepGoingTail')}</em>
        </h2>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {hasSiblings ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card">
              <span className="lv2-eyebrow">
                {t('leafOtherPlaybooks', { persona: persona.shortName.toLowerCase() })}
              </span>
              <ul className="mt-2 flex flex-col gap-2">
                {siblingLeaves.map(s => (
                  <li key={s.slug}>
                    <Link
                      href={`/use-cases/${persona.slug}/${s.slug}`}
                      className="group inline-flex max-w-full items-start gap-1.5 text-sm font-medium leading-relaxed text-[var(--lv2-fg)] hover:text-[var(--lv2-accent-strong)]"
                    >
                      <span className="min-w-0 break-words">{s.title}</span>
                      <ArrowUpRightIcon
                        weight="bold"
                        className="mt-0.5 size-3.5 shrink-0 text-[var(--lv2-muted)] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {hasJobs ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card">
              <span className="lv2-eyebrow">{t('relatedJobsDuetCanDo')}</span>
              <ul className="mt-2 flex flex-col gap-2">
                {leaf.relatedJobs.map(job => (
                  <li key={job}>
                    {/* Published by-job pages keep the related-job rail crawlable
                        without requiring a separate dictionary of labels. */}
                    <Link
                      href={`/use-cases/by-job/${job}`}
                      className="group inline-flex max-w-full items-start gap-1.5 text-sm font-medium leading-relaxed text-[var(--lv2-fg)] hover:text-[var(--lv2-accent-strong)]"
                    >
                      <span className="min-w-0 break-words">{jobLabel(job)}</span>
                      <ArrowUpRightIcon
                        weight="bold"
                        className="mt-0.5 size-3.5 shrink-0 text-[var(--lv2-muted)] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {/* Related personas rail \u2014 keeps the reader inside the
            /use-cases tree if their persona doesn't fit. */}
        <div className="mt-8 flex flex-wrap items-center gap-2 text-sm text-[var(--lv2-fg-soft)]">
          <span className="text-[var(--lv2-muted)]">{t('relatedPersonas')}</span>
          {persona.relatedSlugs.map(slug => {
            const related = getUseCasePersona(slug, locale)
            if (!related) return null
            return (
              <Link
                key={slug}
                href={`/use-cases/${related.slug}`}
                className="rounded-full border border-lv2-line bg-lv2-surface px-3 py-1 text-xs font-medium text-[var(--lv2-fg)] hover:border-lv2-line-strong"
              >
                {related.shortName}
              </Link>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/** Lowercase by-job slug \u2192 human label for the rail. Kept tiny and
 * local so adding a job to the spec doesn't require touching a
 * separate dictionary. */
function jobLabel(slug: string): string {
  // Humanize the published by-job slug so the rail reads like
  // editorial navigation, not a stringly-typed leak.
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function LeafJsonLd({
  persona,
  leaf,
  locale,
}: {
  persona: UseCasePersona
  leaf: UseCasePersonaLeaf
  locale: AppLocale
}) {
  const canonical = localizedCanonical(`/use-cases/${persona.slug}/${leaf.slug}`, locale)

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
        name: persona.shortName,
        item: `${LANDER_ORIGIN}/use-cases/${persona.slug}`,
      },
      { '@type': 'ListItem', position: 4, name: leaf.title, item: canonical },
    ],
  }

  // HowTo \u2014 the headline schema we want on every leaf. The
  // `step.text` field carries the body paragraph so AI Overviews can
  // pull the actual instruction text, not just the title.
  const howTo = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    '@id': `${canonical}#howto`,
    name: leaf.h1,
    description: leaf.intro,
    step: leaf.workflowSteps.map(s => ({
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
    mainEntity: leaf.faqs.map(f => ({
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
