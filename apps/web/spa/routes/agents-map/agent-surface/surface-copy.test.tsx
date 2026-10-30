import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import type { ComponentProps, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import messages from '../../../../messages/en/app.json'
import type { Read } from '../../../knowledge-map-data/use-agent-reads'
import type { AppItem, FileItem, Skill } from '../../../knowledge-map/types'
import { AgentSurface } from './index'

const quiet = { phase: 'ready', items: [] } as const

/**
 * A surface, drawn for real, with every message report collected.
 *
 * `onError` is the point of the render: next-intl reports a key it cannot find
 * there rather than by throwing, so a missing message reaches production as a
 * red console line and a chip labelled with its own key. Collecting the reports
 * is the only way a test sees what the browser saw.
 */
function render(node: ReactNode): { html: string; complaints: string[] } {
  const complaints: string[] = []
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      timeZone="UTC"
      now={new Date(Date.UTC(2026, 7, 5))}
      onError={error => complaints.push(error.message)}
    >
      {/* The door under the list is a router `Link`, and a `Link` with no router
          above it throws before a single message is asked for. */}
      <MemoryRouter>{node}</MemoryRouter>
    </NextIntlClientProvider>,
  )
  return { html, complaints }
}

function renderSurface(
  subtitle?: string,
  extra: {
    setup?: { state: 'ready' | 'waiting' | 'chat' | 'app' | 'blocked'; body: ReactNode }
    files?: Read<FileItem>
    skills?: Read<Skill>
    apps?: Read<AppItem>
    row?: ComponentProps<typeof AgentSurface>['row']
  } = {},
): { html: string; complaints: string[] } {
  return render(
    <AgentSurface
      name="Research"
      subtitle={subtitle}
      portrait={{ avatarKey: 'research' }}
      skills={quiet}
      files={quiet}
      apps={quiet}
      showing={null}
      onShow={() => {}}
      onOpenFile={() => {}}
      row={[{ key: 'files', kind: 'files' }]}
      drag={{ onDrop: () => {} }}
      chat={<p>the conversation</p>}
      {...extra}
    />,
  )
}

/* An agent still waiting on its setup cannot hold a conversation — the composer
   answers that the agent is unavailable, in words that blame a deleted folder —
   has no jobs, and reaches its other apps only once setup finishes. Drawing the
   two-column surface around it put the one thing to do in a corner and three
   dead panels around it. */
test('supplied setup markup withholds the conversation and view selectors', () => {
  const { html, complaints } = renderSurface(undefined, {
    setup: { state: 'ready', body: <p>connect your search data</p> },
  })

  expect(html).toContain('connect your search data')
  expect(html).toContain('data-mode="setup"')
  // The conversation and the row of views are the two panes a locked agent
  // cannot fill. Asserted by their contents rather than by a class, so a
  // renamed wrapper cannot pass this by drawing an empty one.
  expect(html).not.toContain('the conversation')
  expect(html).not.toContain(messages.duetApp.agentSurface.reorder)
  expect(complaints).toEqual([])
})

/* The header is the ONE header. A locked agent's cluster is the same cluster —
   same face, same name, same way out — recomposed and told what it is; a second
   bar over the body would be a title under a title. */
test('supplied setup markup puts one onboarding heading before the agent name', () => {
  const { html, complaints } = renderSurface(undefined, {
    setup: { state: 'ready', body: <p>connect your search data</p> },
  })

  expect(html).toContain(messages.duetApp.agentSurface.setupEyebrow)
  expect(html).toContain(messages.duetApp.agentSurface.setupNoteReady)
  expect(html.match(/<p class="km-eyebrow">Onboarding<\/p>/g)).toHaveLength(1)
  expect(html).toMatch(/<p class="km-eyebrow">Onboarding<\/p>[\s\S]*<h2[^>]*>Research<\/h2>/)
  expect(complaints).toEqual([])
})

/* Every state of a locked surface says a different thing about what to do, and
   the header is where all five of them are said. */
test('the header copy follows each supplied setup state', () => {
  const noteFor = (state: 'ready' | 'waiting' | 'chat' | 'app' | 'blocked'): string =>
    renderSurface(undefined, { setup: { state, body: <p /> } }).html
  const copy = messages.duetApp.agentSurface

  expect(noteFor('waiting')).toContain(copy.setupNoteWaiting)
  expect(noteFor('chat')).toContain(copy.setupNoteChat)
  expect(noteFor('blocked')).toContain(copy.setupNoteBlocked)
  expect(noteFor('ready')).toContain(copy.setupNoteReady)
  expect(noteFor('app')).toContain(copy.setupNoteApp.replaceAll("'", '&#x27;'))
  expect(noteFor('waiting')).not.toContain(copy.setupNoteReady)
})

test('ready markup contains both conversation and work panes', () => {
  const { html } = renderSurface()

  expect(html).toContain('the conversation')
  expect(html).toContain('id="km-pane-chat"')
  expect(html).toContain('id="km-pane-work"')
  expect(html).not.toContain('data-mode="setup"')
})

test('a supplied failed Files continuation renders loaded rows and retry copy', () => {
  const { html } = renderSurface(undefined, {
    files: {
      phase: 'ready',
      items: [{ id: 'brief.md', title: 'brief.md', kind: 'md', when: 'now' }],
      hasMore: false,
      moreFailed: true,
      onLoadMore: () => {},
    },
    row: [],
  })

  expect(html).toContain('brief.md')
  expect(html).toContain('Try again')
})

test('an arrangeable row says what dragging does, in words rather than in a key', () => {
  const { html } = renderSurface()

  expect(html).toContain(messages.duetApp.agentSurface.reorder)
  expect(html).not.toContain('homeSurface.reorder')
})

/* The name at the top of this surface is a display name; the slug is what the
   URL, the folder and the `@` all use, and this is the one place a reader can
   see both at once. The surface prints what it is handed and derives nothing —
   whether the two differ at all is the projection's question, answered before
   the map ever draws a face. */
test('an agent that answers to another name wears it under the one it shows', () => {
  expect(renderSurface('market-scout').html).toContain('market-scout')
  // Handed none, it draws no line at all — not an empty one.
  expect(renderSurface().html).not.toContain('km-well-sub')
})

test('the initial ready surface reports no missing catalogue messages', () => {
  expect(renderSurface().complaints).toEqual([])
})
