import type { QueryClient } from '@tanstack/react-query'

import type { WhoamiResponse, WorkspaceSummary } from '@repo/contract'

import { duetQueryKeys, isWorkspaceQueryKey } from './query-keys'
import { expireWorkspaceCacheScope } from './workspace-cache-scope'

export async function transitionWorkspaceQueries(
  queryClient: QueryClient,
  previousSlug: string,
  nextSlug: string,
): Promise<void> {
  if (previousSlug === nextSlug) return
  expireWorkspaceCacheScope(previousSlug)
  await queryClient.cancelQueries({
    predicate: query => isWorkspaceQueryKey(query.queryKey, previousSlug),
  })
  queryClient.removeQueries({
    predicate: query => isWorkspaceQueryKey(query.queryKey, previousSlug),
  })
  await queryClient.invalidateQueries({ queryKey: duetQueryKeys.workspaces.scope(nextSlug) })
}

export async function prepareWorkspaceTransition(args: {
  queryClient: QueryClient
  previousSlug: string
  nextSlug: string
  refreshIdentity(): Promise<WhoamiResponse>
}): Promise<WorkspaceSummary | undefined> {
  await transitionWorkspaceQueries(args.queryClient, args.previousSlug, args.nextSlug)
  const identity = await args.refreshIdentity()
  return identity.workspaces.find(workspace => workspace.slug === args.nextSlug)
}
