import { expect, test } from 'bun:test'

import { QueryClient, type InfiniteData } from '@tanstack/react-query'

import type { Agent, AgentListResponse } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import {
  invalidateAfterAgentDelete,
  optimisticallyRenameAgent,
  restoreAgentCaches,
} from './agent-mutations'

function agent(slug: string, name: string): Agent {
  return {
    id: `agent_${slug}`,
    workspaceId: 'workspace_acme',
    anchorId: `anchor_${slug}`,
    anchorPath: `agents/${slug}`,
    anchorState: 'active',
    slug,
    name,
    createdAt: 1,
    updatedAt: 2,
  }
}

const LIST_KEY = duetQueryKeys.workspaces.agents.list('acme')

type AgentPages = InfiniteData<AgentListResponse, string | undefined>

function seed(): { queryClient: QueryClient; before: AgentPages } {
  const queryClient = new QueryClient()
  const before: AgentPages = {
    pages: [
      { items: [agent('research', 'Research')], nextCursor: 'page-2' },
      { items: [agent('support', 'Support Bot')], nextCursor: null },
    ],
    pageParams: [undefined, 'page-2'],
  }
  queryClient.setQueryData(LIST_KEY, before)
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.lookup('acme', { slug: 'research' }),
    before.pages[0]?.items[0],
  )
  return { queryClient, before }
}

test('rename patches only the named agent and returns the pre-patch snapshot', () => {
  const { queryClient } = seed()

  const previous = optimisticallyRenameAgent(queryClient, 'acme', 'research', 'Deep Research')

  const patched = queryClient.getQueryData<AgentPages>(LIST_KEY)
  expect(patched?.pages.flatMap(page => page.items).map(a => a.name)).toEqual([
    'Deep Research',
    'Support Bot',
  ])
  // The slug and anchor are untouched — rename is display-name only (the folder does not move).
  expect(patched?.pages[0]?.items[0]?.slug).toBe('research')
  expect(patched?.pages[0]?.items[0]?.anchorPath).toBe('agents/research')
  // The snapshot still holds the original name for rollback.
  expect(previous?.list?.pages[0]?.items[0]?.name).toBe('Research')
  expect(
    queryClient.getQueryData<Agent>(
      duetQueryKeys.workspaces.agents.lookup('acme', { slug: 'research' }),
    )?.name,
  ).toBe('Deep Research')
})

test('rollback restores the exact pre-patch list on error', () => {
  const { queryClient, before } = seed()

  const previous = optimisticallyRenameAgent(queryClient, 'acme', 'research', 'Deep Research')
  restoreAgentCaches(queryClient, 'acme', 'research', previous)

  expect(queryClient.getQueryData<AgentPages>(LIST_KEY)).toEqual(before)
  expect(
    queryClient.getQueryData<Agent>(
      duetQueryKeys.workspaces.agents.lookup('acme', { slug: 'research' }),
    )?.name,
  ).toBe('Research')
})

test('rename against an unloaded list is a safe no-op', () => {
  const queryClient = new QueryClient()

  const previous = optimisticallyRenameAgent(queryClient, 'acme', 'research', 'Deep Research')

  expect(previous).toBeUndefined()
  expect(queryClient.getQueryData(LIST_KEY)).toBeUndefined()
  // Rollback of an absent snapshot must not resurrect an empty list.
  restoreAgentCaches(queryClient, 'acme', 'research', previous)
  expect(queryClient.getQueryData(LIST_KEY)).toBeUndefined()
})

test('a confirmed delete invalidates affected workspace projections and preserves unrelated caches', () => {
  const queryClient = new QueryClient()
  const affected = [
    duetQueryKeys.workspaces.agents.list('acme'),
    duetQueryKeys.workspaces.agents.lookup('acme', { slug: 'research' }),
    duetQueryKeys.workspaces.agents.marketplace.subscriptions('acme'),
    duetQueryKeys.workspaces.sessions.lists('acme'),
    // Agent teardown removes its apps, including app nodes drawn on the home graph.
    duetQueryKeys.workspaces.apps.list('acme'),
    duetQueryKeys.workspaces.train.records.memoryCounts('acme'),
  ]
  const unaffected = [
    duetQueryKeys.workspaces.agents.list('peer'),
    duetQueryKeys.workspaces.sessions.lists('peer'),
    duetQueryKeys.workspaces.apps.list('peer'),
    duetQueryKeys.identity,
  ]
  for (const key of [...affected, ...unaffected]) queryClient.setQueryData(key, { fixture: true })

  invalidateAfterAgentDelete(queryClient, 'acme')

  for (const key of affected) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
  for (const key of unaffected) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)
  queryClient.clear()
})
