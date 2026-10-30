import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query'

import type {
  AppListResponse,
  ConnectedProviderId,
  ConnectPollResponse,
  MarketplaceAgentInstallRequest,
  UsageReportPeriod,
  WorkspaceMember,
} from '@repo/contract'
import { COLLECTION_PAGE_MAX_LIMIT, type CollectionPage } from '@repo/contract'

import type { SpaApi } from '../context'
import { billingOverviewQueryBehavior } from '../entitlements/billing-overview-query'
import { duetMutationKeys, duetQueryKeys, type MarketplaceCatalogKeyFilters } from './query-keys'
import type { TrainScope } from './train-scope'

const WORKSPACE_SKILLS_STALE_MS = 5 * 60_000
export const WORKSPACE_MEMBER_SEARCH_PAGE_SIZE = 20
type AppLookupFilter = { id: string } | { cwd: string }
type AgentLookupFilter = { id: string } | { slug: string }

export type LoadedCollectionPages<Item, Meta = never> = InfiniteData<
  CollectionPage<Item, Meta>,
  string | undefined
> &
  CollectionPage<Item, Meta>

export function flattenCollectionPages<Item, Meta>(
  data: InfiniteData<CollectionPage<Item, Meta>, string | undefined>,
): LoadedCollectionPages<Item, Meta> {
  const first = data.pages[0]
  const last = data.pages.at(-1)
  if (first === undefined || last === undefined) throw new Error('A collection query has no page')
  return {
    ...data,
    ...first,
    items: data.pages.flatMap(page => page.items),
    nextCursor: last.nextCursor,
  }
}

export function collectionItems<Item>(data: InfiniteData<{ items: Item[] }> | undefined): Item[] {
  return data?.pages.flatMap(page => page.items) ?? []
}

export function mapCollectionItems<Page extends { items: unknown[] }, PageParam>(
  data: InfiniteData<Page, PageParam> | undefined,
  update: (items: Page['items']) => Page['items'],
): InfiniteData<Page, PageParam> | undefined {
  if (data === undefined) return undefined
  return {
    ...data,
    pages: data.pages.map(page => ({ ...page, items: update(page.items) })),
  }
}

export function prependCollectionItem<Item, Meta, PageParam>(
  data: InfiniteData<CollectionPage<Item, Meta>, PageParam> | undefined,
  item: Item,
): InfiniteData<CollectionPage<Item, Meta>, PageParam | undefined> {
  if (data === undefined)
    return {
      pages: [{ items: [item], nextCursor: null }],
      pageParams: [undefined],
    }
  return {
    ...data,
    pages: data.pages.map((page, index) =>
      index === 0 ? { ...page, items: [item, ...page.items] } : page,
    ),
  }
}

/** A query is unavailable only when its first usable payload never loaded.
 * TanStack keeps `isError` true for a failed background refetch even while
 * retaining cached data; `isLoadingError` is the narrower state callers mean.
 */
export function isInitialQueryError(result: { isLoadingError: boolean }): boolean {
  return result.isLoadingError
}

export const isInitialCollectionError = isInitialQueryError

export function collectionPagesQueryOptions<
  Item,
  Meta = never,
  const TQueryKey extends QueryKey = QueryKey,
>({
  queryKey,
  queryFn,
  retry,
  staleTime,
}: {
  queryKey: TQueryKey
  queryFn: (request: {
    cursor?: string
    limit: number
    signal: AbortSignal
  }) => Promise<CollectionPage<Item, Meta>>
  retry?: false
  staleTime?: number
}) {
  return infiniteQueryOptions({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      queryFn({
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
        limit: COLLECTION_PAGE_MAX_LIMIT,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    select: flattenCollectionPages,
    retry,
    staleTime,
  })
}

export function invalidateAfterPauseMutation(
  queryClient: QueryClient,
  workspaceSlug: string,
  resource: 'publish' | 'share',
): void {
  void queryClient.invalidateQueries({
    queryKey:
      resource === 'publish'
        ? duetQueryKeys.workspaces.publishes(workspaceSlug)
        : duetQueryKeys.workspaces.shares(workspaceSlug),
  })
}

export function invalidateAfterConnectedProviderMutation(
  queryClient: QueryClient,
  workspaceSlug: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.connectedProviders.list(workspaceSlug),
  })
}

/**
 * Stripe credits the wallet from a webhook that lands after the redirect, so
 * everything the payer's money moves is stale the moment checkout hands the
 * browser back — the wallet itself, the receipt list, and the workspaces the
 * identity carries a servicing verdict for.
 */
export function invalidateAfterCheckoutReturn(queryClient: QueryClient): void {
  for (const queryKey of [
    duetQueryKeys.user.billing.overview,
    duetQueryKeys.user.billing.history,
    duetQueryKeys.identity,
  ]) {
    void queryClient.invalidateQueries({ queryKey })
  }
}

export function connectedProviderPollInterval(
  data: ConnectPollResponse | undefined,
  intervalMs: number,
): number | false {
  return data?.status === 'pending' || data?.status === 'awaiting_code' ? intervalMs : false
}

export function integrationConnectionsPollInterval(
  data: Awaited<ReturnType<SpaApi['listIntegrationConnections']>> | undefined,
  intervalMs: number,
): number | false {
  return data?.items.some(connection => connection.status === 'pending') === true
    ? intervalMs
    : false
}

export async function invalidateAfterMarketplaceAgentMutation(
  queryClient: QueryClient,
  workspaceSlug: string,
  kind: 'install' | 'acknowledge' | 'uninstall',
): Promise<void> {
  const invalidations = [
    queryClient.invalidateQueries({
      queryKey: duetQueryKeys.workspaces.agents.marketplace.subscriptions(workspaceSlug),
    }),
  ]
  if (kind === 'install') {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: duetQueryKeys.workspaces.agents.list(workspaceSlug),
      }),
      queryClient.invalidateQueries({
        queryKey: duetQueryKeys.workspaces.train.records.memoryCounts(workspaceSlug),
      }),
    )
  }
  await Promise.all(invalidations)
}

export function invalidateAfterTrainCompletion(
  queryClient: QueryClient,
  workspaceSlug: string,
  scope: TrainScope,
): void {
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.train.records.list(workspaceSlug, scope),
  })
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.train.uploads(workspaceSlug, scope),
  })
  void queryClient.invalidateQueries({
    queryKey: duetQueryKeys.workspaces.train.records.memoryCounts(workspaceSlug),
  })
}

/* ------------------------------------------------- watching the whole drive

   One request, at two rates, and the question it turns on is whether anything
   on screen is actually reading it.

   It used to turn on whether an agent was *unfolded*, and that meant the same
   thing for as long as the roster only ever stood beside the canvas: inside an
   agent the drive-wide activity was behind the open surface, and coming back
   out refetched immediately. The roster is the agents section's own furniture
   now — it stands beside an agent too, carrying live job dots and a preview of
   the conversation on the next screen — so "unfolded" stopped meaning "nobody
   is looking". At the slow rate that row lagged the chat beside it by a minute.

   Two producers, each a route's own fact rather than a state anything holds:
   the graph is always live (the canvas draws its own dots regardless of the
   roster), and an agent is live exactly while its roster is out.

   Never `false`. An app that has finished starting will never start again, so
   `appsPollInterval` below can switch itself off; a drive that went quiet is
   precisely the drive whose next event is somebody else beginning something,
   and a poll that stopped would never see it.

   It lives here rather than beside the ring's invalidation edges because this
   is the poll-rule module, and because the alternative was this file importing
   backwards out of a module whose subject is what to re-ask when a reader
   crosses a boundary — a different question from how often to ask at all. */
export const ACTIVE_POLL_MS = 10_000
export const QUIET_POLL_MS = 60_000

export function activityPollInterval({ liveActivity }: { liveActivity: boolean }): number {
  return liveActivity ? ACTIVE_POLL_MS : QUIET_POLL_MS
}

// An app that is still starting on the VM has no page to frame yet, and nothing
// pushes its arrival to the browser. Poll only while at least one app is in
// that transient state, then stop.
export const APPS_STARTING_POLL_MS = 5_000

export function appsPollInterval(
  data: AppListResponse | undefined,
  awaitingExpectedApp = false,
): number | false {
  return awaitingExpectedApp ||
    data?.items.some(app => app.runtimeStatus === 'reconciling') === true
    ? APPS_STARTING_POLL_MS
    : false
}

export function workspaceAppsQueryOptions(
  workspaceSlug: string,
  queryFn: (request: {
    cursor?: string
    limit: number
    signal: AbortSignal
  }) => Promise<AppListResponse>,
) {
  return infiniteQueryOptions({
    queryKey: duetQueryKeys.workspaces.apps.list(workspaceSlug),
    queryFn: ({ pageParam, signal }) =>
      queryFn({
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
        limit: COLLECTION_PAGE_MAX_LIMIT,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    select: flattenCollectionPages,
    refetchInterval: query =>
      query.state.data?.pages.some(page => appsPollInterval(page) !== false) === true
        ? APPS_STARTING_POLL_MS
        : false,
  })
}

export function workspaceSubtreeAppsQueryOptions(
  workspaceSlug: string,
  path: string,
  queryFn: (request: {
    cursor?: string
    limit: number
    signal: AbortSignal
  }) => Promise<AppListResponse>,
) {
  return collectionPagesQueryOptions({
    queryKey: duetQueryKeys.workspaces.apps.subtree(workspaceSlug, path),
    queryFn,
  })
}

export function workspaceMembersQueryOptions(
  workspaceSlug: string,
  queryFn: (
    signal: AbortSignal,
    limit: number,
  ) => Promise<{ items: WorkspaceMember[]; nextCursor: string | null }>,
) {
  return queryOptions({
    queryKey: duetQueryKeys.workspaces.members(workspaceSlug),
    queryFn: ({ signal }) => queryFn(signal, COLLECTION_PAGE_MAX_LIMIT),
  })
}

type AdminQueryApi = Pick<
  SpaApi,
  | 'internalAdminSearch'
  | 'internalAdminUserCleanupPreview'
  | 'internalAdminCleanupStatus'
  | 'internalAdminWorkspace'
  | 'internalAdminVmStatus'
  | 'internalAdminFiles'
  | 'internalAdminFile'
  | 'internalAdminLogs'
  | 'internalAdminFeedback'
  | 'internalAdminFreeCredits'
  | 'internalAdminVmUpdates'
  | 'internalAdminFleetHealth'
  | 'internalAdminInferenceMargin'
  | 'internalAdminModelRouterPolicy'
>

export const duetQueryOptions = {
  identity: (api: SpaApi) =>
    queryOptions({
      queryKey: duetQueryKeys.identity,
      queryFn: ({ signal }) => api.whoami(signal),
    }),
  user: {
    invitations: (api: SpaApi) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.user.invitations,
        queryFn: request => api.listIncomingInvitations(request),
        staleTime: 0,
      }),
    profile: (api: SpaApi) =>
      queryOptions({
        queryKey: duetQueryKeys.user.profile,
        queryFn: ({ signal }) => api.userProfile(signal),
      }),
    billingOverview: (api: SpaApi, pollMs: number | false) =>
      queryOptions({
        queryKey: duetQueryKeys.user.billing.overview,
        ...billingOverviewQueryBehavior(api, pollMs),
      }),
    billingHistory: (api: SpaApi) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.user.billing.history,
        queryFn: request => api.billingHistory(request),
      }),
    apiKeys: (api: SpaApi) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.user.apiKeys,
        queryFn: request => api.listUserApiKeys(request),
      }),
    oauthGrants: (api: SpaApi) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.user.oauthGrants,
        queryFn: request => api.listOAuthGrants(request),
      }),
    syncMachines: (api: SpaApi) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.user.syncMachines,
        queryFn: request => api.listSyncMachines(request),
      }),
    shareRequests: (api: SpaApi) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.user.shareRequests,
        queryFn: request => api.listShareRequests(request),
      }),
    pendingShareLanding: (api: SpaApi) =>
      queryOptions({
        queryKey: duetQueryKeys.user.pendingShareLanding,
        queryFn: ({ signal }) => api.consumePendingShare(signal),
        staleTime: Number.POSITIVE_INFINITY,
      }),
  },
  agents: {
    marketplace: {
      catalog: (api: SpaApi, filters: MarketplaceCatalogKeyFilters = {}) =>
        collectionPagesQueryOptions({
          queryKey: duetQueryKeys.agents.marketplace.catalog(filters),
          queryFn: request => api.listMarketplaceCatalog({ ...request, ...filters }),
        }),
      // Keyed by publisher AND agent: a bare name is not unique across
      // publishers, so caching on it would collide two different listings.
      detail: (api: SpaApi, publisherSlug: string, agentName: string) =>
        queryOptions({
          queryKey: duetQueryKeys.agents.marketplace.detail(publisherSlug, agentName),
          queryFn: ({ signal }) =>
            api.getMarketplaceListingDetail(publisherSlug, agentName, signal),
        }),
    },
  },
  workspaces: {
    apps: (api: SpaApi, workspaceSlug: string) =>
      workspaceAppsQueryOptions(workspaceSlug, request => api.listApps(workspaceSlug, request)),
    app: (api: Pick<SpaApi, 'getApp'>, workspaceSlug: string, appSlug: string) =>
      queryOptions({
        queryKey: duetQueryKeys.workspaces.apps.app(workspaceSlug, appSlug),
        queryFn: ({ signal }) => api.getApp(workspaceSlug, appSlug, signal),
      }),
    appLookup: (api: Pick<SpaApi, 'listApps'>, workspaceSlug: string, filter: AppLookupFilter) =>
      queryOptions({
        queryKey: duetQueryKeys.workspaces.apps.lookup(workspaceSlug, filter),
        queryFn: ({ signal }) => api.listApps(workspaceSlug, { ...filter, limit: 1, signal }),
      }),
    // One shared infinite owner for the workspace roster. Later pages advance
    // only through an explicit continuation control; a background drain would
    // hide both its cost and a failed continuation.
    agents: (api: Pick<SpaApi, 'listAgents'>, workspaceSlug: string) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.workspaces.agents.list(workspaceSlug),
        queryFn: request => api.listAgents(workspaceSlug, request),
        retry: false,
      }),
    agentLookup: (
      api: Pick<SpaApi, 'listAgents'>,
      workspaceSlug: string,
      filter: AgentLookupFilter,
    ) =>
      queryOptions({
        queryKey: duetQueryKeys.workspaces.agents.lookup(workspaceSlug, filter),
        queryFn: async ({ signal }) =>
          (await api.listAgents(workspaceSlug, { ...filter, limit: 1, signal })).items[0] ?? null,
      }),
    /* The ring's work *and* each owner's own conversation, in one read — and
       the only read on this surface that polls.

       A single request for the whole drive, and the only thing that can notice
       a job finishing, or a chat going unread, while the reader sits on the
       ring and watches. So it ticks; see `activityPollInterval` for the two
       rates. Everything the faces draw is downstream of this one answer, which
       is what lets the surface have exactly one clock. */
    sessionActivity: (
      api: Pick<SpaApi, 'listSessionActivity'>,
      workspaceSlug: string,
      liveActivity = true,
    ) =>
      queryOptions({
        queryKey: duetQueryKeys.workspaces.sessions.activity(workspaceSlug),
        queryFn: ({ signal }) => api.listSessionActivity(workspaceSlug, signal),
        /* Foreground only — `refetchIntervalInBackground` stays off. A tab
           behind three windows is nobody watching, and the dot it would keep
           warm is for a reader who is not there. */
        refetchInterval: () => activityPollInterval({ liveActivity }),
      }),
    agentSubscriptions: (api: SpaApi, workspaceSlug: string) =>
      queryOptions({
        queryKey: duetQueryKeys.workspaces.agents.marketplace.subscriptions(workspaceSlug),
        queryFn: ({ signal }) => api.listMarketplaceAgentSubscriptions(workspaceSlug, { signal }),
      }),
    members: (api: SpaApi, workspaceSlug: string) =>
      workspaceMembersQueryOptions(workspaceSlug, (signal, limit) =>
        api.listWorkspaceMembers(workspaceSlug, { limit, signal }),
      ),
    memberSearch: (api: SpaApi, workspaceSlug: string, search: string) =>
      infiniteQueryOptions({
        queryKey: duetQueryKeys.workspaces.memberSearch(workspaceSlug, search),
        queryFn: ({ pageParam, signal }) =>
          api.listWorkspaceMembers(workspaceSlug, {
            limit: WORKSPACE_MEMBER_SEARCH_PAGE_SIZE,
            ...(search === '' ? {} : { search }),
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
            signal,
          }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: page => page.nextCursor ?? undefined,
        // The picker owns visible initial/continuation recovery. An automatic
        // retry would collapse those named states into an invisible delay.
        retry: false,
      }),
    invites: (api: SpaApi, workspaceSlug: string) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.workspaces.invites(workspaceSlug),
        queryFn: request => api.listWorkspaceInvites(workspaceSlug, request),
      }),
    shares: (api: SpaApi, workspaceSlug: string) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.workspaces.shares(workspaceSlug),
        queryFn: request => api.listShares(workspaceSlug, request),
      }),
    publishes: (api: SpaApi, workspaceSlug: string) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.workspaces.publishes(workspaceSlug),
        queryFn: request => api.listPublishes(workspaceSlug, request),
      }),
    shareFolder: (api: SpaApi, workspaceSlug: string, path: string) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.workspaces.shareFolder(workspaceSlug, path),
        queryFn: request => api.listWorkspaceFiles(workspaceSlug, path, request),
        retry: false,
      }),
    usage: (
      api: SpaApi,
      workspaceSlug: string,
      period: UsageReportPeriod = 'monthly',
      currentOnly = period === 'monthly',
    ) =>
      queryOptions({
        queryKey: duetQueryKeys.workspaces.usage(workspaceSlug, period, currentOnly),
        queryFn: ({ signal }) => api.workspaceUsage(workspaceSlug, { period, currentOnly, signal }),
      }),
    telemetry: (api: SpaApi, workspaceSlug: string) =>
      queryOptions({
        queryKey: duetQueryKeys.workspaces.telemetry(workspaceSlug),
        queryFn: ({ signal }) => api.workspaceTelemetry(workspaceSlug, undefined, signal),
      }),
    ledger: (api: SpaApi, workspaceSlug: string) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.workspaces.ledger(workspaceSlug),
        queryFn: request => api.workspaceLedger(workspaceSlug, request),
      }),
    audit: (api: SpaApi, workspaceSlug: string) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.workspaces.audit(workspaceSlug),
        queryFn: request => api.listWorkspaceAudit(workspaceSlug, request),
        retry: false,
      }),
    train: {
      memoryCounts: (api: SpaApi, workspaceSlug: string) =>
        queryOptions({
          queryKey: duetQueryKeys.workspaces.train.records.memoryCounts(workspaceSlug),
          queryFn: ({ signal }) => api.listTrainMemoryCounts(workspaceSlug, signal),
        }),
      jobs: (api: SpaApi, workspaceSlug: string, scope: TrainScope) =>
        queryOptions({
          queryKey: duetQueryKeys.workspaces.train.jobs(workspaceSlug, scope),
          queryFn: ({ signal }) => api.listTrainJobs(workspaceSlug, scope, {}, signal),
        }),
      jobPages: (api: SpaApi, workspaceSlug: string, scope: TrainScope) =>
        infiniteQueryOptions({
          queryKey: duetQueryKeys.workspaces.train.jobPages(workspaceSlug, scope),
          queryFn: ({ pageParam, signal }) =>
            api.listTrainJobs(
              workspaceSlug,
              scope,
              pageParam === undefined ? {} : { cursor: pageParam },
              signal,
            ),
          initialPageParam: undefined as string | undefined,
          getNextPageParam: page => page.nextCursor ?? undefined,
        }),
      recordList: (api: SpaApi, workspaceSlug: string, scope: TrainScope) =>
        collectionPagesQueryOptions({
          queryKey: duetQueryKeys.workspaces.train.records.list(workspaceSlug, scope),
          queryFn: ({ cursor, limit, signal }) =>
            api.listTrainRecords(
              workspaceSlug,
              scope,
              { ...(cursor === undefined ? {} : { cursor }), limit },
              signal,
            ),
        }),
      record: (api: SpaApi, workspaceSlug: string, scope: TrainScope, recordSlug: string) =>
        queryOptions({
          queryKey: duetQueryKeys.workspaces.train.records.detail(workspaceSlug, scope, recordSlug),
          queryFn: ({ signal }) => api.getTrainRecord(workspaceSlug, recordSlug, scope, signal),
        }),
    },
    integrations: {
      connections: (api: SpaApi, workspaceSlug: string) =>
        infiniteQueryOptions({
          queryKey: duetQueryKeys.workspaces.integrations.connections(workspaceSlug),
          queryFn: ({ pageParam, signal }) =>
            api.listIntegrationConnections(workspaceSlug, {
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              limit: COLLECTION_PAGE_MAX_LIMIT,
              signal,
            }),
          initialPageParam: undefined as string | undefined,
          getNextPageParam: page => page.nextCursor ?? undefined,
          select: flattenCollectionPages,
          refetchInterval: query =>
            query.state.data?.pages.some(
              page => integrationConnectionsPollInterval(page, 5_000) !== false,
            ) === true
              ? 5_000
              : false,
        }),
      catalog: (api: SpaApi, workspaceSlug: string, search: string) =>
        infiniteQueryOptions({
          queryKey: duetQueryKeys.workspaces.integrations.catalogSearch(workspaceSlug, search),
          queryFn: ({ pageParam, signal }) =>
            api.listIntegrationCatalog(
              workspaceSlug,
              {
                ...(search ? { q: search } : {}),
                ...(pageParam ? { cursor: pageParam } : {}),
              },
              signal,
            ),
          initialPageParam: undefined as string | undefined,
          getNextPageParam: page => page.nextCursor ?? undefined,
        }),
    },
    mcpServers: {
      list: (api: SpaApi, workspaceSlug: string) =>
        queryOptions({
          queryKey: duetQueryKeys.workspaces.mcpServers.list(workspaceSlug),
          queryFn: ({ signal }) => api.listMcpServers(workspaceSlug, { signal }),
        }),
    },
    connectedProviders: {
      list: (api: SpaApi, workspaceSlug: string) =>
        queryOptions({
          queryKey: duetQueryKeys.workspaces.connectedProviders.list(workspaceSlug),
          queryFn: ({ signal }) => api.listConnectedProviders(workspaceSlug, signal),
        }),
      poll: (
        api: Pick<SpaApi, 'pollConnectedProvider'>,
        workspaceSlug: string,
        sessionId: string,
        intervalMs: number,
      ) =>
        queryOptions({
          queryKey: duetQueryKeys.workspaces.connectedProviders.connectPoll(
            workspaceSlug,
            sessionId,
          ),
          queryFn: ({ signal }) => api.pollConnectedProvider(workspaceSlug, sessionId, signal),
          refetchInterval: query => connectedProviderPollInterval(query.state.data, intervalMs),
          refetchIntervalInBackground: true,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
        }),
    },
    // Fetched on composer mount and held across a browsing session: asking
    // costs a full agent-runtime spawn on the VM, and the key is the folder, so
    // every composer pointed at one agent shares a single entry. Opening the
    // picker refetches, which is what keeps a freshly installed skill findable
    // without paying for that spawn on every conversation opened.
    skills: (api: Pick<SpaApi, 'listWorkspaceSkills'>, workspaceSlug: string, cwd?: string) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.workspaces.skills(workspaceSlug, cwd),
        queryFn: options => api.listWorkspaceSkills(workspaceSlug, cwd, options),
        staleTime: WORKSPACE_SKILLS_STALE_MS,
        retry: false,
      }),
    // Same policy as skills, for the same reason: prefetched on composer mount
    // so `@` opens instantly, refetched when the picker opens so a colleague
    // registered a minute ago is there. `retry: false` is what keeps a failed
    // read a state the picker can show rather than a flicker.
    agentRoster: (api: Pick<SpaApi, 'readAgentRoster'>, workspaceSlug: string, agentSlug: string) =>
      collectionPagesQueryOptions({
        queryKey: duetQueryKeys.workspaces.agents.roster(workspaceSlug, agentSlug),
        queryFn: request => api.readAgentRoster(workspaceSlug, agentSlug, request),
        staleTime: WORKSPACE_SKILLS_STALE_MS,
        retry: false,
      }),
  },
  admin: {
    search: (api: AdminQueryApi, search: string) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.search(search),
        queryFn: ({ signal }) => api.internalAdminSearch(search, signal),
      }),
    userCleanupPreview: (api: AdminQueryApi, search: string) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.userCleanupPreview(search),
        queryFn: ({ signal }) => api.internalAdminUserCleanupPreview(search, signal),
        retry: false,
      }),
    userCleanup: (api: AdminQueryApi, operationId: string) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.userCleanup(operationId),
        queryFn: ({ signal }) => api.internalAdminCleanupStatus(operationId, signal),
        refetchInterval: query =>
          query.state.data?.status === 'scheduled' || query.state.data?.status === 'running'
            ? 2000
            : false,
        retry: false,
      }),
    workspace: (api: AdminQueryApi, workspaceId: string) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.workspace(workspaceId),
        queryFn: ({ signal }) => api.internalAdminWorkspace(workspaceId, undefined, signal),
      }),
    vm: (api: AdminQueryApi, workspaceId: string) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.vm(workspaceId),
        queryFn: ({ signal }) => api.internalAdminVmStatus(workspaceId, signal),
      }),
    files: (api: AdminQueryApi, workspaceId: string, path: string) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.files(workspaceId, path),
        queryFn: ({ signal }) => api.internalAdminFiles(workspaceId, path, signal),
      }),
    file: (api: AdminQueryApi, workspaceId: string, path: string | undefined) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.file(workspaceId, path),
        queryFn: ({ signal }) =>
          api.internalAdminFile(workspaceId, requireValue(path, 'A file must be selected'), signal),
      }),
    logs: (
      api: AdminQueryApi,
      workspaceId: string,
      source: 'gateway' | 'agent',
      anchorId?: string,
    ) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.logs(workspaceId, source, anchorId),
        queryFn: ({ signal }) => api.internalAdminLogs(workspaceId, source, anchorId, signal),
      }),
    feedback: (api: AdminQueryApi, archived: boolean) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.feedback(archived),
        queryFn: ({ signal }) => api.internalAdminFeedback(archived, signal),
      }),
    freeCredits: (api: AdminQueryApi) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.freeCredits,
        queryFn: ({ signal }) => api.internalAdminFreeCredits(signal),
      }),
    vmUpdates: (api: AdminQueryApi) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.vmUpdates,
        queryFn: ({ signal }) => api.internalAdminVmUpdates(signal),
      }),
    fleetHealth: (api: AdminQueryApi) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.fleetHealth,
        queryFn: ({ signal }) => api.internalAdminFleetHealth(signal),
      }),
    inferenceMargin: (
      api: AdminQueryApi,
      granularity: UsageReportPeriod,
      through: number | undefined,
    ) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.inferenceMargin(granularity, through),
        queryFn: ({ signal }) => api.internalAdminInferenceMargin(granularity, through, signal),
      }),
    modelRouterPolicy: (api: AdminQueryApi) =>
      queryOptions({
        queryKey: duetQueryKeys.admin.modelRouterPolicy,
        queryFn: ({ signal }) => api.internalAdminModelRouterPolicy(signal),
      }),
  },
}

export const duetMutationOptions = {
  workspaces: {
    connectedProviders: {
      connect: (
        api: Pick<SpaApi, 'connectConnectedProvider'>,
        queryClient: QueryClient,
        workspaceSlug: string,
      ) =>
        mutationOptions({
          mutationKey: duetMutationKeys.workspaces.connectedProviders(workspaceSlug, 'connect'),
          mutationFn: (provider: ConnectedProviderId) =>
            api.connectConnectedProvider(workspaceSlug, provider),
          onSuccess: () => invalidateAfterConnectedProviderMutation(queryClient, workspaceSlug),
        }),
      disconnect: (
        api: Pick<SpaApi, 'disconnectConnectedProvider'>,
        queryClient: QueryClient,
        workspaceSlug: string,
      ) =>
        mutationOptions({
          mutationKey: duetMutationKeys.workspaces.connectedProviders(workspaceSlug, 'disconnect'),
          mutationFn: (provider: ConnectedProviderId) =>
            api.disconnectConnectedProvider(workspaceSlug, provider),
          onSuccess: () => invalidateAfterConnectedProviderMutation(queryClient, workspaceSlug),
        }),
    },
    agents: {
      marketplace: {
        install: (
          api: Pick<SpaApi, 'installMarketplaceAgent'>,
          queryClient: QueryClient,
          workspaceSlug: string,
        ) =>
          mutationOptions({
            mutationKey: duetMutationKeys.workspaces.agents.marketplace(workspaceSlug, 'install'),
            mutationFn: (input: MarketplaceAgentInstallRequest) =>
              api.installMarketplaceAgent(workspaceSlug, input),
            onSettled: () =>
              invalidateAfterMarketplaceAgentMutation(queryClient, workspaceSlug, 'install'),
          }),
        acknowledge: (api: SpaApi, queryClient: QueryClient, workspaceSlug: string) =>
          mutationOptions({
            mutationKey: duetMutationKeys.workspaces.agents.marketplace(
              workspaceSlug,
              'acknowledge',
            ),
            mutationFn: (subscriptionId: string) =>
              api.acknowledgeMarketplaceAgent(workspaceSlug, subscriptionId),
            onSuccess: () =>
              invalidateAfterMarketplaceAgentMutation(queryClient, workspaceSlug, 'acknowledge'),
          }),
        uninstall: (api: SpaApi, queryClient: QueryClient, workspaceSlug: string) =>
          mutationOptions({
            mutationKey: duetMutationKeys.workspaces.agents.marketplace(workspaceSlug, 'uninstall'),
            mutationFn: (subscriptionId: string) =>
              api.uninstallMarketplaceAgent(workspaceSlug, subscriptionId),
            onSuccess: () =>
              invalidateAfterMarketplaceAgentMutation(queryClient, workspaceSlug, 'uninstall'),
          }),
      },
    },
  },
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}
