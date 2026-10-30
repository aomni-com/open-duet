/* Initial markup for the supplied drawer state. Browser coverage owns
   visibility, keyboard access and the control's mounted interaction. */
import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import appEn from '../../../../messages/en/app.json'
import { AgentsRail, type AgentsRailProps } from './index'
import type { RailRow } from './roster'

const ROW: RailRow = {
  agent: { id: 'agent-1', name: 'Analyst', avatarKey: 'analyst', jobs: [], apps: [] },
  duet: false,
  when: '2m',
}

/** A workspace whose roster names nobody, for the rows that are not about names. */
const NOBODY = () => undefined

function render(over: Partial<AgentsRailProps> = {}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <AgentsRail
        out
        onToggle={() => {}}
        onAddAgent={() => {}}
        workDestination={{ href: '/w/acme/home', onOpen: () => {} }}
        graphDestination={{ href: '/w/acme/agents/graph', onOpen: () => {} }}
        graphSelected={false}
        rows={[ROW]}
        memberName={NOBODY}
        phase="ready"
        continuation={{ available: false, loading: false, failed: false, load: () => {} }}
        onRetry={() => {}}
        onOpen={() => {}}
        onOpenApp={() => {}}
        description={() => null}
        {...over}
      />
    </NextIntlClientProvider>,
  )
}

test('initial markup keeps the drawer close control for either supplied state', () => {
  expect(render()).toMatch(/<button\b[^>]*aria-label="Hide agents"/)
  expect(render({ out: false })).toMatch(/<button\b[^>]*aria-label="Hide agents"/)
})

/* The column is left in the document so that it can *move* — it slides shut
   rather than vanishing — which is exactly why it has to be taken out of the
   tab order and the accessibility tree by hand. `overflow: hidden` does
   neither, so a folded rail would otherwise still be tabbable and still be read
   out over the picture you are actually looking at. */
test('closed-drawer markup declares inert and aria-hidden', () => {
  const html = render({ out: false })
  expect(drawerTag(html)).toContain('inert=""')
  expect(drawerTag(html)).toContain('aria-hidden="true"')
})

test('open-drawer markup declares neither inert nor aria-hidden', () => {
  const html = render()
  expect(drawerTag(html)).not.toContain('inert=""')
  expect(drawerTag(html)).not.toContain('aria-hidden="true"')
  expect(html).toContain('Analyst')
})

/* The reader's preference is written by the control and by nothing else. A
   render that merely draws the column must never report itself as the reader
   having opened or closed it, or a visit would rewrite a saved setting nobody
   chose. */
test('initial static markup invokes no toggle callback', () => {
  const said: boolean[] = []
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <AgentsRail
        out
        onToggle={() => said.push(true)}
        onAddAgent={() => {}}
        workDestination={{ href: '/w/acme/home', onOpen: () => {} }}
        graphDestination={{ href: '/w/acme/agents/graph', onOpen: () => {} }}
        graphSelected={false}
        rows={[ROW]}
        memberName={NOBODY}
        phase="ready"
        continuation={{ available: false, loading: false, failed: false, load: () => {} }}
        onRetry={() => {}}
        onOpen={() => {}}
        onOpenApp={() => {}}
        description={() => null}
      />
    </NextIntlClientProvider>,
  )
  expect(said).toEqual([])
})

/* Build and Work are two modes of one workspace. Their desktop navigation has
   one footprint, so crossing the mode boundary changes the list rather than
   making the canvas jump sideways or asking the reader to hover for names. */
test('initial markup carries the shared desktop sidebar width and mode labels', () => {
  const html = render()
  expect(html).toContain('17rem')
  expect(html).not.toContain('hover:w-[var(--rail-peek)]')
  expect(html).not.toContain('focus-within:w-[var(--rail-peek)]')
  expect(html).toContain('Work')
  expect(html).toContain('Build')
})

/* The column is permanent at the same desktop breakpoint as Work. Only the
   smaller-screen drawer has an out-ness because it covers its destination. */
test('closed-drawer markup retains desktop width and translation classes', () => {
  const html = render({ out: false })
  expect(html).toContain('lg:w-[var(--rail-w)]')
  expect(html).toContain('lg:translate-x-0')
})

function drawerTag(html: string): string {
  const tag = html.match(/<div\b[^>]*class="absolute inset-y-0[^"]*"[^>]*>/)?.[0]
  if (tag === undefined) throw new Error('Drawer container was not rendered')
  return tag
}
