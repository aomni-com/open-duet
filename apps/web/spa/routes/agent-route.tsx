'use client'

import { WarningCircle } from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useFormatter, useTranslations } from 'next-intl'
/* ============================================================================
   One agent, as a route of its own.

   `/agents/:agentSlug`, its card one segment further in, its work one further
   still — and nothing on this page is the drive's picture. Two things live
   here: the queries this agent is drawn from, and what happens when you click
   something on it. `useAgentReads` is its own, `AgentSurface` draws it, and the
   roster read this shares with the ring is used for one thing only — resolving
   the slug in the address bar to an agent.

   ---- it used to be a state of the map ----
   The ring and the agent were one component with one `focus`, and which of the
   two it drew was decided at the bottom of six hundred lines. That is what this
   file is the undoing of. The cost was not only the size: `focus` is null for
   *three* different reasons, and only one of them is "the reader is on the
   ring" — so an agent's URL whose roster read had not landed, or whose slug
   this drive does not have, fell through to the map. The whole map, camera and
   all, on `/agents/:agentSlug`. The two states that used to do that are the
   last thing in this file, and neither of them is a picture of somewhere else.

   What the reader can see, they can send. Five pieces of state used to be
   unaddressable — the agent, the card, the dialog, the job in it, the roster
   drawer — which meant no link, from a person or from an agent, could name any
   of them. `drive/agents-map-url.ts` owns the grammar; `where.ts` resolves a
   place against the data; this file only navigates and reads. A conversation
   started here does not teleport the reader to `/sessions/:id`: that promise is
   `SessionsRouting` below, which answers with *the place the reader is on*.
   ========================================================================= */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'

import { agentIsLocked, DEFAULT_AGENT_NAME, ROOT_AGENT_SCOPE } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'

import { appsPollInterval, collectionItems, duetQueryOptions } from '../api/query-options'
import { useAppActions } from '../apps/app-actions'
import { AppFrameBody } from '../apps/app-frame'
import { useSpa } from '../context'
import { desktopFocusRequestId, WorkspaceDesktop } from '../desktop/workspace-desktop'
import { agentConfigQueryOptions } from '../drive/agent-config'
import { AgentOnboardingCta } from '../drive/agent-onboarding-cta'
import {
  isAgentOnboardingAppPending,
  agentOnboardingTarget,
  onboardingAppCwd,
  resolveOnboardingApp,
} from '../drive/agent-onboarding-projection'
import { useAgentOnboardingSession } from '../drive/agent-onboarding-session'
import { useOnboardingWatch } from '../drive/agent-onboarding-watch'
import {
  agentSettingsUrl,
  agentsMapUrl,
  mapPlaceOf,
  type MapCard,
  type MapPlace,
} from '../drive/agents-map-url'
import { driveDestination, driveRoutes } from '../drive/drive-routes'
import { browserPathFromAnchorPath } from '../files/lib/paths'
import { appState, type MapCopy } from '../knowledge-map-data/project'
import { useAgentReads, type Read } from '../knowledge-map-data/use-agent-reads'
import { useMapClock, useWorkspaceMap } from '../knowledge-map-data/use-workspace-map'
import { leavesAgent } from '../knowledge-map/keys'
import type { AppItem } from '../knowledge-map/types'
import {
  ArchiveDefaultChatAction,
  ArchiveDefaultChatDialog,
  type ArchiveDefaultChatTarget,
} from '../sessions/archive-default-chat-control'
import { DefaultChatJobs } from '../sessions/default-chat-jobs'
import { SessionDetailSkeleton } from '../sessions/session-loading'
import WorkApp from '../team-space/work-app'
import WorkConversation from '../team-space/work-conversation'
import { workRouteDestination } from '../team-space/work-destination'
import { AgentDrive } from './agents-map/agent-drive'
import { AgentPage } from './agents-map/agent-page'
import { AgentPageSkeleton } from './agents-map/agent-page-skeleton'
import { AgentSurface, type AgentSurfaceShowing } from './agents-map/agent-surface'
import { SetupStage } from './agents-map/agent-surface/parts'
import { entryCardCanArrive, showingOf, stageOf } from './agents-map/agent-surface/stage'
import { useHeaderRow } from './agents-map/agent-surface/use-header-row'
import { useRosterOut } from './agents-map/agents-rail/out'
import { AgentsSection } from './agents-map/agents-section'
import { useRosterColumn } from './agents-map/roster-column'
import { focusOf } from './agents-map/where'
import {
  DEFAULT_SESSION_TIER,
  SessionsAccessDenied,
  SessionsProduct,
  useCanUseSessions,
  type SessionsRouting,
} from './sessions'
import { trainPath } from './train/train-routes'

function mapCardForSurface(surface: AgentSurfaceShowing, anchorPath: string | undefined): MapCard {
  if (surface.kind === 'app') return { kind: 'app', appSlug: surface.app.id }
  if (surface.kind === 'desktop') return { kind: 'desktop' }
  return {
    kind: 'files',
    path:
      anchorPath === undefined || anchorPath === '' ? '/' : browserPathFromAnchorPath(anchorPath),
  }
}

const GRAPH = { kind: 'graph' } as const
const NO_CHILD_AGENTS: readonly { id: string; name: string }[] = []
// The map can remount its card while one route entry stays active. Pairing a
// page-load id with React Router's entry key lets the gateway dedupe those
// remounts, while a real reload or later navigation still earns a fresh focus.
const DESKTOP_FOCUS_PAGE_ID = crypto.randomUUID()

export default function AgentDestinationHost() {
  const { workspaceSlug = '' } = useParams()
  const location = useLocation()
  const destination = workRouteDestination(location.pathname, workspaceSlug, location.search)
  if (destination.kind === 'session') return <WorkConversation />
  if (destination.kind === 'app') return <WorkApp />
  return <AgentRoute />
}

function AgentRoute() {
  const { workspaceSlug = '' } = useParams()
  const { identity, api } = useSpa()
  const navigate = useNavigate()
  const location = useLocation()
  const t = useTranslations('duetApp.homeSurface')
  /* Two namespaces, and the split is the surfaces': `homeSurface` owns what is
     said *about the drive* — including the sentence for an agent it does not
     have — and `agentSurface` owns the words this page's own furniture uses. */
  const tSurface = useTranslations('duetApp.agentSurface')
  const tApp = useTranslations('duetApp')
  const format = useFormatter()
  const canUseSessions = useCanUseSessions(workspaceSlug)
  const workspace = identity.workspaces.find(candidate => candidate.slug === workspaceSlug)
  // The API permits onboarding only for owners and editors. The projected
  // workspace role keeps viewers from opening an endpoint that will reject them.
  const canOnboardAgent = workspace?.role === 'owner' || workspace?.role === 'editor'
  const now = useMapClock()

  /* Every phrase on the map arrives through here. The projection is pure and
     the map is presentational, so neither can translate anything itself — and
     doing it at this level means the fixture can freeze a locale and a clock
     and get a byte-stable screenshot. */
  const copy = useMemo<MapCopy>(
    () => ({ when: (at, now) => format.relativeTime(at, now) }),
    [format],
  )
  const countsLabel = useCallback(
    (counts: {
      agents: number
      apps: number | undefined
      agentsComplete: boolean
      appsComplete: boolean
    }) =>
      counts.apps === undefined
        ? t(counts.agentsComplete ? 'countsAgentsOnly' : 'countsAgentsLoaded', {
            agents: counts.agents,
          })
        : t(counts.agentsComplete && counts.appsComplete ? 'counts' : 'countsLoaded', {
            agents: counts.agents,
            apps: counts.apps,
          }),
    [t],
  )

  /* ---------------------------------------------------------- where we are
     Read, not held. Everything the reader can see on this surface — which agent
     is unfolded, which face of it the card shows, whether its work is open and
     which conversation of it — is one parse of the address bar. A shape this
     grammar does not have degrades to the ring rather than to an error: the
     router matches `agents/*`, so a path can reach this component that the
     grammar declines, and the drive's own picture is the right answer to "I do
     not know what you asked for".

     Parsed before the map is read rather than after, because the map's own
     freshness now depends on it — see `useRingFreshness`. It costs nothing to
     move: this is a pure function of the address bar and knows nothing about
     the drive. */
  const here = `${location.pathname}${location.search}`
  const place = mapPlaceOf(here, workspaceSlug) ?? GRAPH
  const requestedAgentSlug =
    place.kind === 'graph' || place.agentSlug === ROOT_AGENT_SCOPE ? undefined : place.agentSlug
  const requestedAgentQuery = useQuery({
    ...duetQueryOptions.workspaces.agentLookup(api, workspaceSlug, {
      slug: requestedAgentSlug ?? '',
    }),
    enabled: requestedAgentSlug !== undefined,
  })

  /* Asked before the map read, because the roster's own state is what decides
     that read's cadence here: the column beside this conversation is the only
     thing on the page drawing live dots. `useRosterOut` is the one owner. */
  const fold = useRosterOut()
  const map = useWorkspaceMap(workspaceSlug, {
    /* The default agent's own name, the one given in onboarding. It used to be
       the *drive's* name, which is a different thing that is already set in the
       chrome above the canvas — so the one agent every drive has was the one
       agent whose name you could never see, on the face at the centre or on the
       surface that unfolds out of it. */
    coreLabel: workspace?.duetName ?? DEFAULT_AGENT_NAME,
    copy,
    countsLabel,
    /* Whether the reader is looking at something other than the ring — which
       decides how hard the drive-wide read works. Always true here: this
       component is only mounted under `/agents/:agentSlug`, and the roster it
       borrows is for resolving that slug, not for drawing a picture. */
    unfolded: true,
    /* The roster beside this agent is the only thing on the page reading the
       drive-wide activity, so its own state is the honest answer to whether the
       fast clock is worth paying for. Folded, nothing here draws a live dot and
       the drive can be watched slowly. */
    liveActivity: fold.out,
    includeAgent: requestedAgentQuery.data,
  })

  const go = useCallback(
    (next: MapPlace, options?: { replace?: boolean }) =>
      navigate(agentsMapUrl(workspaceSlug, next), { replace: options?.replace === true }),
    [navigate, workspaceSlug],
  )

  /* What the URL names, against the data the map actually has. `waiting` and
     `unknown` are two answers rather than one so a cold deep link does not
     flash "no such agent" on its way in — see `focusOf`. */
  const routeAgentPhase =
    requestedAgentSlug === undefined
      ? map.phases.agents
      : requestedAgentQuery.isPending || requestedAgentQuery.isError
        ? requestedAgentQuery.isError
          ? 'error'
          : 'pending'
        : 'ready'
  const where = focusOf(place, map, routeAgentPhase)
  const focus = where.kind === 'agent' || where.kind === 'core' ? where.agent : null

  const route = where.kind === 'agent' ? where.route : undefined
  const anchorPath = where.kind === 'core' ? '' : route?.anchorPath

  /* Which single bead the camera is parked on, resolved against what that agent
     is actually carrying. The map's job read is `active`-only, so a job that
     finished since the link was written is simply not on the ring any more —
     that degrades to the branch as a whole, which is the thing the reader can
     still see, rather than to a camera aimed at nothing. */

  /* One slug for every navigation out of here, resolved once. `undefined` means
     the ring, or an agent this drive could not resolve — in both cases there is
     nothing under this to navigate within. */
  const agentSlug = where.kind === 'core' ? ROOT_AGENT_SCOPE : route?.slug

  /* ---- a link to an agent this drive does not have ----
     Said once, on the page, and the URL is left exactly as it arrived:
     rewriting it to the ring destroys the one piece of evidence the reader
     would otherwise paste into a message asking what happened. See the return
     at the bottom of this file.

     It used to be said twice — a toast as well — and the toast was not a
     second thought, it was the only thought: this route drew *the ring* for an
     unknown agent, and a picture of the drive cannot say that the agent you
     asked for is not on it. A page that states it needs no announcement over
     the top of itself. */
  /* The agents one layer beneath this one, for the surface to offer as doors.
     Only an agent has any: root's children ARE the ring, and the core's surface
     sits over that ring rather than repeating it. */
  const childAgents = useMemo(() => {
    if (where.kind !== 'agent') return NO_CHILD_AGENTS
    return (map.childAgentIds.get(where.agent.id) ?? []).flatMap(id => {
      const node = map.agentDirectory.get(id)
      // Routes gate membership: a child with no route has nowhere to open, so
      // it earns no door. The click handler resolves the slug itself.
      return node === undefined || !map.routes.has(id) ? [] : [{ id, name: node.name }]
    })
  }, [map.agentDirectory, map.childAgentIds, map.routes, where])
  const onOpenChildAgent = useCallback(
    (id: string) => {
      const slug = map.routes.get(id)?.slug
      if (slug !== undefined) go({ kind: 'agent', agentSlug: slug, card: { kind: 'default' } })
    },
    [go, map.routes],
  )

  /* ---- Escape leaves the agent, and this route is where it is heard ----
     It used to be the canvas's: `KnowledgeMap` held the listener and fired it
     while something was unfolded over it. Nothing is unfolded over anything
     now — an agent is a page — so on this route the key was simply not bound,
     and the only way back out was the control in the corner. A page that can be
     opened by a link and left only by a click is a page a keyboard reader is
     stuck on.

     `leavesAgent` is the rule and it stays where it was written, because both
     halves of it still apply here: bubble phase, so a dialog, menu or popover
     opened *inside* this surface answers Escape first and this hears that it
     was answered. See `keys.ts` — reading `defaultPrevented` from the capture
     phase would silently always pass. */

  /* Exit returns one layer, not the whole way out: a nested agent's surface
     folds back to its parent's, and only a direct child of root — or the core —
     folds back to the ring. The same rule the roster prompt and the ring layout
     follow (one layer each way), so the map never teleports past an ancestor
     the reader has not seen. */
  const exitZoom = useCallback(() => {
    const parentId = where.kind === 'agent' ? map.parentAgentIds.get(where.agent.id) : undefined
    const parentSlug = parentId === undefined ? undefined : map.routes.get(parentId)?.slug
    go(
      parentSlug === undefined
        ? GRAPH
        : { kind: 'agent', agentSlug: parentSlug, card: { kind: 'default' } },
    )
  }, [go, map.parentAgentIds, map.routes, where])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (leavesAgent(event)) exitZoom()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [exitZoom])

  const reads = useAgentReads(
    workspaceSlug,
    focus === null || anchorPath === undefined ? null : { id: focus.id, anchorPath },
    now,
    copy,
  )

  /* ---- the left column is the agent's default chat, and only ever that ----
     It used to be a pick out of the agent's session *list* — first the newest
     entry, then the oldest — and both were wrong in the same way. That list
     holds every conversation the agent has had, and an agent starts
     conversations of its own: hand it a subagent and the child session lands in
     the list beside the one you were reading, sorted by `updatedAt` like
     everything else, and the panel follows whichever end the heuristic points
     at. There is no ordering of that list that means "the chat this agent is".

     The default chat is a real thing rather than a guess — a pointer on the
     agent's own row, resolved through the `…/sessions/default` alias
     (sessions-and-jobs, D27) — so the panel asks for it by name. `SessionsProduct`
     owns both halves of that: it reads the alias, and it sends the first message
     through the alias so the pointer gets stamped.

     The centre of the map is an owner here like any face: `ROOT_AGENT_SCOPE`
     resolves to the drive root's own alias, whose pointer is
     `workspaces.rootDefaultSessionId` (D10). Clicking into Duet and clicking
     into an agent are the same act on two owners.

     `undefined` is the third case and it is NOT root: it means this zoom has no
     slug resolved yet. Asking anyway would send an agent's panel to the root
     alias and answer it with the drive's own conversation — the same wrong-chat
     bug in a different costume — so the panel waits instead. */
  const agentScope = agentSlug

  /* ---- and archiving it is this route's gesture, not the panel's ----
     The control sits in the header this route draws, and the confirm it opens
     is mounted beside the app dialogs rather than inside the surface, because
     succeeding is exactly what takes the trigger off screen.

     `chatArchivedAt` is the one thing the panel is told. Everything else about
     the empty state arrives on its own: the write invalidates the alias, the
     alias answers `null`, and the day-one composer is what `SessionsProduct`
     already draws for that. What it cannot work out for itself is that the id
     its own first message minted is stale — that id wins over the read by
     design, to keep a just-started conversation from blinking out — so it is
     given a stamp to compare against instead. */
  const [archiveTarget, setArchiveTarget] = useState<ArchiveDefaultChatTarget | null>(null)
  const [chatArchivedAt, setChatArchivedAt] = useState<number>()

  /* Where the surface sends a reader it cannot serve — an agent the picker
     cannot resolve. The ring: the map is the only host, and backing out of one
     agent's panel means the drive itself. Everything else stays put by
     construction now — a first message mints its thread in place, because the
     place was already the agent. */
  const routes = useMemo<SessionsRouting>(
    () => ({ exit: () => agentsMapUrl(workspaceSlug, GRAPH) }),
    [workspaceSlug],
  )

  const onOpenFile = useCallback(
    /* A file's id is its own drive path, so this opens the thing it names — the
       file, or the folder listing if it is a folder. */
    (file: { id: string; folder?: boolean }) =>
      navigate(driveDestination(workspaceSlug, file.id, file.folder === true ? 'folder' : 'file')),
    [navigate, workspaceSlug],
  )

  /* Apps come off the drive's own projection, so they carry the phase of the
     list call that produced them. Handing the surface rows without their phase
     is exactly how a still-loading agent draws as an idle one. */
  const apps = useMemo<Read<AppItem>>(
    () => ({ phase: map.phases.apps, items: focus?.apps ?? [] }),
    [focus, map.phases.apps],
  )

  /* A direct app address names one app, so it reads that app. The browsable
     workspace collection is deliberately not an identity oracle: its first
     page can be complete enough to draw the visible map and still exclude the
     slug in this URL. The public point endpoint is the authority for this
     route, cached under the slug it names. */
  const directAppSlug =
    place.kind === 'agent' && place.card.kind === 'app' ? place.card.appSlug : undefined
  const directAppQuery = useQuery({
    ...duetQueryOptions.workspaces.app(api, workspaceSlug, directAppSlug ?? ''),
    enabled: directAppSlug !== undefined,
  })
  const routeApps = useMemo<Read<AppItem>>(() => {
    if (directAppSlug === undefined) return apps
    const others = apps.items.filter(candidate => candidate.id !== directAppSlug)
    const app = directAppQuery.data?.app
    if (app !== undefined) {
      return {
        phase: 'ready',
        items: [
          ...others,
          {
            id: app.slug,
            title: app.name ?? app.slug,
            when: copy.when(app.updatedAt, now),
            state: appState(app),
          },
        ],
      }
    }
    return {
      phase: directAppQuery.isError ? 'ready' : 'pending',
      items: others,
    }
  }, [apps, copy, directAppQuery.data?.app, directAppQuery.isError, directAppSlug, now])

  /* What the card on the right is showing, named by the URL and resolved against
     its route reads — the two arrive a moment apart, which is `showingOf`'s
     whole job. `null` hands the choice to the reader's own arranged row below.

     Root's registered folder is Drive root, so its short Files entry and its
     canonical resolved location are the same URL. Treat that one entry as the
     explicit Files card; every non-root entry still resolves to its registered
     anchor before anything renders. */
  const rootFilesEntry =
    where.kind === 'core' && place.kind === 'agent' && place.card.kind === 'files-entry'
  const showing: AgentSurfaceShowing | null = rootFilesEntry
    ? { kind: 'files' }
    : place.kind === 'agent'
      ? showingOf(place.card, routeApps)
      : null
  /* Picking a card is a `replace`: it is which face of one agent you are
     looking at, not a place you travelled to. Pushing would make Back walk you
     through every app you glanced at before it let you out to the ring. */
  const onShow = useCallback(
    (next: AgentSurfaceShowing | null) => {
      if (agentSlug === undefined) return
      const card: MapCard =
        next === null ? { kind: 'default' } : mapCardForSurface(next, route?.anchorPath)
      go({ kind: 'agent', agentSlug, card }, { replace: true })
    },
    [agentSlug, go, route?.anchorPath],
  )

  /* The row across the card's top, in this agent's own arrangement. Keyed on the
     agent so flying to another one shows that agent's order rather than this
     one's — see `useHeaderRow`. */
  const row = useHeaderRow(focus?.id ?? '', { appIds: routeApps.items.map(item => item.id) })
  const stage = stageOf(showing, routeApps, row.items)
  const shownApp = stage.kind === 'app' ? stage.app : undefined
  const focusRequestId =
    stage.kind === 'desktop' && agentSlug !== undefined
      ? desktopFocusRequestId(DESKTOP_FOCUS_PAGE_ID, location.key, agentSlug)
      : undefined

  /* A bare agent URL is an entry point, never a hidden fourth card state. The
     reader's arranged row already decides which face opens by default; once
     that answer is available, give it the explicit URL that every other card
     has. Until then the agent surface stays unmounted, so a cold link cannot
     paint one destination and jump to another when the app list arrives. */
  const resolvingEntryCard =
    place.kind === 'agent' &&
    (place.card.kind === 'default' || (place.card.kind === 'files-entry' && !rootFilesEntry))
  useEffect(() => {
    if (!resolvingEntryCard || agentSlug === undefined || place.kind !== 'agent') return
    const card =
      place.card.kind === 'files-entry'
        ? mapCardForSurface({ kind: 'files' }, route?.anchorPath)
        : stage.kind === 'reading' || stage.kind === 'none'
          ? undefined
          : mapCardForSurface(stage, route?.anchorPath)
    if (card !== undefined) {
      go({ kind: 'agent', agentSlug, card }, { replace: true })
    }
  }, [agentSlug, go, place, resolvingEntryCard, route?.anchorPath, stage])

  /* An agent whose onboarding is an app is onboarded by *using* that app, and
     the flip is only noticed by something watching while it is on screen. That
     used to be the app's own page. The card is where an app opens now, so the
     watch came with it — without it, filling in an onboarding form leaves the
     agent locked and the reader parked on a finished form. */
  /* Spelled out rather than inlined into the query, because the wait below has
     to ask the same question: a query that is *disabled* stays `pending`
     forever, and a page that waited on that would never draw for the drive's
     own agent — which has no route and no config to read. */
  const configReadable = focus !== null && route !== undefined
  const focusConfig = useQuery({
    ...agentConfigQueryOptions(api, workspaceSlug, {
      id: focus?.id ?? '',
      anchorPath: route?.anchorPath ?? '',
    }),
    /* Read for every unfolded agent, not only while an app is on the card: the
       same config decides whether this agent can be used at all yet, and that
       verdict has to be in hand before the surface draws anything. */
    enabled: configReadable,
  })
  /* ---- and "in hand" is the whole of it ----
     `locked` below is false while this read is still out, which is not the same
     as the agent being unlocked — it is nobody having said yet. Drawing on it
     paints the ordinary working surface, two columns with a conversation and a
     row of selectors, over an agent that is about to collapse into its setup.
     A reader opening an agent that needs setting up watched three pictures in a
     row: the page's skeleton, a working agent that was never true, and then the
     setup. The verdict is cheap and it arrives with everything else; the page
     waits for it in its own skeleton, and what replaces that is the truth. */
  const setupVerdictIsIn = !configReadable || !focusConfig.isPending

  /* Whether this agent can be used at all yet.
     `onboardedAt` is the one field the map's projection does not carry, so the
     exact route lookup supplies the row even when its roster page has not been
     browsed yet. */
  const focusAgent = requestedAgentQuery.data ?? undefined
  const locked =
    focusAgent !== undefined &&
    focusConfig.data !== undefined &&
    agentIsLocked(focusAgent, focusConfig.data)

  /* The same browser list `useWorkspaceMap` reads, from the same cache entry:
     it supplies whichever app card the map already exposed. The onboarding
     app has its own bounded cwd lookup below, so correctness never depends on
     this browsable list having loaded the page that contains it. */
  const appsQuery = useInfiniteQuery({
    ...duetQueryOptions.workspaces.apps(api, workspaceSlug),
    refetchInterval: query =>
      appsPollInterval({
        items: collectionItems(query.state.data),
        nextCursor: query.state.data?.pages.at(-1)?.nextCursor ?? null,
      }),
  })
  const onboardingCwd =
    focusConfig.data === undefined || route === undefined
      ? undefined
      : onboardingAppCwd(focusConfig.data, route.anchorPath)
  const onboardingAppQuery = useQuery({
    ...duetQueryOptions.workspaces.appLookup(api, workspaceSlug, {
      cwd: onboardingCwd ?? '.',
    }),
    enabled: canOnboardAgent && onboardingCwd !== undefined,
    refetchInterval: query =>
      onboardingCwd === undefined
        ? false
        : appsPollInterval(
            query.state.data ?? {
              items: [],
              nextCursor: null,
              meta: { capabilities: { register: false } },
            },
            locked &&
              query.state.data?.items.some(app => app.anchorPath === onboardingCwd) !== true,
          ),
  })
  const onboardingApp =
    !canOnboardAgent || focusConfig.data === undefined || route === undefined
      ? undefined
      : resolveOnboardingApp(
          focusConfig.data,
          route.anchorPath,
          onboardingAppQuery.data?.items ?? [],
        )
  const stageApp =
    directAppSlug !== undefined
      ? directAppQuery.data?.app
      : (appsQuery.data?.items.find(candidate => candidate.slug === shownApp?.id) ??
        (onboardingApp?.slug === shownApp?.id ? onboardingApp : undefined))
  const onboardingAppPending =
    focusConfig.data !== undefined && route !== undefined
      ? isAgentOnboardingAppPending(
          locked,
          focusConfig.data,
          route.anchorPath,
          onboardingApp === undefined ? [] : [onboardingApp],
        )
      : false
  useOnboardingWatch(
    workspaceSlug,
    canOnboardAgent && onboardingApp !== undefined && onboardingApp.id === stageApp?.id
      ? focus?.id
      : undefined,
  )

  /* What can be done to the app on the card — published, copied, deleted. The
     route owns it rather than the surface because deleting has somewhere to go
     afterwards: the card is *showing* the app that just stopped existing, and
     the honest landing is the agent it belonged to. */
  const appActions = useAppActions(workspaceSlug, {
    onDeleted: () => {
      if (agentSlug !== undefined) go({ kind: 'agent', agentSlug, card: { kind: 'default' } })
    },
  })

  const onboardingTarget =
    focusConfig.data === undefined || route === undefined
      ? undefined
      : agentOnboardingTarget(
          focusConfig.data,
          route.anchorPath,
          onboardingApp === undefined ? [] : [onboardingApp],
        )

  /* The setup conversation, opened by looking at the agent rather than by
     pressing a button that leaves for it. Gated on this agent actually being
     locked and actually onboarding by chat — see the hook: the endpoint
     CREATES on first call, so asking for one anywhere else would mint a
     conversation nobody opened. */
  const onboardingChat = useAgentOnboardingSession(
    api,
    workspaceSlug,
    focusAgent === undefined || agentSlug === undefined
      ? undefined
      : { id: focusAgent.id, slug: agentSlug },
    canOnboardAgent && locked && onboardingTarget?.kind === 'chat',
  )

  const mountSession = (
    on: { kind: 'session'; sessionId: string } | { kind: 'default' },
    key: string,
  ) => (
    <SessionsProduct
      key={key}
      workspaceSlug={workspaceSlug}
      agentSlug={agentScope}
      sessionId={on.kind === 'session' ? on.sessionId : undefined}
      defaultChat={on.kind === 'default'}
      onStarted={id =>
        agentSlug === undefined
          ? undefined
          : /* Replace: the composer it came from is not a place to go back to —
               it is this same conversation, one keystroke earlier. */
            go({ kind: 'sessions', agentSlug, sessionId: id }, { replace: true })
      }
      defaultChatArchivedAt={chatArchivedAt}
      duetName={workspace?.duetName ?? DEFAULT_AGENT_NAME}
      defaultTier={workspace?.defaultTier.effective ?? DEFAULT_SESSION_TIER}
      routes={routes}
      creditRecovery={workspace?.creditRecovery ?? null}
    />
  )

  /* The whole surface while it is locked, and absent otherwise. Three shapes,
     decided here because all three come from the route's own reads:

     - an app-onboarded agent gets its onboarding app, whole;
     - a chat-onboarded one gets the conversation itself, in the same slot;
     - and until one of those is in hand — the app still starting, the session
       still opening, either of them failed — the panel says what this agent is
       waiting for and offers the one control, which is the same call again.

     What frames all three is the agent's own header, which the surface dresses
     itself once it is told this is a setup: the two shapes that arrive are
     somebody else's whole surface — an ordinary session, an ordinary app — and
     that header is the only part of this a reader can tell apart from the
     product they get once setup is done. Which shape is under it is a question
     about this agent's config and its app list, and both are reads that live on
     this route, so it is decided here. */
  const waiting =
    canOnboardAgent &&
    ((onboardingTarget?.kind === 'chat' && !onboardingChat.failed) || onboardingAppPending)
  const setup = !locked
    ? undefined
    : {
        /* What the header says about it. The surface dresses its own cluster
           from this — there is no second header — and the five states are the
           five things this surface can honestly be: blocked, waiting to be
           started, waking up, a conversation, or an app. */
        state: !canOnboardAgent
          ? ('blocked' as const)
          : onboardingApp !== undefined
            ? ('app' as const)
            : onboardingChat.sessionId !== undefined
              ? ('chat' as const)
              : waiting
                ? ('waiting' as const)
                : ('ready' as const),
        body: !canOnboardAgent ? (
          <SetupStage />
        ) : onboardingApp !== undefined ? (
          <AppFrameBody app={onboardingApp} workspaceSlug={workspaceSlug} />
        ) : onboardingChat.sessionId !== undefined ? (
          /* Keyed on the agent for the same reason its ordinary chat is:
               flying to another locked agent must land on that agent's setup,
               not carry this one's composer across. */
          /* `display: contents`, so the conversation lays out exactly as it
               would unwrapped — the wrapper is a handle for one rule and not a
               box. See `.km-setup-chat` in the stylesheet: the composer takes
               the header's measure here rather than the thread's. */
          <div className="km-setup-chat">
            {mountSession(
              { kind: 'session', sessionId: onboardingChat.sessionId },
              `setup:${agentScope}`,
            )}
          </div>
        ) : (
          <SetupStage
            /* The expected setup is in flight: either the conversation is
                 opening or the install has not registered its onboarding app
                 yet. Both reads stay live while this wait is visible. */
            waiting={waiting}
            action={
              <AgentOnboardingCta
                workspaceSlug={workspaceSlug}
                agentSlug={agentSlug ?? ''}
                target={onboardingTarget}
                /* This surface IS where a chat setup opens on sight, so the
                     only reason its CTA is on screen is that the open failed —
                     hand it the ask-again instead of a link to itself. */
                onRetry={onboardingTarget?.kind === 'chat' ? onboardingChat.retry : undefined}
              />
            }
          />
        ),
      }

  /* Everything that hangs off an unfolded agent, drawn on the page rather than
     over the canvas. The dialogs travel with it: both portal to `document.body`,
     so where they sit in this tree decides nothing about where they draw, and
     both are opened by controls that live on this surface. */
  /* Whether this page can draw itself yet. Two waits, and the reader must not be
     able to tell them apart: the agent has not been resolved from the slug, or
     it has and the bare URL is still being rewritten to the explicit card it
     opens on — and only while that rewrite can still happen, which is what
     `entryCardCanArrive` is careful about. The second one used to render
     *nothing* —
     the surface withheld so a cold link cannot paint one destination and jump to
     another, which is right — but "nothing" is a blank page, and on a slow read
     it sat there between the skeleton and the card. Measured under an 8× CPU
     throttle: skeleton, then 1.4s of empty page, then the card's own skeleton.
     One skeleton, held across both waits, is the whole of the fix. */
  const drawable =
    focus !== null && !entryCardCanArrive(resolvingEntryCard, stage) && setupVerdictIsIn

  /* The same column the graph draws, from the same owner. Two arguments are
     this route's own: the row to mark — the agent being read, which is the
     whole reason `list.tsx` asked for the mark back — and no hover reporting,
     because there is no canvas here for a row to mark a counterpart on. */
  const { roster, addDialog, openControl } = useRosterColumn({
    workspaceSlug,
    map,
    now,
    copy,
    fold,
    selectedAgentId: focus?.id,
  })

  const agentBody = (
    <>
      {drawable && (
        <AgentSurface
          openRoster={openControl}
          name={focus.name}
          subtitle={focus.subtitle}
          duet={where.kind === 'core'}
          /* The face the surface draws, off the same record the rest of the
                 product draws an agent from. `focusAgent` is the full row out of
                 the roster query — the projection the ring uses carries no icon —
                 and the key is the slug, which is what `avatarKey` has meant
                 everywhere since `agentIdentityFromProfile`. Duet has no roster
                 row and no slug; it wears its own brand art, which is what the
                 `duet` flag beside this selects. */
          portrait={{
            avatarKey: agentScope ?? focus.name,
            profile:
              focusAgent === undefined
                ? undefined
                : {
                    anchorPath: focusAgent.anchorPath,
                    icon: focusAgent.icon,
                    updatedAt: focusAgent.updatedAt,
                  },
            workspaceSlug,
          }}
          childAgents={childAgents}
          onOpenChildAgent={onOpenChildAgent}
          apps={routeApps}
          skills={reads.skills}
          files={reads.files}
          showing={showing}
          onShow={onShow}
          /* Only once the record is in hand. The surface says "still reading"
               for the moment between the ring knowing an app is there and the
               app list handing over the thing itself. */
          app={
            stageApp === undefined ? undefined : (
              <AppFrameBody app={stageApp} workspaceSlug={workspaceSlug} />
            )
          }
          trainHref={
            /* Duet is the drive itself, so it has no anchor of its own — but it
                 does train, at the root scope. Every other agent trains at its own
                 scope. Both go straight to the training control centre now: this
                 used to build `…/agents/:slug/train`, a legacy path whose only job
                 is to redirect here, so the door was spending a round trip through
                 a URL kept alive for other people's bookmarks. */
            agentSlug === undefined || (locked && !canOnboardAgent)
              ? undefined
              : trainPath(
                  workspaceSlug,
                  where.kind === 'core' ? { kind: 'root' } : { kind: 'agent', agentSlug },
                )
          }
          settingsHref={
            agentSlug === undefined || (locked && !canOnboardAgent)
              ? undefined
              : agentSettingsUrl(workspaceSlug, agentSlug)
          }
          row={row.items}
          drag={{ onDrop: row.drop }}
          /* The agent's folder, opened where the agent lives. Duet has no folder
               of its own — it is the drive — so it comes in at the root. */
          drive={
            <AgentDrive
              workspaceSlug={workspaceSlug}
              agentSlug={agentSlug ?? ROOT_AGENT_SCOPE}
              path={
                place.kind === 'agent' && place.card.kind === 'files'
                  ? place.card.path
                  : route?.anchorPath === undefined || route.anchorPath === ''
                    ? '/'
                    : browserPathFromAnchorPath(route.anchorPath)
              }
            />
          }
          desktop={
            <WorkspaceDesktop
              workspaceSlug={workspaceSlug}
              agentSlug={agentSlug ?? ROOT_AGENT_SCOPE}
              focusRequestId={focusRequestId}
            />
          }
          integrationsHref={driveRoutes.integrations(workspaceSlug)}
          onOpenFile={onOpenFile}
          /* Only once the record is in hand, for the same reason the frame is:
               the menu is about one app, and there is nothing to publish or
               delete until the list has handed that app over. */
          appMenu={stageApp === undefined ? undefined : appActions.menuFor(stageApp)}
          setup={setup}
          chat={
            /* Keyed on the agent, because the panel's subject is the agent
                 rather than a session: zooming from one face to the next must
                 land on that agent's chat with its own draft and its own
                 composer, and an unkeyed instance would carry the previous
                 agent's across. Within one agent it still never remounts, which
                 is what keeps a just-started conversation on screen while the
                 alias catches up to the id it minted. */
            !canUseSessions ? (
              <SessionsAccessDenied />
            ) : agentScope === undefined ? (
              <SessionDetailSkeleton label={t('title')} />
            ) : (
              mountSession({ kind: 'default' }, `chat:${agentScope}`)
            )
          }
          /* Absent under the sessions wall and while the zoom has no slug
               resolved, for the same two reasons the conversation itself is:
               there is nothing to act on, and asking the alias without a slug
               would answer an agent's panel with the drive's own chat. */
          chatAction={
            !canUseSessions || agentScope === undefined ? undefined : (
              <div className="flex min-w-0 items-baseline gap-3">
                <DefaultChatJobs workspaceSlug={workspaceSlug} agentSlug={agentScope} />
                <ArchiveDefaultChatAction
                  workspaceSlug={workspaceSlug}
                  agentSlug={agentScope}
                  onArchive={() =>
                    setArchiveTarget({ agentSlug: agentScope, agentName: focus.name })
                  }
                />
              </div>
            )
          }
        />
      )}
      {appActions.dialogs}
      <ArchiveDefaultChatDialog
        workspaceSlug={workspaceSlug}
        target={archiveTarget}
        onOpenChange={open => {
          if (!open) setArchiveTarget(null)
        }}
        onArchived={() => setChatArchivedAt(Date.now())}
      />
    </>
  )

  /* ---- the surface, or the two honest ways of not having one ----
     Three answers, and the map is not among them. `focusOf` resolves the slug
     in the address bar against the roster the drive has: it is the agent, or
     the read has not landed yet, or this drive has no such agent. The ring used
     to stand in for the last two — the whole component, camera and all, on an
     agent's URL — which is the picture of somewhere else answering for a place
     you asked to go.

     `waiting` gets the surface's own skeleton, because a cold link is a fifth
     of a second from being an agent and anything louder would accuse it. The
     notice is for `unknown` alone, and the URL is left exactly as it arrived:
     rewriting it to the ring destroys the one piece of evidence the reader
     would otherwise paste into a message asking what happened. */
  return (
    <AgentsSection roster={roster}>
      {map.appsContinuation.available || map.appsContinuation.failed ? (
        <div className="absolute right-5 bottom-5 z-20">
          <button
            type="button"
            disabled={map.appsContinuation.loading}
            onClick={map.appsContinuation.load}
            className={buttonVariants({ variant: 'outline' })}
          >
            {map.appsContinuation.loading
              ? t('loadingMoreApps')
              : map.appsContinuation.failed
                ? t('retryMoreApps')
                : t('loadMoreApps')}
          </button>
        </div>
      ) : null}
      <AgentPage>
        {drawable ? (
          agentBody
        ) : where.kind === 'unknown' ? (
          <div className="grid h-full place-items-center px-6">
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <span className="text-muted-foreground">
                <WarningCircle aria-hidden size={24} weight="duotone" />
              </span>
              <p className="font-serif text-lg font-normal italic tracking-tight">
                {t('unknownAgent', { slug: where.agentSlug })}
              </p>
              {/* The same words the surface's own way out spends, because it
                  is the same journey: this page could not draw an agent, and
                  the drive is where every agent is. */}
              <Link
                className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
                to={agentsMapUrl(workspaceSlug, GRAPH)}
              >
                {tSurface('backToMap')}
              </Link>
            </div>
          </div>
        ) : (
          /* This page's own shape, not the chat's. It used to be neither: the
             ring stood here, whole, on an agent's URL. */
          <AgentPageSkeleton label={tApp('loadingIslandLabel')} />
        )}
      </AgentPage>
      {/* A sibling of the frame rather than a child of the column: it is modal,
          and a dialog mounted inside something that can fold to zero width is a
          dialog that folds with it. */}
      {addDialog}
    </AgentsSection>
  )
}
