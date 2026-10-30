'use client'

import { GlobeIcon } from '@phosphor-icons/react'
import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@repo/ui/lib/utils'

import { locales } from '@/i18n/routing'
import {
  defaultLocale,
  isAppLocale,
  localeSwitchPath,
  localeMetadata,
  stripLocaleFromPathname,
} from '@/lib/i18n/locales'
import { persistDuetLocale } from '@/lib/i18n/persist-locale'
import { SPANISH_PUBLIC_PATHS } from '@/src/spanish-public-paths.generated'

const spanishPublicPaths = new Set<string>(SPANISH_PUBLIC_PATHS)

type LocaleSwitcherProps = {
  className?: string
  compact?: boolean
}

export function LocaleSwitcher({ className, compact = false }: LocaleSwitcherProps) {
  const t = useTranslations('localeSwitcher')
  const requestedLocale = useLocale()
  const activeLocale = isAppLocale(requestedLocale) ? requestedLocale : defaultLocale
  const pathname = usePathname() ?? '/'
  const unlocalizedPath = stripLocaleFromPathname(pathname)

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-lv2-line p-1',
        className,
      )}
      aria-label={t('label')}
    >
      {!compact ? <GlobeIcon aria-hidden="true" className="ml-2 size-3.5 text-lv2-muted" /> : null}
      {locales.map(locale => {
        const active = locale === activeLocale
        return (
          <Link
            key={locale}
            href={localeSwitchPath(unlocalizedPath, locale, spanishPublicPaths)}
            hrefLang={active ? undefined : locale}
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              if (locale !== activeLocale) persistDuetLocale(locale)
            }}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-lv2-fg text-lv2-bg'
                : 'text-lv2-muted hover:bg-lv2-surface-alt hover:text-lv2-fg',
            )}
          >
            {compact ? localeMetadata[locale].compactLabel : t(locale)}
          </Link>
        )
      })}
    </div>
  )
}
