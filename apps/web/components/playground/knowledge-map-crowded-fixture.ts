/* Deterministic input for the jobs-on-the-map harness.

   Contract-shaped and nothing else: this module builds `MapData` and a `Job`
   list, which is exactly what the map and the dialog take as props. It knows
   nothing about queries, routes or React — the harness is the host, and a
   fixture that reached for either would be testing the wrong seam.

   Every `when` is a fixed phrase and every id is derived from its index, so the
   same knobs produce the same picture twice. */
import type { AppItem, Job, JobState, MapData } from '../../spa/knowledge-map/types'

const APPS: readonly (readonly [string, AppItem['state']])[] = [
  ['Snowflake', 'connected'],
  ['Metabase', 'connected'],
  ['Stripe', 'connected'],
  ['Linear', 'connected'],
  ['Notion', 'available'],
  ['Slack', 'available'],
]

const NAMES = [
  'Data Analyst',
  'SEO Writer',
  'Support Triage',
  'Revenue Ops',
  'Contract Review',
  'Recruiting',
  'Inbox Zero',
  'Release Notes',
  'Bug Triage',
  'Market Watch',
  'Invoice Chaser',
  'Onboarding',
  'Churn Watch',
  'Docs Keeper',
  'Ad Spend',
  'Pricing Desk',
  'Partner Comms',
  'Security Review',
  'Roadmap Clerk',
  'Board Pack',
  'Payroll Watch',
  'Vendor Review',
  'Trial Nudger',
  'Status Page',
] as const

/* Real-shaped titles, because the whole question the map asks about a job row
   is whether a title survives the room it was given. "Task 3" always fits and
   would make every threshold look generous. */
const TITLES = [
  'Q3 revenue reconciliation',
  'Churn cohort breakdown',
  'Keyword gap vs competitors',
  'Refresh the pricing page',
  'Draft the board summary',
  'Chase 14 overdue invoices',
  'Triage the weekend backlog',
  'Re-run the forecast',
] as const

/* How busy each agent is, by position on the ring. Chosen rather than
   generated: a ring is only honest if the busy ones and the idle ones sit next
   to each other, and at least one has to overflow so the sixth mark is drawn. */
const IN_FLIGHT = [7, 2, 0, 3, 0, 1, 5, 0, 6, 0, 2, 0, 4, 1, 0, 3, 0, 2, 0, 1, 0, 3, 0, 2] as const

/** One job, in the map's own shape. The three states the ring can draw. */
export function fixtureJob(agentIndex: number, index: number): Job {
  const turn = (agentIndex + index) % 3
  const base = {
    id: `a${agentIndex}-j${index}`,
    title: TITLES[(agentIndex * 3 + index) % TITLES.length]!,
  }
  if (turn === 0) {
    return {
      ...base,
      when: '20 min ago',
      state: 'asking' as JobState,
      /* Asking *and* unread, so the ring shows the two axes at once: the bead's
         fill is what the job is doing, the ring around it is whether you have
         seen it. They are independent and a fixture that never lit both
         together would not be drawing the case worth checking. */
      unread: true,
      step: 'Waiting on you',
    }
  }
  if (turn === 1) {
    // Running and read, beside the asking-and-unread one above.
    return { ...base, when: '1 hr ago', state: 'running' as JobState, unread: false, progress: 0.6 }
  }
  return {
    ...base,
    when: '12 min ago',
    state: 'scheduled' as JobState,
    unread: index % 2 === 0,
    wakesIn: 'in 4 hours',
  }
}

export type FixtureKnobs = {
  agents: number
  /** multiplies each agent's own share, so `0` is a drive at rest */
  work: number
}

export function crowdedFixture({ agents, work }: FixtureKnobs): MapData {
  return {
    coreMeta: `${agents} agents · 62 apps`,
    /* Duet carries the drive's own apps on the ring and grows no Jobs seat —
       its seats stand on the ring rather than on a tangent, so there is no row
       for a second one to hang under. */
    /* Duet carries a chat of its own like any owner, and it is read here: the
       centre wearing a mark is worth one deliberate shot, but not in the
       fixture whose subject is twenty faces at once. */
    duet: {
      id: 'core',
      name: 'Acme Studio',
      avatarKey: 'core',
      locked: true,
      jobs: [],
      apps: [],
      chat: [],
    },
    agents: Array.from({ length: agents }, (_, i) => {
      const count = Math.round((IN_FLIGHT[i % IN_FLIGHT.length]! * work) / 100)
      return {
        id: `agent-${i}`,
        name: NAMES[i % NAMES.length]!,
        avatarKey: `agent-${i}`,
        /* Every third owner has been written to and not read back. The dot this
           draws is the one thing the crowded fixture could not show before — it
           shipped `unread: false` everywhere, so the mark had never been
           photographed at the density where its legibility is actually in
           doubt. Spread rather than given to one agent so a shot at twenty shows
           the mark competing with its neighbours, which is the question. A set
           of at most one, because an owner has exactly one chat. */
        chat:
          i % 3 === 0
            ? [
                {
                  id: `agent-${i}-chat`,
                  title: 'Its own chat',
                  when: '3 min ago',
                  state: 'done' as JobState,
                  unread: true,
                },
              ]
            : undefined,
        /* The same bounded recent-work shape production hands the map: every
           unfinished row first, then completed history. Even an otherwise idle
           owner keeps a Jobs section, which is the retained state this fixture
           must make visible. */
        jobs: fixtureHistory(i, count),
        apps: APPS.slice(0, 3 + (i % 4)).map(([title, state], a) => ({
          id: `agent-${i}-app-${a}`,
          title,
          when: state === 'connected' ? 'In use now' : 'One click away',
          state,
        })),
      }
    }),
  }
}

/**
 * Every recent job an agent has, active *and* finished.
 *
 * The production map receives a bounded prefix while the dialog can page the
 * whole history. This fixture is smaller than either bound, so one deterministic
 * list can drive both without inventing hidden rows.
 */
export function fixtureHistory(agentIndex: number, active: number): Job[] {
  const done: Job[] = Array.from({ length: 4 }, (_, j) => ({
    id: `a${agentIndex}-h${j}`,
    title: TITLES[(agentIndex + j + 5) % TITLES.length]!,
    when: j === 0 ? 'Yesterday' : `${j + 1} days ago`,
    state: 'done',
    unread: false,
  }))
  return [...Array.from({ length: active }, (_, j) => fixtureJob(agentIndex, j)), ...done]
}
