import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CaretRightIcon,
  CheckCircleIcon,
} from '@phosphor-icons/react/dist/ssr'
import type { Metadata } from 'next'
import { useTranslations } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { UseCasesSharedCta } from '@/components/landing/use-cases/use-cases-shared-cta'
import {
  getAllComparisonParams,
  getComparison,
  type Comparison,
} from '@/components/landing/vs/vs-spec'
import { Link } from '@/i18n/navigation'
import { getAlternateLocale, localeMetadata, type AppLocale } from '@/lib/i18n/locales'
import { LANDER_ORIGIN, localizedCanonical } from '@/lib/i18n/metadata'
import { safeJsonLd } from '@/lib/json-ld'

const OG_IMAGE = `${LANDER_ORIGIN}/landing/duet-lander-image.jpg`

const DUET_PRODUCT_ENTITY = {
  '@type': 'SoftwareApplication',
  '@id': `${LANDER_ORIGIN}#product`,
  name: 'Duet',
  url: LANDER_ORIGIN,
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web, iOS, Android, macOS',
  description:
    'Duet is a cloud AI workspace where small businesses operate like giants — one AI coworker that builds the apps, runs the workflows, and remembers everything.',
}

type ComparisonPageParams = {
  locale: AppLocale
  slug: string
}

type ComparisonPageProps = {
  // Next 15 ships params as a Promise to support dynamic streaming.
  params: Promise<ComparisonPageParams>
}

/**
 * Pre-render every published comparison slug at build time. The
 * comparison set is small + stable enough that fully static beats
 * ISR — crawlers get instant HTML and a new comparison is just a
 * spec change + a rebuild.
 */
export function generateStaticParams(): ComparisonPageParams[] {
  return getAllComparisonParams().flatMap(({ slug }) => [
    { locale: 'en' as const, slug },
    { locale: 'es-419' as const, slug },
  ])
}

export async function generateMetadata({ params }: ComparisonPageProps): Promise<Metadata> {
  const { locale, slug } = await params
  setRequestLocale(locale)
  const comparison = getComparison(slug, locale)
  if (!comparison) return {}
  const canonical = localizedCanonical(`/vs/${comparison.slug}`, locale)
  return {
    title: comparison.metaTitle,
    description: comparison.metaDescription,
    // Spanish variant discontinued — `/es/...` now 308s to EN
    // (isDiscontinuedEsMarketingPath), so no `es` hreflang alternate.
    alternates: {
      canonical,
    },
    openGraph: {
      title: comparison.metaTitle,
      description: comparison.metaDescription,
      url: canonical,
      type: 'article',
      locale: localeMetadata[locale].ogLocale,
      alternateLocale: [localeMetadata[getAlternateLocale(locale)].ogLocale],
      images: [
        {
          url: OG_IMAGE,
          width: 1200,
          height: 630,
          alt: `Duet vs ${comparison.competitor}`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: comparison.metaTitle,
      description: comparison.metaDescription,
      images: [OG_IMAGE],
    },
  }
}

export default async function ComparisonPage({ params }: ComparisonPageProps) {
  const { locale, slug } = await params
  setRequestLocale(locale)
  const comparison = getComparison(slug, locale)
  if (!comparison) notFound()

  return (
    <LandingChrome noAmbient>
      {/* JSON-LD bundle — Article (with dateModified), BreadcrumbList,
          FAQPage, and a generic Product comparison structure so AI
          engines understand the entity graph: Duet vs <Competitor>. */}
      <ComparisonJsonLd comparison={comparison} locale={locale} />

      <LandingNav sticky />

      <article>
        <Hero comparison={comparison} locale={locale} />
        <Verdict comparison={comparison} />
        <AtAGlance comparison={comparison} />
        <WhereCompetitorWins comparison={comparison} />
        <WhereDuetWins comparison={comparison} />
        <Pricing comparison={comparison} />
        {comparison.migration ? <Migration comparison={comparison} /> : null}
        <HowToChoose comparison={comparison} />
        <Faq comparison={comparison} />
        <FinalCta comparison={comparison} />
      </article>

      <LandingFooter />
    </LandingChrome>
  )
}

/* ----------------------------- sections ----------------------------- */

function Hero({ comparison, locale }: { comparison: Comparison; locale: AppLocale }) {
  const t = useTranslations('vsShell.slug')
  // Human-friendly "Month Year" string for the Updated stamp. We
  // build it from the ISO date in the spec so the JSON-LD
  // `dateModified` and the visible stamp can never drift.
  const dateLocale = locale === 'es-419' ? 'es-419' : 'en-US'
  const updatedLabel = new Date(comparison.lastUpdated).toLocaleDateString(dateLocale, {
    year: 'numeric',
    month: 'long',
  })

  return (
    <section
      aria-labelledby="vs-hero-heading"
      className="relative overflow-hidden px-4 pb-12 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pt-20"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-32 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,var(--lv2-accent-soft),transparent_70%)]"
      />
      <div className="mx-auto flex max-w-4xl flex-col">
        <Breadcrumbs comparison={comparison} />

        <span className="lv2-eyebrow mt-8">
          {t('eyebrow', { competitor: comparison.competitor })}
        </span>
        <h1
          id="vs-hero-heading"
          className="mt-4 text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-[var(--lv2-fg)] sm:text-5xl lg:text-6xl"
          style={serifStyle}
        >
          {comparison.h1}
        </h1>

        <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-[var(--lv2-muted)]">
          <span className="inline-flex items-center gap-1 rounded-full border border-lv2-line bg-lv2-surface px-3 py-1 font-medium text-[var(--lv2-fg-soft)]">
            {t('updated', { date: updatedLabel })}
          </span>
          <span className="text-[var(--lv2-muted)]">{comparison.lastChanged}</span>
        </div>

        <p className="mt-8 max-w-2xl text-balance text-lg leading-relaxed text-[var(--lv2-fg-soft)]">
          {comparison.verdict.tldr}
        </p>

        {/* Skip-ahead anchor links — give scanners (and AI search
            crawlers) an outline of the page they're about to read. */}
        <nav
          aria-label="Skip to section"
          className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
        >
          <SkipLink href="#at-a-glance" label={t('toc.atAGlance')} />
          <SkipLink
            href="#where-competitor-wins"
            label={t('toc.whereCompetitorWins', { competitor: comparison.competitor })}
          />
          <SkipLink href="#where-duet-wins" label={t('toc.whereDuetWins')} />
          <SkipLink href="#pricing" label={t('toc.pricing')} />
          {comparison.migration ? <SkipLink href="#migration" label={t('toc.migration')} /> : null}
          <SkipLink href="#how-to-choose" label={t('toc.howToChoose')} />
          <SkipLink href="#faq" label={t('toc.faq')} />
        </nav>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          <UseCasesSharedCta size="lg" halo>
            {t('heroPrimaryCta')}
          </UseCasesSharedCta>
          <Link
            href="/vs"
            className="group inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
          >
            {t('heroSecondaryCta')}
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

function Verdict({ comparison }: { comparison: Comparison }) {
  // Decision matrix — the single biggest CTR + AI-citation lever
  // according to the template contract. Renders above the at-a-
  // glance feature table because Google likes the punchline first.
  const t = useTranslations('vsShell.slug')
  return (
    <section
      aria-labelledby="vs-verdict-heading"
      className="bg-lv2-band-warm relative px-4 py-16 sm:px-6 sm:py-20 lg:px-8"
    >
      <div className="mx-auto max-w-4xl">
        <span className="lv2-eyebrow">{t('verdictEyebrow')}</span>
        <h2
          id="vs-verdict-heading"
          className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
          style={serifStyle}
        >
          {t('verdictHeadingLead')}{' '}
          <em className="text-[var(--lv2-accent)]">{t('verdictHeadingTrail')}</em>
        </h2>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-[var(--lv2-fg-soft)]">
          {t('verdictBody')}
        </p>

        <div className="mt-8 overflow-x-auto rounded-2xl border border-lv2-line bg-lv2-surface shadow-lv2-card">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="bg-lv2-band-cool/60 text-[var(--lv2-muted)]">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium uppercase tracking-wider">
                  {t('verdictIfYoure')}
                </th>
                <th scope="col" className="px-5 py-3 font-medium uppercase tracking-wider">
                  {t('verdictBestFit')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--lv2-line)]">
              {comparison.verdict.matrix.map(row => (
                <tr
                  key={row.ifYoure}
                  // Highlight rows that pick Duet so the matrix
                  // doesn't feel evenly split when half the answers
                  // are us. Subtle accent — not a marketing trick.
                  className={row.isUs ? 'bg-[var(--lv2-accent-soft)]/30' : ''}
                >
                  <td className="px-5 py-4 text-[var(--lv2-fg-soft)]">{row.ifYoure}</td>
                  <td className="px-5 py-4">
                    <span
                      className={
                        row.isUs
                          ? 'inline-flex items-center gap-1.5 font-semibold text-[var(--lv2-accent)]'
                          : 'font-semibold text-[var(--lv2-fg)]'
                      }
                    >
                      {row.isUs ? (
                        <CheckCircleIcon weight="fill" aria-hidden="true" className="size-4" />
                      ) : null}
                      {row.bestFit}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function AtAGlance({ comparison }: { comparison: Comparison }) {
  // Scored feature table. Scores are 1-5 integers; the dot row
  // renders them visually so the number isn't doing all the work.
  const t = useTranslations('vsShell.slug')
  return (
    <section
      id="at-a-glance"
      aria-labelledby="vs-at-a-glance-heading"
      className="scroll-mt-24 px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-5xl">
        <span className="lv2-eyebrow">{t('atAGlanceEyebrow')}</span>
        <h2
          id="vs-at-a-glance-heading"
          className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
          style={serifStyle}
        >
          {t('atAGlanceHeadingLead')}{' '}
          <em className="text-[var(--lv2-accent)]">{t('atAGlanceHeadingTrail')}</em>
        </h2>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-[var(--lv2-fg-soft)]">
          {t('atAGlanceBody')}
        </p>

        <div className="mt-8 overflow-x-auto rounded-2xl border border-lv2-line bg-lv2-surface shadow-lv2-card">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-lv2-band-cool/60 text-[var(--lv2-muted)]">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium uppercase tracking-wider">
                  {t('capabilityHeader')}
                </th>
                <th scope="col" className="px-5 py-3 font-medium uppercase tracking-wider">
                  {comparison.competitor}
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 font-medium uppercase tracking-wider text-[var(--lv2-accent)]"
                >
                  {t('duetHeader')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--lv2-line)]">
              {comparison.atAGlance.map(row => (
                <tr key={row.capability} className="align-top">
                  <td className="px-5 py-4 font-medium text-[var(--lv2-fg)]">{row.capability}</td>
                  <td className="px-5 py-4">
                    <ScoreDots
                      score={row.competitorScore}
                      ariaLabel={t('scoreOutOf', { score: row.competitorScore })}
                    />
                    {row.competitorNote ? (
                      <p className="mt-1.5 text-xs leading-relaxed text-[var(--lv2-muted)]">
                        {row.competitorNote}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-5 py-4">
                    <ScoreDots
                      score={row.duetScore}
                      ariaLabel={t('scoreOutOf', { score: row.duetScore })}
                      accent
                    />
                    {row.duetNote ? (
                      <p className="mt-1.5 text-xs leading-relaxed text-[var(--lv2-muted)]">
                        {row.duetNote}
                      </p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function ScoreDots({
  score,
  ariaLabel,
  accent = false,
}: {
  score: number
  ariaLabel: string
  accent?: boolean
}) {
  // 5-dot visualisation of the integer score. Filled dots get the
  // accent colour on the Duet column to reinforce the entity at a
  // glance without screaming "we win" — empty dots stay neutral.
  const dots = [1, 2, 3, 4, 5]
  return (
    <div className="flex min-w-max items-center gap-1.5" aria-label={ariaLabel} role="img">
      {dots.map(n => {
        const filled = n <= score
        return (
          <span
            key={n}
            aria-hidden="true"
            className={
              filled
                ? accent
                  ? 'size-2 rounded-full bg-[var(--lv2-accent)]'
                  : 'size-2 rounded-full bg-[var(--lv2-fg)]'
                : 'size-2 rounded-full border border-lv2-line'
            }
          />
        )
      })}
      <span className="ml-1.5 text-xs font-medium text-[var(--lv2-muted)]">{score}/5</span>
    </div>
  )
}

function WhereCompetitorWins({ comparison }: { comparison: Comparison }) {
  const t = useTranslations('vsShell.slug')
  return (
    <section
      id="where-competitor-wins"
      aria-labelledby="vs-competitor-wins-heading"
      // Honest concessions section. Visual treatment is intentionally
      // sober so it reads as a real assessment, not a setup for the
      // next pitch.
      className="scroll-mt-24 bg-lv2-band-cool px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-4xl">
        <span className="lv2-eyebrow">{t('concessionsEyebrow')}</span>
        <h2
          id="vs-competitor-wins-heading"
          className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
          style={serifStyle}
        >
          {t('concessionsHeadingLead')}{' '}
          <em className="text-[var(--lv2-muted)]">
            {t('concessionsHeadingTrail', { competitor: comparison.competitor })}
          </em>
        </h2>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-[var(--lv2-fg-soft)]">
          {t('concessionsBody', { competitor: comparison.competitor })}
        </p>

        <ul className="mt-10 flex flex-col gap-4">
          {comparison.whereCompetitorWins.map(block => (
            <li
              key={block.heading}
              className="rounded-2xl border border-lv2-line bg-lv2-surface p-6"
            >
              <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                {block.heading}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--lv2-fg-soft)] sm:text-base">
                {block.body}
              </p>
            </li>
          ))}
        </ul>

        <p className="mt-8 text-sm leading-relaxed text-[var(--lv2-muted)]">
          {t('competitorSiteLine')}{' '}
          <a
            href={comparison.competitorUrl}
            // Honest do-follow link is the confidence move — Google
            // rewards pages willing to point at competitors, and the
            // template contract explicitly calls for it.
            className="break-words underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
            target="_blank"
            rel="noopener"
          >
            {comparison.competitorUrl}
          </a>
          .
        </p>
      </div>
    </section>
  )
}

function WhereDuetWins({ comparison }: { comparison: Comparison }) {
  const t = useTranslations('vsShell.slug')
  return (
    <section
      id="where-duet-wins"
      aria-labelledby="vs-duet-wins-heading"
      className="scroll-mt-24 px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-4xl">
        <span className="lv2-eyebrow">{t('ourEdgeEyebrow')}</span>
        <h2
          id="vs-duet-wins-heading"
          className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
          style={serifStyle}
        >
          {t('ourEdgeHeadingLead')}{' '}
          <em className="text-[var(--lv2-accent)]">{t('ourEdgeHeadingTrail')}</em>
        </h2>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-[var(--lv2-fg-soft)]">
          {t('ourEdgeBody')}
        </p>

        <ul className="mt-10 flex flex-col gap-4">
          {comparison.whereDuetWins.map(block => (
            <li
              key={block.heading}
              className="rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card"
            >
              <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                {block.heading}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--lv2-fg-soft)] sm:text-base">
                {block.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Pricing({ comparison }: { comparison: Comparison }) {
  // Real-world scenarios > list prices. List prices age the page;
  // scenarios stay relevant even when either vendor adjusts.
  const t = useTranslations('vsShell.slug')
  return (
    <section
      id="pricing"
      aria-labelledby="vs-pricing-heading"
      className="scroll-mt-24 bg-lv2-band-warm px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-5xl">
        <span className="lv2-eyebrow">{t('pricingEyebrow')}</span>
        <h2
          id="vs-pricing-heading"
          className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
          style={serifStyle}
        >
          {t('pricingHeadingLead')}{' '}
          <em className="text-[var(--lv2-accent)]">{t('pricingHeadingTrail')}</em>
        </h2>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-[var(--lv2-fg-soft)]">
          {t('pricingBody')}
        </p>

        <ul className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {comparison.pricingScenarios.map(scenario => (
            <li
              key={scenario.scenario}
              className="flex flex-col gap-4 rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card"
            >
              <h3 className="text-base font-semibold leading-tight text-[var(--lv2-fg)]">
                {scenario.scenario}
              </h3>
              <div>
                <span className="lv2-eyebrow text-[var(--lv2-muted)]">{comparison.competitor}</span>
                <p className="mt-1 text-sm leading-relaxed text-[var(--lv2-fg-soft)]">
                  {scenario.competitorCost}
                </p>
              </div>
              <div>
                <span className="lv2-eyebrow text-[var(--lv2-accent)]">Duet</span>
                <p className="mt-1 text-sm leading-relaxed text-[var(--lv2-fg-soft)]">
                  {scenario.duetCost}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Migration({ comparison }: { comparison: Comparison }) {
  // Optional — only renders when the spec ships a migration block.
  const migration = comparison.migration
  const t = useTranslations('vsShell.slug')
  if (!migration) return null

  return (
    <section
      id="migration"
      aria-labelledby="vs-migration-heading"
      className="scroll-mt-24 px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-4xl">
        <span className="lv2-eyebrow">{t('migrationEyebrow')}</span>
        <h2
          id="vs-migration-heading"
          className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
          style={serifStyle}
        >
          {t('migrationHeadingLead', { competitor: comparison.competitor })}{' '}
          <em className="text-[var(--lv2-accent)]">{t('migrationHeadingTrail')}</em>
        </h2>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-[var(--lv2-fg-soft)]">
          {migration.intro}
        </p>

        <ol className="mt-10 flex flex-col gap-4">
          {migration.steps.map(step => (
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

        {migration.guideHref ? (
          <Link
            href={migration.guideHref}
            className="group mt-8 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--lv2-fg-soft)] hover:text-[var(--lv2-fg)]"
          >
            {migration.guideLabel ?? t('migrationGuideDefault')}
            <ArrowRightIcon
              weight="bold"
              className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        ) : null}
      </div>
    </section>
  )
}

function HowToChoose({ comparison }: { comparison: Comparison }) {
  // "How to choose" rail — links into /use-cases personas so
  // authority flows sideways into the persona axis.
  const t = useTranslations('vsShell.slug')
  return (
    <section
      id="how-to-choose"
      aria-labelledby="vs-how-to-choose-heading"
      className="scroll-mt-24 bg-lv2-band-cool px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-5xl">
        <span className="lv2-eyebrow">{t('howToChooseEyebrow')}</span>
        <h2
          id="vs-how-to-choose-heading"
          className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
          style={serifStyle}
        >
          {t('howToChooseHeadingLead')}{' '}
          <em className="text-[var(--lv2-accent)]">{t('howToChooseHeadingTrail')}</em>
        </h2>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-[var(--lv2-fg-soft)]">
          {t('howToChooseBody')}
        </p>

        <ul className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2">
          {comparison.howToChoose.map(row => (
            <li key={row.persona}>
              <Link
                href={row.link}
                className="group flex h-full flex-col gap-3 rounded-2xl border border-lv2-line bg-lv2-surface p-6 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-lv2-line-strong"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="lv2-eyebrow">{row.persona}</span>
                  <ArrowUpRightIcon
                    weight="bold"
                    className="size-4 text-[var(--lv2-muted)] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    aria-hidden="true"
                  />
                </div>
                <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">
                  {row.recommendation}
                </p>
              </Link>
            </li>
          ))}
        </ul>

        <p className="mt-8 text-sm text-[var(--lv2-muted)]">
          {t('howToChooseFootLead')}{' '}
          <Link
            href="/use-cases"
            className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
          >
            {t('howToChooseFootLink')}
          </Link>
        </p>
      </div>
    </section>
  )
}

function Faq({ comparison }: { comparison: Comparison }) {
  const t = useTranslations('vsShell.slug')
  return (
    <section
      id="faq"
      aria-labelledby="vs-faq-heading"
      className="scroll-mt-24 px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-3xl">
        <div className="mb-10">
          <span className="lv2-eyebrow">{t('faqEyebrow')}</span>
          <h2
            id="vs-faq-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {t('faqHeadingLead')}{' '}
            <em className="text-[var(--lv2-muted)]">
              {t('faqHeadingTrail', { competitor: comparison.competitor })}
            </em>
          </h2>
        </div>

        <div className="divide-y divide-[var(--lv2-line)]">
          {comparison.faqs.map(faq => (
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
  )
}

function FinalCta({ comparison }: { comparison: Comparison }) {
  const t = useTranslations('vsShell.slug')
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
          <em className="text-[var(--lv2-accent)]">{comparison.competitor}</em>
          {t('finalHeadingMid')}
          <em className="text-[var(--lv2-accent)]"> {t('finalHeadingTrail')}</em>
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

/* --------------------------- subcomponents --------------------------- */

function Breadcrumbs({ comparison }: { comparison: Comparison }) {
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
        <li>
          <Link className="hover:text-[var(--lv2-fg)]" href="/vs">
            {t('breadcrumbCompare')}
          </Link>
        </li>
        <li aria-hidden="true">
          <CaretRightIcon weight="bold" className="size-3 text-[var(--lv2-muted)]" />
        </li>
        <li aria-current="page" className="text-[var(--lv2-fg)]">
          {t('hub.cardEyebrow', { competitor: comparison.competitor })}
        </li>
      </ol>
    </nav>
  )
}

function SkipLink({ href, label }: { href: string; label: string }) {
  // Tiny in-page anchor pill — gives skimmers (and AI crawlers) the
  // page outline at a glance, and keeps the matrix above the fold
  // without forcing a separate navigation component.
  return (
    <a
      href={href}
      className="rounded-full border border-lv2-line bg-lv2-surface px-3 py-1 text-[var(--lv2-fg-soft)] transition-colors hover:border-lv2-line-strong hover:text-[var(--lv2-fg)]"
    >
      {label}
    </a>
  )
}

function ComparisonJsonLd({ comparison, locale }: { comparison: Comparison; locale: AppLocale }) {
  const canonical = localizedCanonical(`/vs/${comparison.slug}`, locale)

  // BreadcrumbList — Home › Compare › Duet vs {competitor}. Matches
  // the visible breadcrumb exactly so on-page and crawler see the
  // same trail.
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    '@id': `${canonical}#breadcrumb`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: LANDER_ORIGIN },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Compare',
        item: `${LANDER_ORIGIN}/vs`,
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: `Duet vs ${comparison.competitor}`,
        item: canonical,
      },
    ],
  }

  // Article — the comparison page is editorial content. `dateModified`
  // is the canonical freshness signal Google uses to rank comparison
  // queries, so it must match the visible "Updated" stamp at the top
  // of the page.
  const article = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    '@id': `${canonical}#article`,
    headline: comparison.h1,
    description: comparison.metaDescription,
    url: canonical,
    dateModified: comparison.lastUpdated,
    datePublished: comparison.lastUpdated,
    author: {
      '@type': 'Organization',
      name: 'Duet',
      url: LANDER_ORIGIN,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Duet',
      url: LANDER_ORIGIN,
      logo: {
        '@type': 'ImageObject',
        url: `${LANDER_ORIGIN}/landing/duet-lander-image.jpg`,
      },
    },
    image: [`${LANDER_ORIGIN}/landing/duet-lander-image.jpg`],
  }

  // FAQPage — every comparison ships a focused FAQ block. The
  // strings are the same ones rendered above so on-page and crawler
  // see the same answers.
  const faqPage = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${canonical}#faq`,
    mainEntity: comparison.faqs.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  }

  // Product comparison structure — encodes the entity graph so AI
  // search engines understand "Duet" and "<Competitor>" are real
  // SoftwareApplications being compared in this article.
  const competitorEntity = {
    '@type': 'SoftwareApplication',
    '@id': `${comparison.competitorUrl}#product`,
    name: comparison.competitor,
    url: comparison.competitorUrl,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
  }

  const comparisonGraph = {
    '@context': 'https://schema.org',
    '@graph': [
      DUET_PRODUCT_ENTITY,
      competitorEntity,
      // ItemList glues the two entities to this page's URL so Google
      // sees the comparison relationship rather than two unrelated
      // SoftwareApplication nodes.
      {
        '@type': 'ItemList',
        '@id': `${canonical}#comparison`,
        name: `Duet vs ${comparison.competitor} — feature comparison`,
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            item: { '@id': `${LANDER_ORIGIN}#product` },
          },
          {
            '@type': 'ListItem',
            position: 2,
            item: { '@id': `${comparison.competitorUrl}#product` },
          },
        ],
      },
    ],
  }

  return (
    <>
      {/* safeJsonLd escapes `<` to `\u003c` per Next.js docs so any
          future field containing `</script>` can't break out of the
          surrounding tag. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqPage) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(comparisonGraph) }}
      />
    </>
  )
}
