'use client'

/* ============================================================================
   Adding an agent, as one thing.

   The trigger, the names already taken, what a confirmed creation does to the
   cache, and where it goes afterwards. All four used to sit inline on the map
   route, which was right while the ring's own add slot was the only door.

   The control lives in the roster's head now, and the roster stands on every
   destination under `/agents` — so the door is on both of them, and this is
   what stops that becoming two implementations of the same dialog with two
   answers about what a successful creation does.
   ========================================================================= */
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import type { Agent, AgentListResponse } from '@repo/contract'

import { duetQueryKeys } from '../../api/query-keys'
import { duetQueryOptions, prependCollectionItem } from '../../api/query-options'
import { useSpa } from '../../context'
import { agentsMapUrl } from '../../drive/agents-map-url'
import { driveRoutes } from '../../drive/drive-routes'

export type AddAgent = {
  /** the roster head's control */
  onAddAgent: () => void
  /** everything `AddAgentDialog` needs, so a host spreads it and knows nothing */
  dialog: {
    workspaceSlug: string
    takenSlugs: ReadonlySet<string>
    open: boolean
    onOpenChange: (open: boolean) => void
    onHire: () => void
    onCreated: (agent: Agent) => void
  }
}

export function useAddAgent(workspaceSlug: string): AddAgent {
  const { api } = useSpa()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  /* The control asks which kind of agent before it goes anywhere, because there
     are two answers: hire one off the marketplace, the shelf of agents that
     already exist, or write one from nothing. Hiring leaves for a page; writing
     is a name and stays in the dialog. */
  const [open, setOpen] = useState(false)
  const onAddAgent = useCallback(() => setOpen(true), [])
  const onHire = useCallback(
    () => navigate(driveRoutes.marketplace(workspaceSlug)),
    [navigate, workspaceSlug],
  )

  /* The names already taken, so the dialog can refuse a collision before it
     asks the server. The same cache entry the map's own projection reads. */
  const agentsQuery = useInfiniteQuery(duetQueryOptions.workspaces.agents(api, workspaceSlug))
  const takenSlugs = useMemo(
    () => new Set((agentsQuery.data?.items ?? []).map(agent => agent.slug)),
    [agentsQuery.data],
  )

  const onCreated = useCallback(
    (agent: Agent) => {
      setOpen(false)
      /* The registered row is the server's canonical shape, so place it in the
         roster before opening its route. That route resolves exclusively from
         this cache; invalidation alone leaves one render where a successful
         creation is announced as an unknown agent. */
      queryClient.setQueryData<InfiniteData<AgentListResponse, string | undefined>>(
        duetQueryKeys.workspaces.agents.list(workspaceSlug),
        current => prependCollectionItem(current, agent),
      )
      queryClient.setQueryData(
        duetQueryKeys.workspaces.agents.lookup(workspaceSlug, { slug: agent.slug }),
        agent,
      )
      void queryClient.invalidateQueries({
        queryKey: duetQueryKeys.workspaces.agents.list(workspaceSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: duetQueryKeys.workspaces.apps.list(workspaceSlug),
      })
      navigate(
        agentsMapUrl(workspaceSlug, {
          kind: 'agent',
          agentSlug: agent.slug,
          card: { kind: 'default' },
        }),
      )
    },
    [navigate, queryClient, workspaceSlug],
  )

  return {
    onAddAgent,
    dialog: { workspaceSlug, takenSlugs, open, onOpenChange: setOpen, onHire, onCreated },
  }
}
