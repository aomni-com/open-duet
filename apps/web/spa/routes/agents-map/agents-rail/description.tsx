'use client'

/* ============================================================================
   What one agent says it is, on one row of the roster.

   A component rather than a field on the row, because it is a file read per
   agent — the first prose line of that agent's `AGENTS.md`, which is the
   product's one answer to "what is this agent" (`agent-profile.ts`) — and a
   list cannot call a hook once per row. So the roster takes the *component* and
   mounts one per row, and this is the one the product passes it.

   ---- one request per row, answered before the row asks ----
   The role half on its own, not the profile: the profile also lists the agent's
   skills folder, and nothing on a row draws a skill. Through the profile this
   would be two VM round-trips per agent for a line of prose. Held warm for the
   five minutes `agent-profile.ts` holds every derived profile, so the reads
   happen once a session.

   The queries are mounted rather than gated, and there is nothing to gate them
   on: the roster is a permanent column, out by default, beside every
   destination in the agents section. Every row is on screen at first paint. What
   makes that affordable is that the reads are in flight before the column mounts
   — `preload-agent-pages.ts` warms this exact key for the whole fleet, in
   bounded batches, off the critical path — so these mounts dedupe onto warmed
   entries and this file is a cache reader. A per-row read the preload does not
   warm costs the front door one uncoordinated request per agent to paint.

   ---- and a missing description is a normal state ----
   Most agents ship an `AGENTS.md`; some do not, and a drive whose VM is briefly
   away has none of them. Every one of those draws as no second line rather than
   as an error, a placeholder, or a row that changes height — see
   `agentRoleQueryOptions`, which is where all of it collapses to `null`.
   ========================================================================= */
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useMemo, type ComponentType } from 'react'

import { useSpa } from '../../../context'
import { agentRoleQueryOptions } from '../../../drive/agent-profile'
import type { RailRow } from './roster'

/**
 * The roster's description component, bound to one workspace.
 *
 * A hook rather than a bare factory so the memo cannot be forgotten: the roster
 * mounts whatever it is given once per row, and a component built fresh every
 * render is one that remounts every row every render. `workspaceSlug` is the
 * only thing closed over and it does not change while a drive is open, so in
 * practice this identity is stable for the whole session — which is exactly why
 * a row's anchor travels on the row rather than in a lookup table captured here.
 */
export function useAgentDescription(workspaceSlug: string): ComponentType<{ row: RailRow }> {
  return useMemo(() => {
    function AgentDescription({ row }: { row: RailRow }) {
      const t = useTranslations('duetApp.agentsRail')
      const { api } = useSpa()
      const { anchorPath } = row
      const role = useQuery({
        ...agentRoleQueryOptions(api, workspaceSlug, {
          id: row.agent.id,
          anchorPath: anchorPath ?? '',
        }),
        /* Nowhere to read from is not the drive root. Disabling is the only
           honest response — asking with `''` would print the drive's own
           description under an agent's name. */
        enabled: anchorPath !== undefined,
      })
      if (role.data != null) return role.data
      /* Duet is the one row with no agent record behind it, so when the drive
         root describes itself nowhere there is no second place to look. Saying
         what it is beats leaving the one name every drive has unexplained —
         and it is the only row that gets a fallback, because it is the only one
         whose identity is a product fact rather than a file. */
      return row.duet ? t('duet') : null
    }
    return AgentDescription
  }, [workspaceSlug])
}
