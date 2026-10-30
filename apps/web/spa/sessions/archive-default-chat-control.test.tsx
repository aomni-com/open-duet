/* ============================================================================
   The archive control's words, in every locale that ships.

   The failure this guards is silent by construction: next-intl falls back to
   the English catalogue for a key a locale is missing, so a Spanish reader gets
   an English button and nothing anywhere goes red. The surface's own copy test
   only ever loads `en`, and the confirm renders through a portal — which is
   nothing at all on a server pass — so neither of them can see this.
   ========================================================================= */
import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import en from '../../messages/en/app.json'
import es from '../../messages/es-419/app.json'
import { ArchiveDefaultChatButton } from './archive-default-chat-control'

const LOCALES = [
  ['en', en],
  ['es-419', es],
] as const

test('the archive control is labelled in each locale’s own words', () => {
  for (const [locale, messages] of LOCALES) {
    const complaints: string[] = []
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="UTC"
        onError={error => complaints.push(error.message)}
      >
        <ArchiveDefaultChatButton disabled={false} onClick={() => {}} />
      </NextIntlClientProvider>,
    )
    expect(complaints).toEqual([])
    expect(html).toContain(messages.duetApp.agentSurface.archiveChat)
  }
})

test('the English archive control uses the short label', () => {
  expect(en.duetApp.agentSurface.archiveChat).toBe('archive')
})

/* The confirm cannot be rendered here — it is portalled, so a server pass draws
   none of it and a test that asserted over the markup would report zero missing
   keys by drawing zero of them. Its catalogue is what gets checked instead. */
test('the confirm says the same things in both catalogues', () => {
  const [enArchive, esArchive] = LOCALES.map(
    ([, messages]) => messages.duetApp.agentSurface.archive,
  )
  expect(Object.keys(esArchive!).sort()).toEqual(Object.keys(enArchive!).sort())
})

/* The agent's name is named in the reassurance — "anything {name} is working on
   right now keeps running" — and a translation that drops the placeholder drops
   the half of the sentence that says the work survives. */
test('both catalogues still name the agent in the reassurance', () => {
  for (const [, messages] of LOCALES) {
    expect(messages.duetApp.agentSurface.archive.body).toContain('{name}')
  }
})
