import { hasLocale, NextIntlClientProvider } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { locales } from '@/i18n/routing'

export function generateStaticParams() {
  return locales.map(locale => ({ locale }))
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  if (!hasLocale(locales, locale)) {
    notFound()
  }

  // `setRequestLocale` keeps this segment statically renderable per
  // locale. The prop-less `<NextIntlClientProvider>` (next-intl 4.x
  // recommended pattern) reads locale + messages lazily from the
  // `getRequestConfig` context that `setRequestLocale` populated, so we
  // don't have to call `getMessages()` ourselves — next-intl forwards
  // only the slices client components in this tree actually use.
  setRequestLocale(locale)

  return (
    <NextIntlClientProvider>
      <LocaleHtmlLang locale={locale} />
      {children}
    </NextIntlClientProvider>
  )
}

// `<html lang>` is hardcoded to `en` in root layout to stay static. For
// /es/* pages, override the attribute via a tiny inline script so
// screen readers and `:lang(es)` selectors see the correct locale
// without forcing dynamic rendering on the whole tree.
function LocaleHtmlLang({ locale }: { locale: string }) {
  if (locale === 'en') return null
  const safeLocale = JSON.stringify(locale)
  return (
    <script
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{
        __html: `document.documentElement.lang=${safeLocale}`,
      }}
    />
  )
}
