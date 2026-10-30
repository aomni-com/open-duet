'use client'

/* ============================================================================
   The two drives the agent surface is judged against, and the stand-ins it is
   judged with.

   The home fixture is deliberately sparse — it exists to prove the projection,
   and four agents with one app each is the honest shape of a young drive. That
   is exactly the wrong shape for judging a composition: every surface looks
   calm when there is nothing in it.

   So `BUSY_*` is the drive on a busy day: an agent with work in every state this
   surface can actually reach, and more apps than the ring will show at once,
   because "and four more" is a state it has to answer for.

   And `QUIET_*` is the opposite end, which is not a corner case at all — it is
   what a real drive looks like on its first week and what this product's own
   workspace looks like today: one agent, one app, nothing running. A layout
   that only holds up full is a layout that has been judged once. The row of
   selectors is where that bites: with one app it is a single word on the left
   and two on the right, and everything between them is empty header.

   The two conversations in here are not the same kind of thing, and the
   difference is the whole reason there are two. In the map's own column what is
   under review is the room a layout gives a thread, so `FixtureChat` is a
   stand-in. In the jobs dialog the thread is the subject, so `FixtureSession`
   renders the product's real timeline and its real compose bar — see its own
   header.
   ========================================================================= */
import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { useState } from 'react'

import { bucketOf } from '@repo/contract'
import type { Agent, App, Machine, SessionSummary, WorkspaceMember } from '@repo/contract'
import { ComposeBar } from '@repo/ui/components/compose-bar'

import type { AgentSlice, CoreFacts, MapCopy } from '../../spa/knowledge-map-data/project'
import { buildTierQualityOptions } from '../../spa/model-tiers/tier-quality-options'
import type { ProjectedMessage } from '../../spa/sessions/projection'
import { createSessionAuthorDirectory } from '../../spa/sessions/session-authors'
import { SessionTimeline } from '../../spa/sessions/session-message'
import { workspaceSessionProjection } from './session-fixture'

/* Frozen, so every `when` caption on the surface is the same in every shot. */
export const BUSY_FIXTURE_NOW = Date.parse('2026-07-30T12:00:00.000Z')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const BUSY_FIXTURE_COPY: MapCopy = {
  when: (at, now) => {
    const minutes = Math.max(1, Math.round((now - at) / MINUTE))
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`
    const days = Math.round(hours / 24)
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
    return `${Math.round(days / 7)} wk ago`
  },
}

export const BUSY_FIXTURE_CORE: CoreFacts = {
  name: 'Acme Studio',
  meta: '4 agents · 14 apps',
  apps: [],
  jobs: [],
}

/* The id is opaque and deliberately unlike the slug, the same as in
   `knowledge-map-home-fixture.ts` and for the same reason: on the wire it is a
   Convex id, so a fixture where the two fields are the same string cannot
   photograph a surface that keys an avatar off the wrong one. */
function agent(slug: string, name: string): Agent {
  return {
    id: `k57${slug}xyz2`,
    workspaceId: 'ws-acme',
    anchorId: `anchor-${slug}`,
    anchorPath: `agents/${slug}`,
    anchorState: 'active',
    slug,
    name,
    createdAt: BUSY_FIXTURE_NOW - 90 * DAY,
    updatedAt: BUSY_FIXTURE_NOW - DAY,
  }
}

function job(
  id: string,
  title: string,
  turnStatus: SessionSummary['turnStatus'],
  ago: number,
  machine: Machine,
  /* See `knowledge-map-home-fixture`: opt-in, never derived from the bucket. */
  unread = false,
): SessionSummary {
  return {
    id,
    ...workspaceSessionProjection(),
    turnStatus,
    /* Derived, never stated: a fixture that picks its own bucket can disagree
       with the rule the product uses, and then it is testing itself. */
    bucket: bucketOf({ turnStatus, machine }),
    title,
    titleOrigin: 'auto',
    titleStatus: 'complete',
    createdAt: BUSY_FIXTURE_NOW - ago - HOUR,
    updatedAt: BUSY_FIXTURE_NOW - ago,
    lastEventSeq: 12,
    unread,
    machine,
  }
}

/* The drive's own work, as Duet answers for it.

   Duet is not an agent with a folder — it answers for the whole drive, so its
   list is the one place rows belong to *different* owners. That is the only
   thing this fixture exists to draw: `toMapJob` carries the owner into `sub`,
   and the dialog prints it on Duet's rows and on nobody else's. Two owners and
   one unclaimed row, because a list where every row names the same agent proves
   nothing about a column that only appears when they differ. */
export const DRIVE_UNCLAIMED_JOBS: readonly SessionSummary[] = [
  {
    ...job('job-d1', 'Nightly drive backup', 'running', 8 * MINUTE, {
      orderedPath: [],
      activity: 'running',
      definitionName: 'backup',
      currentState: 'copying',
    }),
    agent: { id: 'agent-ops', name: 'Ops' },
  },
  {
    ...job('job-d2', 'Reindex the shared folder', 'ask', 34 * MINUTE, {
      orderedPath: [],
      activity: 'waiting',
      definitionName: 'reindex',
      currentState: 'confirm the scope',
    }),
    agent: { id: 'agent-librarian', name: 'Librarian' },
  },
  /* No owner at all — the case `ROOT_AGENT_SCOPE` names and the one that has to
     survive a column built from `job.agent?.name`. */
  /* Finished two days ago and never opened: the case unread exists for, drawn
     under a heading that on its own says nothing about who has seen it. */
  job(
    'job-d3',
    'Prune expired share links',
    'complete',
    2 * DAY,
    { orderedPath: [], activity: 'idle', definitionName: 'prune' },
    true,
  ),
]

function app(slug: string, name: string, runtimeStatus: App['runtimeStatus'], ago: number): App {
  return {
    id: `app-${slug}`,
    workspaceId: 'ws-acme',
    anchorId: `anchor-app-${slug}`,
    anchorPath: `apps/${slug}`,
    anchorState: 'active',
    slug,
    name,
    runtimeStatus,
    createdAt: BUSY_FIXTURE_NOW - 30 * DAY,
    updatedAt: BUSY_FIXTURE_NOW - ago,
  } as App
}

/* Work in every state this surface can actually show. The map reads the jobs
   list's *active* view, so a finished job never reaches it — a fixture with one
   in it would screenshot a state no reader can get to, and its header would say
   "6 in flight" over a list where two of them are not. */
const ANALYST_JOBS: readonly SessionSummary[] = [
  job('job-a1', 'Backfill Q2 cohorts', 'ask', 26 * MINUTE, {
    orderedPath: [],
    activity: 'waiting',
    definitionName: 'backfill',
    currentState: 'needs a date range',
  }),
  job('job-a2', 'Reconcile the ledger export', 'ask', 51 * MINUTE, {
    orderedPath: [],
    activity: 'waiting',
    definitionName: 'reconcile',
    currentState: 'two rows will not match',
  }),
  /* Running *and* unread, beside `job-a4` which is running and read. Two rows
     under one heading, differing only in the reader's own history — which is
     the claim the dot makes and the bucket cue cannot. */
  job(
    'job-a3',
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
  job('job-a4', 'Churn model retrain', 'running', 9 * MINUTE, {
    orderedPath: [],
    activity: 'running',
    definitionName: 'retrain',
    currentState: 'scoring the holdout',
    progress: { completed: 7, total: 9 },
  }),
  job('job-a5', 'Refresh the pricing dashboard', 'sleep', 12 * MINUTE, {
    orderedPath: [],
    activity: 'sleeping',
    definitionName: 'refresh',
    nextWakeAt: BUSY_FIXTURE_NOW + 4 * HOUR,
  }),
  job('job-a6', 'Nightly warehouse cost sweep', 'sleep', 3 * HOUR, {
    orderedPath: [],
    activity: 'sleeping',
    definitionName: 'sweep',
    nextWakeAt: BUSY_FIXTURE_NOW + 9 * HOUR,
  }),
]

/* More than the ring draws at once, on purpose. */
const ANALYST_APPS: readonly App[] = [
  app('metrics', 'Metrics', 'reconciled', 3 * HOUR),
  app('warehouse', 'Warehouse', 'reconciled', 40 * MINUTE),
  app('cohorts', 'Cohort Explorer', 'reconciled', DAY),
  app('pricing', 'Pricing Board', 'reconciled', 2 * DAY),
  app('forecast', 'Forecast', 'reconciling', 5 * HOUR),
  app('ledger', 'Ledger', 'reconciled', 6 * DAY),
  app('anomaly', 'Anomaly Watch', 'reconcile_failed', 9 * DAY),
  app('exports', 'Exports', 'reconciled', 11 * DAY),
]

export const BUSY_FIXTURE_SLICES: readonly AgentSlice[] = [
  { agent: agent('analyst', 'Data Analyst'), apps: ANALYST_APPS, jobs: ANALYST_JOBS },
  {
    agent: agent('seo', 'SEO Writer'),
    apps: [app('search-console', 'Search Console', 'reconciled', 2 * DAY)],
    jobs: [
      job('job-s1', 'Refresh the pricing page', 'sleep', 12 * MINUTE, {
        orderedPath: [],
        activity: 'sleeping',
        definitionName: 'refresh',
        nextWakeAt: BUSY_FIXTURE_NOW + 4 * HOUR,
      }),
    ],
  },
  {
    agent: agent('support', 'Support Triage'),
    apps: [
      app('helpdesk', 'Helpdesk', 'reconciled', 20 * MINUTE),
      app('status-page', 'Status Page', 'reconciling', 4 * DAY),
    ],
    jobs: [
      job('job-t1', 'Tag overnight tickets', 'ask', 55 * MINUTE, {
        orderedPath: [],
        activity: 'waiting',
        currentState: 'which queue?',
      }),
    ],
  },
  {
    agent: agent('scout', 'Market Scout'),
    apps: [app('rss', 'Feeds', 'reconcile_failed', 11 * DAY)],
    jobs: [],
  },
]

/* One agent, one app, nothing in flight — this product's own workspace, and
   every drive's first week. The core says so too: a map that claimed four
   agents over a ring holding one would be a fixture arguing with itself. */
export const QUIET_FIXTURE_CORE: CoreFacts = {
  name: 'Acme Studio',
  meta: '1 agent · 1 app',
  apps: [],
  jobs: [],
}

export const QUIET_FIXTURE_SLICES: readonly AgentSlice[] = [
  {
    agent: agent('analyst', 'Data Analyst'),
    apps: [app('metrics', 'Metrics', 'reconciled', 3 * HOUR)],
    jobs: [],
  },
]

/* A conversation-shaped stand-in. It has the two things the surface has to be
   judged against — a thread that scrolls and a composer pinned under it — and
   nothing else, because everything else would be the session surface's design
   rather than this one's. */
export function FixtureChat() {
  return (
    <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
      <div className="grid min-h-0 gap-3 overflow-y-auto px-3.5 py-3 content-start">
        <Turn who="you">Pull last week&rsquo;s revenue by channel and flag anything odd.</Turn>
        <Turn who="agent">
          Running it now against the warehouse. Paid search is down 18% week on week — everything
          else is inside its usual band.
        </Turn>
        <Turn who="you">Is that the tracking change from Tuesday?</Turn>
        <Turn who="agent">
          Looks like it. I have queued a backfill for Q2 cohorts, but I need a date range before it
          can start.
        </Turn>
      </div>
      <div className="m-2.5 mt-0 flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--km-line)_80%,transparent)] bg-[color-mix(in_srgb,var(--km-slab-2)_45%,transparent)] px-3 py-2.5">
        <span className="km-quiet">Continue the thread…</span>
        <span
          aria-hidden
          className="ml-auto grid size-5 place-items-center rounded-md bg-[var(--km-slab-2)] text-[10px] text-[var(--km-dim)]"
        >
          ↑
        </span>
      </div>
    </div>
  )
}

/* ---- the conversation in the dialog's right pane ----
   `FixtureChat` above is a stand-in and says why: what is under review one
   column over is the room a layout gives a thread, not the thread. Here the
   thread *is* the subject. The route mounts a live `SessionsProduct` in this
   pane, so what has to be judged is the product's own conversation — its
   measure, its authored rows, its compose bar — sitting in a box it has never
   been asked to sit in before.

   Four `<p>` bubbles and a div shaped like a composer answered every question
   about this pane except that one, and every screenshot ever taken of this
   dialog was therefore of a lookalike. So this renders the two components the
   route renders: `SessionTimeline` and `ComposeBar`.

   What cannot come with them is the surface around them. `SessionsProduct` is a
   query surface — Convex, auth, a session id, an event stream — and mounting it
   is what `/playground/spa-shell` is for. The frame below is that surface's
   `bare` skeleton copied by hand: same scroller, same top and bottom masks, same
   footer, and the same absence of a gutter, because `bare` means the host owns
   the gutter (see the footer's comment in `spa/routes/sessions.tsx`). Copied,
   which means it can drift — and if it does, this screenshot goes back to
   describing a pane the product does not draw. The live path is the check on
   that, and it is the one to run when this shot and the real dialog disagree. */

/* On the same frozen clock as everything else here, and derived from it rather
   than written out again: a transcript that drifted from the drive's own "now"
   would put a conversation in the future of the list beside it, and a clock that
   moves at all is a baseline that fails for a reason nobody changed. */
const SESSION_FIXTURE_AT = BUSY_FIXTURE_NOW - 46 * MINUTE

const READER: WorkspaceMember = {
  id: 'user-mara',
  email: 'mara@acme.example',
  name: 'Mara Chen',
  role: 'owner',
  isBillingUser: true,
}

/* A loaded roster, deliberately: with `members` left out the directory reports
   `rosterLoaded: false` and every authored row draws the grey placeholder bar
   instead of a name — which is a real state of the product, and not the one
   this dialog is being judged in. */
const SESSION_FIXTURE_AUTHORS = createSessionAuthorDirectory({
  viewer: READER,
  members: [READER],
})

const READER_SENDER = { kind: 'user', userId: READER.id } as const

/* One long agent paragraph on purpose. The right pane is a thousand pixels wide
   at 1440, and the thread's `max-w-4xl` is the only thing between that and a
   hundred-character line; a fixture of short replies would let a broken measure
   through. */
function sessionFixtureMessages(title: string): ProjectedMessage[] {
  return [
    {
      id: 'fixture-ask',
      role: 'input',
      source: 'prompt',
      sender: READER_SENDER,
      text: `${title} — where did this land?`,
      createdAt: SESSION_FIXTURE_AT,
    },
    {
      id: 'fixture-answer',
      role: 'agent',
      finalized: true,
      createdAt: SESSION_FIXTURE_AT + MINUTE,
      parts: [
        {
          kind: 'text',
          id: 'fixture-answer-text',
          text: 'Two of the three source tables reconciled cleanly. The third is missing yesterday’s partition, so I have paused rather than publish a number I cannot stand behind — the rollup would have shipped a day of orders short and nothing downstream would have said so.',
        },
      ],
    },
    {
      id: 'fixture-steer',
      role: 'input',
      source: 'prompt',
      sender: READER_SENDER,
      text: 'Use the previous partition and flag it.',
      createdAt: SESSION_FIXTURE_AT + 3 * MINUTE,
    },
    {
      id: 'fixture-close',
      role: 'agent',
      finalized: true,
      createdAt: SESSION_FIXTURE_AT + 4 * MINUTE,
      parts: [
        {
          kind: 'text',
          id: 'fixture-close-text',
          text: 'Done. The rollup is running again and the flag is on the summary row.',
        },
      ],
    },
  ]
}

/* The setup interview, in the same real components. An onboarding conversation
   is an ordinary session — that is the whole premise of the feature — so the
   shot of one has to be of the product's own timeline and compose bar rather
   than of a lookalike. Only the words differ from a working thread, and they
   have to: an agent asking for what it needs reads nothing like an agent
   reporting on a job, and the header above it names the difference. */
export const ONBOARDING_FIXTURE_MESSAGES: ProjectedMessage[] = [
  {
    id: 'fixture-onboarding-open',
    role: 'agent',
    finalized: true,
    createdAt: SESSION_FIXTURE_AT,
    parts: [
      {
        kind: 'text',
        id: 'fixture-onboarding-open-text',
        text: 'Before I can be useful I need to know what good looks like here. Which warehouse should I read from, and is there a metrics definition I should treat as the source of truth?',
      },
    ],
  },
  {
    id: 'fixture-onboarding-answer',
    role: 'input',
    source: 'prompt',
    sender: READER_SENDER,
    text: 'Snowflake, the ANALYTICS_PROD database. Definitions live in dbt — the semantic layer, not the raw tables.',
    createdAt: SESSION_FIXTURE_AT + MINUTE,
  },
  {
    id: 'fixture-onboarding-follow',
    role: 'agent',
    finalized: true,
    createdAt: SESSION_FIXTURE_AT + 2 * MINUTE,
    parts: [
      {
        kind: 'text',
        id: 'fixture-onboarding-follow-text',
        text: 'Noted, and I have written both down. Last thing: when a number looks wrong, would you rather I pause and ask, or publish it with a flag on the row?',
      },
    ],
  },
]

export function FixtureSession({
  title,
  messages,
}: {
  title: string
  /** The transcript, when the default working thread is the wrong subject. */
  messages?: ProjectedMessage[]
}) {
  const t = useTranslations('duetApp.sessionProduct')
  /* Local, so the composer is a real controlled component the way its README
     says every consumer owns it — and so poking at the playground types the way
     the product does. It starts empty, which is the deterministic state and also
     the resting one: placeholder showing, send button off. */
  const [draft, setDraft] = useState('')
  /* The product's own two tiers, built by the product's own builder rather
     than typed out here: the row draws a label and three meters per option, and
     a fixture with its own copy of those would be screenshotting numbers nobody
     ships. */
  const qualityOptions = buildTierQualityOptions()

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <main className="relative flex h-full min-w-0 flex-1 flex-col bg-background">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-brand/[0.07] via-brand/[0.03] to-transparent"
        />
        <div
          role="log"
          aria-label={t('timeline')}
          /* The BARE path's padding and mask, which is the path a host like this
             one puts the conversation on. The tall top band and the
             transparent-topped fade exist to let a thread scroll under the
             route's own translucent header, and a bare host has taken that
             header away — so on a phone they were eighty pixels of dead space
             above the first message and a fade over nothing. This copy had the
             un-bare version, which is the drift its own header warns about. */
          className="relative min-h-0 flex-1 scroll-pb-16 overflow-y-auto scroll-smooth pb-3 pt-3 [mask-image:linear-gradient(to_bottom,black_calc(100%-1rem),transparent)] md:py-3"
        >
          <div className="relative mx-auto max-w-4xl pb-10">
            <SessionTimeline
              messages={messages ?? sessionFixtureMessages(title)}
              duetName={SESSION_FIXTURE_AUTHORS.duetName}
              agent={{ name: 'Data Analyst', avatarKey: 'analyst' }}
              authors={SESSION_FIXTURE_AUTHORS}
              imageUrl={() => '/icons/duet-avatar.png'}
              cwd={undefined}
              fileUrl={() => 'about:blank'}
            />
          </div>
        </div>
        {/* `bare`'s footer, to the class: no gutter and no standoff of its own,
            because the host is what frames this. Which host that is decides
            where the composer sits — see the right pane in `agent-jobs/panes.tsx`.

            `max-h-[50%]` and the flex column with it are the product's own
            sizing rule, copied because this shot is a claim about the real
            footer: the composer may take half the conversation and the draft
            finds its size under that, which is why the compose bar below passes
            no `maxHeight` of its own. It does not bind at this pane's height —
            that is the point, it should not — but a copy that omits the rule is
            a copy that cannot show it failing. */}
        <footer className="relative z-10 flex max-h-[50%] min-h-0 flex-col bg-background pb-0 pt-2">
          {/* `mx-auto max-w-4xl` — the same measure the timeline above uses, and
              the same one `bare` gives the composer in `sessions.tsx`. Without
              it a wide pane stretches the compose bar to a thousand pixels while
              the thread stays capped at eight hundred and ninety-six, and the
              two stop being one column. This line is the copy that has to track
              the real footer; if they drift, this is where. */}
          <div className="mx-auto min-w-0 max-w-4xl">
            {/* Idle, not `disabled`. Passing `disabled` drops the whole compose
                surface to 70% opacity, and a shot of that is a verdict on a
                greyed-out composer rather than on the one a reader meets. This
                one is inert because nothing is wired behind it, which is a
                different thing from being switched off — and it is what the real
                pane looks like the moment before somebody types.

                What the product adds and this does not is `SessionComposer`, the
                thin wrapper that puts the "Follow up" checkbox in the toolbar
                row: that checkbox is a choice about how the next message is
                delivered, and there is no delivery here to choose for. It is one
                label wide, and it is the one place this shot is narrower than
                the live dialog. */}
            <ComposeBar
              value={draft}
              onValueChange={setDraft}
              onSubmit={() => setDraft('')}
              input={{
                label: t('messageLabel'),
                placeholder: t('messagePlaceholder'),
              }}
              /* Every capability the session composer turns on at rest, and the
                 same copy out of the same namespace: a fixture that dropped the
                 quality row or the attach button would be judging a composer
                 one row shorter than the real one. */
              quality={{
                label: t('quality'),
                value: 'balanced',
                options: qualityOptions,
                onValueChange: () => {},
              }}
              aiToggle={{
                label: t('askDuet'),
                enabled: true,
                onEnabledChange: () => {},
                icon: (
                  <Image
                    unoptimized
                    src="/icons/duet-avatar.png"
                    alt=""
                    width={24}
                    height={24}
                    className="size-6 select-none object-cover"
                  />
                ),
              }}
              attachments={{
                items: [],
                onFilesSelected: () => {},
                onRemove: () => {},
                fileInput: { label: t('attachFiles') },
                dropLabel: t('dropFiles'),
              }}
              submit={{ label: t('send') }}
              classNames={{
                surface:
                  'border-border/70 bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-brand/35 focus-within:ring-2 focus-within:ring-brand/10',
              }}
            />
          </div>
        </footer>
      </main>
    </div>
  )
}

/* An app-shaped stand-in for the stage. The product mounts a cross-origin
   iframe here; a fixture cannot, and a screenshot of somebody else's document
   would be a screenshot of their design rather than of the room this surface
   gives them. So it is a plain sheet at the size a real app renders at. */
export function FixtureApp({ title }: { title: string }) {
  return (
    <div className="grid min-h-0 content-start gap-4 overflow-hidden bg-card p-7">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="grid gap-2.5">
        {[92, 78, 64].map(width => (
          <div key={width} className="h-3 rounded-full bg-muted" style={{ width: `${width}%` }} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {['Runs', 'Sources', 'Alerts'].map(card => (
          <div key={card} className="grid gap-2 rounded-xl border border-border p-4">
            <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              {card}
            </span>
            <span className="text-2xl font-semibold tabular-nums">{card.length * 4}</span>
          </div>
        ))}
      </div>
      {/* A chart-shaped block rather than an empty bordered box: the same
          hairline as the cards above it, with nothing in it, read as a fourth
          card that had failed to load. */}
      <div className="flex h-56 items-end gap-2 rounded-xl bg-muted/40 p-5">
        {[38, 62, 47, 80, 55, 71, 44, 66, 90, 58].map((height, index) => (
          <span
            key={index}
            style={{ height: `${height}%` }}
            className="flex-1 rounded-t-sm bg-muted-foreground/25"
          />
        ))}
      </div>
    </div>
  )
}

function Turn({ who, children }: { who: 'you' | 'agent'; children: React.ReactNode }) {
  return (
    <p
      data-who={who}
      className={
        who === 'you'
          ? 'ml-auto w-fit max-w-[85%] rounded-xl rounded-br-sm bg-[color-mix(in_srgb,var(--km-slab-2)_80%,transparent)] px-3 py-2 km-body'
          : /* a measure, not a container width: this stands in for the product's
               own thread, and a hundred-character line would flatter a wide
               pane for a reason the real one would not share */
            'w-fit max-w-[58ch] km-body text-[color-mix(in_srgb,var(--km-fg)_88%,transparent)]'
      }
    >
      {children}
    </p>
  )
}
