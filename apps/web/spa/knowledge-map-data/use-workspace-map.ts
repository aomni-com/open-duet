'use client'

/* ============================================================================
   The queries behind the knowledge map, assembled into one `MapData`.

   Three:

     listAgents            the ring
     listApps              attributed to agents by anchor-path containment
     listSessionActivity   every owner's prioritized recent work, bounded per owner

   The session read used to be three — one workspace-wide page per unfinished
   bucket, because `bucket` leads the index and a Convex cursor belongs to one
   range — split across the agents here. That was the wrong axis. The ring is
   drawn per agent and the pages did not grow with the fleet, so on a busy drive
   an agent whose work fell off page one was drawn with less than it had and
   sorted in the drawer as though it had never moved.

   The fan-out now happens server-side, which is the same reads against the same
   index for one request instead of one per face. Rows, not counts: the ring
   draws one node per session, so a count would delete what it is made of.

   It used to be sixteen. Every agent's skills folder was listed on load, and
   the open branch's folder on top of that, to draw four numbers under four
   chips — twelve full round-trips for twelve integers on the landing page's
   critical path. The ring does not draw those numbers any more: an agent
   carries its apps, and everything else about it is read when you go inside it,
   by `use-agent-reads.ts`, for exactly one agent at a time.

   The three answer independently and none of them waits on another. What waits
   is the *picture*: an agent is its face, the apps it carries and the work under
   it, so a map drawn on the first read is a map of a drive that does not exist
   — and the camera has already framed it. `arrived` is where that is decided
   here rather than by each surface guessing from `isPending`, which is one read
   of the three. See `KnowledgeMapHome`, which holds the shape of the map on the
   canvas until then.
   ========================================================================= */
import { useInfiniteQuery, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useCallback, useMemo, useSyncExternalStore } from 'react'

import {
  agentResolutionCandidate,
  groupAgentsByParent,
  groupAppsByAgent,
  ROOT_AGENT_SCOPE,
  type ActivitySessionSummary,
  type Agent,
  type App,
} from '@repo/contract'

import { useCollectionContinuation } from '../api/collection-continuation'
import { duetQueryOptions, isInitialCollectionError } from '../api/query-options'
import { useSpa } from '../context'
import { useDriveFileIconUrl } from '../drive/drive-file-icon'
import {
  projectWorkspaceMap,
  type AgentSlice,
  type MapCopy,
  type MapIcons,
  type WorkspaceMap,
} from './project'
import { useRingFreshness } from './ring-freshness'

const NO_AGENTS: readonly Agent[] = []
const NO_APPS: readonly App[] = []
const NO_JOBS: readonly ActivitySessionSummary[] = []

/** Everything the route has to hand the map that the map cannot know itself. */
export type WorkspaceMapOptions = {
  /**
   * The default agent's name — what onboarding called it. It labels the face at
   * the centre *and* names the surface that unfolds out of it, because those are
   * one agent seen at two zoom levels. Not the drive's name: the drive is named
   * in the chrome above the canvas, and putting it here left the one agent every
   * drive has anonymous on the only surface that draws it.
   */
  coreLabel: string
  copy: MapCopy
  /**
   * The centre's caption, from counts this hook is the only place to know.
   * `apps` is `undefined` when the app list failed — a count is a claim, and
   * this refuses to make one it does not have.
   */
  countsLabel: (counts: {
    agents: number
    apps: number | undefined
    agentsComplete: boolean
    appsComplete: boolean
  }) => string
  /**
   * Whether an agent is unfolded over the canvas, from the URL.
   *
   * The map's own freshness turns on it — see `useRingFreshness`. It is the
   * route's fact rather than this hook's, because the address bar is the one
   * owner of where the reader is, but it belongs *here* because what it decides
   * is when these reads are worth re-asking. Defaults to the ring: a caller
   * that never unfolds anything is always looking at the drive.
   */
  unfolded?: boolean
  /**
   * Whether anything on screen is actually reading the drive-wide activity, and
   * therefore how fast it is worth re-asking for.
   *
   * Deliberately a second fact rather than a reading of `unfolded`. They used to
   * be the same one because the roster only ever stood beside the canvas, so
   * "inside an agent" and "nobody is watching the drive" coincided. They do not
   * any more: the roster stands beside an agent too, and while it is out its
   * live dots and its preview line are exactly what the fast rate is for.
   *
   * `unfolded` above is still about *navigation* — which boundary the reader
   * just crossed, and what to re-ask because of it. This is about *visibility*.
   */
  liveActivity?: boolean
  /** A route-resolved agent that may sit beyond the roster pages browsed so far. */
  includeAgent?: Agent | null
}

/**
 * Where one of the map's reads has got to.
 *
 * Three words rather than two booleans, because the only reason a surface asks
 * is to choose between three sentences — "still asking", "that did not load",
 * and the answer itself. A read that failed must never be drawn as an empty
 * list, and this repo has shipped that bug more than once.
 */
export type Phase = 'pending' | 'error' | 'ready'

export function phaseOf(query: Pick<UseQueryResult<unknown>, 'isPending' | 'isError'>): Phase {
  return query.isError ? 'error' : query.isPending ? 'pending' : 'ready'
}

export type WorkspaceMapState = WorkspaceMap & {
  isPending: boolean
  isError: boolean
  /** each read on its own, so a surface can tell "none" from "not yet" */
  phases: { agents: Phase; apps: Phase; jobs: Phase }
  /**
   * Whether every read the picture is made of has answered.
   *
   * Not `isPending`, which is the ring's read alone. A surface that draws all
   * three at once — the map does; an agent is its face, its apps and its work —
   * is drawing a drive that does not exist until this is true, and it has no
   * way to ask that of three booleans without deciding, here, what "loaded"
   * means. Answered rather than succeeded: a read that failed is as final as
   * one that returned, and a map waiting on one that is never coming would sit
   * on its own skeleton forever.
   */
  arrived: boolean
  agentsContinuation: {
    available: boolean
    loading: boolean
    failed: boolean
    load(): void
  }
  appsContinuation: {
    available: boolean
    loading: boolean
    failed: boolean
    load(): void
  }
  /** re-ask all three list calls */
  refetch: () => void
}

export function useWorkspaceMap(
  workspaceSlug: string,
  {
    coreLabel,
    copy,
    countsLabel,
    unfolded = false,
    liveActivity = true,
    includeAgent,
  }: WorkspaceMapOptions,
): WorkspaceMapState {
  const { api } = useSpa()

  const agentsQuery = useInfiniteQuery(duetQueryOptions.workspaces.agents(api, workspaceSlug))
  const appsQuery = useInfiniteQuery(duetQueryOptions.workspaces.apps(api, workspaceSlug))
  const agentsContinuation = useCollectionContinuation(agentsQuery)
  const appsContinuation = useCollectionContinuation(appsQuery)
  /* All four buckets, for every owner, already prioritized. Unfinished work
     comes first; completed history fills the owner's remaining bounded rows,
     so a quiet Jobs section keeps recent sessions instead of disappearing. */
  const activityQuery = useQuery(
    duetQueryOptions.workspaces.sessionActivity(api, workspaceSlug, liveActivity),
  )
  const loadedAgents = agentsQuery.data?.items ?? NO_AGENTS
  const agents = useMemo(
    () =>
      includeAgent === undefined ||
      includeAgent === null ||
      loadedAgents.some(a => a.id === includeAgent.id)
        ? loadedAgents
        : [...loadedAgents, includeAgent],
    [includeAgent, loadedAgents],
  )
  const apps = appsQuery.data?.items ?? NO_APPS
  /* Indexed once per read, not per face: the wire is an array (ordered, and it
     does not force a reader to know `root` is a key rather than an id), and the
     ring wants a lookup.

     Whole owners rather than their session lists, because one read now answers
     both questions a face asks — what this owner has been doing, and which
     conversation it *is*. That used to be one extra request per drawn face
     (`use-default-chats.ts`, deleted), and the gap between the two answers was
     visible: until the aliases landed, every owner's chat was still among its
     work, so the ring drew a Jobs seat and a bead for a conversation the dialog
     behind them withholds — and the seat displaced an app tile while it did. */
  const activity = useMemo(
    () => new Map(activityQuery.data?.owners.map(owner => [owner.agentId, owner])),
    [activityQuery.data],
  )
  const knownAgentIds = useMemo(() => new Set(agents.map(agent => agent.id)), [agents])

  /* Keeping the faces honest, in both directions the reader can be wrong about
     them: coming back from a conversation, and never leaving the ring at all
     while the drive moves underneath. It lives here rather than on the route
     because the activity read is here, and that read is what it spends. */
  useRingFreshness(workspaceSlug, {
    unfolded,
    activity: activityQuery.data,
    knownAgentIds,
  })

  /* An app — and an agent with a custom icon of its own — is drawn as a file on
     this drive, so the map is handed the same URL rule every other surface
     serves one by. One resolver, because an agent's icon and an app's icon are
     the same fact: a file at an anchor, versioned by `updatedAt`. */
  const driveIconUrl = useDriveFileIconUrl(workspaceSlug)
  const icons = useMemo<MapIcons>(
    () => ({ app: driveIconUrl, agent: driveIconUrl }),
    [driveIconUrl],
  )

  const now = useMapClock()
  const appsFailed = isInitialCollectionError(appsQuery)
  const agentsPhase = isInitialCollectionError(agentsQuery)
    ? 'error'
    : agentsQuery.isPending
      ? 'pending'
      : 'ready'
  const appsPhase = appsFailed ? 'error' : appsQuery.isPending ? 'pending' : 'ready'
  const jobsPhase = phaseOf(activityQuery)

  const refetchAgents = agentsQuery.refetch
  const refetchApps = appsQuery.refetch
  const refetchActivity = activityQuery.refetch
  const refetch = useCallback(() => {
    void refetchAgents()
    void refetchApps()
    /* One call now, so a retry can no longer leave the ring holding one fresh
       bucket and two stale ones — a face that disagreed with itself about what
       it was doing. */
    void refetchActivity()
  }, [refetchAgents, refetchApps, refetchActivity])
  return useMemo(() => {
    /* Apps belong to whichever agent's anchor encloses them — the same rule the
       roster and the agent canvas use, so an app never appears under two
       agents or under none. */
    const grouped = groupAppsByAgent(agents.map(agentResolutionCandidate), apps)
    /* The same one-layer rule the projection applies — called on the same
       owner, `groupAgentsByParent`, so the caption and the picture cannot
       drift. Captions count what the layer draws (the ring), not the census. */
    const ringIds = new Set(
      groupAgentsByParent(agents.map(agentResolutionCandidate)).rootChildren.map(
        candidate => candidate.agentId,
      ),
    )

    /* No grouping pass here any more. The wire is keyed by owner, so the split
       that used to happen on a truncated page — and that could only ever be as
       complete as that page — is the server's, over a list bounded per owner. */
    const root = activity.get(ROOT_AGENT_SCOPE)

    const slices: AgentSlice[] = agents.map(agent => {
      const owner = activity.get(agent.id)
      return {
        agent,
        apps: grouped.byAgentId.get(agent.id) ?? NO_APPS,
        jobs: owner?.sessions ?? NO_JOBS,
        ...(owner?.chat === undefined ? {} : { chat: owner.chat }),
      }
    })

    /* The centre counts what the map draws — which is every app on the drive,
       because the ones no anchor claims are Duet's own and hang off the centre.
       A caption that disagrees with the picture beside it is the one thing this
       number must never do, and it used to: the seeded hello app sits outside
       every agent's folder, so a drive with three apps read "2 apps". */
    const drawnApps =
      grouped.root.length +
      slices.reduce(
        (total, slice) => (ringIds.has(slice.agent.id) ? total + slice.apps.length : total),
        0,
      )

    const projected = projectWorkspaceMap(
      {
        name: coreLabel,
        apps: grouped.root,
        jobs: root?.sessions ?? NO_JOBS,
        ...(root?.chat === undefined ? {} : { chat: root.chat }),
        meta: countsLabel({
          agents: ringIds.size,
          apps: appsFailed ? undefined : drawnApps,
          agentsComplete: !agentsQuery.hasNextPage && !agentsQuery.isFetchNextPageError,
          appsComplete: !appsFailed && !appsQuery.hasNextPage && !appsQuery.isFetchNextPageError,
        }),
      },
      slices,
      now,
      copy,
      icons,
    )

    return {
      ...projected,
      isPending: agentsQuery.isPending,
      isError: agentsPhase === 'error',
      phases: { agents: agentsPhase, apps: appsPhase, jobs: jobsPhase },
      arrived: agentsPhase !== 'pending' && appsPhase !== 'pending' && jobsPhase !== 'pending',
      agentsContinuation,
      appsContinuation,
      refetch,
    }
  }, [
    agents,
    agentsPhase,
    apps,
    appsFailed,
    appsPhase,
    coreLabel,
    copy,
    countsLabel,
    icons,
    activity,
    jobsPhase,
    now,
    refetch,
    agentsQuery.isPending,
    agentsQuery.hasNextPage,
    agentsQuery.isFetchNextPageError,
    agentsContinuation,
    appsQuery.hasNextPage,
    appsQuery.isFetchNextPageError,
    appsContinuation,
  ])
}

/* ---------------------------------------------------------------- the clock
   Every "2 min ago" on the map is relative to a `now` that has to come from
   somewhere, and `Date.now()` inside the projection memo is the one place it
   must not come from. The memo genuinely memoises and nothing on this surface
   polls, so a focus refetch that returns identical data changes no dependency,
   the memo does not re-run, and the wall clock is never read again. Leave home
   open for an hour and every job still says "2 min ago". The memoisation
   working is exactly what stopped the clock.

   So the clock is a dependency like any other, coarse enough that a recompute
   is a once-a-minute event: one projection plus one layout, measured at well
   under a tenth of a millisecond.

   The snapshot is cached rather than computed per call because
   `useSyncExternalStore` compares it on every render, and because two captions
   rendered a microsecond apart disagreeing about "now" is a bug waiting for a
   screenshot test. */
const TICK_MS = 60_000

let tickAt = Date.now()
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

/** The wall clock, rounded down to when it was last looked at. */
function readMapClock(): number {
  const now = Date.now()
  /* Self-healing: a tab that was backgrounded, or a store nobody was
     subscribed to, still hands back something current on the next render. */
  if (now - tickAt >= TICK_MS) tickAt = now
  return tickAt
}

function subscribeMapClock(onChange: () => void): () => void {
  listeners.add(onChange)
  timer ??= setInterval(() => {
    tickAt = Date.now()
    for (const listener of listeners) listener()
  }, TICK_MS)
  return () => {
    listeners.delete(onChange)
    if (listeners.size > 0) return
    clearInterval(timer)
    timer = undefined
  }
}

/**
 * `now`, as something a memo can depend on: one shared value that moves once a
 * minute, not a fresh reading per render.
 */
export function useMapClock(): number {
  return useSyncExternalStore(subscribeMapClock, readMapClock, readMapClock)
}
