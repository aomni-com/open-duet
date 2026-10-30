import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import type { AppDomain, AppDomainResponse } from '@repo/contract'

import type { SpaApi } from '../context'
import { duetQueryKeys } from './query-keys'
import { collectionPagesQueryOptions } from './query-options'

function hasPendingDomainWork(domain: AppDomain) {
  return (
    !domain.retryRequired &&
    !domain.operatorRepairRequired &&
    (domain.checking === true || ['pending', 'verifying', 'removing'].includes(domain.status))
  )
}

export function appDomainQueryOptions(
  api: Pick<SpaApi, 'getAppDomain'>,
  workspaceSlug: string,
  appSlug: string,
) {
  return queryOptions({
    queryKey: duetQueryKeys.workspaces.apps.domain(workspaceSlug, appSlug),
    queryFn: ({ signal }) => api.getAppDomain(workspaceSlug, appSlug, signal),
    staleTime: 0,
    retry: false,
    refetchInterval: query =>
      query.state.data?.domain && hasPendingDomainWork(query.state.data.domain) ? 2_000 : false,
  })
}

export function useAppDomain(
  api: Pick<SpaApi, 'getAppDomain'>,
  workspaceSlug: string,
  appSlug: string,
) {
  const queryClient = useQueryClient()
  const query = useQuery(appDomainQueryOptions(api, workspaceSlug, appSlug))
  const domain = query.data?.domain
  const observed =
    domain === undefined
      ? undefined
      : domain === null
        ? 'none'
        : `${domain.id}:${domain.hostname}:${domain.status}`
  const previous = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (observed !== undefined && previous.current !== observed) {
      void invalidateAppDomainProjections(queryClient, workspaceSlug)
    }
    previous.current = observed
  }, [observed, queryClient, workspaceSlug])
  return query
}

function invalidateAppDomainProjections(queryClient: QueryClient, workspaceSlug: string) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: duetQueryKeys.workspaces.apps.all(workspaceSlug),
    }),
    queryClient.invalidateQueries({
      queryKey: duetQueryKeys.workspaces.appDomains(workspaceSlug),
    }),
  ])
}

export function workspaceAppDomainsQueryOptions(
  api: Pick<SpaApi, 'listAppDomains'>,
  workspaceSlug: string,
) {
  return infiniteQueryOptions({
    ...collectionPagesQueryOptions({
      queryKey: duetQueryKeys.workspaces.appDomains(workspaceSlug),
      queryFn: request => api.listAppDomains(workspaceSlug, request),
      retry: false,
    }),
    refetchInterval: query =>
      query.state.data?.pages.some(page => page.items.some(row => hasPendingDomainWork(row.domain)))
        ? 2_000
        : false,
  })
}

// The collection observes provider completion even after its manager closes.
// Refresh address consumers only; invalidating this collection here would loop.
export function useWorkspaceAppDomains(api: Pick<SpaApi, 'listAppDomains'>, workspaceSlug: string) {
  const queryClient = useQueryClient()
  const query = useInfiniteQuery(workspaceAppDomainsQueryOptions(api, workspaceSlug))
  const observed = query.data?.items
    .map(({ domain }) => `${domain.id}:${domain.hostname}:${domain.status}`)
    .join('|')
  const previous = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (observed !== undefined && previous.current !== observed) {
      void queryClient.invalidateQueries({
        queryKey: duetQueryKeys.workspaces.apps.all(workspaceSlug),
      })
    }
    previous.current = observed
  }, [observed, queryClient, workspaceSlug])
  return query
}

// Both the dialog and Settings share this accepted-response/cache boundary.
// No optimistic domain state: admission can refuse, and removal keeps its slot.
export function appDomainMutationOptions(
  queryClient: QueryClient,
  workspaceSlug: string,
  appSlug: string,
) {
  return {
    onSuccess: async (result: AppDomainResponse) => {
      const queryKey = duetQueryKeys.workspaces.apps.domain(workspaceSlug, appSlug)
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData(queryKey, result)
      await invalidateAppDomainProjections(queryClient, workspaceSlug)
    },
  }
}
