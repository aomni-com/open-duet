import { describe, expect, test } from 'bun:test'

import { QueryClient } from '@tanstack/react-query'

import { normalizeWorkspaceMemberSearch } from '@repo/contract'

import { duetQueryKeys, isWorkspaceQueryKey } from './query-keys'
import { invalidateAfterTrainCompletion } from './query-options'
import { ROOT_TRAIN_SCOPE } from './train-scope'

describe('Duet query keys', () => {
  test('session keys compose from broad invalidation prefixes to exact parameter objects', () => {
    const filters = { search: 'launch', archived: 'exclude' as const }

    expect(duetQueryKeys.workspaces.sessions.all('acme')).toEqual([
      'duet',
      'workspaces',
      'acme',
      'sessions',
    ])
    expect(duetQueryKeys.workspaces.sessions.lists('acme')).toEqual([
      'duet',
      'workspaces',
      'acme',
      'sessions',
      'list',
    ])
    expect(duetQueryKeys.workspaces.sessions.list('acme', filters)).toEqual([
      'duet',
      'workspaces',
      'acme',
      'sessions',
      'list',
      { filters },
    ])
    expect(duetQueryKeys.workspaces.sessions.history('acme', 'session_1')).toEqual([
      'duet',
      'workspaces',
      'acme',
      'sessions',
      'history',
      'session_1',
    ])
  })

  test('top-level session lists do not share a cache entry with the whole collection', () => {
    const all = { search: '', archived: 'exclude' as const }
    const topLevel = { ...all, topLevel: true as const }

    expect(duetQueryKeys.workspaces.sessions.list('acme', topLevel)).not.toEqual(
      duetQueryKeys.workspaces.sessions.list('acme', all),
    )
    expect(duetQueryKeys.workspaces.sessions.list('acme', topLevel)).toEqual([
      'duet',
      'workspaces',
      'acme',
      'sessions',
      'list',
      { filters: topLevel },
    ])
  })

  test('direct children are isolated by parent beneath the session collection', () => {
    const alpha = duetQueryKeys.workspaces.sessions.children('acme', 'session_alpha')
    const beta = duetQueryKeys.workspaces.sessions.children('acme', 'session_beta')

    expect(alpha).toEqual([
      'duet',
      'workspaces',
      'acme',
      'sessions',
      'list',
      'children',
      'session_alpha',
      { filters: { archived: 'exclude' } },
    ])
    expect(alpha).not.toEqual(beta)
    expect(alpha.slice(0, duetQueryKeys.workspaces.sessions.all('acme').length)).toEqual([
      ...duetQueryKeys.workspaces.sessions.all('acme'),
    ])
    expect(alpha.slice(0, duetQueryKeys.workspaces.sessions.lists('acme').length)).toEqual([
      ...duetQueryKeys.workspaces.sessions.lists('acme'),
    ])
  })

  test('direct-child buckets page through independent cache entries', () => {
    const running = duetQueryKeys.workspaces.sessions.children('acme', 'session_alpha', {
      bucket: 'running',
      archived: 'exclude',
    })
    const done = duetQueryKeys.workspaces.sessions.children('acme', 'session_alpha', {
      bucket: 'done',
      archived: 'exclude',
    })

    expect(running).not.toEqual(done)
  })

  test('agent keys nest the list under a broad per-workspace invalidation prefix', () => {
    expect(duetQueryKeys.workspaces.agents.all('acme')).toEqual([
      'duet',
      'workspaces',
      'acme',
      'agents',
    ])
    expect(duetQueryKeys.workspaces.agents.list('acme')).toEqual([
      'duet',
      'workspaces',
      'acme',
      'agents',
      'list',
    ])
    expect(isWorkspaceQueryKey(duetQueryKeys.workspaces.agents.list('acme'), 'acme')).toBe(true)
  })

  test('targeted app lookups do not alias the paginated browser list', () => {
    const bySlug = duetQueryKeys.workspaces.apps.app('acme', 'reports')
    const byId = duetQueryKeys.workspaces.apps.lookup('acme', { id: 'app_101' })
    expect(bySlug).toEqual(['duet', 'workspaces', 'acme', 'apps', 'app', 'reports'])
    expect(byId).toEqual(['duet', 'workspaces', 'acme', 'apps', 'lookup', { id: 'app_101' }])
    expect(duetQueryKeys.workspaces.apps.lookup('acme', { cwd: 'apps/reports/deep' })).not.toEqual(
      duetQueryKeys.workspaces.apps.list('acme'),
    )
    expect(byId.slice(0, duetQueryKeys.workspaces.apps.all('acme').length)).toEqual([
      ...duetQueryKeys.workspaces.apps.all('acme'),
    ])
    expect(bySlug).not.toEqual(duetQueryKeys.workspaces.apps.list('acme'))
    expect(duetQueryKeys.workspaces.apps.children('acme', 'reports')).not.toEqual(
      duetQueryKeys.workspaces.apps.subtree('acme', 'reports'),
    )
  })

  test('member search is normalized beneath the bounded roster root', () => {
    const members = duetQueryKeys.workspaces.members('acme')
    const search = duetQueryKeys.workspaces.memberSearch(
      'acme',
      normalizeWorkspaceMemberSearch('  MAYA  '),
    )

    expect(search).toEqual([...members, 'search', { search: 'maya' }])
    expect(search).not.toEqual(members)
  })

  test('marketplace agent keys extend the one agent namespace at global and workspace scopes', () => {
    expect(duetQueryKeys.agents.marketplace.catalog()).toEqual([
      'duet',
      'agents',
      'marketplace',
      'catalog',
      {},
    ])
    expect(duetQueryKeys.agents.marketplace.detail('acme-labs', 'research')).toEqual([
      'duet',
      'agents',
      'marketplace',
      'detail',
      'acme-labs',
      'research',
    ])
    expect(duetQueryKeys.workspaces.agents.marketplace.subscriptions('acme')).toEqual([
      'duet',
      'workspaces',
      'acme',
      'agents',
      'marketplace',
      'subscriptions',
    ])
  })

  test('workspace ownership is recognizable without matching another workspace', () => {
    const key = duetQueryKeys.workspaces.apps.list('acme')

    expect(isWorkspaceQueryKey(key, 'acme')).toBe(true)
    expect(isWorkspaceQueryKey(key, 'labs')).toBe(false)
    expect(isWorkspaceQueryKey(duetQueryKeys.user.profile, 'acme')).toBe(false)
  })

  test('keeps identical Train record slugs isolated across root and agent scopes', () => {
    const queryClient = new QueryClient()
    const agentA = { kind: 'agent' as const, agentSlug: 'research' }
    const agentB = { kind: 'agent' as const, agentSlug: 'writer' }
    const rootKey = duetQueryKeys.workspaces.train.records.detail(
      'acme',
      ROOT_TRAIN_SCOPE,
      'handbook',
    )
    const agentAKey = duetQueryKeys.workspaces.train.records.detail('acme', agentA, 'handbook')
    const agentBKey = duetQueryKeys.workspaces.train.records.detail('acme', agentB, 'handbook')

    queryClient.setQueryData(rootKey, 'root')
    queryClient.setQueryData(agentAKey, 'agent-a')
    queryClient.setQueryData(agentBKey, 'agent-b')

    expect(rootKey).toEqual([
      'duet',
      'workspaces',
      'acme',
      'train',
      'records',
      'detail',
      'handbook',
    ])
    expect(agentAKey).toEqual([
      'duet',
      'workspaces',
      'acme',
      'agent',
      'research',
      'train',
      'records',
      'detail',
      'handbook',
    ])
    expect(queryClient.getQueryData<string>(rootKey)).toBe('root')
    expect(queryClient.getQueryData<string>(agentAKey)).toBe('agent-a')
    expect(queryClient.getQueryData<string>(agentBKey)).toBe('agent-b')
  })

  test('keeps every root Train query key byte-identical', () => {
    expect({
      all: duetQueryKeys.workspaces.train.all('acme', ROOT_TRAIN_SCOPE),
      uploads: duetQueryKeys.workspaces.train.uploads('acme', ROOT_TRAIN_SCOPE),
      jobs: duetQueryKeys.workspaces.train.jobs('acme', ROOT_TRAIN_SCOPE),
      records: duetQueryKeys.workspaces.train.records.all('acme', ROOT_TRAIN_SCOPE),
      memoryCounts: duetQueryKeys.workspaces.train.records.memoryCounts('acme'),
      recordList: duetQueryKeys.workspaces.train.records.list('acme', ROOT_TRAIN_SCOPE),
      record: duetQueryKeys.workspaces.train.records.detail('acme', ROOT_TRAIN_SCOPE, 'handbook'),
    }).toEqual({
      all: ['duet', 'workspaces', 'acme', 'train'],
      uploads: ['duet', 'workspaces', 'acme', 'train', 'uploads'],
      jobs: ['duet', 'workspaces', 'acme', 'train', 'jobs'],
      records: ['duet', 'workspaces', 'acme', 'train', 'records'],
      memoryCounts: ['duet', 'workspaces', 'acme', 'train', 'records', 'memory-counts'],
      recordList: ['duet', 'workspaces', 'acme', 'train', 'records', 'list'],
      record: ['duet', 'workspaces', 'acme', 'train', 'records', 'detail', 'handbook'],
    })
  })

  test('a completion invalidates records and uploads only inside its Train scope', () => {
    const queryClient = new QueryClient()
    const agentA = { kind: 'agent' as const, agentSlug: 'research' }
    const agentB = { kind: 'agent' as const, agentSlug: 'writer' }
    const scopes = [ROOT_TRAIN_SCOPE, agentA, agentB] as const

    for (const scope of scopes) {
      queryClient.setQueryData(
        duetQueryKeys.workspaces.train.records.list('acme', scope),
        scope.kind,
      )
      queryClient.setQueryData(duetQueryKeys.workspaces.train.uploads('acme', scope), scope.kind)
    }
    queryClient.setQueryData(duetQueryKeys.workspaces.train.records.memoryCounts('acme'), {
      counts: { research: 1 },
    })

    invalidateAfterTrainCompletion(queryClient, 'acme', agentA)

    for (const scope of scopes) {
      const shouldInvalidate = scope === agentA
      expect(
        queryClient.getQueryState(duetQueryKeys.workspaces.train.records.list('acme', scope))
          ?.isInvalidated,
      ).toBe(shouldInvalidate)
      expect(
        queryClient.getQueryState(duetQueryKeys.workspaces.train.uploads('acme', scope))
          ?.isInvalidated,
      ).toBe(shouldInvalidate)
    }
    expect(
      queryClient.getQueryState(duetQueryKeys.workspaces.train.records.memoryCounts('acme'))
        ?.isInvalidated,
    ).toBe(true)
  })
})
