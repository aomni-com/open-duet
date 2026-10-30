import { expect, test } from 'bun:test'

import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'

import type { App, AppListResponse } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import { projectFilesRows } from './app-rows'
import { directoryAppsQueryOptions } from './apps-context'
import { activateFilesRow } from './files-interactions'
import type { IWorkspaceAppsSource } from './lib/apps-source'

const response: AppListResponse = {
  items: [],
  nextCursor: null,
  meta: { capabilities: { register: true } },
}

test('directory apps use a folder-keyed children query and forward pagination', async () => {
  const calls: Array<{
    workspaceSlug: string
    cursor?: string
    limit?: number
    signal?: AbortSignal
  }> = []
  const source: IWorkspaceAppsSource = {
    async listApps(workspaceSlug, options) {
      calls.push({ workspaceSlug, ...options })
      return { ...response, nextCursor: options?.cursor === undefined ? 'app-100' : null }
    },
  }
  const queryClient = new QueryClient()
  const options = directoryAppsQueryOptions(source, 'acme', '/reports')

  const observer = new InfiniteQueryObserver(queryClient, options)
  const unsubscribe = observer.subscribe(() => {})
  await expect(observer.refetch()).resolves.toMatchObject({
    data: {
      items: [],
      nextCursor: 'app-100',
    },
  })
  expect([...options.queryKey]).toEqual([
    ...duetQueryKeys.workspaces.apps.children('acme', 'reports'),
  ])
  expect(calls).toHaveLength(1)
  expect(calls[0]?.workspaceSlug).toBe('acme')
  expect(calls[0]?.limit).toBe(100)
  expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
  expect(calls[0]).toMatchObject({ path: 'reports', scope: 'children' })

  await observer.fetchNextPage()
  expect(calls.at(-1)).toMatchObject({
    workspaceSlug: 'acme',
    cursor: 'app-100',
    limit: 100,
    path: 'reports',
    scope: 'children',
  })
  unsubscribe()
})

test('an app on page two decorates its folder and opens through app navigation', async () => {
  const target: App = {
    id: 'app-101',
    workspaceId: 'workspace-acme',
    anchorId: 'anchor-101',
    anchorPath: 'reports/dashboard',
    anchorState: 'active',
    command: 'bun run start',
    apiScopes: [],
    port: 41_101,
    slug: 'dashboard',
    visibility: 'folder',
    canonicalUrl: 'https://dashboard--acme.duet.so',
    runtimeStatus: 'reconciled',
    createdByUserId: 'user-1',
    createdAt: 1,
    updatedAt: 2,
    controls: {
      manageDomain: true,
      updateRuntime: true,
      makePublic: true,
      makePrivate: true,
      delete: true,
    },
  }
  const source: IWorkspaceAppsSource = {
    async listApps(_workspaceSlug, options) {
      return options?.cursor === undefined
        ? { ...response, nextCursor: 'page-2' }
        : { ...response, items: [target] }
    },
  }
  const queryClient = new QueryClient()
  const observer = new InfiniteQueryObserver(
    queryClient,
    directoryAppsQueryOptions(source, 'acme', '/reports'),
  )
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()
  const entry = {
    name: 'dashboard',
    path: '/reports/dashboard',
    type: 'directory' as const,
    isDirectory: true as const,
  }
  expect(
    projectFilesRows({ entries: [entry], apps: observer.getCurrentResult().data!.items }),
  ).toEqual([{ entry }])

  await observer.fetchNextPage()
  const [row] = projectFilesRows({
    entries: [entry],
    apps: observer.getCurrentResult().data!.items,
  })
  expect(row?.app?.app.slug).toBe('dashboard')
  const opened: string[] = []
  activateFilesRow(row!, {
    navigator: { openApp: app => opened.push(app.slug) },
    openEntry: folder => opened.push(folder.path),
  })
  expect(opened).toEqual(['dashboard'])
  unsubscribe()
})

test('a failed app continuation keeps page-one app data', async () => {
  const firstPageApp = {
    id: 'app-1',
    workspaceId: 'workspace-acme',
    anchorId: 'anchor-1',
    anchorPath: 'reports/overview',
    anchorState: 'active' as const,
    command: 'bun run start',
    apiScopes: [],
    port: 41_001,
    slug: 'overview',
    visibility: 'folder' as const,
    canonicalUrl: 'https://overview--acme.duet.so',
    runtimeStatus: 'reconciled' as const,
    createdByUserId: 'user-1',
    createdAt: 1,
    updatedAt: 2,
    controls: {
      manageDomain: true,
      updateRuntime: true,
      makePublic: true,
      makePrivate: true,
      delete: true,
    },
  }
  const source: IWorkspaceAppsSource = {
    async listApps(_workspaceSlug, options) {
      if (options?.cursor !== undefined) throw new Error('continuation failed')
      return { ...response, items: [firstPageApp], nextCursor: 'page-2' }
    },
  }
  const observer = new InfiniteQueryObserver(
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    directoryAppsQueryOptions(source, 'acme', '/reports'),
  )
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()
  await observer.fetchNextPage()

  expect(observer.getCurrentResult().isFetchNextPageError).toBe(true)
  expect(observer.getCurrentResult().data?.items.map(app => app.slug)).toEqual(['overview'])
  unsubscribe()
})
