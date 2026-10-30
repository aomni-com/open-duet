'use client'

/* ============================================================================
   Where a roster row leads.

   Two destinations — the agent, and one of the apps it can reach — and they are
   the same two from whichever surface the roster is standing on. That is the
   whole reason this is a module: the roster is section furniture now, mounted
   beside the canvas *and* beside an agent, and two copies of "where does a row
   go" is two answers that can disagree about the product's most-clicked list.

   A row's own destination is the conversation with that carrier, which the
   agent's page opens on. Its other sessions are not here and are not a
   destination this column offers: they belong to Work.

   Every answer is a URL, built through `agentsMapUrl`, because the grammar has
   one owner and this is not it.
   ========================================================================= */
import { useCallback } from 'react'
import { useNavigate } from 'react-router'

import { ROOT_AGENT_SCOPE } from '@repo/contract'

import { agentsMapUrl, type MapPlace } from '../../drive/agents-map-url'
import type { AgentRoute } from '../../knowledge-map-data/project'
import type { AppItem, Agent as MapAgent } from '../../knowledge-map/types'
import type { RailRow } from './agents-rail/roster'

/**
 * An agent id as a URL spells it, or `undefined` for one this drive has no route
 * to.
 *
 * The drive root is the single id the route table has no entry for — it is the
 * centre of the map rather than a face on the ring — and its reserved slug is
 * the answer. Exported because three callers need it and none of them may
 * decide separately: this module's own destinations, the head's way back to an
 * agent, and the row the reader is on. Spelled once, they cannot drift; spelled
 * three times, two of them keyed on `row.duet` and one on the id, they are the
 * same fact free to disagree.
 */
export function agentSlug(
  routes: ReadonlyMap<string, AgentRoute>,
  agentId: string,
): string | undefined {
  return agentId === ROOT_AGENT_SCOPE ? ROOT_AGENT_SCOPE : routes.get(agentId)?.slug
}

export type RosterHandlers = {
  /** the head's way to the drive's picture of itself */
  onOpenGraph: () => void
  /**
   * The same destination `onOpen` navigates to, as a URL.
   *
   * The head's control is a link as well as a handler — a way to a destination
   * that cannot be cmd-clicked into a new tab is the one place in the product
   * where that silently would not work. Built here rather than by the caller so
   * the href and the navigation cannot describe two different places.
   */
  hrefOf: (row: RailRow) => string | undefined
  onOpen: (row: RailRow) => void
  onOpenApp: (row: RailRow, app: AppItem) => void
}

export function useRosterDestinations({
  workspaceSlug,
  routes,
}: {
  workspaceSlug: string
  /** the map's own agentId → route table, which is what turns a row into a slug */
  routes: ReadonlyMap<string, AgentRoute>
}): RosterHandlers {
  const navigate = useNavigate()

  const go = useCallback(
    (next: MapPlace) => navigate(agentsMapUrl(workspaceSlug, next)),
    [navigate, workspaceSlug],
  )

  const slugOf = useCallback((agent: MapAgent) => agentSlug(routes, agent.id), [routes])

  const onOpen = useCallback(
    (row: RailRow) => {
      const slug = slugOf(row.agent)
      if (slug === undefined) return
      go({ kind: 'agent', agentSlug: slug, card: { kind: 'default' } })
    },
    [go, slugOf],
  )

  /* An app opens where it lives: on the card of the agent whose folder encloses
     it, which for a roster row is the row's own agent. An app's id is its slug. */
  const onOpenApp = useCallback(
    (row: RailRow, app: AppItem) => {
      const slug = slugOf(row.agent)
      if (slug === undefined) return
      go({ kind: 'agent', agentSlug: slug, card: { kind: 'app', appSlug: app.id } })
    },
    [go, slugOf],
  )

  const onOpenGraph = useCallback(() => go({ kind: 'graph' }), [go])

  const hrefOf = useCallback(
    (row: RailRow) => {
      const slug = slugOf(row.agent)
      return slug === undefined
        ? undefined
        : agentsMapUrl(workspaceSlug, { kind: 'agent', agentSlug: slug, card: { kind: 'default' } })
    },
    [slugOf, workspaceSlug],
  )

  return { onOpenGraph, hrefOf, onOpen, onOpenApp }
}
