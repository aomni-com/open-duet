import { expect, test } from 'bun:test'

import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  type InfiniteData,
} from '@tanstack/react-query'

import type { App, AppListResponse } from '@repo/contract'

import type { SpaApi } from '../context'
import {
  collectionPagesQueryOptions,
  isInitialCollectionError,
  isInitialQueryError,
  duetQueryOptions,
  mapCollectionItems,
  prependCollectionItem,
  workspaceMembersQueryOptions,
  workspaceSubtreeAppsQueryOptions,
} from './query-options'

test('a collection query fetches continuation only when its caller asks for the next page', async () => {
  const requests: Array<{ cursor?: string; limit: number }> = []
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const options = collectionPagesQueryOptions({
    queryKey: ['duet', 'user', 'collection-people'] as const,
    queryFn: async request => {
      requests.push({
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        limit: request.limit,
      })
      return request.cursor === undefined
        ? { items: ['Ada'], nextCursor: 'older' }
        : { items: ['Grace'], nextCursor: null }
    },
  })

  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()
  expect(requests).toEqual([{ limit: 100 }])

  await observer.fetchNextPage()
  expect(requests).toEqual([{ limit: 100 }, { cursor: 'older', limit: 100 }])
  expect(queryClient.getQueryData(options.queryKey)).toMatchObject({
    pages: [
      { items: ['Ada'], nextCursor: 'older' },
      { items: ['Grace'], nextCursor: null },
    ],
  })
  expect(observer.getCurrentResult().data?.items).toEqual(['Ada', 'Grace'])
  unsubscribe()
})

test('the shared agent roster reaches page two and retains page one across retry', async () => {
  let failContinuation = true
  const requests: Array<string | undefined> = []
  const row = (slug: string) => ({
    id: `agent_${slug}`,
    workspaceId: 'workspace_acme',
    anchorId: `anchor_${slug}`,
    anchorPath: `agents/${slug}`,
    anchorState: 'active' as const,
    slug,
    name: slug,
    createdAt: 1,
    updatedAt: 1,
  })
  const api = {
    listAgents: async (_workspaceSlug: string, request: { cursor?: string }) => {
      requests.push(request.cursor)
      if (request.cursor === undefined) return { items: [row('alpha')], nextCursor: 'page-2' }
      if (failContinuation) throw new Error('page two unavailable')
      return { items: [row('zulu')], nextCursor: null }
    },
  } as unknown as SpaApi
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const observer = new InfiniteQueryObserver(
    queryClient,
    duetQueryOptions.workspaces.agents(api, 'acme'),
  )
  const unsubscribe = observer.subscribe(() => {})

  await observer.refetch()
  await observer.fetchNextPage()
  expect(observer.getCurrentResult().isFetchNextPageError).toBe(true)
  expect(observer.getCurrentResult().data?.items.map(agent => agent.slug)).toEqual(['alpha'])

  failContinuation = false
  await observer.fetchNextPage()
  expect(observer.getCurrentResult().data?.items.map(agent => agent.slug)).toEqual([
    'alpha',
    'zulu',
  ])
  expect(requests).toEqual([undefined, 'page-2', 'page-2'])
  unsubscribe()
})

test('a reachable-agent roster retains its prefix and retries only on request', async () => {
  let failContinuation = true
  const requests: Array<string | undefined> = []
  const row = (slug: string) => ({
    slug,
    name: slug,
    path: `agents/${slug}`,
    locked: false,
    relationship: 'child' as const,
  })
  const api = {
    readAgentRoster: async (
      _workspaceSlug: string,
      _agentSlug: string,
      request: { cursor?: string },
    ) => {
      requests.push(request.cursor)
      if (request.cursor === undefined) return { items: [row('alpha')], nextCursor: 'page-2' }
      if (failContinuation) throw new Error('page two unavailable')
      return { items: [row('zulu')], nextCursor: null }
    },
  } as unknown as SpaApi
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const observer = new InfiniteQueryObserver(
    queryClient,
    duetQueryOptions.workspaces.agentRoster(api, 'acme', 'root'),
  )
  const unsubscribe = observer.subscribe(() => {})

  await observer.refetch()
  await observer.fetchNextPage()
  expect(observer.getCurrentResult().isFetchNextPageError).toBe(true)
  expect(observer.getCurrentResult().data?.items.map(agent => agent.slug)).toEqual(['alpha'])

  failContinuation = false
  await observer.fetchNextPage()
  expect(observer.getCurrentResult().data?.items.map(agent => agent.slug)).toEqual([
    'alpha',
    'zulu',
  ])
  expect(requests).toEqual([undefined, 'page-2', 'page-2'])
  unsubscribe()
})

test('agent identity lookup is exact and independent of the browsed roster prefix', async () => {
  const requests: Array<{ id?: string; slug?: string; limit?: number }> = []
  const api = {
    listAgents: async (
      _workspaceSlug: string,
      request: { id?: string; slug?: string; limit?: number },
    ) => {
      requests.push(request)
      return {
        items: [
          {
            id: 'agent_zulu',
            workspaceId: 'workspace_acme',
            anchorId: 'anchor_zulu',
            anchorPath: 'agents/zulu',
            anchorState: 'active' as const,
            slug: 'zulu',
            name: 'Zulu',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        nextCursor: null,
      }
    },
  } as unknown as SpaApi
  const queryClient = new QueryClient()
  queryClient.setQueryData(duetQueryOptions.workspaces.agents(api, 'acme').queryKey, {
    pages: [{ items: [], nextCursor: 'page-2' }],
    pageParams: [undefined],
  })

  const result = await queryClient.fetchQuery(
    duetQueryOptions.workspaces.agentLookup(api, 'acme', { id: 'agent_zulu' }),
  )
  expect(result?.slug).toBe('zulu')
  expect(requests).toEqual([
    expect.objectContaining({
      id: 'agent_zulu',
      limit: 1,
      signal: expect.any(AbortSignal),
    }),
  ])
})

test('workspace audit retains earlier activity when older activity is loaded', async () => {
  const requests: Array<{ cursor?: string; limit?: number }> = []
  const api = {
    listWorkspaceAudit: async (
      _workspaceSlug: string,
      options: { cursor?: string; limit?: number },
    ) => {
      requests.push(options)
      return options.cursor === undefined
        ? {
            items: [{ id: 'audit-newest', event: 'workspace.member_changed', at: 2 }],
            nextCursor: 'audit-older',
          }
        : {
            items: [{ id: 'audit-oldest', event: 'api_key.issued', at: 1 }],
            nextCursor: null,
          }
    },
  } as unknown as SpaApi
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const options = duetQueryOptions.workspaces.audit(api, 'acme')
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})

  await observer.refetch()
  await observer.fetchNextPage()

  expect(requests.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
    { cursor: undefined, limit: 100 },
    { cursor: 'audit-older', limit: 100 },
  ])
  expect(observer.getCurrentResult().data?.items.map(event => event.id)).toEqual([
    'audit-newest',
    'audit-oldest',
  ])
  unsubscribe()
})

test('workspace skills beyond the first bounded page stay lazy and reachable', async () => {
  const requests: Array<{
    cursor?: string
    limit?: number
    signal?: AbortSignal
  }> = []
  let continuationAttempts = 0
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    name: `skill-${index + 1}`,
    path: `/skills/${index + 1}`,
  }))
  const api = {
    listWorkspaceSkills: async (
      _workspaceSlug: string,
      _cwd: string | undefined,
      options: { cursor?: string; limit?: number; signal?: AbortSignal },
    ) => {
      requests.push(options)
      if (options.cursor === undefined) return { items: firstPage, nextCursor: 'skill-101' }
      continuationAttempts += 1
      if (continuationAttempts === 1) throw new Error('workspace woke up too slowly')
      return {
        items: [{ name: 'skill-101', path: '/skills/101' }],
        nextCursor: null,
      }
    },
  } as unknown as SpaApi
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const options = duetQueryOptions.workspaces.skills(api, 'acme', 'agents/scout')
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})

  await observer.refetch()
  expect(requests).toEqual([{ limit: 100, signal: expect.any(AbortSignal) }])
  expect(observer.getCurrentResult().data?.items.at(-1)?.name).toBe('skill-100')

  await observer.fetchNextPage()
  expect(observer.getCurrentResult()).toMatchObject({
    isFetchNextPageError: true,
    data: { items: firstPage },
  })

  await observer.fetchNextPage()
  expect(requests.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
    { cursor: undefined, limit: 100 },
    { cursor: 'skill-101', limit: 100 },
    { cursor: 'skill-101', limit: 100 },
  ])
  expect(observer.getCurrentResult().data?.items.at(-1)?.name).toBe('skill-101')

  requests.length = 0
  await observer.refetch()
  expect(requests.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
    { cursor: undefined, limit: 100 },
    { cursor: 'skill-101', limit: 100 },
  ])
  unsubscribe()
})

test('OAuth settings can reach and retain a revocable grant beyond the first 100 rows', async () => {
  const requests: Array<{ cursor?: string; limit?: number }> = []
  const api = {
    listOAuthGrants: async (options: { cursor?: string; limit?: number }) => {
      requests.push(options)
      return options.cursor === undefined
        ? {
            items: Array.from({ length: 100 }, (_, index) => ({
              id: `grant-${index + 1}`,
            })),
            nextCursor: 'grant-101',
          }
        : { items: [{ id: 'grant-101' }], nextCursor: null }
    },
  } as unknown as SpaApi
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const options = duetQueryOptions.user.oauthGrants(api)
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})

  await observer.refetch()
  expect(observer.getCurrentResult().data?.items).toHaveLength(100)
  await observer.fetchNextPage()

  expect(observer.getCurrentResult().data?.items.at(-1)?.id).toBe('grant-101')
  expect(requests.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
    { cursor: undefined, limit: 100 },
    { cursor: 'grant-101', limit: 100 },
  ])
  unsubscribe()
})

test('the ordinary member roster requests its full 100-seat capacity in one bounded page', async () => {
  const requests: number[] = []
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const options = workspaceMembersQueryOptions('acme', async (_signal, limit) => {
    requests.push(limit)
    return { items: [], nextCursor: null }
  })

  await queryClient.fetchQuery(options)

  expect(requests).toEqual([100])
})

test('a mutation updates items on every page without collapsing the continuation', () => {
  const data = {
    pages: [
      { items: [{ id: 'new', active: true }], nextCursor: 'older' },
      { items: [{ id: 'old', active: true }], nextCursor: null },
    ],
    pageParams: [undefined, 'older'],
  }

  expect(
    mapCollectionItems(data, items =>
      items.map(item => (item.id === 'old' ? { ...item, active: false } : item)),
    ),
  ).toEqual({
    pages: [
      { items: [{ id: 'new', active: true }], nextCursor: 'older' },
      { items: [{ id: 'old', active: false }], nextCursor: null },
    ],
    pageParams: [undefined, 'older'],
  })
})

test('a failed first collection read has no usable prefix', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const options = collectionPagesQueryOptions({
    queryKey: ['duet', 'user', 'failed-first-page'] as const,
    queryFn: async () => {
      throw new Error('collection unavailable')
    },
  })
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})

  await observer.refetch()
  const result = observer.getCurrentResult()
  expect(result.data).toBeUndefined()
  expect(isInitialCollectionError(result)).toBe(true)
  unsubscribe()
})

test('a failed general refetch keeps a cached collection prefix usable', async () => {
  let fail = false
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const options = collectionPagesQueryOptions({
    queryKey: ['duet', 'user', 'cached-refetch-prefix'] as const,
    queryFn: async () => {
      if (fail) throw new Error('refresh unavailable')
      return { items: ['Ada'], nextCursor: 'older' }
    },
  })
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})

  await observer.refetch()
  fail = true
  await observer.refetch()

  const result = observer.getCurrentResult()
  expect(result.data?.items).toEqual(['Ada'])
  expect(isInitialCollectionError(result)).toBe(false)
  unsubscribe()
})

test('a failed point refetch keeps its cached payload usable', async () => {
  let fail = false
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const observer = new QueryObserver(queryClient, {
    queryKey: ['duet', 'user', 'cached-point'] as const,
    queryFn: async () => {
      if (fail) throw new Error('refresh unavailable')
      return { id: 'session_1' }
    },
  })
  const unsubscribe = observer.subscribe(() => {})

  await observer.refetch()
  fail = true
  await observer.refetch()

  const result = observer.getCurrentResult()
  expect(result.data).toEqual({ id: 'session_1' })
  expect(isInitialQueryError(result)).toBe(false)
  unsubscribe()
})

test('a landing item seeds an empty infinite collection cache', () => {
  expect(prependCollectionItem(undefined, { id: 'share-beyond-page-one' })).toEqual({
    pages: [{ items: [{ id: 'share-beyond-page-one' }], nextCursor: null }],
    pageParams: [undefined],
  })
})

test('training records and integration connections expose their server continuations lazily', async () => {
  const recordRequests: Array<{ cursor?: string; limit?: number }> = []
  const connectionRequests: Array<{
    cursor?: string
    limit?: number
    signal?: AbortSignal
  }> = []
  const api = {
    listTrainRecords: async (
      _workspaceSlug: string,
      _scope: unknown,
      options: { cursor?: string; limit?: number; signal?: AbortSignal },
    ) => {
      recordRequests.push(options)
      return {
        items: [],
        nextCursor: options.cursor === undefined ? 'record-2' : null,
      }
    },
    listIntegrationConnections: async (
      _workspaceSlug: string,
      options: { cursor?: string; limit?: number },
    ) => {
      connectionRequests.push(options)
      return {
        items: [],
        nextCursor: options.cursor === undefined ? 'connection-2' : null,
      }
    },
  } as unknown as SpaApi
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const records = duetQueryOptions.workspaces.train.recordList(api, 'acme', {
    kind: 'root',
  })
  const connections = duetQueryOptions.workspaces.integrations.connections(api, 'acme')
  const recordObserver = new InfiniteQueryObserver(queryClient, records)
  const connectionObserver = new InfiniteQueryObserver(queryClient, connections)
  const unsubscribeRecords = recordObserver.subscribe(() => {})
  const unsubscribeConnections = connectionObserver.subscribe(() => {})

  await Promise.all([recordObserver.refetch(), connectionObserver.refetch()])
  expect(recordRequests).toEqual([{ limit: 100 }])
  expect(connectionRequests).toEqual([{ limit: 100, signal: expect.any(AbortSignal) }])

  await Promise.all([recordObserver.fetchNextPage(), connectionObserver.fetchNextPage()])
  expect(recordRequests).toEqual([{ limit: 100 }, { cursor: 'record-2', limit: 100 }])
  expect(connectionRequests.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
    { cursor: undefined, limit: 100 },
    { cursor: 'connection-2', limit: 100 },
  ])
  unsubscribeRecords()
  unsubscribeConnections()
})

function browserPageApp(index: number): App {
  return {
    id: `app-${index}`,
    workspaceId: 'workspace-acme',
    anchorId: `anchor-${index}`,
    anchorPath: `apps/app-${index}`,
    anchorState: 'active',
    command: 'bun start',
    apiScopes: [],
    port: 41000 + index,
    slug: `app-${index}`,
    visibility: 'folder',
    canonicalUrl: `https://app-${index}--acme.duet.so`,
    runtimeStatus: 'reconciled',
    createdByUserId: 'owner',
    createdAt: 1,
    updatedAt: 1,
    controls: {
      manageDomain: true,
      updateRuntime: true,
      makePublic: true,
      makePrivate: true,
      delete: true,
    },
  }
}

test('targeted app identity does not depend on the first 100 browser rows', async () => {
  const requests: unknown[] = []
  const api = {
    listApps: async (_workspaceSlug: string, options: unknown) => {
      requests.push(options)
      return {
        items: [{ id: 'app-101', anchorPath: 'apps/reports' }],
        nextCursor: null,
        meta: { capabilities: { register: false } },
      }
    },
  } as unknown as SpaApi
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const firstBrowserPage = Array.from({ length: 100 }, (_, id) => browserPageApp(id))
  queryClient.setQueryData(duetQueryOptions.workspaces.apps(api, 'acme').queryKey, {
    pages: [{ items: firstBrowserPage, nextCursor: 'older' }],
    pageParams: [undefined],
  })

  const byId = duetQueryOptions.workspaces.appLookup(api, 'acme', {
    id: 'app-101',
  })
  const byCwd = duetQueryOptions.workspaces.appLookup(api, 'acme', {
    cwd: 'apps/reports/deep',
  })
  expect((await queryClient.fetchQuery(byId)).items[0]?.id).toBe('app-101')
  expect((await queryClient.fetchQuery(byCwd)).items[0]?.id).toBe('app-101')
  expect(
    queryClient.getQueryData<InfiniteData<AppListResponse, string | undefined>>(
      duetQueryOptions.workspaces.apps(api, 'acme').queryKey,
    ),
  ).toEqual({
    pages: [{ items: firstBrowserPage, nextCursor: 'older' }],
    pageParams: [undefined],
  })
  expect(requests).toEqual([
    { id: 'app-101', limit: 1, signal: expect.any(AbortSignal) },
    { cwd: 'apps/reports/deep', limit: 1, signal: expect.any(AbortSignal) },
  ])
})

test('a direct app URL reads app identity by slug outside the first browser page', async () => {
  const requests: Array<{
    workspaceSlug: string
    appSlug: string
    signal?: AbortSignal
  }> = []
  const api = {
    getApp: async (workspaceSlug: string, appSlug: string, signal?: AbortSignal) => {
      requests.push({ workspaceSlug, appSlug, signal })
      return {
        app: {
          id: 'app-101',
          slug: appSlug,
          anchorPath: 'apps/reports',
        },
      }
    },
  } as unknown as SpaApi
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const firstBrowserPage = Array.from({ length: 100 }, (_, id) => browserPageApp(id))
  queryClient.setQueryData(duetQueryOptions.workspaces.apps(api, 'acme').queryKey, {
    pages: [{ items: firstBrowserPage, nextCursor: 'older' }],
    pageParams: [undefined],
  })

  const direct = duetQueryOptions.workspaces.app(api, 'acme', 'reports')
  expect((await queryClient.fetchQuery(direct)).app.id).toBe('app-101')
  expect(
    queryClient.getQueryData<InfiniteData<AppListResponse, string | undefined>>(
      duetQueryOptions.workspaces.apps(api, 'acme').queryKey,
    ),
  ).toEqual({
    pages: [{ items: firstBrowserPage, nextCursor: 'older' }],
    pageParams: [undefined],
  })
  expect(requests).toEqual([
    {
      workspaceSlug: 'acme',
      appSlug: 'reports',
      signal: expect.any(AbortSignal),
    },
  ])
})

test('a shared-folder app preview preserves loaded rows when its continuation fails', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const options = workspaceSubtreeAppsQueryOptions('acme', 'launch', async request => {
    if (request.cursor !== undefined) throw new Error('continuation failed')
    return {
      items: Array.from({ length: 100 }, (_, index) => ({
        id: `app-${index}`,
        workspaceId: 'workspace_acme',
        anchorId: `anchor-${index}`,
        anchorPath: `launch/app-${index}`,
        anchorState: 'active' as const,
        command: 'bun run start',
        apiScopes: [],
        port: 4173,
        slug: `app-${index}`,
        visibility: 'folder' as const,
        canonicalUrl: `https://app-${index}.duet.so`,
        runtimeStatus: 'reconciled' as const,
        createdByUserId: 'user_1',
        createdAt: 1,
        updatedAt: 2,
        controls: {
          manageDomain: true,
          updateRuntime: true,
          makePublic: true,
          makePrivate: true,
          delete: true,
        },
      })),
      nextCursor: 'older',
      meta: { capabilities: { register: false } },
    }
  })
  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()
  await observer.fetchNextPage()
  expect(observer.getCurrentResult().isFetchNextPageError).toBe(true)
  expect(observer.getCurrentResult().data?.items.map(app => app.id)).toEqual(
    Array.from({ length: 100 }, (_, index) => `app-${index}`),
  )
  unsubscribe()
})
