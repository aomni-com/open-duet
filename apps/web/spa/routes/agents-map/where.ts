/* ============================================================================
   What the map is showing, resolved from the URL against the data it has.

   Pure. The route owns the queries and the navigation; this owns the one
   question between them — *the address says `ops`, so what does the canvas
   draw?* — and it is a question with five answers, not two.

   ---- `waiting` and `unknown` are different, and it matters ----
   A cold deep link and a dead link look identical for the first few hundred
   milliseconds: in both, the slug names an agent the projection does not have.
   Collapse them and every link anyone ever pastes flashes "that agent is not
   here" before it opens. So the phase decides which one it is, and only a
   *settled* read is allowed to call an agent missing.

   An `error` phase is `waiting`, not `unknown`. A read that failed has not
   established anything about who is on this drive, and telling a reader their
   colleague does not exist because a request timed out is the worst answer
   available.

   ---- it resolves against the live projection, on purpose ----
   The zoom used to hold `node.data` — the agent object as it was at the instant
   of the click — so an agent's work never updated while you were inside it. A
   slug resolved per render fixes that for free: a job that starts while you are
   reading reaches the surface, because the surface is looking the agent up
   again rather than remembering it.
   ========================================================================= */
import { ROOT_AGENT_SCOPE } from '@repo/contract'

import type { MapPlace } from '../../drive/agents-map-url'
import type { AgentRoute } from '../../knowledge-map-data/project'
import type { Phase } from '../../knowledge-map-data/use-workspace-map'
import type { Agent as MapAgent, MapData } from '../../knowledge-map/types'

/** The half of `useWorkspaceMap`'s return this resolution actually reads. */
export type MapProjection = {
  data: MapData
  /** every agent, ring or not — the ring shows one layer, links reach all */
  agentDirectory: ReadonlyMap<string, MapAgent>
  routes: ReadonlyMap<string, AgentRoute>
}

export type MapFocus =
  /** nobody is unfolded; the reader is looking at the whole drive */
  | { kind: 'graph' }
  /** the URL names an agent and the ring has not answered yet */
  | { kind: 'waiting'; agentSlug: string }
  /** the ring has answered and this drive has no such agent */
  | { kind: 'unknown'; agentSlug: string }
  /** the drive's own agent, which is the centre and has no route of its own */
  | { kind: 'core'; agent: MapAgent }
  | { kind: 'agent'; agent: MapAgent; route: AgentRoute }

/** Which agent a place unfolds, if any. */
export function focusOf(place: MapPlace, map: MapProjection, phase: Phase): MapFocus {
  if (place.kind === 'graph') return { kind: 'graph' }

  /* The centre is never on the ring — `listAgents` has never returned it — so
     there is no route to find and looking would always miss. It answers to the
     token the contract already spends everywhere else. */
  if (place.agentSlug === ROOT_AGENT_SCOPE) return { kind: 'core', agent: map.data.duet }

  for (const [agentId, route] of map.routes) {
    if (route.slug !== place.agentSlug) continue
    /* The directory, not the ring: the ring draws one layer, and a deep link
       to a nested agent must keep resolving after it left root's circle. */
    const agent = map.agentDirectory.get(agentId)
    if (agent === undefined) continue
    return { kind: 'agent', agent, route }
  }

  /* An unfolded agent that is missing has lost the whole destination, so it is
     worth saying out loud. A read still in flight is `waiting` either way,
     because nothing has been established yet. */
  if (phase !== 'ready') return { kind: 'waiting', agentSlug: place.agentSlug }
  return { kind: 'unknown', agentSlug: place.agentSlug }
}
