import { expect, test } from 'bun:test'

import { QueryClient, QueryObserver } from '@tanstack/react-query'

import type { AgentListResponse } from '@repo/contract'

import { onboardingFlipStep, onboardingWatchQueryOptions } from './agent-onboarding-watch'

test('polls only while the onboarding watch is mounted and clears the interval on unmount', () => {
  let requests = 0
  const api = {
    listAgents: async (): Promise<AgentListResponse> => {
      requests += 1
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
            updatedAt: requests,
          },
        ],
        nextCursor: null,
      }
    },
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const observer = new QueryObserver(
    client,
    onboardingWatchQueryOptions(api, 'acme', 'agent_research', 10),
  )

  const query = client.getQueryCache().find({
    queryKey: onboardingWatchQueryOptions(api, 'acme', 'agent_research', 10).queryKey,
  })!
  expect(query.getObserversCount()).toBe(0)

  const unsubscribe = observer.subscribe(() => {})
  expect(observer.options.refetchInterval).not.toBe(false)
  expect(query.getObserversCount()).toBe(1)
  unsubscribe()
  expect(query.getObserversCount()).toBe(0)
})

test('an onboarded flip navigates exactly once across repeated refetch results', () => {
  const navigated = new Set<string>()
  const locked = { id: 'agent_research', slug: 'research', onboardedAt: undefined }
  const onboarded = { ...locked, onboardedAt: 1_700_000_000_000 }

  expect(onboardingFlipStep(navigated, locked)).toBe(false)
  expect(onboardingFlipStep(navigated, onboarded)).toBe(true)
  expect(onboardingFlipStep(navigated, onboarded)).toBe(false)
  expect(onboardingFlipStep(navigated, { ...onboarded, onboardedAt: 1_700_000_000_001 })).toBe(
    false,
  )
})
