import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import appEn from '../../messages/en/app.json'
import { WorkLoadingIsland, WorkSessionBodyLoading } from './work-loading'

test('only asking sessions reserve the blocking-input tray', () => {
  const ordinary = renderToStaticMarkup(<WorkSessionBodyLoading label="Loading" />)
  const asking = renderToStaticMarkup(<WorkSessionBodyLoading asking label="Loading" />)

  expect(ordinary).not.toContain('data-work-loading-question')
  expect(asking).toContain('data-work-loading-question="true"')
  expect(asking).toContain('data-session-asking="true"')
})

test('the session skeleton renders a composer footer with safe-area inset and bordered surface', () => {
  const html = renderToStaticMarkup(<WorkSessionBodyLoading label="Loading" />)

  expect(html).toContain('data-work-loading-composer-footer="true"')
  expect(html).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom))]')
  expect(html).toContain('data-work-loading-compose-surface="true"')
  expect(html).toContain('rounded-xl border')
})

test('Work App loading renders a hidden frame placeholder under one announcing status', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <WorkLoadingIsland view="work-app" label="Opening app" />
    </NextIntlClientProvider>,
  )

  expect(html).toContain('data-app-frame-placeholder')
  expect(html).toContain('aria-hidden="true" data-app-frame-placeholder')
  expect(html.match(/role="status"/g)).toHaveLength(1)
})
