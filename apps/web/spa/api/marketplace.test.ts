import { expect, test } from 'bun:test'

import {
  InfiniteQueryObserver,
  MutationObserver,
  QueryClient,
  QueryObserver,
  type InfiniteData,
} from '@tanstack/react-query'

import type { AgentListResponse, MarketplaceAgentSubscriptionList } from '@repo/contract'

import type { SpaApi } from '../context'
import { duetQueryKeys, isWorkspaceQueryKey } from './query-keys'
import {
  duetMutationOptions,
  duetQueryOptions,
  invalidateAfterMarketplaceAgentMutation,
} from './query-options'

// OA-SLICE-09-KZQ7

test('marketplace query options keep fetchers on the agent cache namespace', () => {
  const api = {} as SpaApi

  expect([
    ...duetQueryOptions.agents.marketplace.catalog(api, { tag: 'marketing' }).queryKey,
  ]).toEqual([...duetQueryKeys.agents.marketplace.catalog({ tag: 'marketing' })])
  expect(duetQueryOptions.agents.marketplace.catalog(api).queryKey).not.toEqual(
    duetQueryOptions.agents.marketplace.catalog(api, {
      availability: 'available',
    }).queryKey,
  )
  expect([
    ...duetQueryOptions.agents.marketplace.detail(api, 'acme-labs', 'research').queryKey,
  ]).toEqual([...duetQueryKeys.agents.marketplace.detail('acme-labs', 'research')])
  expect([...duetQueryOptions.workspaces.agentSubscriptions(api, 'acme').queryKey]).toEqual([
    ...duetQueryKeys.workspaces.agents.marketplace.subscriptions('acme'),
  ])
  expect(
    isWorkspaceQueryKey(
      duetQueryOptions.workspaces.agentSubscriptions(api, 'acme').queryKey,
      'acme',
    ),
  ).toBe(true)
})

test('install invalidates subscriptions, roster, and memory counts only in its workspace', async () => {
  const queryClient = new QueryClient()
  const keys = [
    duetQueryKeys.workspaces.agents.marketplace.subscriptions('acme'),
    duetQueryKeys.workspaces.agents.list('acme'),
    duetQueryKeys.workspaces.train.records.memoryCounts('acme'),
    duetQueryKeys.workspaces.agents.marketplace.subscriptions('peer'),
  ]
  for (const key of keys) queryClient.setQueryData(key, { value: 'cached' })

  await invalidateAfterMarketplaceAgentMutation(queryClient, 'acme', 'install')

  expect(keys.map(key => queryClient.getQueryState(key)?.isInvalidated)).toEqual([
    true,
    true,
    true,
    false,
  ])
  queryClient.clear()
})

test('install waits for subscription and roster caches to refresh', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const subscriptionsKey = duetQueryKeys.workspaces.agents.marketplace.subscriptions('acme')
  const agentsKey = duetQueryKeys.workspaces.agents.list('acme')
  queryClient.setQueryData(subscriptionsKey, { items: [], nextCursor: null })
  queryClient.setQueryData(agentsKey, {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  })

  const subscriptionsObserver = new QueryObserver(queryClient, {
    queryKey: subscriptionsKey,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      await Bun.sleep(20)
      return {
        items: [
          {
            id: 'subscription_research',
            agentId: 'agent_research',
            anchorId: 'anchor_research',
            listingId: 'listing-1',
            agentName: 'research',
            path: 'agents/research',
            mode: 'subscribe' as const,
            state: 'active' as const,
          },
        ],
        nextCursor: null,
      }
    },
  })
  const agentsObserver = new InfiniteQueryObserver(
    queryClient,
    duetQueryOptions.workspaces.agents(
      {
        listAgents: async () => {
          await Bun.sleep(20)
          return {
            items: [
              {
                id: 'agent_research',
                workspaceId: 'workspace_acme',
                anchorId: 'anchor_research',
                anchorPath: 'agents/research',
                anchorState: 'active' as const,
                slug: 'research',
                name: 'Research',
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            nextCursor: null,
          }
        },
      } as unknown as SpaApi,
      'acme',
    ),
  )
  const unsubscribeSubscriptions = subscriptionsObserver.subscribe(() => {})
  const unsubscribeAgents = agentsObserver.subscribe(() => {})

  await invalidateAfterMarketplaceAgentMutation(queryClient, 'acme', 'install')

  expect(queryClient.getQueryData<MarketplaceAgentSubscriptionList>(subscriptionsKey)).toEqual({
    items: [
      expect.objectContaining({
        listingId: 'listing-1',
        agentName: 'research',
        state: 'active',
      }),
    ],
    nextCursor: null,
  })
  expect(queryClient.getQueryData<InfiniteData<AgentListResponse>>(agentsKey)).toEqual({
    pages: [
      {
        items: [expect.objectContaining({ slug: 'research' })],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  })

  unsubscribeSubscriptions()
  unsubscribeAgents()
})

test('failed install refreshes the durable subscription and roster projections', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const subscriptionsKey = duetQueryKeys.workspaces.agents.marketplace.subscriptions('acme')
  const agentsKey = duetQueryKeys.workspaces.agents.list('acme')
  queryClient.setQueryData(subscriptionsKey, { items: [], nextCursor: null })
  queryClient.setQueryData(agentsKey, {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  })

  const subscriptionsObserver = new QueryObserver(queryClient, {
    queryKey: subscriptionsKey,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => ({
      items: [
        {
          id: 'subscription_research',
          agentId: 'agent_research',
          anchorId: 'anchor_research',
          listingId: 'listing-1',
          agentName: 'research',
          path: 'agents/research',
          mode: 'subscribe' as const,
          state: 'error' as const,
          lastErrorCode: 'pull_failed',
        },
      ],
      nextCursor: null,
    }),
  })
  const agentsObserver = new InfiniteQueryObserver(
    queryClient,
    duetQueryOptions.workspaces.agents(
      {
        listAgents: async () => ({
          items: [
            {
              id: 'agent_research',
              workspaceId: 'workspace_acme',
              anchorId: 'anchor_research',
              anchorPath: 'agents/research',
              anchorState: 'active' as const,
              slug: 'research',
              name: 'Research',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          nextCursor: null,
        }),
      } as unknown as SpaApi,
      'acme',
    ),
  )
  const unsubscribeSubscriptions = subscriptionsObserver.subscribe(() => {})
  const unsubscribeAgents = agentsObserver.subscribe(() => {})
  const mutation = new MutationObserver(
    queryClient,
    duetMutationOptions.workspaces.agents.marketplace.install(
      {
        installMarketplaceAgent: async () => {
          throw new Error('pull_failed')
        },
      },
      queryClient,
      'acme',
    ),
  )

  await expect(
    mutation.mutate({ listingId: 'listing-1', name: 'Research Assistant' }),
  ).rejects.toThrow('pull_failed')

  expect(queryClient.getQueryData<MarketplaceAgentSubscriptionList>(subscriptionsKey)).toEqual({
    items: [
      expect.objectContaining({
        listingId: 'listing-1',
        agentName: 'research',
        state: 'error',
      }),
    ],
    nextCursor: null,
  })
  expect(queryClient.getQueryData<InfiniteData<AgentListResponse>>(agentsKey)).toEqual({
    pages: [
      {
        items: [expect.objectContaining({ slug: 'research' })],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  })

  unsubscribeSubscriptions()
  unsubscribeAgents()
})

test('uninstall and acknowledge invalidate only subscription state', async () => {
  for (const kind of ['uninstall', 'acknowledge'] as const) {
    const queryClient = new QueryClient()
    const keys = [
      duetQueryKeys.workspaces.agents.marketplace.subscriptions('acme'),
      duetQueryKeys.workspaces.agents.list('acme'),
      duetQueryKeys.workspaces.train.records.memoryCounts('acme'),
      duetQueryKeys.workspaces.agents.marketplace.subscriptions('peer'),
    ]
    for (const key of keys) queryClient.setQueryData(key, { value: 'cached' })

    await invalidateAfterMarketplaceAgentMutation(queryClient, 'acme', kind)

    expect(keys.map(key => queryClient.getQueryState(key)?.isInvalidated)).toEqual([
      true,
      false,
      false,
      false,
    ])
    queryClient.clear()
  }
})
