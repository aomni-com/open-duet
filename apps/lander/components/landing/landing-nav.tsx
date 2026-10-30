'use client'

import {
  ArrowRightIcon,
  CaretDownIcon,
  FileTextIcon,
  type Icon as PhosphorIcon,
  ListIcon,
  MegaphoneIcon,
  MoonIcon,
  PenNibIcon,
  SunIcon,
  TargetIcon,
  UserIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useLocale, useTranslations } from 'next-intl'
import { useTheme } from 'next-themes'
import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { USE_CASE_NAV_ENTRIES } from '@/components/landing/use-cases/use-cases-nav'
import { Link, usePathname } from '@/i18n/navigation'
import { type AppLocale, defaultLocale, isAppLocale } from '@/lib/i18n/locales'
import { productHref } from '@/src/config/origins'

/**
 * Light/dark theme toggle for the landing nav. next-themes sets the
 * .dark class on the html root, which the lander's `.dark .landing-v2`
 * token override picks up. Mounted gate prevents the hydration flicker
 * between server (no theme info) and client (resolved theme).
 */
function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const t = useTranslations('nav')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return <div className="size-9" aria-hidden="true" />
  }

  const isDark = resolvedTheme === 'dark'

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? t('switchToLight') : t('switchToDark')}
      className="lv2-nav-chip lv2-nav-chip-icon lv2-nav-chip-ghost"
    >
      {isDark ? (
        <SunIcon weight="duotone" className="size-5" />
      ) : (
        <MoonIcon weight="duotone" className="size-5" />
      )}
    </button>
  )
}

type LandingNavProps = {
  /** Href the logo links to. Defaults to `/`. */
  homeHref?: string
  /** Keep the nav sticky with a subtle backdrop. Use on content pages. */
  sticky?: boolean
}

const LINKS: readonly { key: 'pricing' | 'guides' | 'blog'; href: string }[] = [
  { key: 'pricing', href: '/pricing' },
  { key: 'guides', href: '/guides' },
  { key: 'blog', href: '/blog' },
] as const

/** Map icon name → Phosphor component for the use-case nav entries. */
const NAV_ICON_MAP: Record<string, PhosphorIcon> = {
  FileText: FileTextIcon,
  PenNib: PenNibIcon,
  User: UserIcon,
  Target: TargetIcon,
  Megaphone: MegaphoneIcon,
}

/**
 * Use-cases dropdown menu — two-column mega-menu built from
 * `USE_CASE_NAV_ENTRIES`. Left column lists personas with icon +
 * title + subtitle; right column shows a contextual preview (image +
 * headline + body) for the hovered/focused entry. Rendered on
 * hover/focus on desktop; the mobile sheet expands an inline list.
 */
function UseCasesDropdown({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false)
  const [hoveredSlug, setHoveredSlug] = useState<string>(USE_CASE_NAV_ENTRIES[0]?.slug ?? '')
  const t = useTranslations('nav')
  const localeFromHook = useLocale()
  const activeLocale: AppLocale = isAppLocale(localeFromHook) ? localeFromHook : defaultLocale
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mouse-leave delays close by 120ms so the user can drag the cursor
  // diagonally from the trigger into the menu without it snapping shut.
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 120)
  }
  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  useEffect(() => () => cancelClose(), [])

  const previewEntry =
    USE_CASE_NAV_ENTRIES.find(p => p.slug === hoveredSlug) ?? USE_CASE_NAV_ENTRIES[0]

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
      onFocus={() => setOpen(true)}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false)
      }}
    >
      {/* Trigger is a button, not a link — clicking it only toggles the
          dropdown. Users navigate via the "All use cases" footer link
          or by picking a specific persona. This avoids the bad UX of
          opening the menu AND navigating in the same click. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn('lv2-nav-chip', active && 'lv2-nav-chip-active', 'pr-3')}
      >
        {t('useCases')}
        <CaretDownIcon
          weight="bold"
          aria-hidden="true"
          className={cn('size-3 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {/* Two-column mega-dropdown. Left: persona list. Right: preview panel.
          A small gap (pt-2) above lets the cursor cross without triggering
          the close timer. */}
      {open ? (
        <div
          role="menu"
          aria-label={t('useCases')}
          className="absolute left-1/2 top-full z-30 w-[640px] -translate-x-1/2 pt-2"
        >
          <div
            className={cn(
              'overflow-hidden rounded-2xl shadow-[0_18px_48px_-12px_hsl(216_60%_4%/0.45)]',
              'border border-[hsl(218_42%_14%/0.08)] bg-[hsl(210_30%_99%)]',
              'dark:border-[hsl(40_28%_94%/0.12)] dark:bg-[hsl(216_28%_14%)]',
            )}
          >
            <div className="flex">
              {/* Left column — persona list */}
              <div className="flex w-[280px] shrink-0 flex-col gap-1 p-3">
                {USE_CASE_NAV_ENTRIES.map(p => {
                  const Icon = NAV_ICON_MAP[p.navIcon] ?? FileTextIcon
                  const isActive = p.slug === hoveredSlug
                  return (
                    <Link
                      key={p.slug}
                      role="menuitem"
                      href={`/use-cases/${p.slug}`}
                      onMouseEnter={() => setHoveredSlug(p.slug)}
                      onFocus={() => setHoveredSlug(p.slug)}
                      className={cn(
                        'flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors',
                        isActive
                          ? 'border border-[hsl(214_65%_50%/0.3)] bg-[hsl(214_70%_95%)]'
                          : 'border border-transparent hover:bg-[hsl(214_30%_94%)]',
                        isActive
                          ? 'dark:border-[hsl(214_55%_50%/0.35)] dark:bg-[hsl(214_55%_20%)]'
                          : 'dark:hover:bg-[hsl(216_28%_20%)]',
                      )}
                    >
                      {/* Icon badge */}
                      <span
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-lg',
                          isActive ? 'bg-white shadow-sm' : 'bg-[hsl(214_30%_94%)]',
                          'dark:bg-[hsl(216_28%_22%)]',
                        )}
                      >
                        <Icon
                          weight="regular"
                          className={cn(
                            'size-4',
                            isActive ? 'text-[hsl(214_65%_50%)]' : 'text-[hsl(218_20%_50%)]',
                            !isActive && 'dark:text-[hsl(40_22%_60%)]',
                          )}
                        />
                      </span>
                      {/* Labels */}
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block text-sm font-semibold leading-snug',
                            isActive ? 'text-[hsl(214_65%_45%)]' : 'text-[hsl(218_30%_20%)]',
                            isActive
                              ? 'dark:text-[hsl(214_78%_66%)]'
                              : 'dark:text-[hsl(40_28%_90%)]',
                          )}
                        >
                          {p.navLabel[activeLocale]}
                        </span>
                        <span
                          className={cn(
                            'block truncate text-xs text-[hsl(218_20%_50%)]',
                            'dark:text-[hsl(40_14%_56%)]',
                          )}
                        >
                          {p.navSubtitle[activeLocale]}
                        </span>
                      </span>
                    </Link>
                  )
                })}
              </div>

              {/* Divider */}
              <div
                className={cn(
                  'w-px self-stretch bg-[hsl(218_42%_14%/0.08)]',
                  'dark:bg-[hsl(40_28%_94%/0.08)]',
                )}
              />

              {/* Right column — preview panel */}
              <div className="flex flex-1 flex-col p-4">
                <div className="relative mb-3 aspect-video w-full overflow-hidden rounded-xl">
                  {previewEntry && (
                    <Image
                      key={previewEntry.slug}
                      src={previewEntry.previewImage}
                      alt={previewEntry.navLabel[activeLocale]}
                      fill
                      className="object-cover transition-opacity duration-200"
                      sizes="320px"
                    />
                  )}
                </div>
                {previewEntry && (
                  <>
                    <p
                      className={cn(
                        'text-sm font-bold leading-snug text-[hsl(218_42%_14%)]',
                        'dark:text-[hsl(40_28%_94%)]',
                      )}
                    >
                      {previewEntry.previewHeadline[activeLocale]}
                    </p>
                    <p
                      className={cn(
                        'mt-1 text-xs leading-relaxed text-[hsl(218_20%_50%)]',
                        'dark:text-[hsl(40_14%_56%)]',
                      )}
                    >
                      {previewEntry.previewBody[activeLocale]}
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Footer — All Use Cases */}
            <div
              className={cn(
                'flex items-center justify-between border-t border-[hsl(218_42%_14%/0.08)] bg-[hsl(214_40%_96%)] px-5 py-3',
                'dark:border-[hsl(40_28%_94%/0.08)] dark:bg-[hsl(216_28%_18%)]',
              )}
            >
              <Link
                role="menuitem"
                href="/use-cases"
                className={cn(
                  'text-sm font-semibold text-[hsl(214_65%_50%)] transition-colors hover:text-[hsl(214_65%_40%)]',
                  'dark:text-[hsl(214_78%_66%)] dark:hover:text-[hsl(214_78%_76%)]',
                )}
              >
                {t('allUseCases')}
              </Link>
              <Link
                role="menuitem"
                href="/use-cases"
                aria-label={t('allUseCases')}
                // text-white on the Link forces currentColor for the SVG
                // (Phosphor icons inherit via fill="currentColor"). The icon
                // also sets text-white + [&_*]:fill-white to defeat any global
                // anchor color cascade in the landing styles.
                className={cn(
                  'flex size-8 items-center justify-center rounded-full bg-[hsl(214_65%_50%)] text-white transition-colors',
                  'hover:bg-[hsl(214_65%_42%)] hover:text-white',
                )}
              >
                <ArrowRightIcon weight="bold" className="size-4 text-white [&_*]:fill-white" />
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function LandingNav({ homeHref = '/', sticky = false }: LandingNavProps) {
  const pathname = usePathname() ?? ''
  const t = useTranslations('nav')
  const localeFromHook = useLocale()
  const activeLocale: AppLocale = isAppLocale(localeFromHook) ? localeFromHook : defaultLocale
  const [mobileOpen, setMobileOpen] = useState(false)
  // Track the use-cases group's open state inside the mobile sheet so
  // it can collapse by default and expand inline on tap.
  const [mobileUseCasesOpen, setMobileUseCasesOpen] = useState(false)

  const useCasesActive = pathname === '/use-cases' || pathname.startsWith('/use-cases/')

  // Close the mobile menu on route change so navigating doesn't leave
  // the sheet sitting on top of the new page.
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  // Escape key closes the mobile menu.
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  return (
    <nav
      className={cn(
        'relative z-20 w-full',
        // Sticky variant (content pages) — solid tinted bar with a
        // frosted-glass background, so it reads as a fixed header.
        // No hairline border; the blur alone separates it from the
        // page body. Landing variant is fully transparent; the
        // per-item chips carry all the frost.
        sticky && 'sticky top-0 bg-[color:var(--lv2-bg)]/80 backdrop-blur-md',
      )}
    >
      {/* Mobile: flex with logo on left and right cluster on right.
          Desktop: three-column grid so the middle nav stays visually
          centered to the viewport regardless of side-cluster widths. */}
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4 sm:px-6 md:grid md:grid-cols-3 md:gap-6 md:px-8">
        <Link href={homeHref} className="lv2-hero-ink flex items-center gap-2 justify-self-start">
          <Image
            src="/icons/icon-192.png"
            alt=""
            width={28}
            height={28}
            className="size-7 rounded-md"
            priority
          />
          <span className="text-2xl font-semibold tracking-tight">Duet</span>
        </Link>

        {/* Center nav — desktop only. Mobile equivalents live in the
            hamburger sheet below. The {t('useCases')} dropdown is interleaved
            with the simple links to preserve visual order; the dropdown
            owns its own hover/focus state. */}
        <div className="hidden items-center justify-center gap-2 md:flex">
          <UseCasesDropdown active={useCasesActive} />
          {LINKS.map(l => {
            const active = pathname === l.href || pathname.startsWith(`${l.href}/`)
            return (
              <Link
                key={l.key}
                href={l.href}
                className={cn('lv2-nav-chip', active && 'lv2-nav-chip-active')}
              >
                {t(l.key)}
              </Link>
            )
          })}
        </div>

        <div className="flex items-center justify-end gap-2">
          {/* Theme toggle — desktop only; folds into the mobile sheet. The
              wrapping <div> carries the responsive `hidden md:block` classes
              because the chip's own `display: inline-flex` rule has higher
              specificity than Tailwind's `.hidden`, so putting them on the
              chip itself fails to hide it on mobile. {t('login')} is the
              header's only auth action (the marketing surface converts via
              lead capture, not signup), so it stays on every breakpoint. */}
          <div className="hidden md:block">
            <ThemeToggle />
          </div>
          <a href={productHref('/sign-in')} className="lv2-nav-chip">
            {t('login')}
          </a>
          {/* Hamburger — mobile only. Same specificity caveat applies,
              hence the wrapper. */}
          <div className="md:hidden">
            <button
              type="button"
              onClick={() => setMobileOpen(o => !o)}
              aria-label={mobileOpen ? t('closeMenu') : t('openMenu')}
              aria-expanded={mobileOpen}
              aria-controls="landing-nav-mobile-sheet"
              className="lv2-nav-chip lv2-nav-chip-icon"
            >
              {mobileOpen ? (
                <XIcon weight="bold" className="size-5" />
              ) : (
                <ListIcon weight="bold" className="size-5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile sheet — drops down below the nav bar with the items
          that don't fit on small screens. Backdrop closes on tap. */}
      {mobileOpen && (
        <>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label={t('closeMenu')}
            tabIndex={-1}
            className="fixed inset-0 z-20 cursor-default bg-[hsl(216_60%_4%/0.35)] backdrop-blur-sm md:hidden"
          />
          <div
            id="landing-nav-mobile-sheet"
            role="dialog"
            aria-modal="true"
            className="absolute left-0 right-0 top-full z-30 px-4 pb-4 pt-2 md:hidden"
          >
            <div className="flex flex-col gap-1 rounded-2xl border border-[hsl(218_42%_14%/0.08)] bg-[hsl(210_30%_99%)] p-3 shadow-[0_18px_48px_-12px_hsl(216_60%_4%/0.45)]">
              {/* {t('useCases')} group — expands inline on tap, no separate
                  sheet so navigation stays in one place. The trigger
                  toggles the persona list below it. */}
              <button
                type="button"
                onClick={() => setMobileUseCasesOpen(o => !o)}
                aria-expanded={mobileUseCasesOpen}
                aria-controls="landing-nav-mobile-use-cases"
                className={cn(
                  'flex h-11 items-center justify-between rounded-xl px-3 text-base font-medium transition-colors',
                  useCasesActive
                    ? 'bg-[hsl(214_30%_93%)] text-[hsl(218_42%_14%)]'
                    : 'text-[hsl(218_30%_26%)] hover:bg-[hsl(214_30%_93%)]',
                )}
              >
                <span>{t('useCases')}</span>
                <CaretDownIcon
                  weight="bold"
                  aria-hidden="true"
                  className={cn(
                    'size-4 transition-transform duration-200',
                    mobileUseCasesOpen && 'rotate-180',
                  )}
                />
              </button>
              {mobileUseCasesOpen ? (
                <div
                  id="landing-nav-mobile-use-cases"
                  className="ml-2 mt-0.5 flex flex-col gap-0.5 border-l border-[hsl(218_42%_14%/0.08)] pl-2"
                >
                  {USE_CASE_NAV_ENTRIES.map(p => (
                    <Link
                      key={p.slug}
                      href={`/use-cases/${p.slug}`}
                      className="flex h-10 items-center rounded-lg px-3 text-sm font-medium text-[hsl(218_30%_26%)] transition-colors hover:bg-[hsl(214_30%_93%)] hover:text-[hsl(218_42%_14%)]"
                    >
                      {p.navLabel[activeLocale]}
                    </Link>
                  ))}
                  <Link
                    href="/use-cases"
                    className="flex h-10 items-center rounded-lg px-3 text-sm font-semibold text-[hsl(214_65%_50%)] transition-colors hover:bg-[hsl(214_70%_92%)]"
                  >
                    {t('allUseCases')} →
                  </Link>
                </div>
              ) : null}

              {LINKS.map(l => {
                const active = pathname === l.href || pathname.startsWith(`${l.href}/`)
                return (
                  <Link
                    key={l.key}
                    href={l.href}
                    className={cn(
                      'flex h-11 items-center rounded-xl px-3 text-base font-medium transition-colors',
                      active
                        ? 'bg-[hsl(214_30%_93%)] text-[hsl(218_42%_14%)]'
                        : 'text-[hsl(218_30%_26%)] hover:bg-[hsl(214_30%_93%)]',
                    )}
                  >
                    {t(l.key)}
                  </Link>
                )
              })}
              <div className="mt-1 flex items-center justify-between border-t border-[hsl(218_42%_14%/0.08)] px-3 pt-3">
                <span className="text-sm text-[hsl(218_30%_26%)]">{t('theme')}</span>
                <div className="flex items-center gap-2">
                  <ThemeToggle />
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </nav>
  )
}
