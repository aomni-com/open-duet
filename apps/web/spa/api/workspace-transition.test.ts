import { describe, expect, test } from 'bun:test'

import { QueryClient } from '@tanstack/react-query'

import type { WhoamiResponse } from '@repo/contract'

import type { SpaApi } from '../context'
import { sessionQueryOptions } from '../sessions/session-data'
import { duetQueryKeys } from './query-keys'
import { ROOT_TRAIN_SCOPE } from './train-scope'
import { captureWorkspaceCacheScope } from './workspace-cache-scope'
import { prepareWorkspaceTransition, transitionWorkspaceQueries } from './workspace-transition'

describe('workspace cache transition', () => {
  test('aborts real session list, detail, and history transports before removing old keys', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const signals: AbortSignal[] = []
    const pending = <Value>(signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<Value>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const api = {
      listSessions: (_workspaceSlug: string, _query: unknown, signal: AbortSignal) =>
        pending(signal),
      getSession: (_workspaceSlug: string, _sessionId: string, signal: AbortSignal) =>
        pending(signal),
      getSessionHistory: (
        _workspaceSlug: string,
        _sessionId: string,
        _afterSeq: number,
        signal: AbortSignal,
      ) => pending(signal),
    } as unknown as SpaApi
    const listOptions = sessionQueryOptions.list(api, 'old', {
      search: '',
      archived: 'exclude',
    })
    const detailOptions = sessionQueryOptions.detail(api, 'old', 'session_1')
    const historyOptions = sessionQueryOptions.history(api, queryClient, 'old', 'session_1')
    const requests = [
      queryClient.fetchInfiniteQuery(listOptions).catch(() => undefined),
      queryClient.fetchQuery(detailOptions).catch(() => undefined),
      queryClient.fetchQuery(historyOptions).catch(() => undefined),
    ]
    await Promise.resolve()

    await transitionWorkspaceQueries(queryClient, 'old', 'next')
    await Promise.all(requests)

    expect(signals).toHaveLength(3)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(
      queryClient.getQueryCache().findAll({ queryKey: duetQueryKeys.workspaces.scope('old') }),
    ).toHaveLength(0)
  })

  test('cancels and removes only the old workspace while preserving identity and peers', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData<{ user: string }>(duetQueryKeys.identity, { user: 'owner' })
    queryClient.setQueryData<string[]>(duetQueryKeys.workspaces.sessions.all('old'), ['old'])
    queryClient.setQueryData<string[]>(duetQueryKeys.workspaces.sessions.all('next'), ['next'])
    queryClient.setQueryData<string[]>(duetQueryKeys.workspaces.sessions.all('peer'), ['peer'])
    const oldScope = captureWorkspaceCacheScope('old')

    await transitionWorkspaceQueries(queryClient, 'old', 'next')

    expect(queryClient.getQueryData(duetQueryKeys.workspaces.sessions.all('old'))).toBeUndefined()
    expect(queryClient.getQueryData<{ user: string }>(duetQueryKeys.identity)).toEqual({
      user: 'owner',
    })
    expect(
      queryClient.getQueryData<string[]>(duetQueryKeys.workspaces.sessions.all('peer')),
    ).toEqual(['peer'])
    expect(oldScope.isActive()).toBe(false)
    expect(
      queryClient.getQueryState(duetQueryKeys.workspaces.sessions.all('next'))?.isInvalidated,
    ).toBe(true)
  })

  test('refreshes live identity before accepting a workspace target', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(duetQueryKeys.workspaces.sessions.all('old'), ['old'])
    const freshIdentity: WhoamiResponse = {
      user: { id: 'user_1', email: 'owner@example.com' },
      workspaces: [
        {
          id: 'workspace_2',
          slug: 'next',
          name: 'Next',
          status: 'unhealthy',
          servicingStatus: 'active',
          role: 'viewer',
          billingUserId: 'user_1',
          funding: { plan: null, active: true },
          creditRecovery: null,
          defaultTier: { effective: 'balanced' },
        },
      ],
      scopes: ['ws:next:read'],
      versions: { api: 1 },
      internalAdmin: false,
    }

    const workspace = await prepareWorkspaceTransition({
      queryClient,
      previousSlug: 'old',
      nextSlug: 'next',
      refreshIdentity: async () => freshIdentity,
    })

    expect(workspace).toEqual(freshIdentity.workspaces[0])
    expect(workspace?.role).toBe('viewer')
    expect(workspace?.status).toBe('unhealthy')
    expect(queryClient.getQueryData(duetQueryKeys.workspaces.sessions.all('old'))).toBeUndefined()
  })

  test('workspace removal clears root and every agent Train scope', async () => {
    const queryClient = new QueryClient()
    const scopes = [
      ROOT_TRAIN_SCOPE,
      { kind: 'agent' as const, agentSlug: 'research' },
      { kind: 'agent' as const, agentSlug: 'writer' },
    ]
    for (const scope of scopes) {
      queryClient.setQueryData(duetQueryKeys.workspaces.train.jobs('old', scope), scope.kind)
    }
    queryClient.setQueryData(duetQueryKeys.workspaces.train.jobs('peer', ROOT_TRAIN_SCOPE), 'peer')

    await transitionWorkspaceQueries(queryClient, 'old', 'next')

    expect(
      queryClient.getQueryCache().findAll({ queryKey: duetQueryKeys.workspaces.scope('old') }),
    ).toHaveLength(0)
    expect(
      queryClient.getQueryData<string>(
        duetQueryKeys.workspaces.train.jobs('peer', ROOT_TRAIN_SCOPE),
      ),
    ).toBe('peer')
  })
})
