import { NextIntlClientProvider } from 'next-intl'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'

import { DUET_LOCALE_COOKIE } from '@repo/web-locale'

import { localeMetadata } from '@/lib/i18n/locales'
import { loadProductMessages, resolveProductLocale } from '@/lib/i18n/product-locale'

/**
 * Request-time locale provider for product and identity routes.
 * Only these request-aware routes read DUET_LOCALE; the public locale tree
 * remains URL-owned and statically rendered.
 */
export async function RuntimeIntlProvider({ children }: { children: ReactNode }) {
  const cookieLocale = (await cookies()).get(DUET_LOCALE_COOKIE)?.value
  const locale = resolveProductLocale(cookieLocale)
  const messages = await loadProductMessages(locale)

  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <div className="contents" lang={localeMetadata[locale].htmlLang} data-runtime-locale={locale}>
        {children}
      </div>
    </NextIntlClientProvider>
  )
}
