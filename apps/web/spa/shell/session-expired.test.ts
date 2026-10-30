import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { type ComponentType, createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import en from '../../messages/en/app.json'
import { SessionExpired } from './session-expired'

function markup(returnTo: string | undefined): string {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider as ComponentType<{
        locale: string
        messages: typeof en
        children?: ReactNode
        timeZone?: string
      }>,
      { locale: 'en', messages: en, timeZone: 'UTC' },
      createElement(SessionExpired, { returnTo }),
    ),
  )
}

test('the expired-session link encodes its current product page as the sign-in return target', () => {
  const html = markup('/w/dan-test/agents/root/apps/files?tab=recent')

  expect(html).toContain(en.duetApp.unauthorizedTitle)
  expect(html).toContain(
    `href="/sign-in?returnTo=${encodeURIComponent('/w/dan-test/agents/root/apps/files?tab=recent')}"`,
  )
})

test('a page sign-in cannot return to falls back to the product root', () => {
  expect(markup('https://evil.example/phish')).toContain('href="/sign-in?returnTo=%2F"')
  expect(markup(undefined)).toContain('href="/sign-in?returnTo=%2F"')
})
