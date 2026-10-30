'use client'

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'
import { useMemo, useState } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'

import { TooltipProvider } from '@repo/ui/components/shadcn/tooltip'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import { duetQueryOptions } from '../../spa/api/query-options'
import { useAppActions } from '../../spa/apps/app-actions'
import { duetQueryKeys } from '../../spa/api/query-keys'
import { SpaContext, useSpa, type SpaContextValue } from '../../spa/context'
import WorkspaceSettingsRoute from '../../spa/routes/workspace-settings'
import { ToastProvider } from '../../spa/shell/toast'
import {
  createWorkspaceAppDomainsFixture,
  WORKSPACE_DOMAIN_STATES,
  type WorkspaceDomainFixtureState,
} from './workspace-app-domains-fixture'

export function WorkspaceAppDomainsPlayground() {
  const [showApp, setShowApp] = useState(false)
  const [state, setState] = useState<WorkspaceDomainFixtureState>('ready')
  const [locale, setLocale] = useState<'en' | 'es-419'>('en')
  const [requests, setRequests] = useState<Array<{ path: string; method: string }>>([])
  const { fixture, client } = useMemo(
    () => ({
      fixture: createWorkspaceAppDomainsFixture(state, request =>
        setRequests(current => [...current, request]),
      ),
      client: new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
    }),
    [state],
  )
  const context = {
    api: fixture.api,
    activeWorkspaceSlug: 'acme',
    identity: {
      workspaces: [
        {
          id: 'workspace_acme',
          slug: 'acme',
          name: 'Acme',
          role: state === 'read-only' ? 'viewer' : 'owner',
        },
      ],
    },
  } as unknown as SpaContextValue
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'en' ? appEn : appEs}
      timeZone="UTC"
    >
      <QueryClientProvider client={client}>
        <SpaContext.Provider value={context}>
          <ToastProvider>
            <TooltipProvider>
              <nav aria-label="Workspace domain fixture controls" className="sr-only">
                {WORKSPACE_DOMAIN_STATES.map(next => (
                  <button
                    key={next}
                    onClick={() => {
                      setRequests([])
                      setState(next)
                    }}
                  >
                    Inventory: {next}
                  </button>
                ))}
                <button onClick={() => setLocale('es-419')}>Inventory: Spanish</button>
                <button onClick={() => fixture.failContinuation()}>
                  Inventory: fail next page
                </button>
                <button
                  onClick={() => {
                    fixture.failRefresh()
                    void client.invalidateQueries({
                      queryKey: duetQueryKeys.workspaces.appDomains('acme'),
                    })
                  }}
                >
                  Inventory: fail refresh
                </button>
                <button onClick={() => fixture.failOpen()}>Inventory: fail open</button>
                <button onClick={() => setShowApp(true)}>Inventory: show billing app</button>
                <button onClick={() => fixture.completeRechecks()}>
                  Inventory: complete recheck
                </button>
                <button onClick={() => fixture.release()}>Inventory: release loading</button>
                <button
                  onClick={() => {
                    fixture.finishCleanup('site')
                    void client.invalidateQueries({
                      queryKey: duetQueryKeys.workspaces.apps.domain('acme', 'site'),
                    })
                  }}
                >
                  Inventory: finish cleanup
                </button>
              </nav>
              <MemoryRouter key={state} initialEntries={['/w/acme/settings/app-domains']}>
                {showApp && <InventoryAppMenu />}
                <Routes>
                  <Route
                    path="/w/:workspaceSlug/settings/:surface"
                    element={<WorkspaceSettingsRoute />}
                  />
                  <Route path="*" element={<InventoryNavigationDestination />} />
                </Routes>
              </MemoryRouter>
              <output className="sr-only" data-workspace-domain-requests>
                {JSON.stringify(requests)}
              </output>
            </TooltipProvider>
          </ToastProvider>
        </SpaContext.Provider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  )
}

function InventoryNavigationDestination() {
  const location = useLocation()
  return <output data-workspace-domain-destination>{location.pathname + location.search}</output>
}

function InventoryAppMenu() {
  const { api } = useSpa()
  const app = useQuery(duetQueryOptions.workspaces.app(api, 'acme', 'billing')).data?.app
  const actions = useAppActions('acme')
  return (
    <div data-inventory-app-menu>
      {app && actions.menuFor(app)}
      {actions.dialogs}
    </div>
  )
}
