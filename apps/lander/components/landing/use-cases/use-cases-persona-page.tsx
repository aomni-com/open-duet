import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import Image from 'next/image'

import { cn } from '@repo/ui/lib/utils'

import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { Link } from '@/i18n/navigation'
import type { AppLocale } from '@/lib/i18n/locales'

import { UseCasesJsonLd } from './use-cases-json-ld'
import { UseCasesSharedCta } from './use-cases-shared-cta'
import { getRelatedPersonas, type UseCasePersona } from './use-cases-spec'

// Format an ISO date (YYYY-MM-DD) as a locale-aware, human-readable
// string for the visible "Last updated" line near the hero. Kept
// inside the component file so we don't have to thread a new utility
// through the i18n layer just for one freshness label.
function formatLastUpdated(iso: string, locale: AppLocale): string {
  // Pin to UTC so the same date string renders regardless of where
  // the build runs — prevents Vercel preview/prod drift around
  // midnight boundaries.
  const date = new Date(`${iso}T00:00:00Z`)
  const intlLocale = locale === 'es-419' ? 'es-419' : 'en-US'
  return new Intl.DateTimeFormat(intlLocale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

type UseCasesPersonaPageProps = {
  persona: UseCasePersona
  locale: AppLocale
}

/**
 * The full reusable persona page shell. Every /use-cases/[slug] route
 * just resolves a persona from the spec and renders this component.
 *
 * Page order is deliberate — pain first (relate), use cases second
 * (show the work), how it works third (de-risk), comparison fourth
 * (anchor the choice), related fifth (cross-pollinate), FAQ sixth
 * (cover objections + drop schema), final CTA last (one-tap close).
 */
export async function UseCasesPersonaPage({ persona, locale }: UseCasesPersonaPageProps) {
  const related = getRelatedPersonas(persona)
  const t = await getTranslations({ locale, namespace: 'useCasesShell' })
  const ctaLabel = persona.primaryCtaLabel ?? t('startFree')

  return (
    <>
      {/* SEO scripts ship server-side so first-byte crawlers see the
          structured data without waiting for hydration. */}
      <UseCasesJsonLd slug={persona.slug} name={persona.name} faqs={persona.faqs} />

      <LandingNav sticky />

      {/* HERO — subtle radial gradient does the dramatic work, no
          heavy agent viz. Keeps these persona pages lighter than the
          main landing page. */}
      <section
        aria-labelledby="persona-hero-heading"
        className="relative overflow-hidden px-4 pb-20 pt-16 sm:px-6 sm:pt-20 lg:px-8 lg:pb-28 lg:pt-28"
      >
        {/* Soft daylight gradient — brand blue diffused through the
            porcelain so the hero has presence without going dark. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-32 -z-10 h-[480px] bg-[radial-gradient(ellipse_at_top,var(--lv2-accent-soft),transparent_70%)]"
        />

        <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
          <span className="lv2-eyebrow mb-5">{persona.eyebrow}</span>

          <h1
            id="persona-hero-heading"
            className="text-balance text-5xl font-semibold leading-[1.02] tracking-tight text-[var(--lv2-fg)] sm:text-6xl lg:text-7xl"
            style={serifStyle}
          >
            <span className="block font-sans tracking-tight">{persona.h1Lead}</span>
            {/* Serif italic highlight — `serifStyle` is already on the
                parent <h1>, but explicit italic + accent here keeps the
                styling readable even if a future refactor swaps the
                wrapper. */}
            <span className="mt-2 block italic text-[var(--lv2-accent)]" style={serifStyle}>
              {persona.h1Highlight}
            </span>
          </h1>

          <p className="mt-7 max-w-2xl text-balance text-lg leading-relaxed text-[var(--lv2-fg-soft)] sm:text-xl">
            {persona.heroDescription}
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <UseCasesSharedCta size="lg" halo>
              {ctaLabel}
            </UseCasesSharedCta>
            <Link
              href="/use-cases"
              className="group inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
            >
              {t('readAllUseCases')}
              <ArrowRightIcon
                weight="bold"
                className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </Link>
          </div>

          {/* Visible freshness marker — helps Google/AI overviews see
              the page is maintained (I/O 2026 adapt). Kept quiet so it
              doesn't compete with the H1 or the CTA row. */}
          <p
            className="mt-6 text-xs uppercase tracking-[0.18em] text-[var(--lv2-muted)]"
            // Datetime is the canonical ISO form so machine readers
            // pick up the freshness signal without depending on the
            // localized human string.
          >
            <time dateTime={persona.lastUpdated}>
              {t('lastUpdatedLabel', { date: formatLastUpdated(persona.lastUpdated, locale) })}
            </time>
          </p>

          {/* Editorial hero illustration — monochrome stippled, starry
              style that matches the blog covers. Visual capstone of the
              hero block; below the H1 so the headline still wins the
              first scroll. Sized 1792×1008 (16:9) so `aspect-video`
              just works. */}
          <div className="relative mt-14 w-full max-w-3xl aspect-video overflow-hidden rounded-2xl border border-lv2-line shadow-lv2-card">
            <Image
              src={`/use-cases/${persona.slug}.webp`}
              alt={`Use cases for ${persona.name.toLowerCase()} — Duet AI coworker illustration`}
              fill
              sizes="(min-width: 1024px) 768px, (min-width: 640px) 90vw, 100vw"
              className="object-cover"
              // ~200KB monochrome ASCII PNG — already small; skip the
              // optimizer (which was failing PR-preview deploys).
              unoptimized
            />
          </div>
        </div>
      </section>

      {/* DEFINITIONAL ANSWER — bold H2 + 2-3 sentence answer to
          "What is an AI coworker for <persona>?". Designed to feed
          Google AI Overview / Perplexity definitional citations
          (I/O 2026 adapt). Skips silently when the persona spec
          hasn't shipped a definition yet so older personas don't
          render an empty block. */}
      {persona.definition ? (
        <section
          aria-labelledby="persona-definition-heading"
          className="px-4 pb-4 pt-2 sm:px-6 lg:px-8"
        >
          <div className="mx-auto max-w-3xl">
            <h2
              id="persona-definition-heading"
              className="text-balance text-2xl font-bold leading-snug tracking-tight text-[var(--lv2-fg)] sm:text-3xl"
            >
              {t('definitionHeading', { persona: persona.name.toLowerCase() })}
            </h2>
            <p className="mt-4 max-w-[68ch] text-base leading-relaxed text-[var(--lv2-fg-soft)] sm:text-lg">
              {persona.definition}
            </p>
          </div>
        </section>
      ) : null}

      {/* PAIN — three cards. Eye lands on the quote first, then the
          body sentence reframes the pain as a job Duet does. */}
      <section
        aria-labelledby="persona-pain-heading"
        className="bg-lv2-band-cool relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
      >
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 max-w-2xl">
            <span className="lv2-eyebrow">{t('whatWeHear')}</span>
            <h2
              id="persona-pain-heading"
              className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
              style={serifStyle}
            >
              {t('painHeadingLead')}{' '}
              <em className="text-[var(--lv2-muted)]">{t('painHeadingTail')}</em>
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {persona.painCards.map(card => (
              <article
                key={card.title}
                className="flex flex-col gap-4 rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card"
              >
                <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                  {card.title}
                </h3>
                {/* Persona's voice — italic serif quote sits as the
                    relatable hook. */}
                <p
                  className="text-base italic leading-snug text-[var(--lv2-fg-soft)]"
                  style={serifStyle}
                >
                  {card.quote}
                </p>
                <p className="text-sm leading-relaxed text-[var(--lv2-muted)]">{card.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* USE CASES — 4-up grid. Each card shows a real prompt in a
          code block + a time-saved chip. This is the page's beating
          heart — show the actual job. */}
      <section
        aria-labelledby="persona-use-cases-heading"
        className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
      >
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 max-w-2xl">
            <span className="lv2-eyebrow">{t('whatDuetDoes')}</span>
            <h2
              id="persona-use-cases-heading"
              className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
              style={serifStyle}
            >
              {t('useCasesHeadingLead')}{' '}
              <em className="text-[var(--lv2-accent)]">{t('useCasesHeadingTail')}</em>
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {persona.useCases.map((uc, idx) => (
              <article
                key={uc.id}
                className="group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card"
              >
                {/* Watermark numeral — quiet brand-blue serif numeral
                    in the corner mirrors the marketing-page chapter
                    style without taking over the card. */}
                <span
                  aria-hidden="true"
                  className="lv2-numeral pointer-events-none absolute right-5 top-3 text-5xl opacity-[0.08]"
                >
                  {String(idx + 1).padStart(2, '0')}
                </span>

                <h3 className="relative z-10 max-w-[28ch] text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                  {uc.title}
                </h3>

                {/* Prompt — styled like a Duet command. Dark code-on-paper
                    in light mode flips via the lv2 code tokens. */}
                <pre className="relative z-10 overflow-x-auto rounded-xl bg-[var(--lv2-code-bg)] p-4 text-[13px] leading-relaxed text-[var(--lv2-code-fg)]">
                  <code className="font-mono">{uc.prompt}</code>
                </pre>

                {/* Time-saved chip — brand-blue pill, low-key but unmissable. */}
                <span
                  className={cn(
                    'relative z-10 inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium',
                    'bg-[var(--lv2-accent-soft)] text-[var(--lv2-accent-strong)]',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-[var(--lv2-accent)]"
                  />
                  {uc.outcome}
                </span>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS — three numbered steps. */}
      <section
        aria-labelledby="persona-how-it-works-heading"
        className="bg-lv2-band-warm relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
      >
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 max-w-2xl">
            <span className="lv2-eyebrow">{t('howItWorks')}</span>
            <h2
              id="persona-how-it-works-heading"
              className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
              style={serifStyle}
            >
              {t('ourThreeStepsHeading')}
            </h2>
          </div>

          <ol className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {persona.howItWorks.map(step => (
              <li
                key={step.step}
                className="flex flex-col gap-3 rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card"
              >
                <span className="lv2-numeral text-5xl">{String(step.step).padStart(2, '0')}</span>
                <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                  {step.title}
                </h3>
                <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* COMPARISON — Without Duet | With Duet, four bullets each. */}
      <section
        aria-labelledby="persona-comparison-heading"
        className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
      >
        <div className="mx-auto max-w-5xl">
          <div className="mb-10 max-w-2xl">
            <span className="lv2-eyebrow">{t('beforeAndAfter')}</span>
            <h2
              id="persona-comparison-heading"
              className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
              style={serifStyle}
            >
              {t('comparisonHeadingLead')}{' '}
              <em className="text-[var(--lv2-accent)]">{t('comparisonHeadingTail')}</em>
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <article
              aria-label={t('withoutDuet')}
              className="flex flex-col gap-4 rounded-2xl border border-lv2-line bg-lv2-surface-alt p-6"
            >
              <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-[var(--lv2-muted)]">
                <XCircleIcon
                  weight="duotone"
                  className="size-5 text-[var(--lv2-muted)]"
                  aria-hidden="true"
                />
                {t('withoutDuet')}
              </h3>
              <ul className="space-y-3">
                {persona.comparison.without.map(item => (
                  <li
                    key={item}
                    className="flex gap-2.5 text-sm leading-relaxed text-[var(--lv2-fg-soft)]"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--lv2-line-strong)]"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>

            <article
              aria-label={t('withDuet')}
              className="flex flex-col gap-4 rounded-2xl border border-[var(--lv2-accent-strong)]/40 bg-lv2-surface p-6 shadow-lv2-card"
            >
              <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-[var(--lv2-accent-strong)]">
                <CheckCircleIcon
                  weight="duotone"
                  className="size-5 text-[var(--lv2-accent)]"
                  aria-hidden="true"
                />
                {t('withDuet')}
              </h3>
              <ul className="space-y-3">
                {persona.comparison.with.map(item => (
                  <li
                    key={item}
                    className="flex gap-2.5 text-sm leading-relaxed text-[var(--lv2-fg)]"
                  >
                    <CheckCircleIcon
                      weight="fill"
                      className="mt-0.5 size-4 shrink-0 text-[var(--lv2-accent)]"
                      aria-hidden="true"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          </div>
        </div>
      </section>

      {/* SUB-USE-CASES — leaf-level long-tail pages under this persona.
          Only renders when the persona has shipped leaves; empty
          arrays just hide the section so unfinished personas don't
          show a sad empty grid. Each card links down to
          /use-cases/<persona>/<leaf>. */}
      {persona.leaves.length > 0 ? (
        <section
          aria-labelledby="persona-sub-use-cases-heading"
          className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
        >
          <div className="mx-auto max-w-6xl">
            <div className="mb-12 max-w-2xl">
              <span className="lv2-eyebrow">{t('subUseCases')}</span>
              <h2
                id="persona-sub-use-cases-heading"
                className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
                style={serifStyle}
              >
                {t('leavesHeadingLead')}{' '}
                <em className="text-[var(--lv2-accent)]">{t('leavesHeadingTail')}</em>
              </h2>
              <p className="mt-4 max-w-[60ch] text-base leading-relaxed text-[var(--lv2-fg-soft)]">
                {t('leavesIntroLead')}{' '}
                <Link
                  href="/use-cases/by-job"
                  className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
                >
                  /use-cases/by-job
                </Link>
                .
              </p>
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {persona.leaves.map(leaf => (
                <Link
                  key={leaf.slug}
                  href={`/use-cases/${persona.slug}/${leaf.slug}`}
                  className="group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-lv2-line-strong"
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
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* RELATED — two cross-link cards into other personas. Keeps the
          section internally linked for SEO and keeps the reader on
          the site if their persona doesn't quite match. */}
      {related.length > 0 ? (
        <section
          aria-labelledby="persona-related-heading"
          className="bg-lv2-band-cool relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
        >
          <div className="mx-auto max-w-5xl">
            <h2
              id="persona-related-heading"
              className="mb-3 text-2xl font-semibold tracking-tight text-[var(--lv2-fg)] sm:text-3xl"
              style={serifStyle}
            >
              {t('relatedNotQuiteYouLead')}{' '}
              <em className="text-[var(--lv2-muted)]">{t('relatedNotQuiteYouTail')}</em>
            </h2>
            {/* Cross-axis prompt — links into the by-job tree so
                visitors who don't see their role in the related-
                personas grid can pivot to browsing by task. Keeps the
                section internally linked across both axes. */}
            <p className="mb-8 max-w-[60ch] text-sm leading-relaxed text-[var(--lv2-fg-soft)] sm:text-base">
              {t('relatedSkipRoleLead')}{' '}
              <Link
                href="/use-cases/by-job"
                className="font-medium text-[var(--lv2-fg)] underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
              >
                {t('browseUseCasesByJob')}
              </Link>
              .
            </p>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {related.map(p => (
                <Link
                  key={p.slug}
                  href={`/use-cases/${p.slug}`}
                  className="group flex flex-col gap-3 rounded-2xl border border-lv2-line bg-lv2-surface p-6 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-lv2-line-strong"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="lv2-eyebrow">{p.shortName}</span>
                    <ArrowUpRightIcon
                      weight="bold"
                      className="size-4 text-[var(--lv2-muted)] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                      aria-hidden="true"
                    />
                  </div>
                  <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                    {p.name}
                  </h3>
                  <p className="text-sm text-[var(--lv2-muted)]">{p.primaryKeyword}</p>
                </Link>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* FAQ — visible semantic Q&A. The matching FAQPage JSON-LD
          shipped via `<UseCasesJsonLd>` at the top of the page so the
          on-screen list and the schema stay in lockstep. */}
      <section
        aria-labelledby="persona-faq-heading"
        className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
      >
        <div className="mx-auto max-w-3xl">
          <div className="mb-10">
            <span className="lv2-eyebrow">{t('faq')}</span>
            <h2
              id="persona-faq-heading"
              className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
              style={serifStyle}
            >
              {t('faqHeadingLead')}{' '}
              <em className="text-[var(--lv2-muted)]">{t('faqHeadingTail')}</em>
            </h2>
          </div>

          <div className="divide-y divide-[var(--lv2-line)]">
            {persona.faqs.map(faq => (
              <details
                key={faq.q}
                // Native <details> is keyboard-accessible without
                // extra JS. Visible Q&A also helps crawlers confirm
                // the FAQPage schema we ship in the head.
                className="group py-5"
              >
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

      {/* FINAL CTA — one-tap close, full-width band. */}
      <section
        aria-labelledby="persona-final-cta-heading"
        className="relative overflow-hidden px-4 py-24 text-center sm:px-6 sm:py-32 lg:px-8"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full bg-[radial-gradient(ellipse_at_center,var(--lv2-accent-soft),transparent_60%)]"
        />
        <div className="mx-auto max-w-3xl">
          <h2
            id="persona-final-cta-heading"
            className="text-4xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-5xl"
            style={serifStyle}
          >
            {t('ctaPersonaHeadingLead')}{' '}
            <em className="text-[var(--lv2-accent)]">{t('ctaPersonaHeadingMid')}</em>{' '}
            {t('ctaPersonaHeadingTail')}
          </h2>
          <p className="mt-5 text-lg text-[var(--lv2-fg-soft)]">{t('ctaPersonaBody')}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <UseCasesSharedCta size="lg" halo magnetic>
              {ctaLabel}
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

      <LandingFooter />
    </>
  )
}
