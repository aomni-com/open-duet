import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import appEn from '../../../../messages/en/app.json'
import { SetupStage } from './parts'

test('the supplied setup wait renders initial progress and suppresses its action', () => {
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <SetupStage waiting action={<button type="button">Start setup</button>} />
    </NextIntlClientProvider>,
  )

  expect(markup).toContain('role="status"')
  expect(markup).toContain('We&#x27;re setting up your new agent')
  expect(markup).toContain('Usually ready in about 30 seconds')
  expect(markup).toContain('30 seconds remaining')
  expect(markup).toContain('role="progressbar"')
  expect(markup).toContain('aria-valuenow="0"')
  expect(markup).not.toContain('Start setup')
})

test('setup without an action is a passive owner-or-editor handoff', () => {
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <SetupStage />
    </NextIntlClientProvider>,
  )

  expect(markup).toContain(
    'An owner or editor needs to finish setup before you can use this agent.',
  )
  expect(markup).not.toContain('<button')
  expect(markup).not.toContain('role="progressbar"')
})
