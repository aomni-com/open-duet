/* The order is the feature. A drawer that claims to be sorted by latest
   activity and is not is worse than an unsorted one — the reader trusts a
   claim they cannot check row by row — so every rule the sort has is pinned
   here, including the two that decide what "no activity" means. */
import { describe, expect, test } from 'bun:test'

import { ROOT_AGENT_SCOPE } from '@repo/contract'

import type { AgentRoute, MapActivity, MapPreviews } from '../../../knowledge-map-data/project'
import type { Agent as MapAgent, Job, MapData } from '../../../knowledge-map/types'
import { railRows } from './roster'

const NOW = Date.parse('2026-07-30T12:00:00.000Z')

/* Reports its argument rather than pretending to format: what these tests care
   about is *which* moment a row was phrased from, not the phrasing. */
const COPY = { when: (at: number, now: number) => `${Math.round((now - at) / 60_000)}m` }

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'Reconcile invoices',
    when: '2m',
    state: 'running',
    unread: false,
    ...over,
  }
}

function carrier(over: Partial<MapAgent> = {}): MapAgent {
  return { id: 'agent-1', name: 'Analyst', avatarKey: 'analyst', jobs: [], apps: [], ...over }
}

function map(over: Partial<MapData> = {}): MapData {
  return {
    duet: carrier({ id: ROOT_AGENT_SCOPE, name: 'Duet' }),
    coreMeta: '2 agents',
    agents: [],
    ...over,
  }
}

function activity(entries: Record<string, number>): MapActivity {
  return new Map(Object.entries(entries))
}

/* Most of these tests are about order, and the preview is deliberately not in
   it — so they say so by handing in nothing rather than by ignoring a table. */
const NO_PREVIEWS: MapPreviews = new Map()

/* The side table the map already keeps. Most of these tests are about order and
   counts, so it answers for every agent they name and nothing turns on it. */
function routes(...ids: readonly string[]): ReadonlyMap<string, AgentRoute> {
  return new Map(
    ids.map(id => [id, { slug: id, anchorPath: `agents/${id}`, launchable: true }] as const),
  )
}

const ROUTES = routes('a', 'agent-1', 'alpha', 'busy', 'newest', 'stale', 'zeta')

/* The rail reads the directory, not the ring — in these tests every carrier is
   on the ring, so the directory is simply the same list, keyed. The one test
   where they differ builds its own. */
function directoryOf(data: MapData): ReadonlyMap<string, MapAgent> {
  return new Map(data.agents.map(agent => [agent.id, agent]))
}

describe('railRows', () => {
  test('the drive is a row like any other, not a header above them', () => {
    const data = map({ agents: [carrier({ id: 'a', name: 'Analyst' })] })
    const rows = railRows(data, directoryOf(data), activity({}), NO_PREVIEWS, ROUTES, NOW, COPY)
    expect(rows.map(row => row.agent.id)).toEqual(['a', ROOT_AGENT_SCOPE])
    expect(rows.find(row => row.agent.id === ROOT_AGENT_SCOPE)?.duet).toBe(true)
    expect(rows.find(row => row.agent.id === 'a')?.duet).toBe(false)
  })

  test('the most recently moved carrier is first, whoever it is', () => {
    const data = map({
      agents: [carrier({ id: 'stale', name: 'Stale' }), carrier({ id: 'newest', name: 'Newest' })],
    })
    const rows = railRows(
      data,
      directoryOf(data),
      activity({ stale: NOW - 600_000, newest: NOW - 60_000, [ROOT_AGENT_SCOPE]: NOW - 300_000 }),
      NO_PREVIEWS,
      ROUTES,
      NOW,
      COPY,
    )
    expect(rows.map(row => row.agent.id)).toEqual(['newest', ROOT_AGENT_SCOPE, 'stale'])
  })

  /* Quiet is not "moved a very long time ago" — it is a different fact, and it
     belongs below every carrier that has moved rather than interleaved with the
     oldest of them by an invented timestamp. */
  test('carriers that have not moved sit below every carrier that has, by name', () => {
    const data = map({
      agents: [
        carrier({ id: 'zeta', name: 'Zeta' }),
        carrier({ id: 'busy', name: 'Busy' }),
        carrier({ id: 'alpha', name: 'Alpha' }),
      ],
    })
    const rows = railRows(
      data,
      directoryOf(data),
      // the oldest possible reading still outranks having no reading at all
      activity({ busy: 0 }),
      NO_PREVIEWS,
      ROUTES,
      NOW,
      COPY,
    )
    expect(rows.map(row => row.agent.id)).toEqual(['busy', 'alpha', ROOT_AGENT_SCOPE, 'zeta'])
  })

  /* ---- the sixth band ----
     Handed through from the wire, never re-derived: the server cut and
     flattened it at write time, and a second opinion here is a second answer
     to a question already settled. */
  test('a carrier carries the last thing said to it, and the drive carries its own', () => {
    const data = map({ agents: [carrier({ id: 'a' })] })
    const rows = railRows(
      data,
      directoryOf(data),
      activity({}),
      new Map([
        ['a', { text: 'ship the lander copy', author: { kind: 'user', userId: 'u_1' } as const }],
        [ROOT_AGENT_SCOPE, { text: 'I reindexed the drive.', author: { kind: 'agent' } as const }],
      ]),
      ROUTES,
      NOW,
      COPY,
    )
    expect(rows.find(row => row.agent.id === 'a')?.preview).toEqual({
      text: 'ship the lander copy',
      author: { kind: 'user', userId: 'u_1' },
    })
    // The drive is keyed by the scope token, the same as everywhere else.
    expect(rows.find(row => row.duet)?.preview).toEqual({
      text: 'I reindexed the drive.',
      author: { kind: 'agent' },
    })
  })

  /* Absent is ordinary — nobody has written to this carrier, or nothing in its
     conversation was a message. It must be *absent* rather than empty, or the
     row draws a band with nothing in it. */
  test('a carrier nobody has written to carries no preview at all', () => {
    const data = map({ agents: [carrier({ id: 'a' })] })
    const rows = railRows(data, directoryOf(data), activity({}), NO_PREVIEWS, ROUTES, NOW, COPY)
    expect(rows[0]).not.toHaveProperty('preview')
  })

  /* Two clocks, two questions. What was last said never moves a row, because
     the column's one promise is that it is ordered by when work moved. */
  test('the preview never touches the order', () => {
    const data = map({
      agents: [carrier({ id: 'stale', name: 'Stale' }), carrier({ id: 'newest', name: 'Newest' })],
    })
    const moved = activity({ stale: NOW - 600_000, newest: NOW - 60_000 })
    const spoken = new Map([
      ['stale', { text: 'hello again', author: { kind: 'user', userId: 'u_1' } as const }],
    ])
    expect(
      railRows(data, directoryOf(data), moved, spoken, ROUTES, NOW, COPY).map(row => row.agent.id),
    ).toEqual(
      railRows(data, directoryOf(data), moved, NO_PREVIEWS, ROUTES, NOW, COPY).map(
        row => row.agent.id,
      ),
    )
  })

  test('a quiet carrier is phrased as nothing rather than as the epoch', () => {
    const data = map({ agents: [carrier({ id: 'a' })] })
    const rows = railRows(data, directoryOf(data), activity({}), NO_PREVIEWS, ROUTES, NOW, COPY)
    expect(rows[0]?.when).toBeUndefined()
  })

  test('a moved carrier is phrased from the moment it moved', () => {
    const data = map({ agents: [carrier({ id: 'a' })] })
    const rows = railRows(
      data,
      directoryOf(data),
      activity({ a: NOW - 420_000 }),
      NO_PREVIEWS,
      ROUTES,
      NOW,
      COPY,
    )
    expect(rows[0]?.when).toBe('7m')
  })

  /* A row is a carrier and the conversation you have with it. It carries the
     carrier whole — which is where the row's mark reads `chat` from — and makes
     no projection of the carrier's work, because Build's column does not list
     work. It used to carry a filtered copy of `jobs` and a numeral counting
     them, and a row holding a list nothing draws is a row the next reader draws
     it from. */
  test('a row carries the carrier, and no projection of its work', () => {
    const data = map({
      agents: [
        carrier({
          id: 'a',
          jobs: [job({ id: 'running', state: 'running' }), job({ id: 'asking', state: 'asking' })],
          chat: [job({ id: 'chat', state: 'asking', unread: true })],
        }),
      ],
    })
    const rows = railRows(
      data,
      directoryOf(data),
      activity({ a: NOW }),
      NO_PREVIEWS,
      ROUTES,
      NOW,
      COPY,
    )
    expect(rows[0]?.agent).toEqual(data.agents[0])
    expect(Object.keys(rows[0] ?? {})).not.toContain('jobs')
    expect(Object.keys(rows[0] ?? {})).not.toContain('active')
  })

  /* The row carries where to read a description from, and the drive root is
     Duet's — it *is* the drive. An agent the side table has never heard of gets
     no anchor at all rather than the root's, which would print the drive's own
     description under somebody else's name. */
  test('the drive root describes Duet, and an unrouted agent has nowhere to read from', () => {
    const data = map({ agents: [carrier({ id: 'a' }), carrier({ id: 'ghost', name: 'Ghost' })] })
    const rows = railRows(
      data,
      directoryOf(data),
      activity({}),
      NO_PREVIEWS,
      routes('a'),
      NOW,
      COPY,
    )
    const at = (id: string) => rows.find(row => row.agent.id === id)
    expect(at(ROOT_AGENT_SCOPE)?.anchorPath).toBe('')
    expect(at('a')?.anchorPath).toBe('agents/a')
    expect(at('ghost')?.anchorPath).toBeUndefined()
  })

  test('a carrier nobody has written to carries no chat to mark', () => {
    const data = map({ agents: [carrier({ id: 'a', jobs: [job({ state: 'done' })] })] })
    const rows = railRows(data, directoryOf(data), activity({}), NO_PREVIEWS, ROUTES, NOW, COPY)
    expect(rows[0]?.agent.chat).toBeUndefined()
  })
})
