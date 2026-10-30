/* Two of this list's rules are the kind that fail silently — they do not throw,
   they just quietly assert something nobody checked. A read that has not landed
   drawn as an empty drive, and a read that *failed* drawn the same way. Both are
   a sentence the product would be saying on its own authority, so both are
   pinned here. */
import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import appEn from '../../../../messages/en/app.json'
import { createAgentAvatarDataUri } from '../../../agents/agent-avatar'
import type { Job } from '../../../knowledge-map/types'
import { AgentsRailList, type AgentsRailListProps } from './list'
import type { RailRow } from './roster'

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'Reconcile invoices',
    when: '26m',
    state: 'running',
    unread: false,
    ...over,
  }
}

function row(over: Partial<RailRow> = {}): RailRow {
  return {
    agent: { id: 'agent-1', name: 'Analyst', avatarKey: 'analyst', jobs: [], apps: [] },
    duet: false,
    when: '2m',
    ...over,
  }
}

/* Work in flight must not become activity on an agent's own conversation. */
const BUSY = row({
  agent: {
    id: 'agent-1',
    name: 'Analyst',
    avatarKey: 'analyst',
    apps: [],
    jobs: [
      job({ id: 'a', title: 'Reconcile invoices', state: 'asking' }),
      job({ id: 'b', title: 'Draft the Q3 memo' }),
    ],
  },
})

/** A workspace whose roster names nobody, for the rows that are not about names. */
const NOBODY = () => undefined

function render(over: Partial<AgentsRailListProps> = {}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <AgentsRailList
        rows={[BUSY]}
        memberName={NOBODY}
        phase="ready"
        continuation={{ available: false, loading: false, failed: false, load: () => {} }}
        onRetry={() => {}}
        onOpen={() => {}}
        onOpenApp={() => {}}
        description={({ row: entry }) => <>{entry.agent.name} does the work.</>}
        {...over}
      />
    </NextIntlClientProvider>,
  )
}

/* Build's column is a directory of carriers, not a worklist. A carrier's other
   sessions are Work's subject and are listed there; drawing them here as well
   would put the same rows under two headings, in two orders, in one product —
   and only one of the two would be complete, because this list is projected
   from a bounded per-owner summary rather than from a paged query. */
test('the column lists carriers and never their work', () => {
  const html = render()
  expect(html).toContain('Analyst')
  expect(html).not.toContain('Reconcile invoices')
  expect(html).not.toContain('Draft the Q3 memo')
  expect(html).not.toContain('in flight')
})

test('the workspace-sidebar variant is the same claim, one line per carrier', () => {
  const html = render({ compact: true })
  expect(html).toContain('Analyst')
  expect(html).not.toContain('Reconcile invoices')
  expect(html).not.toContain('Draft the Q3 memo')
})

/* Two things arrive here as an owner with no chat: one nobody has written to,
   and every owner on a drive whose activity read has not landed yet — the
   roster and the activity are two reads a moment apart, so the second is the
   ordinary first paint. Both draw as nothing at all, which claims nothing. */
test('an agent nobody has written to is listed, and claims nothing', () => {
  const html = render({ rows: [row()] })
  expect(html).not.toContain('data-chat-state=')
  expect(html).not.toContain('>0<')
  // …and it is still listed, by name
  expect(html).toContain('Analyst')
})

test('a roster that failed says so and offers the retry, rather than an empty drive', () => {
  const html = render({ phase: 'error', rows: [] })
  expect(html).toContain('That did not load')
  expect(html).toContain('Try again')
})

test('a pending roster declares hidden skeleton markup without failure copy', () => {
  const html = render({ phase: 'pending', rows: [] })
  expect(html).toContain('aria-hidden')
  expect(html).not.toContain('That did not load')
})

test('a partial roster names its loaded prefix and offers explicit continuation', () => {
  const html = render({
    rows: [BUSY],
    continuation: { available: true, loading: false, failed: false, load: () => {} },
  })
  expect(html).toContain('1 agent loaded')
  expect(html).toContain('Load more agents')
})

test('a supplied failed continuation renders loaded rows and retry copy', () => {
  const html = render({
    rows: [BUSY],
    continuation: { available: false, loading: false, failed: true, load: () => {} },
  })
  expect(html).toContain('Analyst')
  expect(html).toContain('1 agent loaded')
  expect(html).toContain('More agents couldn’t be loaded.')
  expect(html).toContain('Try again')
  expect(html).not.toContain('That did not load')
})

/* What an agent can reach was already on the row and was being thrown away —
   `railRows` carries the whole `apps` list and nothing drew it. The order is
   the claim being pinned here: what it can touch, then what it is doing with
   it. A reader scanning for "can this one even see the warehouse" should not
   have to read a job list to find out. */
test('an agent shows two of the apps it can reach, and no more', () => {
  const html = render({
    rows: [
      row({
        agent: {
          id: 'agent-1',
          name: 'Analyst',
          avatarKey: 'analyst',
          jobs: [],
          apps: [
            { id: 'metrics', title: 'Metrics', when: '2m', state: 'connected' },
            { id: 'warehouse', title: 'Warehouse', when: '5m', state: 'connected' },
            { id: 'cohorts', title: 'Cohort Explorer', when: '8m', state: 'connected' },
          ],
        },
      }),
    ],
  })

  expect(html).toContain('Metrics')
  expect(html).toContain('Warehouse')
  expect(html).not.toContain('Cohort Explorer')
  expect(html.indexOf('Analyst')).toBeLessThan(html.indexOf('Metrics'))
})

/* An agent that reaches nothing draws no strip at all — not an empty one. A
   bordered box with nothing in it reads as apps that failed to load, which is
   a different sentence from "this one is not connected to anything". */
test('an agent that reaches nothing draws no apps strip', () => {
  expect(render({ rows: [row()] })).not.toContain('data-rail-apps')
})

/* A row with activity shows the newest thing said instead of its fallback
   description. The visible line carries no attribution glyph: the wire's author is `user` or
   `agent` and cannot name *which* person, so "You" is a claim this row cannot
   check. The words are in the accessible layer instead. */
test('the agent\u2019s last word is the row\u2019s one line of prose', () => {
  const html = render({
    rows: [row({ preview: { text: 'I shipped the lander.', author: { kind: 'agent' } } })],
  })
  expect(html).toContain('I shipped the lander.')
  expect(html).toContain('data-preview-author="agent"')
  expect(html).toContain('Last message, from Analyst')
  // the description the harness supplies for every row must be absent here
  expect(html).not.toContain('Analyst does the work.')
  /* And no name in front of it: the row is already under the agent's name, so
     a second copy fifteen pixels lower spends two fifths of a truncating line
     on nothing. The absence of a prefix is what marks the agent's own voice. */
  expect(html).not.toContain('Analyst:')
})

/* With no message to show, the row says what the agent is. */
test('a row nobody has written to says what the agent is', () => {
  const html = render({ rows: [row({ when: '2m' })] })
  expect(html.replace(/<[^>]*>/g, '').trim()).toBe('Analyst2mAnalyst does the work.')
  expect(html).not.toContain('data-rail-preview')
})

/* Who spoke, by name. A bare category would be undrawable: a workspace has
   several members, so it says a person spoke and never which one — and "You:"
   is a claim the row cannot check, because it does not know which member is
   reading it. `author` carries the sender identity, and the row resolves it
   through the same author directory the transcript resolves a bubble with. */
test('a person\u2019s last word is prefixed with the person, not with \u201cyou\u201d', () => {
  const html = render({
    rows: [
      row({ preview: { text: 'ship the lander copy', author: { kind: 'user', userId: 'u_ada' } } }),
    ],
    memberName: (userId: string) => (userId === 'u_ada' ? 'Ada Lovelace' : undefined),
  })
  expect(html).toContain('ship the lander copy')
  expect(html).toContain('Ada Lovelace')
  expect(html).toContain('data-preview-author="user"')
  expect(html).not.toContain('You:')
})

/* A roster that has not answered yet, or a member who has since left, must not
   turn the line into a lie or a blank. The words are what the row is for; the
   name is the part allowed to be missing. */
test('an unresolvable person leaves the words alone', () => {
  const html = render({
    rows: [
      row({
        preview: { text: 'ship the lander copy', author: { kind: 'user', userId: 'u_gone' } },
      }),
    ],
    memberName: () => undefined,
  })
  expect(html).toContain('ship the lander copy')
  expect(html).not.toContain('undefined')
})

/* This file used to say, of the missing mark: "If the rail ever stays out
   beside an agent, that is when it needs one back." That day is here — the
   roster stands beside a conversation on every destination now, and a
   permanent list with no answer to which row you are reading is a list you
   have to re-find your place in on every glance. */
test('the row the reader is on says so', () => {
  const html = render({
    rows: [
      row(),
      row({ agent: { id: 'agent-2', name: 'Writer', avatarKey: 'writer', jobs: [], apps: [] } }),
    ],
    selectedAgentId: 'agent-2',
  })
  const rows = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? []
  expect(rows).toHaveLength(2)
  expect(rows[0]).toContain('Analyst')
  expect(rows[0]).not.toContain('aria-current')
  expect(rows[1]).toContain('Writer')
  expect(rows[1]).toContain('aria-current="true"')
})

test('nothing is marked when the reader is not on any of these rows', () => {
  expect(render({ rows: [row()] })).not.toContain('aria-current')
})

/* ---------------------------------------------------------------- the mark

   Build's column is a list of agents, and a row *is* the conversation you have
   with one — clicking it opens that agent's own chat and nothing else. So the
   mark on the row answers for that chat: unread means the chat has something
   you have not read, and the state dot is the state the chat is in.

   It used to answer for the agent's work instead, which is the same row saying
   something about a conversation the reader cannot reach from it. An agent with
   three jobs running and a silent chat wore a live dot; one whose chat had
   asked a question and had no work in flight wore nothing. */
test('the mark on a row answers for the agent\u2019s own chat', () => {
  const html = render({
    compact: true,
    rows: [
      row({
        agent: {
          id: 'agent-1',
          name: 'Analyst',
          avatarKey: 'analyst',
          jobs: [],
          apps: [],
          chat: [job({ id: 'chat', state: 'asking', unread: true })],
        },
      }),
    ],
  })
  expect(html).toContain('data-unread=""')
  expect(html).toContain('data-chat-state="asking"')
})

test('work in flight puts no mark on the row it cannot be reached from', () => {
  const html = render({
    compact: true,
    rows: [
      row({
        agent: {
          id: 'agent-1',
          name: 'Analyst',
          avatarKey: 'analyst',
          apps: [],
          jobs: [job({ id: 'a', state: 'asking', unread: true })],
          chat: [job({ id: 'chat', state: 'done', unread: false })],
        },
      }),
    ],
  })
  expect(html).not.toContain('data-unread=""')
  expect(html).not.toContain('data-chat-state=')
})

/* An owner nobody has written to has no chat at all, which is a different fact
   from a chat with nothing in it — and both draw nothing rather than a resting
   mark, because a dot on every row is a dot nobody reads. */
test('an agent nobody has written to wears no mark', () => {
  const html = render({ compact: true, rows: [row()] })
  expect(html).toContain('Analyst')
  expect(html).not.toContain('data-unread=""')
  expect(html).not.toContain('data-chat-state=')
})

/* The rail and the ring are the same agents twice, side by side in one grid
   (`agents-section.tsx`), so a row that seeds its face from a different field
   than everything else draws a second, different robot for one agent on one
   screen. This pins the row to the canonical key rather than to whatever it
   happens to have on hand — the defect was `avatarKey={row.agent.id}`, which
   looks correct in a diff because an id is unique too. Unique is not the
   question; *the same as everywhere else* is. */
test('a row draws the agent face the rest of the product draws for that agent', () => {
  const html = render({
    rows: [
      row({ agent: { id: 'k57xy2', name: 'Analyst', avatarKey: 'analyst', jobs: [], apps: [] } }),
    ],
  })

  expect(html).toContain(escapeAttribute(createAgentAvatarDataUri('analyst')))
  expect(html).not.toContain(escapeAttribute(createAgentAvatarDataUri('k57xy2')))
})

/* An agent that has uploaded an icon wears it everywhere — the ring already
   does (`AgentFace`'s `src`), and the rail took a `workspaceSlug` as if it did
   too — while never handing its avatar anything to draw. So a custom icon
   appeared on the canvas and the row beside it still showed the robot. */
test('a row draws an uploaded icon rather than the generated face', () => {
  const html = render({
    rows: [
      row({
        agent: {
          id: 'k57xy2',
          name: 'Analyst',
          avatarKey: 'analyst',
          icon: 'https://drive.example/agents/analyst/icon.png',
          jobs: [],
          apps: [],
        },
      }),
    ],
  })

  expect(html).toContain('data-agent-avatar="custom"')
  expect(html).toContain('https://drive.example/agents/analyst/icon.png')
})

/* The faces are data URIs in an `src`, and React escapes `&` on the way into
   the markup — so the raw URI never appears in the string being searched. */
function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;')
}
