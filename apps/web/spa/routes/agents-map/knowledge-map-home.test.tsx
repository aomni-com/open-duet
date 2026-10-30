import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

/* A drive with nothing on the ring is still a drive with Duet on it.

   `listAgents` has never returned Duet — it is the centre, not a ring member —
   so an empty roster is not an empty picture: it is the core, the add slot, and
   the trunk between them. Home used to answer that state with a paragraph, and
   the one drive that got it was the one that had never seen the map. */
import { ROOT_AGENT_SCOPE } from '@repo/contract'

import appEn from '../../../messages/en/app.json'
import type { MapData } from '../../knowledge-map/types'
import { KnowledgeMapHome } from './knowledge-map-home'

const EMPTY: MapData = {
  duet: {
    id: ROOT_AGENT_SCOPE,
    name: 'Acme Studio',
    avatarKey: ROOT_AGENT_SCOPE,
    locked: true,
    jobs: [],
    apps: [],
  },
  coreMeta: 'No agents · no apps',
  agents: [],
}

function renderHome(data: MapData, state: 'loading' | 'error' | 'ready' = 'ready'): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <KnowledgeMapHome data={data} state={state} onOpen={() => {}} onAddAgent={() => {}} />
    </NextIntlClientProvider>,
  )
}

test('an empty supplied roster renders core and add nodes', () => {
  const html = renderHome(EMPTY)

  expect(html).toContain('data-node="core"')
  expect(html).toContain('data-node="add"')
  expect(html).not.toContain('Nothing here yet')
})

/* A map drawn from reads that have not all answered is a map drawn wrong: the
   ring is there and the fans are not, so the picture the reader is given is one
   the drive does not have, and the camera has framed it. The placeholder is the
   *shape* of the map — same centre, same ring, same fit — so what arrives is the
   same composition with the drive's own faces in it, rather than a picture that
   grows two more rows while somebody is looking at it. */
test('supplied loading state renders the map placeholder without the core node', () => {
  const html = renderHome(EMPTY, 'loading')

  expect(html).toContain('data-loading-view="agents-map"')
  expect(html).not.toContain('data-node="core"')
})
