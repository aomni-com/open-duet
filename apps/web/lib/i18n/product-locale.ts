import { defaultLocale, isAppLocale, type AppLocale } from './locales'

export function resolveProductLocale(cookieLocale: string | undefined): AppLocale {
  return isAppLocale(cookieLocale) ? cookieLocale : defaultLocale
}

export async function loadProductMessages(locale: AppLocale) {
  const auth = (await import(`../../messages/${locale}/auth.json`)).default
  const app = (await import(`../../messages/${locale}/app.json`)).default
  return { ...auth, ...app }
}
