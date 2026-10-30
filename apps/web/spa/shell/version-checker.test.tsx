import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import en from '../../messages/en/app.json'
import es from '../../messages/es-419/app.json'
import { appUpdateToast } from './app-version'
import { ToastCard } from './toast'

test('the update notice offers a reload in both supported locales', () => {
  for (const [locale, messages] of [
    ['en', en],
    ['es-419', es],
  ] as const) {
    const copy = messages.duetAppUpdate
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ToastCard
          toast={appUpdateToast(
            key => copy[key],
            () => {},
          )}
          onDismiss={() => {}}
        />
      </NextIntlClientProvider>,
    )

    expect(html).toContain(escapeCopy(copy.message))
    expect(html).toContain(escapeCopy(copy.description))
    expect(html).toContain(escapeCopy(copy.action))
    // A reload is an action on this tab, not a destination: an anchor would
    // navigate to a URL the tab is already on and leave the stale code running.
    expect(html).not.toContain(`>${escapeCopy(copy.action)}</a>`)
    expect(html).toContain(`>${escapeCopy(copy.action)}</button>`)
  }
})

test('the update notice requests persistent toast presentation', () => {
  expect(
    appUpdateToast(
      key => key,
      () => {},
    ).persist,
  ).toBe(true)
})

function escapeCopy(copy: string): string {
  return copy.replaceAll('&', '&amp;').replaceAll("'", '&#x27;').replaceAll('"', '&quot;')
}
