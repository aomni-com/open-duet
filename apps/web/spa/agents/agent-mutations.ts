import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query'

import type { Agent, AgentListResponse, WhoamiResponse } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import { mapCollectionItems } from '../api/query-options'
import { useSpa } from '../context'

// The mutations behind the ⋯ menu (D6) have deliberately different cache behavior:
//
// - **Rename is optimistic.** It is display-name only (`UpdateAgentRequest`
//   exposes `name`, never slug or path — the folder does not move), a cheap
//   control-plane patch, so the roster name updates immediately and rolls back
//   if the server rejects it.
// - **Delete is NOT optimistic.** Slice 02 gave agent deletion a fail-closed
//   gateway leg: an unreachable gateway returns 502 and deletes *nothing*. An
//   optimistic patch would pull the card for an agent that still exists with
//   its sessions still running — the one lie this flow must never tell. Delete
//   waits for the server, and only a confirmed success removes the card.

// Patch the cached agent list in place, renaming the one agent by slug. Returns
// the pre-patch list so the caller can roll back on error. Exported so the
// optimistic path is unit-testable without a rendered component.
export function optimisticallyRenameAgent(
  queryClient: QueryClient,
  workspaceSlug: string,
  slug: string,
  name: string,
): AgentCacheSnapshot | undefined {
  const listKey = duetQueryKeys.workspaces.agents.list(workspaceSlug)
  const lookupKey = duetQueryKeys.workspaces.agents.lookup(workspaceSlug, { slug })
  const list =
    queryClient.getQueryData<InfiniteData<AgentListResponse, string | undefined>>(listKey)
  const lookup = queryClient.getQueryData<Agent | null>(lookupKey)
  if (list === undefined && lookup === undefined) return undefined
  queryClient.setQueryData<InfiniteData<AgentListResponse, string | undefined>>(listKey, current =>
    mapCollectionItems(current, items =>
      items.map(agent => (agent.slug === slug ? { ...agent, name } : agent)),
    ),
  )
  queryClient.setQueryData<Agent | null>(lookupKey, current =>
    current === undefined || current === null ? current : { ...current, name },
  )
  return { list, lookup }
}

export type AgentCacheSnapshot = {
  list: InfiniteData<AgentListResponse, string | undefined> | undefined
  lookup: Agent | null | undefined
}

// Restore the snapshot captured by {@link optimisticallyRenameAgent}. A no-op
// when there was nothing cached (the list had not loaded yet).
export function restoreAgentCaches(
  queryClient: QueryClient,
  workspaceSlug: string,
  slug: string,
  previous: AgentCacheSnapshot | undefined,
): void {
  if (previous === undefined) return
  queryClient.setQueryData(duetQueryKeys.workspaces.agents.list(workspaceSlug), previous.list)
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.lookup(workspaceSlug, { slug }),
    previous.lookup,
  )
}

export type RenameAgentInput = { slug: string; name: string }

export function useRenameAgent(workspaceSlug: string) {
  const { api } = useSpa()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ slug, name }: RenameAgentInput) =>
      api.updateAgent(workspaceSlug, slug, { name }),
    onMutate: async ({ slug, name }) => {
      // Stop any in-flight roster refetch from clobbering the optimistic value.
      await queryClient.cancelQueries({
        queryKey: duetQueryKeys.workspaces.agents.list(workspaceSlug),
      })
      return { previous: optimisticallyRenameAgent(queryClient, workspaceSlug, slug, name) }
    },
    onError: (_error, input, context) => {
      restoreAgentCaches(queryClient, workspaceSlug, input.slug, context?.previous)
    },
    // Reconcile with the server's canonical row (name normalization, updatedAt)
    // whether the mutation won or lost.
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: duetQueryKeys.workspaces.agents.all(workspaceSlug),
      })
    },
  })
}

/**
 * Renaming the default agent.
 *
 * Its name lives on the workspace identity, not in the agents list — that list
 * has no row for the drive root at all. Patching the agents cache here would
 * appear to work and then revert on the next roster read, which is the failure
 * mode this separate hook exists to make impossible.
 */
export function useRenameDefaultAgent(workspaceSlug: string) {
  const { api } = useSpa()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.updateDefaultAgent(workspaceSlug, { name }),
    onMutate: async name => {
      await queryClient.cancelQueries({ queryKey: duetQueryKeys.identity })
      const previous = queryClient.getQueryData<WhoamiResponse>(duetQueryKeys.identity)
      queryClient.setQueryData<WhoamiResponse>(duetQueryKeys.identity, current =>
        current === undefined
          ? current
          : {
              ...current,
              workspaces: current.workspaces.map(workspace =>
                workspace.slug === workspaceSlug ? { ...workspace, duetName: name } : workspace,
              ),
            },
      )
      return { previous }
    },
    onError: (_error, _name, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(duetQueryKeys.identity, context.previous)
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: duetQueryKeys.identity })
    },
  })
}

// The caches a confirmed delete must reconcile: the roster and Official Agent
// subscription projections (the agent disappears and an install becomes
// available), plus every session/job list (the deleted agent's work moves to
// history). Not touched until success — a fail-closed 502 leaves them intact.
export function invalidateAfterAgentDelete(queryClient: QueryClient, workspaceSlug: string): void {
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.agents.all(workspaceSlug),
  })
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.agents.marketplace.subscriptions(workspaceSlug),
  })
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.sessions.lists(workspaceSlug),
  })
  /* The agent's apps went with it — teardown mirrors `deleteAppRow` row by
     row — and the home graph draws app nodes from this cache entry. Left
     stale, the map keeps the dead agent's apps on screen until an unrelated
     refetch, and clicking one opens a frame onto a 404. */
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.apps.all(workspaceSlug),
  })
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.train.records.memoryCounts(workspaceSlug),
  })
}

export function useDeleteAgent(workspaceSlug: string) {
  const { api } = useSpa()
  const queryClient = useQueryClient()
  return useMutation({
    // No `onMutate`: delete is fail-closed, so the card is removed only after
    // the server confirms. The error surfaces to the confirmation dialog, which
    // offers a retry; the card and its sessions stay put until success.
    mutationFn: (slug: string) => api.deleteAgent(workspaceSlug, slug),
    onSuccess: () => invalidateAfterAgentDelete(queryClient, workspaceSlug),
  })
}

export function useRedoAgentOnboarding(workspaceSlug: string) {
  const { api } = useSpa()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (slug: string) => api.setAgentOnboarded(workspaceSlug, slug, { onboarded: false }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: duetQueryKeys.workspaces.agents.all(workspaceSlug),
      })
    },
  })
}
