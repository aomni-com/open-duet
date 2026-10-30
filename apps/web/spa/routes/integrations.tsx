'use client'

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'

import type { AddMcpServerRequest, IntegrationConnection, McpServer } from '@repo/contract'

import { DuetApiError } from '../api/client'
import { duetQueryKeys } from '../api/query-keys'
import {
  collectionItems,
  duetQueryOptions,
  isInitialCollectionError,
  mapCollectionItems,
} from '../api/query-options'
import { useSpa, type SpaApi } from '../context'
import {
  IntegrationsSurface,
  type IntegrationReturnNotice,
} from './integrations/integrations-surface'
import { McpServersPanel } from './integrations/mcp-servers-panel'

const SEARCH_DELAY_MS = 300
type IntegrationConnectionsPage = Awaited<ReturnType<SpaApi['listIntegrationConnections']>>
type IntegrationConnectionsData = InfiniteData<IntegrationConnectionsPage, unknown>
type McpServersData = Awaited<ReturnType<SpaApi['listMcpServers']>>

export default function IntegrationsRoute() {
  const { api, activeWorkspaceSlug, clock } = useSpa()
  const workspaceSlug = activeWorkspaceSlug ?? ''
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [catalogSearch, setCatalogSearch] = useState('')
  const [returnNotice, setReturnNotice] = useState<IntegrationReturnNotice>()
  const [pendingAgentPolicies, setPendingAgentPolicies] = useState<Set<string>>(() => new Set())
  const [failedAgentPolicies, setFailedAgentPolicies] = useState<Set<string>>(() => new Set())
  const [pendingMcpPolicies, setPendingMcpPolicies] = useState<Set<string>>(() => new Set())
  const [failedMcpPolicies, setFailedMcpPolicies] = useState<Set<string>>(() => new Set())
  const [pendingAdd, setPendingAdd] = useState<{
    workspaceSlug: string
    name: string
    url: string
  }>()
  const [addError, setAddError] = useState(false)
  const connectionsKey = duetQueryKeys.workspaces.integrations.connections(workspaceSlug)
  const catalogKey = duetQueryKeys.workspaces.integrations.catalog(workspaceSlug)
  const mcpServersKey = duetQueryKeys.workspaces.mcpServers.list(workspaceSlug)

  useEffect(() => {
    const timer = window.setTimeout(() => setCatalogSearch(search.trim()), SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [search])

  const connections = useInfiniteQuery({
    ...duetQueryOptions.workspaces.integrations.connections(api, workspaceSlug),
    enabled: workspaceSlug.length > 0,
  })
  const agents = useInfiniteQuery({
    ...duetQueryOptions.workspaces.agents(api, workspaceSlug),
    enabled: workspaceSlug.length > 0,
  })
  /* Its own query, deliberately not folded into the connections one: these
     servers are the workspace's own and must still list while the provider
     catalog is down. */
  const mcpServers = useQuery({
    ...duetQueryOptions.workspaces.mcpServers.list(api, workspaceSlug),
    enabled: workspaceSlug.length > 0,
  })
  const catalog = useInfiniteQuery({
    ...duetQueryOptions.workspaces.integrations.catalog(api, workspaceSlug, catalogSearch),
    enabled: workspaceSlug.length > 0,
  })
  const catalogItems = useMemo(
    () => catalog.data?.pages.flatMap(page => page.items) ?? [],
    [catalog.data],
  )
  const agentOptions = useMemo(
    () =>
      (agents.data?.items ?? []).map(agent => ({
        id: agent.id,
        name: agent.name?.trim() || agent.slug,
      })),
    [agents.data],
  )
  const visiblePendingAgentPolicies = policySubjectsForWorkspace(
    pendingAgentPolicies,
    workspaceSlug,
  )
  const visibleFailedAgentPolicies = policySubjectsForWorkspace(failedAgentPolicies, workspaceSlug)

  const connect = useMutation({
    mutationFn: async (integration: string) =>
      await api.connectIntegration(workspaceSlug, {
        integration,
        redirectTo: `/w/${workspaceSlug}/integrations`,
      }),
    onSuccess: result => window.location.assign(result.authorizeUrl),
  })
  const disconnect = useMutation({
    mutationFn: async (connection: IntegrationConnection) =>
      await api.disconnectIntegration(workspaceSlug, connection.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: connectionsKey })
      await queryClient.invalidateQueries({ queryKey: catalogKey })
    },
  })
  const setAgentPolicy = useMutation({
    mutationFn: async (variables: ReturnType<typeof integrationAgentPolicyMutation>) =>
      await api.setIntegrationAgentPolicy(
        variables.workspaceSlug,
        variables.integration,
        variables.allowedAgentIds === undefined
          ? {}
          : { allowedAgentIds: variables.allowedAgentIds },
      ),
    onMutate: async variables => {
      setPendingAgentPolicies(current => new Set(current).add(variables.mutationId))
      setFailedAgentPolicies(current => {
        const next = new Set(current)
        next.delete(variables.mutationId)
        return next
      })
      await queryClient.cancelQueries({ queryKey: variables.connectionsKey })
      const previous = applyOptimisticIntegrationAgentPolicy(queryClient, variables)
      return { previous }
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData<IntegrationConnectionsData>(variables.connectionsKey, current =>
        replaceAgentPolicy(current, result.integration, result.allowedAgentIds),
      )
    },
    onError: (_error, variables, context) => {
      const previous = context?.previous
      if (previous !== undefined) {
        queryClient.setQueryData<IntegrationConnectionsData>(variables.connectionsKey, current =>
          replaceConnection(current, previous),
        )
      }
      setFailedAgentPolicies(current => new Set(current).add(variables.mutationId))
    },
    onSettled: (_result, _error, variables) => {
      setPendingAgentPolicies(current => {
        const next = new Set(current)
        next.delete(variables.mutationId)
        return next
      })
    },
  })
  const addServer = useMutation({
    mutationFn: async (input: AddMcpServerRequest) => await api.addMcpServer(workspaceSlug, input),
    onMutate: input => {
      setAddError(false)
      setPendingAdd({ workspaceSlug, name: input.name, url: input.url })
    },
    onSuccess: async () => await queryClient.invalidateQueries({ queryKey: mcpServersKey }),
    onError: () => setAddError(true),
    onSettled: () => setPendingAdd(undefined),
  })
  /* D2's OAuth branch, reached from the row that says it is waiting. The API
     answers a URL rather than redirecting, and this is a TOP-LEVEL navigation
     for the same reason the connected-app connect above it is: a third party's
     consent page is theirs to frame-protect and most refuse framing outright,
     as do Duet's own auth pages. */
  const connectServer = useMutation({
    mutationFn: async (server: McpServer) =>
      await api.connectMcpServer(workspaceSlug, server.name, {
        redirectTo: `/w/${workspaceSlug}/integrations`,
      }),
    onSuccess: result => window.location.assign(result.authorizeUrl),
  })
  const removeServer = useMutation({
    mutationFn: async (server: McpServer) => await api.removeMcpServer(workspaceSlug, server.name),
    onSuccess: async () => await queryClient.invalidateQueries({ queryKey: mcpServersKey }),
  })
  const setMcpAgentPolicy = useMutation({
    mutationFn: async (variables: ReturnType<typeof mcpServerAgentPolicyMutation>) =>
      await api.setMcpServerAgentPolicy(
        variables.workspaceSlug,
        variables.name,
        variables.allowedAgentIds === undefined
          ? {}
          : { allowedAgentIds: variables.allowedAgentIds },
      ),
    onMutate: async variables => {
      setPendingMcpPolicies(current => new Set(current).add(variables.mutationId))
      setFailedMcpPolicies(current => {
        const next = new Set(current)
        next.delete(variables.mutationId)
        return next
      })
      await queryClient.cancelQueries({ queryKey: variables.serversKey })
      const previous = applyOptimisticMcpServerAgentPolicy(queryClient, variables)
      return { previous }
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData<McpServersData>(variables.serversKey, current =>
        replaceMcpAgentPolicy(current, result.name, result.allowedAgentIds),
      )
    },
    onError: (_error, variables, context) => {
      const previous = context?.previous
      if (previous !== undefined) {
        queryClient.setQueryData<McpServersData>(variables.serversKey, current =>
          replaceMcpServer(current, previous),
        )
      }
      setFailedMcpPolicies(current => new Set(current).add(variables.mutationId))
    },
    onSettled: (_result, _error, variables) => {
      setPendingMcpPolicies(current => {
        const next = new Set(current)
        next.delete(variables.mutationId)
        return next
      })
    },
  })
  const providerStatus = searchParams.get('status')
  useEffect(() => {
    if (!providerStatus) return
    setReturnNotice(
      providerStatus === 'success'
        ? { kind: 'success', integration: 'Integration' }
        : providerStatus === 'canceled'
          ? { kind: 'canceled' }
          : { kind: 'error' },
    )
    setSearchParams({}, { replace: true })
    void queryClient.invalidateQueries({
      queryKey: duetQueryKeys.workspaces.integrations.connections(workspaceSlug),
    })
    void queryClient.invalidateQueries({
      queryKey: duetQueryKeys.workspaces.integrations.catalog(workspaceSlug),
    })
  }, [providerStatus, queryClient, setSearchParams, workspaceSlug])

  return (
    <IntegrationsSurface
      state={
        connections.isPending || catalog.isPending || agents.isPending
          ? 'loading'
          : isInitialCollectionError(connections) ||
              isInitialCollectionError(catalog) ||
              isInitialCollectionError(agents)
            ? 'error'
            : 'ready'
      }
      connections={connections.data?.items ?? []}
      connectionsHasMore={connections.hasNextPage || connections.isFetchNextPageError}
      connectionsPageFailed={connections.isFetchNextPageError}
      connectionsLoadingMore={connections.isFetchingNextPage}
      agents={agentOptions}
      catalog={catalogItems}
      mcpServersPanel={
        <McpServersPanel
          state={
            mcpServers.isPending
              ? 'loading'
              : mcpServers.isLoadingError || mcpServers.data === undefined
                ? 'error'
                : 'ready'
          }
          refreshFailed={mcpServers.isRefetchError}
          servers={mcpServers.data?.items ?? []}
          agents={agentOptions}
          now={clock?.() ?? Date.now()}
          pendingAdd={
            pendingAdd?.workspaceSlug === workspaceSlug
              ? { name: pendingAdd.name, url: pendingAdd.url }
              : undefined
          }
          addError={addError}
          removing={removeServer.isPending ? removeServer.variables?.name : undefined}
          connecting={connectServer.isPending ? connectServer.variables?.name : undefined}
          connectError={
            connectServer.isError && connectServer.variables !== undefined
              ? {
                  name: connectServer.variables.name,
                  ...(connectServer.error instanceof DuetApiError
                    ? { code: connectServer.error.code }
                    : {}),
                }
              : undefined
          }
          pendingAgentPolicies={policySubjectsForWorkspace(pendingMcpPolicies, workspaceSlug)}
          failedAgentPolicies={policySubjectsForWorkspace(failedMcpPolicies, workspaceSlug)}
          onProbe={(input, signal) => api.probeMcpServer(workspaceSlug, input, signal)}
          onAdd={input => addServer.mutate(input)}
          onConnect={server => connectServer.mutate(server)}
          onRemove={server => removeServer.mutate(server)}
          onSetAgentPolicy={(server, allowedAgentIds) => {
            const mutation = mcpServerAgentPolicyMutation(
              workspaceSlug,
              server.name,
              allowedAgentIds,
            )
            if (pendingMcpPolicies.has(mutation.mutationId)) return
            setMcpAgentPolicy.mutate(mutation)
          }}
          onRetry={() => void mcpServers.refetch()}
        />
      }
      search={search}
      hasMore={catalog.hasNextPage}
      catalogPageFailed={catalog.isFetchNextPageError}
      refreshing={
        connections.isFetching || catalog.isFetching || agents.isFetching || mcpServers.isFetching
      }
      refreshFailed={
        (connections.isRefetchError && !connections.isFetchNextPageError) ||
        (catalog.isRefetchError && !catalog.isFetchNextPageError) ||
        (agents.isRefetchError && !agents.isFetchNextPageError)
      }
      loadingMore={catalog.isFetchingNextPage}
      connecting={connect.isPending ? connect.variables : undefined}
      disconnecting={disconnect.isPending ? disconnect.variables?.id : undefined}
      pendingAgentPolicies={visiblePendingAgentPolicies}
      failedAgentPolicies={visibleFailedAgentPolicies}
      returnNotice={returnNotice}
      mutationError={connect.isError || disconnect.isError}
      onSearch={setSearch}
      onRetry={() => {
        void connections.refetch()
        void catalog.refetch()
        void agents.refetch()
      }}
      onRefresh={() => {
        void connections.refetch()
        void catalog.refetch()
        void agents.refetch()
        void mcpServers.refetch()
      }}
      onLoadMore={() => void catalog.fetchNextPage()}
      onLoadMoreConnections={() => void connections.fetchNextPage()}
      onConnect={integration => connect.mutate(integration)}
      onDisconnect={connection => disconnect.mutate(connection)}
      onSetAgentPolicy={(connection, allowedAgentIds) => {
        const mutation = integrationAgentPolicyMutation(
          workspaceSlug,
          connection.integration,
          allowedAgentIds,
        )
        if (pendingAgentPolicies.has(mutation.mutationId)) return
        setAgentPolicy.mutate(mutation)
      }}
      onDismissNotice={() => {
        setReturnNotice(undefined)
        setSearchParams({}, { replace: true })
      }}
    />
  )
}

export function integrationAgentPolicyMutation(
  workspaceSlug: string,
  integration: string,
  allowedAgentIds: string[] | undefined,
) {
  return {
    workspaceSlug,
    connectionsKey: duetQueryKeys.workspaces.integrations.connections(workspaceSlug),
    mutationId: `${workspaceSlug}\u0000${integration}`,
    integration,
    allowedAgentIds,
  }
}

export function applyOptimisticIntegrationAgentPolicy(
  queryClient: QueryClient,
  variables: ReturnType<typeof integrationAgentPolicyMutation>,
): IntegrationConnection | undefined {
  const previous = queryClient.getQueryData<IntegrationConnectionsData>(variables.connectionsKey)
  const previousConnection = collectionItems(previous).find(
    connection => connection.integration === variables.integration,
  )
  queryClient.setQueryData<IntegrationConnectionsData>(variables.connectionsKey, current =>
    replaceAgentPolicy(current, variables.integration, variables.allowedAgentIds),
  )
  return previousConnection
}

export function mcpServerAgentPolicyMutation(
  workspaceSlug: string,
  name: string,
  allowedAgentIds: string[] | undefined,
) {
  return {
    workspaceSlug,
    serversKey: duetQueryKeys.workspaces.mcpServers.list(workspaceSlug),
    mutationId: `${workspaceSlug}\u0000${name}`,
    name,
    allowedAgentIds,
  }
}

export function applyOptimisticMcpServerAgentPolicy(
  queryClient: QueryClient,
  variables: ReturnType<typeof mcpServerAgentPolicyMutation>,
): McpServer | undefined {
  const previous = queryClient
    .getQueryData<McpServersData>(variables.serversKey)
    ?.items.find(server => server.name === variables.name)
  queryClient.setQueryData<McpServersData>(variables.serversKey, current =>
    replaceMcpAgentPolicy(current, variables.name, variables.allowedAgentIds),
  )
  return previous
}

function policySubjectsForWorkspace(mutationIds: Set<string>, workspaceSlug: string): Set<string> {
  const prefix = `${workspaceSlug}\u0000`
  return new Set(
    [...mutationIds]
      .filter(mutationId => mutationId.startsWith(prefix))
      .map(mutationId => mutationId.slice(prefix.length)),
  )
}

/* Absent and empty are different answers — every agent versus none — so the
   field is deleted rather than written as `[]` when the policy is cleared. */
function withAgentPolicy<T extends { allowedAgentIds?: string[] }>(
  item: T,
  allowedAgentIds: string[] | undefined,
): T {
  const next = { ...item }
  delete next.allowedAgentIds
  if (allowedAgentIds !== undefined) next.allowedAgentIds = allowedAgentIds
  return next
}

function replaceAgentPolicy(
  data: IntegrationConnectionsData | undefined,
  integration: string,
  allowedAgentIds: string[] | undefined,
) {
  return mapCollectionItems(data, items =>
    items.map(connection =>
      connection.integration === integration
        ? withAgentPolicy(connection, allowedAgentIds)
        : connection,
    ),
  )
}

function replaceMcpAgentPolicy(
  data: McpServersData | undefined,
  name: string,
  allowedAgentIds: string[] | undefined,
) {
  if (data === undefined) return data
  return {
    ...data,
    items: data.items.map(server =>
      server.name === name ? withAgentPolicy(server, allowedAgentIds) : server,
    ),
  }
}

function replaceMcpServer(data: McpServersData | undefined, previous: McpServer) {
  if (data === undefined) return data
  return {
    ...data,
    items: data.items.map(server => (server.name === previous.name ? previous : server)),
  }
}

function replaceConnection(
  data: IntegrationConnectionsData | undefined,
  previous: IntegrationConnection,
) {
  return mapCollectionItems(data, items =>
    items.map(connection =>
      connection.integration === previous.integration ? previous : connection,
    ),
  )
}
