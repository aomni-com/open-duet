'use client'

/* ============================================================================
   The agents rail, in the four pictures that decide whether it is right.

   `canvas`  — the map with the control standing on it, shut. This is the only
               shot that judges the thing the feature is mostly *seen* as: a
               faint square under the workspace's own mark, which has to be
               findable without competing with the drive behind it. Judge it by
               looking away from it.
   `open`    — the rail out, beside the map rather than over it. What this shot
               is for is the one thing the unit tests cannot reach: that the
               canvas gave up room instead of being covered, that the ring
               re-framed itself into what was left, and that nothing anywhere had
               to be dimmed to make the list legible.
   `inside`  — the agent's own page, with the column standing beside it. It used
               to prove the opposite rule (nothing of the rail's left standing on
               that surface), and the reversal is the whole feature: the roster
               is the section's navigator, so it is on every destination in it.
   `inside-folded`
             — the same page with the column away. This is the shot that judges
               the state the other three cannot: with the head gone, the only way
               back is the control standing in the agent's own well, in the slot
               a back-arrow used to hold. Get this wrong and a reader who folds
               the column on an agent has no way to reach a second one.
   `states`  — the list on its own, inline, four times over. The full-page
               capture cannot hold four whole rails at one viewport position, so
               every answer the read can give gets its own box instead.

   Everything below the fixture data is production: `railRows` is the same
   projection the route runs, over `projectWorkspaceMap`'s own output, so a shot
   here cannot flatter a rail the product would draw differently.
   ========================================================================= */
import { NextIntlClientProvider } from 'next-intl'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MemoryRouter } from 'react-router'

import { ROOT_AGENT_SCOPE } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import {
  projectWorkspaceMap,
  type MapCopy,
  type MapPreviews,
} from '../../spa/knowledge-map-data/project'
import type { KnowledgeMapZoom } from '../../spa/knowledge-map/knowledge-map'
import type { Job, Agent as MapAgent, MapData } from '../../spa/knowledge-map/types'
import { AgentPage } from '../../spa/routes/agents-map/agent-page'
import { AgentSurface } from '../../spa/routes/agents-map/agent-surface'
import { useHeaderRow } from '../../spa/routes/agents-map/agent-surface/use-header-row'
import { AgentsRail, OpenRoster } from '../../spa/routes/agents-map/agents-rail'
import { AgentsRailList } from '../../spa/routes/agents-map/agents-rail/list'
import { railRows, type RailRow } from '../../spa/routes/agents-map/agents-rail/roster'
import { AgentsSection } from '../../spa/routes/agents-map/agents-section'
import { KnowledgeMapHome } from '../../spa/routes/agents-map/knowledge-map-home'
import {
  BUSY_FIXTURE_CORE,
  BUSY_FIXTURE_NOW,
  BUSY_FIXTURE_SLICES,
  DRIVE_UNCLAIMED_JOBS,
  FixtureApp,
  FixtureChat,
} from './agent-surface-busy-fixture'
import { SURFACE_FILES, SURFACE_SKILLS } from './agent-surface-fixture'
import { FIXTURE_APP_ICONS } from './knowledge-map-fixture'

/* The first prose line of each agent's `AGENTS.md`, which is what the product
   reads per row. Deliberately uneven: one that fits, one that is long enough to
   be cut, and one agent that describes itself nowhere — the row that has to
   stay the same height as its neighbours with nothing on its second line. */
const DESCRIPTIONS: Record<string, string> = {
  analyst: 'Turns the warehouse into decisions — cohorts, funnels, and the weekly numbers.',
  seo: 'Writes and refreshes the pages that have to rank, and says when they slipped.',
  support:
    'Reads every ticket that came in overnight, tags it, and escalates the ones that cannot wait until Monday.',
}

function FixtureDescription({ row }: { row: RailRow }) {
  if (row.duet) return <>The drive itself</>
  return <>{DESCRIPTIONS[row.agent.id] ?? null}</>
}

/* The fixture clock next door only speaks about the past — it clamps a negative
   difference to one minute — which is enough for surfaces that print how long
   ago something moved. This list also prints when a sleeping job is due to
   *wake*, so without the other direction the one scheduled row in here reads "1
   min ago" about something that has not happened yet, and the shot quietly
   stops showing the behaviour it exists to show. The product says "in 4 hours"
   through `format.relativeTime`; this says the same in the fixture's register. */
const RAIL_COPY: MapCopy = {
  when: (at, now) => (at > now ? `in ${span(at - now)}` : `${span(now - at)} ago`),
}

/* The roster resolves a sender id against the workspace roster; the fixture
   stands in for that read so the shot shows the name a reader would actually
   see rather than the bare words a missing roster leaves behind. */
const FIXTURE_MEMBER_NAME = (userId: string) => (userId === 'u_1' ? 'Ada Lovelace' : undefined)

/* The last thing said to each carrier, in the three shapes the band has: the
   agent's own last word, a person's, and none.

   SEO Writer is the load-bearing absence. It has a description and no preview,
   which is the only combination that shows whether a missing message reads as
   *not talked to yet* or as a line that failed — Market Scout has neither, so
   its hole proves nothing about this band.

   Held here rather than as a `chat` on the shared drive fixture, because a
   chat on a slice also hangs a bead off that agent's face: every shot the ring
   is in would move for a band only this column draws. `railRows` takes the
   table as an argument precisely so a surface can answer for it alone. */
const RAIL_PREVIEWS: MapPreviews = new Map([
  ['analyst', { text: 'Paid search is down 18% week on week.', author: { kind: 'agent' } }],
  [
    'support',
    { text: 'escalate anything still open from Friday', author: { kind: 'user', userId: 'u_1' } },
  ],
  [
    ROOT_AGENT_SCOPE,
    { text: 'reindex the drive and tell me what changed', author: { kind: 'user', userId: 'u_1' } },
  ],
])

/* Each carrier's own conversation, in the states the row's mark can be in.
   Rail-local for exactly the reason `RAIL_PREVIEWS` is: a `chat` on the shared
   drive fixture hangs an unread bead off that agent's face, so every shot the
   ring is in would move for a mark only this column draws.

   Four answers across the rows. Analyst has an unread chat that is also waiting
   on a person — both marks at once, which is the only combination that shows
   they do not collapse into one. The drive's own chat is unread and finished:
   unread is not a fifth state. Support Triage is running and read: the state dot
   without the unread one. SEO Writer and Market Scout have no chat at all, which
   is what a carrier nobody has written to looks like and must not look like a
   resting mark. */
const RAIL_CHATS: ReadonlyMap<string, Job> = new Map([
  [
    'analyst',
    { id: 'chat_analyst', title: 'Analyst', when: '4 min', state: 'asking', unread: true },
  ],
  [
    ROOT_AGENT_SCOPE,
    { id: 'chat_root', title: 'Acme Studio', when: '8 min', state: 'done', unread: true },
  ],
  [
    'support',
    {
      id: 'chat_support',
      title: 'Support Triage',
      when: '55 min',
      state: 'running',
      unread: false,
    },
  ],
])

/** One carrier, with its conversation hung on it when this table names one. */
function withRailChat(agent: MapAgent): MapAgent {
  const chat = RAIL_CHATS.get(agent.id)
  return chat === undefined ? agent : { ...agent, chat: [chat] }
}

/* Both halves, because `railRows` reads them from two places: Duet off the
   drive, and every other carrier off the *directory*. Chatting only the drive
   is the mistake this pair exists to make impossible — it leaves every agent
   row unmarked while the fixture reads as though it had marked them. */
function withRailChats(data: MapData): MapData {
  return { ...data, duet: withRailChat(data.duet), agents: data.agents.map(withRailChat) }
}

function directoryWithRailChats(
  directory: ReadonlyMap<string, MapAgent>,
): ReadonlyMap<string, MapAgent> {
  return new Map([...directory].map(([id, agent]) => [id, withRailChat(agent)]))
}

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return days < 7 ? `${days} day${days === 1 ? '' : 's'}` : `${Math.round(days / 7)} wk`
}

export function AgentsRailPlayground({
  view = 'canvas',
}: { view?: 'canvas' | 'open' | 'inside' | 'inside-folded' | 'states' } = {}) {
  const host = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(view !== 'canvas' && view !== 'inside-folded')
  /* The fixture holds the same fact the route does, because this is the only
     place the pair is photographed together — a rail wired to nothing here
     would screenshot green while the mark it drives never fires. */
  const [railHover, setRailHover] = useState<string | null>(null)

  /* Duet answers for what nobody claimed, so the drive's own unclaimed work is
     its row's — otherwise the one carrier every drive has would be the one
     carrier this fixture never shows working. */
  const projected = useMemo(
    () =>
      projectWorkspaceMap(
        { ...BUSY_FIXTURE_CORE, jobs: DRIVE_UNCLAIMED_JOBS },
        BUSY_FIXTURE_SLICES,
        BUSY_FIXTURE_NOW,
        RAIL_COPY,
        FIXTURE_APP_ICONS,
      ),
    [],
  )
  const rows = useMemo(
    () =>
      railRows(
        withRailChats(projected.data),
        directoryWithRailChats(projected.agentDirectory),
        projected.activity,
        RAIL_PREVIEWS,
        projected.routes,
        BUSY_FIXTURE_NOW,
        RAIL_COPY,
      ),
    [projected],
  )

  /* The same drive one beat earlier: the roster has answered and the job read
     has not, which is every drive's first paint. Built by taking the work away
     rather than by hand, so it stays the state the product actually passes
     through — no jobs means no counts, no rows under a name, and no activity to
     sort on, which is what drops the whole list to its alphabetical fall-back. */
  const rosterOnly = useMemo(() => {
    const jobless = {
      ...projected.data,
      duet: { ...projected.data.duet, jobs: [] },
      agents: projected.data.agents.map(agent => ({ ...agent, jobs: [] })),
    }
    return railRows(
      jobless,
      new Map(jobless.agents.map(agent => [agent.id, agent])),
      new Map(),
      /* Previews ride the same read the jobs do, so a roster that has answered
         while that one has not has neither. */
      new Map(),
      projected.routes,
      BUSY_FIXTURE_NOW,
      RAIL_COPY,
    )
  }, [projected])

  const markFrameReady = useCallback(() => {
    if (host.current) host.current.dataset.playgroundFrameReady = 'true'
  }, [])
  /* The map answers this through `onSettled`, because a shot of the ring must
     not land mid-flight. The agent's page has no camera and nothing to settle,
     so it says so itself on the frame it mounts — without this the `inside`
     capture waits for a signal that route can never send. */
  const insideRef = useRef(false)
  useEffect(() => {
    if (view !== 'inside' || insideRef.current) return
    insideRef.current = true
    markFrameReady()
  }, [markFrameReady, view])

  /* ------------------------------------------------------------ `inside`
     The agent the camera is inside, picked off the projection rather than named
     so the shot cannot drift from the fixture it is drawn out of. */
  const agent = projected.data.agents[0]
  /* Narrowed to the agent variant rather than the whole union: everything below
     reads `zoom.agent`, and the core has none. */
  const zoom = useMemo<Extract<KnowledgeMapZoom, { kind: 'agent' }> | null>(
    () =>
      (view === 'inside' || view === 'inside-folded') && agent !== undefined
        ? { kind: 'agent', agent }
        : null,
    [agent, view],
  )
  /* The real hook over in-memory storage, so the strip is the one the product
     arranges and the screenshot is the same every run. */
  const kept = useRef(new Map<string, string>())
  const storage = useMemo(
    () => ({
      getItem: (key: string) => kept.current.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.current.set(key, value),
    }),
    [],
  )
  const row = useHeaderRow(
    agent?.id ?? '',
    { appIds: agent?.apps.map(item => item.id) ?? [] },
    storage,
  )

  if (view === 'states') {
    return (
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <MemoryRouter>
          <div className="grid gap-4 lg:grid-cols-2">
            <StateBox title="ready — the drive, listed">
              <AgentsRailList
                rows={rows}
                phase="ready"
                continuation={{ available: true, loading: false, failed: false, load: () => {} }}
                onRetry={() => {}}
                onOpen={() => {}}
                onOpenApp={() => {}}
                memberName={FIXTURE_MEMBER_NAME}
                description={FixtureDescription}
              />
            </StateBox>
            {/* The ordinary first paint, and the one worth staring at. Two
                reads land a moment apart, so for that moment every row is a
                name and a description and nothing else — no number, no work,
                and no order to speak of either, which is what the alphabetical
                fall-back below the fold is for. Nothing here is a zero: a row
                with nothing on it claims nothing. */}
            <StateBox title="the roster has landed, the jobs have not">
              <AgentsRailList
                rows={rosterOnly}
                phase="ready"
                continuation={{ available: false, loading: false, failed: true, load: () => {} }}
                onRetry={() => {}}
                onOpen={() => {}}
                onOpenApp={() => {}}
                memberName={FIXTURE_MEMBER_NAME}
                description={FixtureDescription}
              />
            </StateBox>
            <StateBox title="still reading">
              <AgentsRailList
                rows={[]}
                phase="pending"
                continuation={{ available: false, loading: false, failed: false, load: () => {} }}
                onRetry={() => {}}
                onOpen={() => {}}
                onOpenApp={() => {}}
                memberName={FIXTURE_MEMBER_NAME}
                description={FixtureDescription}
              />
            </StateBox>
            <StateBox title="that did not load">
              <AgentsRailList
                rows={[]}
                phase="error"
                continuation={{ available: false, loading: false, failed: false, load: () => {} }}
                onRetry={() => {}}
                onOpen={() => {}}
                onOpenApp={() => {}}
                memberName={FIXTURE_MEMBER_NAME}
                description={FixtureDescription}
              />
            </StateBox>
          </div>
        </MemoryRouter>
      </NextIntlClientProvider>
    )
  }

  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <MemoryRouter>
        {/* The product's own bar height, declared here because `DriveShell` is
            what sets it and no shell is mounted: without it the control would be
            photographed hard against the top of the frame, which is the one
            thing about its placement worth checking. */}
        <div
          ref={host}
          data-playground-wait-for-frame
          className="h-[100dvh] bg-background [--drive-topbar-h:3rem]"
        >
          {/* One or the other, the way the router has it: the graph is
              `agents/graph` and an agent is `agents/:agentSlug`, so no picture
              ever holds both. The rail is furniture on either — and its head's
              one control points at whichever of the two is not on screen, so
              these two shots are also the two states of that toggle. */}
          {zoom === null ? (
            <AgentsSection
              roster={
                <AgentsRail
                  onHoverNode={setRailHover}
                  out={open}
                  onToggle={() => setOpen(value => !value)}
                  onAddAgent={() => {}}
                  workDestination={{ href: '/w/acme/home', onOpen: () => {} }}
                  graphDestination={{ href: '/w/acme/agents/graph', onOpen: () => {} }}
                  graphSelected
                  rows={rows}
                  phase="ready"
                  continuation={{ available: true, loading: false, failed: false, load: () => {} }}
                  onRetry={() => {}}
                  onOpen={() => {}}
                  onOpenApp={() => {}}
                  memberName={FIXTURE_MEMBER_NAME}
                  description={FixtureDescription}
                />
              }
            >
              <KnowledgeMapHome
                highlightId={railHover}
                data={projected.data}
                state="ready"
                zoom={null}
                onZoom={() => {}}
                onOpen={() => {}}
                onAddAgent={() => {}}
                onSettled={markFrameReady}
              />
            </AgentsSection>
          ) : (
            <AgentsSection
              roster={
                <AgentsRail
                  out={open}
                  onToggle={() => setOpen(value => !value)}
                  onAddAgent={() => {}}
                  workDestination={{ href: '/w/acme/home', onOpen: () => {} }}
                  graphDestination={{ href: '/w/acme/agents/graph', onOpen: () => {} }}
                  graphSelected={false}
                  /* The agent the camera is inside is the agent the reader is
                     reading, so its row is marked — which is the only state the
                     mark exists for, and the reason it is photographed here
                     rather than in a fixture of its own. Off `zoom` rather than
                     named, so the row that lights up cannot drift from the
                     surface beside it. */
                  selectedAgentId={zoom.agent.id}
                  rows={rows}
                  phase="ready"
                  continuation={{ available: true, loading: false, failed: false, load: () => {} }}
                  onRetry={() => {}}
                  onOpen={() => {}}
                  onOpenApp={() => {}}
                  memberName={FIXTURE_MEMBER_NAME}
                  description={FixtureDescription}
                />
              }
            >
              <AgentPage>
                <AgentSurface
                  openRoster={
                    open ? null : <OpenRoster onToggle={() => setOpen(value => !value)} />
                  }
                  name={zoom.agent.name}
                  subtitle={zoom.agent.subtitle}
                  portrait={{ avatarKey: 'research' }}
                  apps={{ phase: 'ready', items: zoom.agent.apps }}
                  row={row.items}
                  drag={{ onDrop: row.drop }}
                  skills={{ phase: 'ready', items: SURFACE_SKILLS }}
                  files={{ phase: 'ready', items: SURFACE_FILES }}
                  showing={null}
                  onShow={() => {}}
                  onOpenFile={() => {}}
                  integrationsHref="/w/acme/integrations"
                  trainHref={`/w/acme/agents/${zoom.agent.id}/train`}
                  settingsHref={`/w/acme/agents/${zoom.agent.id}`}
                  chat={<FixtureChat />}
                  app={
                    zoom.agent.apps[0] === undefined ? undefined : (
                      <FixtureApp title={zoom.agent.apps[0].title} />
                    )
                  }
                />
              </AgentPage>
            </AgentsSection>
          )}
        </div>
      </MemoryRouter>
    </NextIntlClientProvider>
  )
}

function StateBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid content-start gap-2">
      <h2 className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="km-hues w-[24rem] overflow-hidden rounded-lg border border-border bg-card">
        {children}
      </div>
    </section>
  )
}
