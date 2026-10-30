import { expect, test } from 'bun:test'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { App } from '@repo/contract'

import { duetQueryOptions } from '../api/query-options'
import { SpaContext, type SpaApi, type SpaContextValue } from '../context'
import { TRANSCRIPT_SNAPSHOT } from './projection/fixtures'
import { useSessionPaneApp } from './session-pane-app'

const APP: App = {
  id: 'app_reports',
  workspaceId: 'workspace_acme',
  anchorId: 'anchor_reports',
  anchorPath: 'apps/reports',
  anchorState: 'active',
  command: 'bun run start',
  apiScopes: [],
  port: 41_000,
  slug: 'reports',
  visibility: 'folder',
  canonicalUrl: 'https://reports--acme.edge.example/',
  runtimeStatus: 'reconciled',
  createdByUserId: 'user_1',
  createdAt: 1,
  updatedAt: 1,
  controls: {
    manageDomain: true,
    updateRuntime: true,
    makePublic: true,
    makePrivate: false,
    delete: true,
  },
}

test('returns the server lookup app for an anchor cwd', () => {
  expect(selectedPaneApp('apps/reports', [APP])).toEqual(APP)
})

test('returns the server lookup app for a nested cwd', () => {
  expect(selectedPaneApp('apps/reports/src/charts', [APP])).toEqual(APP)
})

test('returns no pane when the server lookup has no sibling match', () => {
  expect(selectedPaneApp('apps/reports-archive', [])).toBeUndefined()
})

test('preserves the nested app and its failed runtime state from the server lookup', () => {
  const editor: App = {
    ...APP,
    id: 'app_editor',
    anchorId: 'anchor_editor',
    anchorPath: 'apps/reports/editor',
    slug: 'editor',
    runtimeStatus: 'reconcile_failed',
    reconciliationError: 'process exited',
  }

  expect(selectedPaneApp('apps/reports/editor/src', [editor])).toEqual(editor)
})

test('uses the cwd lookup result independently of the first 100 browser rows', () => {
  expect(selectedPaneApp('apps/reports', [APP], 'success', 100)).toEqual(APP)
})

test('returns no pane for an empty outside-app lookup', () => {
  expect(selectedPaneApp('notes/meeting', [])).toBeUndefined()
})

test('returns no pane while the cwd lookup query is pending', () => {
  expect(selectedPaneApp('apps/reports', [APP], 'loading')).toBeUndefined()
})

test('returns no pane when the cwd lookup query has failed', () => {
  expect(selectedPaneApp('apps/reports', [APP], 'error')).toBeUndefined()
})

function selectedPaneApp(
  cwd: string | undefined,
  lookupItems: App[],
  queryState: 'success' | 'loading' | 'error' = 'success',
  browserRows = 0,
): App | undefined {
  const api = {} as SpaApi
  const queryClient = new QueryClient()
  const appsOptions = duetQueryOptions.workspaces.appLookup(api, 'acme', { cwd: cwd ?? '.' })
  if (browserRows > 0) {
    queryClient.setQueryData(duetQueryOptions.workspaces.apps(api, 'acme').queryKey, {
      pages: [
        {
          items: Array.from({ length: browserRows }, (_, index) => ({
            ...APP,
            id: `earlier-${index}`,
            slug: `earlier-${index}`,
            anchorId: `earlier-anchor-${index}`,
            anchorPath: `apps/earlier-${index}`,
          })),
          nextCursor: 'app-100',
          meta: { capabilities: { register: false } },
        },
      ],
      pageParams: [undefined],
    })
  }
  if (queryState !== 'loading') {
    queryClient.setQueryData(appsOptions.queryKey, {
      items: lookupItems,
      nextCursor: null,
      meta: { capabilities: { register: false } },
    })
  }
  if (queryState === 'error') {
    const query = queryClient.getQueryCache().find({ queryKey: appsOptions.queryKey })
    query?.setState({ ...query.state, error: new Error('apps unavailable'), status: 'error' })
  }
  const context = {
    api,
    activeWorkspaceSlug: 'acme',
    identity: { workspaces: [] },
  } as unknown as SpaContextValue
  let selected: App | undefined

  function Probe() {
    selected = useSessionPaneApp('acme', { ...TRANSCRIPT_SNAPSHOT, cwd })
    return null
  }

  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SpaContext.Provider, { value: context }, createElement(Probe)),
    ),
  )
  return selected
}
