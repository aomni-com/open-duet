/* ============================================================================
   The drive as a list: every carrier on it, busiest-most-recent first.

   The map answers "what is this drive" with a picture. This answers the same
   question with rows, for the reader who would rather scan than look — and it
   is deliberately the *same data*, rearranged. It projects `MapData`, which is
   already on screen behind the drawer, rather than reading the drive again:
   two views of one drive that disagreed about how busy an agent is would be
   worse than having only one of them.

   ---- a row is one carrier, and one conversation ----
   Not its work. Build's column lists the drive's carriers, and clicking a row
   opens the conversation you have with that one; a carrier's other sessions
   live in Work, which is the surface built to list them. So a row carries the
   carrier and nothing else about what it is doing — the mark the row wears
   comes off `agent.chat`, which the projection already puts beside the work
   rather than inside it.

   It used to carry the work too: a filtered copy of `agent.jobs` and a numeral
   counting it. Both are gone rather than merely undrawn, because a row holding
   a list nothing draws is a row the next reader will draw it from.

   ---- and the order is the whole feature ----
   A list that says it is sorted by latest activity and is not is worse than an
   unsorted one, because the reader trusts a claim they cannot check. So the
   rule is one a reader *can* check: every row prints the moment it was sorted
   on. See `MapActivity` for why a carrier that has not moved is absent from
   that table rather than sitting at zero, and `byActivity` for what this does
   with the absence.
   ========================================================================= */
import { ROOT_AGENT_SCOPE, type MessagePreview } from '@repo/contract'

import type {
  AgentRoute,
  MapActivity,
  MapCopy,
  MapPreviews,
} from '../../../knowledge-map-data/project'
import { CORE_ID } from '../../../knowledge-map/layout'
import type { Agent as MapAgent, MapData } from '../../../knowledge-map/types'

export type RailRow = {
  /**
   * The carrier itself, not a copy of its fields.
   *
   * The row hands this straight back when it is clicked, and the map's own
   * callbacks take an agent node — so a click can fly the camera or open a job
   * without the drawer owning a lookup table of its own.
   */
  agent: MapAgent
  /** the drive itself rather than a face on the ring */
  duet: boolean
  /**
   * Where this carrier lives on the drive, so its description can be read.
   *
   * On the row rather than looked up beside it, because the thing that draws
   * the description is a *component* mounted per row — and one that closed over
   * a lookup table would take a new identity every time the table did, which is
   * once a minute when the map's clock ticks. Every row on the drawer would
   * remount to redraw a line of prose that had not changed.
   *
   * Duet's is `''`: Duet is the drive, so what describes it is the drive root's
   * own `AGENTS.md`. Absent means nowhere is known to read one from, which is
   * a different thing from the drive root and must not degrade to it.
   */
  anchorPath?: string
  /** when it last moved, already phrased. Absent for a carrier that has not. */
  when?: string
  /**
   * The last thing said in the conversation you have with it, and who said it.
   *
   * Handed in already cut and already flattened — the server decided all of
   * that at write time, and re-deciding any of it here would be a second
   * answer to a question the wire has settled. Absent is ordinary: nobody has
   * written to this carrier, or nothing in its conversation was a message.
   *
   * Never in the sort. The list is ordered by `when`, which is a question
   * about work; this is a question about words.
   */
  preview?: MessagePreview
}

/**
 * Most recently moved first; then everything quiet, alphabetically.
 *
 * The two halves are sorted by different questions on purpose. A carrier that
 * has moved has a moment, and the newest of those goes to the top. A carrier
 * that has not has no moment at all — and inventing one for it, so it could
 * join the same comparison, is how "quiet" quietly becomes "moved in 1970" and
 * an agent nobody has ever used sorts *between* two that are working.
 *
 * Alphabetical below the fold rather than arbitrary, because that half of the
 * list has no order of its own to show and a stable one is what makes it
 * scannable. `localeCompare` so a Spanish drive sorts its own way.
 */
function byActivity(activity: MapActivity) {
  return (a: RailRow, b: RailRow): number => {
    const left = activity.get(a.agent.id)
    const right = activity.get(b.agent.id)
    if (left !== undefined && right !== undefined) return right - left
    if (left !== undefined) return -1
    if (right !== undefined) return 1
    return a.agent.name.localeCompare(b.agent.name)
  }
}

function previewOf(previews: MapPreviews, agentId: string): { preview?: MessagePreview } {
  const preview = previews.get(agentId)
  return preview === undefined ? {} : { preview }
}

function anchorOf(
  routes: ReadonlyMap<string, AgentRoute>,
  agentId: string,
): { anchorPath?: string } {
  const route = routes.get(agentId)
  return route === undefined ? {} : { anchorPath: route.anchorPath }
}

export function railRows(
  data: MapData,
  /**
   * The rail is the escape hatch, so it lists every agent on the drive — the
   * directory — not the one-layer ring behind it. A nested agent the ring
   * defers to its parent is still a row here, or it would be reachable only
   * by knowing its URL.
   */
  directory: ReadonlyMap<string, MapAgent>,
  activity: MapActivity,
  /** beside `activity` and never merged into it — see `MapPreviews` */
  previews: MapPreviews,
  routes: ReadonlyMap<string, AgentRoute>,
  now: number,
  copy: MapCopy,
): readonly RailRow[] {
  /* Duet is a row and not a heading over the others. It is the drive itself, so
     it is tempting to pin it to the top — but the list's one promise is its
     order, and a row exempt from that promise is the row that makes a reader
     stop believing the rest. When Duet is the busiest thing on the drive it
     leads; when it has been idle for a week it sits under the agents that have
     not. */
  const rows = [...directory.values(), data.duet].map<RailRow>(agent => {
    const moved = activity.get(agent.id)
    const duet = agent.id === ROOT_AGENT_SCOPE
    return {
      agent,
      duet,
      /* The drive root for Duet, and whatever the side table says for everyone
         else. A ring agent the table has never heard of should not be possible
         — both come out of one projection over one list — but falling back to
         `''` for one would read the *drive's* own description out under
         somebody else's name, so the absence stays an absence. */
      ...(duet ? { anchorPath: '' } : anchorOf(routes, agent.id)),
      ...(moved === undefined ? {} : { when: copy.when(moved, now) }),
      ...previewOf(previews, agent.id),
    }
  })
  return rows.sort(byActivity(activity))
}

/**
 * The id the ring knows this row by.
 *
 * One record, two names: the roster calls Duet `ROOT_AGENT_SCOPE` because that
 * is what the drive's own scope is called, and the ring draws it at the centre
 * as `CORE_ID`. Anything pointing from this list at that picture has to cross
 * that, and doing it here means once rather than once per band of a row.
 */
export function railNodeId(row: RailRow): string {
  return row.duet ? CORE_ID : row.agent.id
}
