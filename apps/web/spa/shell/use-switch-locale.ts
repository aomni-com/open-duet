'use client'

import { useLocale } from 'next-intl'

import type { DuetLocale } from '@repo/web-locale'

import { persistDuetLocale } from '../../lib/i18n/persist-locale'
import { useSpa } from '../context'

/**
 * Persist and apply a locale choice. The SPA host normally supplies a live
 * `onLocaleChange`; without one, a full reload is what re-reads the cookie.
 */
export function useSwitchLocale() {
  const locale = useLocale()
  const { onLocaleChange } = useSpa()
  return (next: DuetLocale) => {
    if (next === locale) return
    persistDuetLocale(next)
    if (onLocaleChange) onLocaleChange(next)
    else window.location.reload()
  }
}
