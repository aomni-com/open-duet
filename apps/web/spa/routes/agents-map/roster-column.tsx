'use client'

/* ============================================================================
   The roster, assembled once for both destinations.

   `agents-section` decides where the column stands; this decides what is in it.
   The split matters because the two are owned by different things — the shell
   is geometry, and this is a projection plus four handlers — but neither is
   route-specific, and both destinations under `/agents` want exactly the same
   answer.

   It is a hook rather than a component because half of what it returns is not
   the column: the add dialog is mounted beside the destination rather than
   inside the column (it is modal, and a dialog inside something that can fold
   to zero width folds with it), while the control that opens it lives in the
   column's head. One call hands a route both, already wired to each other.
   ========================================================================= */
import { useQuery } from '@tanstack/react-query'
import { useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router'

import { duetQueryOptions } from '../../api/query-options'
import { useSpa } from '../../context'
import { driveRoutes } from '../../drive/drive-routes'
import type { MapCopy } from '../../knowledge-map-data/project'
import type { WorkspaceMapState } from '../../knowledge-map-data/use-workspace-map'
import { createSessionAuthorDirectory } from '../../sessions/session-authors'
import { workHomeUrl } from '../../team-space/work-destination'
import { useAddAgent } from './add-agent'
import { AddAgentDialog } from './add-agent-dialog'
import { AgentsRail, OpenRoster } from './agents-rail'
import { useAgentDescription } from './agents-rail/description'
import { railRows } from './agents-rail/roster'
import { useRosterDestinations } from './roster-destinations'

export type RosterColumn = {
  /** the column itself, for `AgentsSection`'s first track */
  roster: ReactNode
  /**
   * The same control the column's head carries, for the one other place that
   * offers it: the canvas's own add slot, a dashed empty seat in the ring.
   * Two doors, one dialog — which is the whole reason this is a hook.
   */
  onAddAgent: () => void
  /** modal, so it is mounted outside the foldable column rather than inside it */
  addDialog: ReactNode
  /**
   * The way back to a folded column, or `null` when it is already out.
   *
   * The control that folds the roster lives in its head, which goes with it —
   * so something has to stand in for it while the column is away, and it has to
   * stand *in flow* on whatever is beside it. It used to be one absolutely
   * positioned button holding a single position in both states, which read well
   * on a canvas and put a square on top of the agent's own face the moment the
   * destination beside it had something at its top-left corner.
   *
   * So the destination places it. `null` while the column is out, because then
   * the head's own control is the one on screen and a second would be two
   * controls for one fact.
   */
  openControl: ReactNode | null
}

export function useRosterColumn({
  workspaceSlug,
  map,
  now,
  copy,
  fold,
  selectedAgentId,
  graphSelected,
  onHoverNode,
}: {
  workspaceSlug: string
  map: WorkspaceMapState
  now: number
  copy: MapCopy
  /**
   * The fold, resolved by the route rather than here.
   *
   * It has to be: on an agent's page the roster's out-ness decides how fast the
   * drive-wide activity read ticks, so the route needs the answer *before* it
   * calls `useWorkspaceMap` — and this hook needs that map. Resolving it here
   * would either be circular or be a second, independent copy of the reader's
   * preference. `useRosterOut` stays the one owner; the route asks it early.
   */
  fold: { out: boolean; toggle: () => void; dismissAfterPick: () => void }
  /** the row the reader is on, marked. Absent on the graph, which marks faces instead. */
  selectedAgentId?: string
  /** whether the graph's own row is the one being read */
  graphSelected?: boolean
  /** how a row marks its counterpart on the canvas. Absent where there is no canvas. */
  onHoverNode?: (nodeId: string | null) => void
}): RosterColumn {
  const describeAgent = useAgentDescription(workspaceSlug)
  const destinations = useRosterDestinations({ workspaceSlug, routes: map.routes })
  const addAgent = useAddAgent(workspaceSlug)
  const navigate = useNavigate()

  /* The transcript's own author directory, not a second lookup beside it: it is
     what decides that a member with a blank name is called by their email and
     that the signed-in reader resolves without waiting on the roster read. A
     `find` here would agree with it on the common case and quietly disagree on
     both of those, which is the whole failure this shares an owner to avoid.

     The roster read is a cache hit on any surface that has already drawn a
     conversation, and rows degrade to the words alone while it is in flight — a
     name arriving a moment late fills a gap rather than correcting a lie. */
  const { api, identity } = useSpa()
  const members = useQuery(duetQueryOptions.workspaces.members(api, workspaceSlug))
  const authors = useMemo(
    () => createSessionAuthorDirectory({ viewer: identity.user, members: members.data?.items }),
    [identity.user, members.data?.items],
  )

  const rows = useMemo(
    () => railRows(map.data, map.agentDirectory, map.activity, map.previews, map.routes, now, copy),
    [copy, map.activity, map.agentDirectory, map.data, map.previews, map.routes, now],
  )

  /* Every way out of this column also dismisses it, and the dismissal is a
     no-op except where the column covers what it is sending the reader to. It
     is wrapped here rather than inside each handler because "picking something
     closes the panel" is a fact about the column, not about any one
     destination. */
  const dismissing = <T extends unknown[]>(pick: (...args: T) => void) => {
    return (...args: T) => {
      pick(...args)
      fold.dismissAfterPick()
    }
  }

  const roster = (
    <AgentsRail
      out={fold.out}
      onToggle={fold.toggle}
      onAddAgent={dismissing(addAgent.onAddAgent)}
      workDestination={{
        href: workHomeUrl(workspaceSlug),
        onOpen: dismissing(() => navigate(workHomeUrl(workspaceSlug))),
      }}
      graphDestination={{
        href: driveRoutes.graph(workspaceSlug),
        onOpen: dismissing(destinations.onOpenGraph),
      }}
      graphSelected={graphSelected === true}
      rows={rows}
      selectedAgentId={selectedAgentId}
      /* The roster's own phase, not the map's overall one: it lists agents the
         moment they land, exactly as the ring draws them, and their work fills
         in behind. There is no second flag for the job read — a row with
         nothing in flight draws no number at all, so a drive still reading and
         a drive that is quiet look the same, which is the truth in both. */
      phase={map.phases.agents}
      onRetry={map.refetch}
      continuation={map.agentsContinuation}
      onOpen={dismissing(destinations.onOpen)}
      onOpenApp={dismissing(destinations.onOpenApp)}
      onHoverNode={onHoverNode}
      memberName={authors.memberName}
      description={describeAgent}
    />
  )

  return {
    roster,
    onAddAgent: addAgent.onAddAgent,
    addDialog: <AddAgentDialog {...addAgent.dialog} />,
    openControl: fold.out ? null : <OpenRoster onToggle={fold.toggle} />,
  }
}
