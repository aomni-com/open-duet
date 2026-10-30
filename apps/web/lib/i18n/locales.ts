import { defaultLocale, locales, type AppLocale } from '@/i18n/routing'

export { defaultLocale, locales, type AppLocale }

export const localeMetadata: Record<
  AppLocale,
  { htmlLang: string; label: string; compactLabel: string }
> = {
  en: { htmlLang: 'en', label: 'English', compactLabel: 'EN' },
  'es-419': { htmlLang: 'es-419', label: 'Español', compactLabel: 'ES' },
}

const localeSet = new Set<string>(locales)

export function isAppLocale(value: string | undefined | null): value is AppLocale {
  return typeof value === 'string' && localeSet.has(value)
}
