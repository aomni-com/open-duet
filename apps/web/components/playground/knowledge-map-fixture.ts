/* Deterministic data for the knowledge-map fixture.

   Three agents, so the ring puts one north, one east and one south — which is
   what makes the fan geometry visible in a single screenshot: the same row of
   apps hangs off each of them square to its own radius, a horizontal row at the
   top and bottom and a vertical column on the flank.

   Between them they carry every state the ring can draw: an agent that needs
   you, one that is running something, one with nothing in flight; an app that
   is connected and one that is only an offer; a fan that fits and a fan that
   has to count what it is hiding.

   Duet is never on the ring — it is the drive root, a presentation identity
   rather than an agent row — so it is drawn on the core, and the one app here
   that no agent owns is drawn hanging off it. */
import { ROOT_AGENT_SCOPE } from '@repo/contract'

import type { MapIcons } from '../../spa/knowledge-map-data/project'
import type { Job, MapData } from '../../spa/knowledge-map/types'

/* Stand-in artwork for an app that ships an icon. A data URI rather than a file
   the playground serves, because the fan is drawn in SVG and a screenshot must
   not wait on a second request to know what it looks like. Two of them, so the
   picture shows what artwork does to a fan: a tile that is a picture, a tile
   that is two letters, and the same square around both. */
function art(back: string, ink: string, mark: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${back}"/>${mark.replaceAll('%INK%', ink)}</svg>`,
  )}`
}

export const FIXTURE_APP_ART = {
  chart: art(
    '#1e3a5f',
    '#8fd3ff',
    '<rect x="14" y="34" width="8" height="18" rx="2" fill="%INK%"/><rect x="28" y="22" width="8" height="30" rx="2" fill="%INK%"/><rect x="42" y="12" width="8" height="40" rx="2" fill="%INK%"/>',
  ),
  page: art(
    '#f2ede3',
    '#3d3427',
    '<rect x="16" y="12" width="32" height="40" rx="4" fill="none" stroke="%INK%" stroke-width="3"/><path d="M24 24h16M24 32h16M24 40h10" stroke="%INK%" stroke-width="3" stroke-linecap="round"/>',
  ),
} as const

/* The drive serves an app's icon out of its own folder; a fixture hands the
   artwork back inline instead, so the picture is the same bytes every run and
   no screenshot waits on a request. `icon` on the record is still what decides:
   an app that declares none is drawn as its initials, exactly as in the
   product. */
export const FIXTURE_APP_ICONS: MapIcons = { app: app => app.icon, agent: agent => agent.icon }

/* The owner's own conversation, unread — the one thing on this map that draws
   the dot on a face.

   It is here because for a long time it was nowhere: no fixture set a `chat`,
   so `hasUnread` was false on every node of every screenshot and the mark had
   no visual coverage at all. That is how two draw sites came to place it by
   different hand-tuned constants without any baseline noticing — `metrics.ts`
   now derives the position from the plate, and this is what proves it.

   On Duet *and* on a face, because those are the two draw sites and the whole
   defect was that they disagreed. One shot with both in it is the comparison. */
const UNREAD_CHAT: Job[] = [
  {
    id: 'chat-unread',
    title: 'Your conversation',
    when: '2 min ago',
    state: 'running',
    unread: true,
  },
]

export const KNOWLEDGE_MAP_FIXTURE: MapData = {
  duet: {
    id: ROOT_AGENT_SCOPE,
    name: 'Acme Studio',
    avatarKey: ROOT_AGENT_SCOPE,
    locked: true,
    jobs: [],
    chat: UNREAD_CHAT,
    apps: [
      {
        id: 'd-a1',
        title: 'Hello',
        when: '6 days ago',
        state: 'connected',
        icon: FIXTURE_APP_ART.page,
      },
    ],
  },
  coreMeta: '3 agents · 10 apps',
  agents: [
    {
      id: 'data-analyst',
      avatarKey: 'data-analyst',
      name: 'Data Analyst',
      /* A name its owner gave it, over the slug the rest of the product knows it
         by. Two of the three carry one and the third has never been renamed,
         because that is the ring the product actually draws — the second line
         has to sit under a two-word name and a one-word one, and a face with no
         second line at all has to look finished rather than clipped. */
      subtitle: 'data-analyst',
      /* The face's own chat, so the ring draws the mark too — see UNREAD_CHAT. */
      chat: UNREAD_CHAT,
      jobs: [
        {
          id: 'n-j1',
          title: 'Q3 revenue reconciliation',
          when: '20 min ago',
          state: 'asking',
          unread: false,
          step: 'Waiting on you',
        },
        {
          id: 'n-j2',
          title: 'Churn cohort breakdown',
          when: '1 hr ago',
          state: 'running',
          /* This agent is asking *and* holding unread work, which is the
             composition 09b exists to draw: two marks in opposite corners of one
             seat, answering two questions that can both be live. */
          unread: true,
          step: 'Tracking 14 cohorts forward',
          progress: 0.75,
        },
        {
          id: 'n-j3',
          title: 'Pipeline forecast v4',
          when: 'Yesterday',
          state: 'done',
          unread: false,
          step: 'Three scenarios written',
        },
      ],
      /* Five, so the fan draws three and one node counting the other two. */
      apps: [
        {
          id: 'n-a1',
          title: 'Snowflake',
          when: 'In use now',
          state: 'connected',
          icon: FIXTURE_APP_ART.chart,
        },
        { id: 'n-a2', title: 'Metabase', when: 'Yesterday', state: 'connected' },
        { id: 'n-a3', title: 'Stripe', when: '3 days ago', state: 'connected' },
        { id: 'n-a4', title: 'CSV import', when: 'One click away', state: 'available' },
        { id: 'n-a5', title: 'Looker', when: 'One click away', state: 'available' },
      ],
    },
    {
      id: 'seo-optimizer',
      avatarKey: 'seo-optimizer',
      name: 'SEO Writer',
      /* Renamed away from its slug, which is the case the line exists for: the
         face says one word and every URL says another. */
      subtitle: 'seo-optimizer',
      jobs: [
        {
          id: 'e-j2',
          title: 'Keyword gap vs competitors',
          when: '1 hr ago',
          state: 'running',
          unread: false,
          step: 'Reading rival 3 of 4',
          progress: 0.62,
        },
        {
          id: 'e-j5',
          title: 'Refresh the pricing page',
          when: '12 min ago',
          state: 'scheduled',
          unread: false,
          wakesIn: 'in 4 hours',
        },
      ],
      apps: [
        {
          id: 'e-a1',
          title: 'Search Console',
          when: 'In use now',
          state: 'connected',
          icon: FIXTURE_APP_ART.chart,
        },
        { id: 'e-a2', title: 'Ahrefs', when: '2 hrs ago', state: 'connected' },
        { id: 'e-a3', title: 'Screaming Frog', when: 'One click away', state: 'available' },
      ],
    },
    {
      /* Nothing in flight and one app: the ring has to hold a quiet member
         without it looking broken or half-drawn. Nobody has renamed it either,
         so it goes by its slug and wears no second line — a second line here would
         be the same word twice. */
      id: 'support-triage',
      avatarKey: 'support-triage',
      name: 'support-triage',
      jobs: [],
      apps: [{ id: 't-a1', title: 'Helpdesk', when: '20 min ago', state: 'connected' }],
    },
  ],
}
