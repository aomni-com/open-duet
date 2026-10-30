'use client'

import { useFormatter, useTranslations } from 'next-intl'
/* ============================================================================
   The drive, as a map of itself. `/agents/graph`, and nothing else.

   Two things live here and nowhere else: the queries the picture is made of,
   and what happens when you click something on it. The picture is
   `KnowledgeMapHome` and its data is `useWorkspaceMap`. The column beside it is
   neither of this file's business — `useRosterColumn` assembles it and
   `AgentsSection` decides where it stands, on this destination and on the
   agent's page alike.

   ---- one agent is a different route ----
   It used to be this one. `agents/:agentSlug` resolved to this component, which
   read the slug, resolved it against the roster, and unfolded that agent over
   its own canvas — so the ring and the agent were one surface, one camera and
   one six-hundred-line route, and which of the two you got was decided at the
   bottom of it. `agent-route.tsx` is that half, extracted, and the seam is the
   URL rather than a `focus` variable: clicking a face navigates, this unmounts,
   the agent's page mounts. Nothing here knows what an agent's page contains and
   nothing there knows this exists.

   The reason it had to be undone, rather than tidied: `focus` was null for
   three different reasons and only one of them meant "the reader is on the
   ring". An agent's URL whose roster read had not landed, or whose slug this
   drive does not have, fell through to *the map* — the whole thing, camera and
   all, on `/agents/:agentSlug`. A component cannot be the fallback for a
   destination it is not.

   What the reader can see, they can send. `drive/agents-map-url.ts` owns the
   grammar for every place under `/agents`; this file only navigates and reads.
   ========================================================================= */
import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { DEFAULT_AGENT_NAME, ROOT_AGENT_SCOPE } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'

import { useSpa } from '../context'
import { agentsMapUrl, type MapPlace } from '../drive/agents-map-url'
import type { MapCopy } from '../knowledge-map-data/project'
import { useMapClock, useWorkspaceMap } from '../knowledge-map-data/use-workspace-map'
import type { KnowledgeMapOpen, KnowledgeMapZoom } from '../knowledge-map/knowledge-map'
import type { Agent as MapAgent } from '../knowledge-map/types'
import { workHomeUrl, workSessionUrl } from '../team-space/work-destination'
import { useRosterOut } from './agents-map/agents-rail/out'
import { AgentsSection } from './agents-map/agents-section'
import { KnowledgeMapHome } from './agents-map/knowledge-map-home'
import { useRosterColumn } from './agents-map/roster-column'
import { useCanUseSessions } from './sessions'

const GRAPH = { kind: 'graph' } as const

export default function AgentsMapRoute() {
  const { workspaceSlug = '' } = useParams()
  const { identity } = useSpa()
  const navigate = useNavigate()
  const t = useTranslations('duetApp.homeSurface')
  const format = useFormatter()
  const canUseSessions = useCanUseSessions(workspaceSlug)
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

  const workspace = identity.workspaces.find(candidate => candidate.slug === workspaceSlug)
  /* Asked before the map read, because on the agent's page next door the
     same answer decides that read's cadence. One owner, asked early on both. */
  const fold = useRosterOut({ preferOutWhenCramped: true })
  const map = useWorkspaceMap(workspaceSlug, {
    /* The default agent's own name, the one given in onboarding. It used to be
       the *drive's* name, which is a different thing that is already set in the
       chrome above the canvas — so the one agent every drive has was the one
       agent whose name you could never see, on the face at the centre or on the
       surface that unfolds out of it. */
    coreLabel: workspace?.duetName ?? DEFAULT_AGENT_NAME,
    copy,
    countsLabel,
    /* The canvas draws its own live dots whenever it is on screen, and this
       component is only ever mounted where it is — so the drive's clock runs
       fast here regardless of whether the roster beside it is out. The agent's
       page answers the same question with the roster's own state, because
       there the roster is the only thing reading this. */
    liveActivity: true,
  })

  const go = useCallback(
    (next: MapPlace, options?: { replace?: boolean }) =>
      navigate(agentsMapUrl(workspaceSlug, next), { replace: options?.replace === true }),
    [navigate, workspaceSlug],
  )

  /* Which row the pointer is on, so the ring can mark the same agent. Held
     here rather than in either component because it is the one fact the list
     and the picture both need and neither owns. */
  const [railHover, setRailHover] = useState<string | null>(null)

  /* Nothing is unfolded here and nothing can be: an agent is another route, so
     this component draws the drive and only ever the drive. `focusOf` — which
     resolves a slug in the address bar against the roster — moved to the page
     that has a slug to resolve. What is left of "who is the reader looking at"
     on this surface is a mark under the pointer, and `roster-column` reports it. */

  const slugOf = useCallback(
    (agent: MapAgent): string | undefined =>
      agent.id === ROOT_AGENT_SCOPE ? ROOT_AGENT_SCOPE : map.routes.get(agent.id)?.slug,
    [map.routes],
  )

  const onZoom = useCallback(
    (next: KnowledgeMapZoom | null) => {
      if (next === null) {
        go(GRAPH)
        return
      }
      const slug = next.kind === 'core' ? ROOT_AGENT_SCOPE : slugOf(next.agent)
      if (slug === undefined) return
      go({ kind: 'agent', agentSlug: slug, card: { kind: 'default' } })
    },
    [go, slugOf],
  )

  /* The two doors on the ring. An app used to open on a workspace-level route of
     its own; an app belongs to whichever agent's folder encloses it, so it opens
     *that agent* with the app on its card — the carrier the node already hangs
     off, and a destination that never leaves the map.

     A bead of work is the door that does leave. It used to unfold a dialog over
     this same canvas; that list is Work's now, and a seat with no row behind it
     — the summary seat, which names no single job — opens the owner's Work home
     rather than guessing which of its sessions the reader meant.

     It used to be four state writes in a deliberate order, precisely because
     they could race the reset inside `onZoom`. One URL cannot race itself. */
  const onOpen = useCallback(
    (event: KnowledgeMapOpen) => {
      const slug = slugOf(event.agent)
      if (slug === undefined) return
      if (event.kind === 'apps') {
        go({ kind: 'agent', agentSlug: slug, card: { kind: 'app', appSlug: event.app.id } })
        return
      }
      if (!canUseSessions) return
      const job = event.job
      navigate(
        job == null
          ? workHomeUrl(workspaceSlug, slug)
          : workSessionUrl(workspaceSlug, slug, job.id),
      )
    },
    [canUseSessions, go, navigate, slugOf, workspaceSlug],
  )

  /* The column, assembled by its own owner so this route and the agent's page
     cannot build it two ways. What is route-specific is only the two arguments:
     which row is marked — none here, because the reader is on the drive itself
     rather than on an agent — and where a hover is reported, which is the
     canvas, the one surface with faces to mark. */
  const { roster, onAddAgent, addDialog, openControl } = useRosterColumn({
    workspaceSlug,
    map,
    now,
    copy,
    fold,
    graphSelected: true,
    onHoverNode: setRailHover,
  })

  return (
    <AgentsSection roster={roster}>
      {/* The canvas has no chrome of its own to hang this in, and nothing at
          its top-left corner to collide with — so on this destination the way
          back to a folded column stands on the picture, which is where the
          control lived on both surfaces before an agent's face needed that
          corner. */}
      {openControl === null ? null : (
        <div className="absolute top-[calc(var(--drive-topbar-h,0px)+10px)] left-5 z-20">
          {openControl}
        </div>
      )}
      {map.appsContinuation.available || map.appsContinuation.failed ? (
        <div className="absolute bottom-5 left-1/2 z-20 -translate-x-1/2">
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
      <KnowledgeMapHome
        highlightId={railHover}
        data={map.data}
        /* `arrived`, not `isPending`: the ring is one of the three reads this
         picture is made of, and drawing on the first of them paints a drive
         whose agents carry nothing — then re-frames twice as the rest lands.
         The shape of the map stands in until all three have answered. */
        state={map.isError ? 'error' : map.arrived ? 'ready' : 'loading'}
        /* No `zoom`, and that is the whole change rather than an omission. It
           used to carry whichever agent the URL named, and this component would
           unfold that agent over its own canvas — which is what made the ring
           and the agent one surface with one camera and one enormous route
           between them. Clicking a face is a navigation now: `onZoom` writes
           the URL, the router unmounts this, and the agent's page mounts. */
        onZoom={onZoom}
        onOpen={onOpen}
        onAddAgent={onAddAgent}
        onRetry={map.refetch}
      />
      {/* A sibling, because the map draws a ring and nothing else now — there
        is no slot inside it to mount into, and this is where the add slot is
        clicked. */}
      {addDialog}
    </AgentsSection>
  )
}
