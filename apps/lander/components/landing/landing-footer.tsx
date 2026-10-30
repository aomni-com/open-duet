'use client'

import { useLocale, useTranslations } from 'next-intl'

import { AppStoreBadges } from '@/components/common/app-store-badges'
import { LocaleSwitcher } from '@/components/i18n/locale-switcher'
import { VERTICALS } from '@/components/landing/for/verticals-spec'
import { USE_CASE_NAV_ENTRIES } from '@/components/landing/use-cases/use-cases-nav'
import { getComparison, type Comparison } from '@/components/landing/vs/vs-spec'
import { Link } from '@/i18n/navigation'
import { defaultLocale, isAppLocale, type AppLocale } from '@/lib/i18n/locales'
import { SUPPORT_EMAIL } from '@/lib/public-site-config'
import { productHref } from '@/src/config/origins'

type LandingFooterProps = {
  /** Href the logo + aria-label links to. Defaults to `/`. */
  homeHref?: string
}

// The competitor pages surfaced in the footer. Driven off the same slugs the
// `/vs/*` route + sitemap use, so adding a competitor here is just a slug
// update — competitor display names come from the spec, not a parallel i18n
// key set.
const FOOTER_COMPARISON_SLUGS = ['claude-code', 'cursor', 'codex', 'lovable'] as const

function DuetMark({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img aria-hidden="true" src="/icons/duet-monogram.svg" alt="" className={className} />
  )
}

// Brand badges: a rounded-square accent-blue tile with a white glyph, matching
// the footer reference. The accent token keeps the blue consistent across
// light and dark mode.
function XBadge({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 25 25" fill="none" className={className} aria-hidden="true">
      <rect width="24.4376" height="24.4376" rx="6" fill="var(--lv2-accent)" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.3084 7.7627H7.04688L10.914 12.8439L7.29425 17.1064H8.96666L11.7044 13.8826L14.1353 17.0768H17.3969L13.4174 11.8479L13.4245 11.857L16.8508 7.82205H15.1784L12.634 10.8184L10.3084 7.7627ZM8.8472 8.65258H9.86256L15.5966 16.1869H14.5812L8.8472 8.65258Z"
        fill="#fff"
      />
    </svg>
  )
}

function LinkedInBadge({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 25 25" fill="none" className={className} aria-hidden="true">
      <rect width="24.4376" height="24.4376" rx="6" fill="var(--lv2-accent)" />
      <path d="M9.45808 10.4966H7.35547V17.2017H9.45808V10.4966Z" fill="#fff" />
      <path
        d="M15.145 10.3509C15.0674 10.3412 14.9851 10.3363 14.9027 10.3315C13.7254 10.2831 13.0617 10.9807 12.8292 11.2811C12.7662 11.3634 12.7371 11.4119 12.7371 11.4119V10.5156H10.7266V17.2207H12.7371H12.8292C12.8292 16.5376 12.8292 15.8593 12.8292 15.1762C12.8292 14.808 12.8292 14.4398 12.8292 14.0716C12.8292 13.6162 12.7953 13.1318 13.023 12.7151C13.2168 12.3663 13.5656 12.1919 13.958 12.1919C15.1207 12.1919 15.145 13.2432 15.145 13.3401C15.145 13.3449 15.145 13.3498 15.145 13.3498V17.2498H17.2476V12.875C17.2476 11.378 16.4869 10.4962 15.145 10.3509Z"
        fill="#fff"
      />
      <path
        d="M8.40837 9.62924C9.08264 9.62924 9.62925 9.08264 9.62925 8.40837C9.62925 7.7341 9.08264 7.1875 8.40837 7.1875C7.7341 7.1875 7.1875 7.7341 7.1875 8.40837C7.1875 9.08264 7.7341 9.62924 8.40837 9.62924Z"
        fill="#fff"
      />
    </svg>
  )
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-lv2-fg/60 mb-3 text-[11px] font-semibold uppercase tracking-[0.18em]">
        {title}
      </h3>
      <ul className="space-y-2 text-[13px]" role="list">
        {children}
      </ul>
    </div>
  )
}

export function LandingFooter({ homeHref = '/' }: LandingFooterProps) {
  const year = new Date().getFullYear()
  const nav = useTranslations('nav')
  const footer = useTranslations('footer')
  const t = useTranslations('marketingFooter')
  const localeFromHook = useLocale()
  const activeLocale: AppLocale = isAppLocale(localeFromHook) ? localeFromHook : defaultLocale

  const featuredComparisons = FOOTER_COMPARISON_SLUGS.map(slug => getComparison(slug)).filter(
    (comparison): comparison is Comparison => comparison !== undefined,
  )

  return (
    <footer className="relative z-10 border-t border-lv2-line">
      {/*
       * SEO note: the `/use-cases/*`, `/for/*`, and `/vs/*` deep links below
       * are intentional. Google Search Console showed those routes stuck in
       * "Discovered — not indexed" for 40-80 days when nothing on the
       * marketing tree linked to them directly — the hub pages were the only
       * crawl entry points. Sitewide footer anchors give every page a path to
       * the leaf URLs and let Googlebot prioritise the crawl. Labels are
       * sourced from the same specs the navbar and hubs use, so there's one
       * source of truth per persona/vertical/competitor. `data-nosnippet`
       * keeps the link wall out of search snippets.
       */}
      <div
        data-nosnippet
        className="mx-auto grid max-w-7xl grid-cols-2 gap-x-8 gap-y-10 px-6 py-12 sm:grid-cols-3 md:px-8 lg:grid-cols-[1.4fr_repeat(6,1fr)]"
      >
        <div className="col-span-2 sm:col-span-3 lg:col-span-1">
          <Link
            href={homeHref}
            className="text-lv2-fg inline-flex items-center gap-2"
            aria-label={footer('homeAria')}
          >
            <DuetMark className="size-5" />
            <span className="text-base font-semibold tracking-tight">Duet</span>
          </Link>
          <div className="mt-4 flex items-center gap-2">
            <a
              href="https://www.linkedin.com/company/duet-chat/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex transition-opacity hover:opacity-80"
              aria-label={footer('linkedinAria')}
            >
              <LinkedInBadge className="size-7" />
            </a>
            <a
              href="https://x.com/duetchat"
              target="_blank"
              rel="noreferrer"
              className="inline-flex transition-opacity hover:opacity-80"
              aria-label={footer('xAria')}
            >
              <XBadge className="size-7" />
            </a>
          </div>
          <div className="mt-5">
            <AppStoreBadges size="sm" />
          </div>
        </div>

        <FooterColumn title={t('product')}>
          <li>
            <a href={productHref('/sign-in?from=footer')} className="lv2-link">
              {t('startFree')}
            </a>
          </li>
          <li>
            <Link href="/pricing" className="lv2-link">
              {t('pricing')}
            </Link>
          </li>
          <li>
            <a href={productHref('/sign-in')} className="lv2-link">
              {nav('login')}
            </a>
          </li>
        </FooterColumn>

        <FooterColumn title={t('useCases')}>
          {USE_CASE_NAV_ENTRIES.map(persona => (
            <li key={persona.slug}>
              <Link href={`/use-cases/${persona.slug}`} className="lv2-link">
                {persona.navLabel[activeLocale]}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/use-cases" className="lv2-link">
              {t('allUseCases')}
            </Link>
          </li>
        </FooterColumn>

        <FooterColumn title={t('industries')}>
          {VERTICALS.map(vertical => (
            <li key={vertical.slug}>
              <Link href={`/for/${vertical.slug}`} className="lv2-link">
                {vertical.audience}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/for" className="lv2-link">
              {t('allIndustries')}
            </Link>
          </li>
        </FooterColumn>

        <FooterColumn title={t('compare')}>
          {featuredComparisons.map(comparison => (
            <li key={comparison.slug}>
              <Link href={`/vs/${comparison.slug}`} className="lv2-link">
                Duet vs {comparison.competitor}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/vs" className="lv2-link">
              {t('seeAllComparisons')}
            </Link>
          </li>
        </FooterColumn>

        <FooterColumn title={t('resources')}>
          <li>
            <Link href="/blog" className="lv2-link">
              {t('blog')}
            </Link>
          </li>
          <li>
            <Link href="/guides" className="lv2-link">
              {t('guides')}
            </Link>
          </li>
          <li>
            <a href="https://docs.duet.so" className="lv2-link">
              {t('apiDocs')}
            </a>
          </li>
          <li>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="lv2-link">
              {footer('support')}
            </a>
          </li>
        </FooterColumn>

        <FooterColumn title={t('legal')}>
          <li>
            <Link href="/terms" className="lv2-link">
              {t('terms')}
            </Link>
          </li>
          <li>
            <Link href="/privacy-policy" className="lv2-link">
              {t('privacy')}
            </Link>
          </li>
          <li>
            <Link href="/data-protection" className="lv2-link">
              {t('dataProtection')}
            </Link>
          </li>
        </FooterColumn>
      </div>

      <div className="border-t border-lv2-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6 sm:flex-row sm:items-center sm:justify-between md:px-8">
          <p className="lv2-folio whitespace-nowrap">
            © {year} Duet · {footer('runByAgents')}
          </p>
          <LocaleSwitcher />
        </div>
      </div>
    </footer>
  )
}
