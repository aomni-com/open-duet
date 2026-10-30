import { defaultLocale, locales, type AppLocale } from '@/i18n/routing'

export { defaultLocale, locales, type AppLocale }

export const localeMetadata: Record<
  AppLocale,
  {
    pathPrefix: string
    hreflang: string
    ogLocale: string
    htmlLang: string
    label: string
    compactLabel: string
  }
> = {
  en: {
    pathPrefix: '',
    hreflang: 'en',
    ogLocale: 'en_US',
    htmlLang: 'en',
    label: 'English',
    compactLabel: 'EN',
  },
  'es-419': {
    pathPrefix: '/es',
    hreflang: 'es',
    ogLocale: 'es_LA',
    htmlLang: 'es-419',
    label: 'Español',
    compactLabel: 'ES',
  },
}

export const localePathPrefixes = Object.fromEntries(
  locales
    .map(locale => [localeMetadata[locale].pathPrefix, locale] as const)
    .filter(([prefix]) => prefix),
) as Record<string, AppLocale>

const localeSet = new Set<string>(locales)

export function isAppLocale(value: string | undefined | null): value is AppLocale {
  return typeof value === 'string' && localeSet.has(value)
}

export function getAlternateLocale(locale: AppLocale): AppLocale {
  return locale === defaultLocale ? 'es-419' : defaultLocale
}

export function getLocaleFromPathname(pathname: string): AppLocale {
  const firstSegment = pathname.split('/').filter(Boolean)[0]
  if (isAppLocale(firstSegment)) return firstSegment
  return localePathPrefixes[`/${firstSegment}`] ?? defaultLocale
}

export function stripLocaleFromPathname(pathname: string): string {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`
  const firstSegment = normalized.split('/').filter(Boolean)[0]
  const prefix = firstSegment ? `/${firstSegment}` : ''
  const locale = getLocaleFromPathname(normalized)
  if (locale === defaultLocale && !isAppLocale(firstSegment) && !localePathPrefixes[prefix]) {
    return normalized
  }

  const internalPrefix = isAppLocale(firstSegment) ? `/${firstSegment}` : undefined
  const publicPrefix = localeMetadata[locale].pathPrefix
  const prefixToStrip = internalPrefix ?? publicPrefix
  if (!prefixToStrip) return normalized

  const stripped = normalized.replace(new RegExp(`^${prefixToStrip}(?=/|$)`), '')
  return stripped || '/'
}

export function localizePath(pathname: string, locale: AppLocale): string {
  const unlocalized = stripLocaleFromPathname(pathname)
  const prefix = localeMetadata[locale].pathPrefix
  if (!prefix) return unlocalized
  return unlocalized === '/' ? prefix : `${prefix}${unlocalized}`
}

export function localeSwitchPath(
  pathname: string,
  locale: AppLocale,
  spanishPublicPaths: ReadonlySet<string>,
): string {
  const localized = localizePath(pathname, locale)
  if (locale !== 'es-419' || spanishPublicPaths.has(localized)) return localized
  return localeMetadata['es-419'].pathPrefix
}
