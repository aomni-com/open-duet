import { getRequestConfig } from 'next-intl/server'
import { cookies } from 'next/headers'

import { DUET_LOCALE_COOKIE } from '@repo/web-locale'

import { loadProductMessages, resolveProductLocale } from '@/lib/i18n/product-locale'

export default getRequestConfig(async () => {
  const cookieLocale = (await cookies()).get(DUET_LOCALE_COOKIE)?.value
  const locale = resolveProductLocale(cookieLocale)
  return {
    locale,
    timeZone: 'UTC',
    messages: await loadProductMessages(locale),
  }
})
