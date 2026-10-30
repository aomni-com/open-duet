/* Contract-shaped input for the home fixture.

   Deliberately not `MapData`: the map already has a fixture of its own in
   `knowledge-map-fixture.ts`. What is unproven here is the *projection* — that
   real `Agent`/`App`/`ActivitySessionSummary` records come out the far side looking like a
   map — so the fixture starts where the wire starts and runs through
   `projectWorkspaceMap` like the product does. */
import {
  bucketOf,
  projectSessionActivityMachine,
  type ActivitySessionSummary,
  type Agent,
  type App,
  type Machine,
} from '@repo/contract'

import type { AgentSlice, CoreFacts, MapCopy } from '../../spa/knowledge-map-data/project'
import { FIXTURE_APP_ART } from './knowledge-map-fixture'

/** Bytes no browser will decode. See the Feeds app below for why. */
const UNDRAWABLE_ART = 'data:image/png;base64,bm90LWFuLWltYWdl'

/* Fixed so the screenshot is deterministic: every `when` caption on the map is
   this minus the record's own timestamp. */
export const FIXTURE_NOW = Date.parse('2026-07-30T12:00:00.000Z')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/* `name` is optional on the wire and optional here for the same reason: an agent
   nobody has renamed goes by its slug, and it is the one face on the ring that
   draws no second line under it. A fixture where every agent had been named
   would screenshot only half of that rule.

   The id is opaque and deliberately unlike the slug, because on the wire it is
   a Convex id and never resembles one. It used to default *to* the slug, which
   made every surface that keyed an avatar off the wrong field — the rail keyed
   off `id` for months — draw the correct face in every screenshot while drawing
   a different one in the product. A fixture that cannot tell two fields apart
   cannot photograph the difference between them. */
function agent(slug: string, name: string | undefined, id = `k57${slug}xyz2`): Agent {
  return {
    id,
    workspaceId: 'ws-acme',
    anchorId: `anchor-${slug}`,
    anchorPath: `agents/${slug}`,
    anchorState: 'active',
    slug,
    name,
    createdAt: FIXTURE_NOW - 90 * DAY,
    updatedAt: FIXTURE_NOW - DAY,
  }
}

/* `machine` is optional because a session no longer needs one to exist. That is
   the whole of what the merge changed here: an ordinary chat and a state machine
   are the same row, and the ring draws both. */
function job(
  id: string,
  title: string,
  turnStatus: 'ask' | 'complete' | 'interrupted' | 'running' | 'sleep',
  ago: number,
  machine?: Machine,
  /* Opt-in per row rather than derived from the bucket: unread is a fact about
     a reader, so a fixture that inferred it from what the session is doing
     would be drawing a different thing than the product does. */
  unread = false,
): ActivitySessionSummary {
  return {
    id,
    bucket: bucketOf({ turnStatus, ...(machine === undefined ? {} : { machine }) }),
    title,
    updatedAt: FIXTURE_NOW - ago,
    unread,
    /* Projected, as the server projects it before a summary leaves Convex: the
       map reads `step`, not the raw `currentState` a machine carries. */
    ...(machine === undefined ? {} : { machine: projectSessionActivityMachine(machine) }),
  }
}

function app(
  slug: string,
  name: string,
  runtimeStatus: App['runtimeStatus'],
  ago: number,
  icon?: string,
): App {
  return {
    id: `app-${slug}`,
    workspaceId: 'ws-acme',
    anchorId: `anchor-app-${slug}`,
    anchorPath: `apps/${slug}`,
    anchorState: 'active',
    slug,
    name,
    icon,
    runtimeStatus,
    createdAt: FIXTURE_NOW - 30 * DAY,
    updatedAt: FIXTURE_NOW - ago,
  } as App
}

/* Duet's own: an app outside every agent's anchor, which every drive is born
   with one of. It hangs off the centre rather than off a face, so the fixture is
   the one picture that proves the core carries a fan of its own — and the count
   says five, because five is what the map draws. */
/* The owner's own conversation, unread — the only thing on this map that puts
   a dot on a face.

   It is here because it was nowhere: no fixture set a `chat`, so `hasUnread`
   answered false on every node of every screenshot and the mark had no visual
   coverage at all. That is how the two draw sites — a face on the ring and the
   face at the centre — came to place it by different hand-tuned constants with
   no baseline to notice. `unreadDotOffset` derives the position from the plate
   now, and this is the picture that holds it to that: both marks in one shot,
   on plates of two different sizes, where a drift between them is visible. */
const UNREAD_CHAT = job('chat-unread', 'Your conversation', 'running', 2 * MINUTE, undefined, true)

export const HOME_FIXTURE_CORE: CoreFacts = {
  name: 'Acme Studio',
  meta: '4 agents · 5 apps',
  apps: [app('hello', 'Hello', 'reconciled', 6 * DAY, FIXTURE_APP_ART.page)],
  jobs: [],
  chat: UNREAD_CHAT,
}

/* The product hands the projection a locale-aware formatter; the fixture hands
   it a frozen one, so the screenshot says the same thing every time. */
export const HOME_FIXTURE_COPY: MapCopy = {
  when: (at, now) => {
    const minutes = Math.max(1, Math.round((now - at) / MINUTE))
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`
    const days = Math.round(hours / 24)
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
    const weeks = Math.round(days / 7)
    return `${weeks} wk${weeks === 1 ? '' : 's'} ago`
  },
}

export const HOME_FIXTURE_SLICES: readonly AgentSlice[] = [
  {
    agent: agent('analyst', 'Data Analyst'),
    /* The face's half of the comparison above — a ring plate, against Duet's
       larger one at the centre. */
    chat: UNREAD_CHAT,
    apps: [app('metrics', 'Metrics', 'reconciled', 3 * HOUR, FIXTURE_APP_ART.chart)],
    jobs: [
      /* Unread and running, beside an unread asking row on the same agent: the
         Jobs seat therefore wears both marks and the count is two, which is what
         makes the numeral worth drawing rather than a dot. */
      job(
        'job-a1',
        'Weekly revenue rollup',
        'running',
        4 * MINUTE,
        {
          orderedPath: [],
          activity: 'running',
          definitionName: 'rollup',
          currentState: 'joining orders',
          progress: { completed: 3, total: 5 },
        },
        true,
      ),
      /* Unread, and asking. The two facts are independent — this row proves
         the dot is not a restatement of the bucket cue beside it. */
      job(
        'job-a2',
        'Backfill Q2 cohorts',
        'ask',
        26 * MINUTE,
        {
          orderedPath: [],
          activity: 'waiting',
          definitionName: 'backfill',
          currentState: 'needs a date range',
        },
        true,
      ),
    ],
  },
  {
    agent: agent('seo', 'SEO Writer'),
    apps: [app('search-console', 'Search Console', 'reconciled', 2 * DAY)],
    jobs: [
      job('job-s1', 'Refresh the pricing page', 'sleep', 12 * MINUTE, {
        orderedPath: [],
        activity: 'sleeping',
        definitionName: 'refresh',
        nextWakeAt: FIXTURE_NOW + 4 * HOUR,
      }),
    ],
  },
  {
    agent: agent('support', 'Support Triage'),
    apps: [
      app('helpdesk', 'Helpdesk', 'reconciled', 20 * MINUTE),
      app('status-page', 'Status Page', 'reconciling', 4 * DAY),
    ],
    /* A plain conversation — no machine, nobody started a "job" — that came
       back with a question. Before the merge the ring read a jobs-only list and
       this agent would have sat grey while a chat waited on its owner. It wears
       coral now, which is the change this slice exists to make visible. */
    jobs: [
      job('job-t1', 'Which queue for overnight tickets?', 'ask', 55 * MINUTE, undefined, true),
    ],
  },
  {
    // A brand-new agent: nothing run, one app it has not been connected to, and
    // no name of its own yet. The ring has to hold a quiet member without
    // looking broken — and this is the face that goes by its slug.
    agent: agent('scout', undefined),
    /* An icon the drive cannot draw: the row names one and the bytes behind it
       are not an image — which is what an icon row that outlived its file looks
       like to a browser. Every other surface falls back to a glyph when that
       happens, and the map has to fall back to the app's initials rather than
       leave an empty tile. Undecodable rather than missing so the fixture asks
       nothing of the network. */
    apps: [app('rss', 'Feeds', 'reconcile_failed', 11 * DAY, UNDRAWABLE_ART)],
    jobs: [],
  },
  {
    /* Nested one folder under the unnamed scout, so the shot proves the one-layer
       rule: this agent must NOT appear on the ring — its parent shows it on
       the zoomed surface instead — while the rail (its own fixture) lists it,
       because the escape hatch loses nobody. */
    agent: {
      ...agent('scout-helper', 'Scout Helper'),
      anchorPath: 'agents/scout/helper',
    },
    apps: [],
    jobs: [],
  },
]
