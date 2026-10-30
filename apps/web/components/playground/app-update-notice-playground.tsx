'use client'

import { NextIntlClientProvider, useTranslations } from 'next-intl'
import { useEffect, useRef } from 'react'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import { appUpdateToast } from '../../spa/shell/app-version'
import { ToastProvider, useToast } from '../../spa/shell/toast'

const MESSAGES_BY_LOCALE = { en: appEn, 'es-419': appEs } as const

export function AppUpdateNoticePlayground({ locale }: { locale: 'en' | 'es-419' }) {
  return (
    <NextIntlClientProvider locale={locale} messages={MESSAGES_BY_LOCALE[locale]} timeZone="UTC">
      {/* The production provider owns where a toast sits — bottom-right on
          desktop, above the mobile tab bar. Posting through it keeps this
          fixture honest about placement instead of restating the rail. */}
      <ToastProvider>
        <UpdateNoticeFixture />
      </ToastProvider>
    </NextIntlClientProvider>
  )
}

function UpdateNoticeFixture() {
  const t = useTranslations('duetAppUpdate')
  const showToast = useToast()
  const posted = useRef(false)

  useEffect(() => {
    if (posted.current) return
    posted.current = true
    showToast(appUpdateToast(t, () => {}))
  }, [showToast, t])

  return <main className="min-h-[100dvh] bg-background" />
}
