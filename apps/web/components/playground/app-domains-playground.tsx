'use client'

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'
import { useMemo, useState } from 'react'

import { TooltipProvider } from '@repo/ui/components/shadcn/tooltip'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import { duetQueryKeys } from '../../spa/api/query-keys'
import { duetQueryOptions } from '../../spa/api/query-options'
import { useAppActions } from '../../spa/apps/app-actions'
import { AppDomainDialog } from '../../spa/apps/app-domain-dialog'
import { SpaContext, type SpaContextValue } from '../../spa/context'
import { ToastProvider } from '../../spa/shell/toast'
import {
  APP_DOMAIN_STATES,
  createAppDomainsFixture,
  type AppDomainFixtureState,
} from './app-domains-fixture'

export function AppDomainsPlayground() {
  const [state, setState] = useState<AppDomainFixtureState>('verifying')
  const [locale, setLocale] = useState<'en' | 'es-419'>('en')
  const [lastRequest, setLastRequest] = useState<unknown>()
  const { fixture, client } = useMemo(
    () => ({
      fixture: createAppDomainsFixture(state, setLastRequest),
      client: new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
    }),
    [state],
  )
  const context = {
    api: fixture.api,
    identity: { workspaces: [] },
    trainUploads: {},
    transitionWorkspace: async () => undefined,
    createWorkspace: async () => ({}),
    logout: async () => {},
  } as unknown as SpaContextValue
  return (
    <QueryClientProvider client={client}>
      <SpaContext.Provider value={context}>
        <ToastProvider>
          <TooltipProvider>
            <NextIntlClientProvider
              locale={locale}
              messages={locale === 'en' ? appEn : appEs}
              timeZone="UTC"
            >
              <nav aria-label="Domain fixture controls" className="sr-only">
                {APP_DOMAIN_STATES.map(next => (
                  <button
                    type="button"
                    key={next}
                    onClick={() => {
                      setLastRequest(undefined)
                      setState(next)
                    }}
                  >
                    Domain: {next}
                  </button>
                ))}
                <button type="button" onClick={() => setLocale('es-419')}>
                  Domain: Spanish
                </button>
                <button type="button" onClick={() => fixture.holdNextMutation()}>
                  Domain: hold mutation
                </button>
                <button type="button" onClick={() => fixture.releaseMutation()}>
                  Domain: release mutation
                </button>
                <button type="button" onClick={() => fixture.completeRecheck()}>
                  Domain: complete recheck
                </button>
                <button type="button" onClick={() => fixture.refuseNextMutation('hostname_in_use')}>
                  Domain: conflict next
                </button>
                <button
                  type="button"
                  onClick={() => {
                    fixture.advance('active')
                    void client.invalidateQueries({
                      queryKey: duetQueryKeys.workspaces.apps.domain('acme', 'site'),
                    })
                  }}
                >
                  Domain: activate
                </button>
                <button
                  type="button"
                  onClick={() => {
                    fixture.advance('empty')
                    void client.invalidateQueries({
                      queryKey: duetQueryKeys.workspaces.apps.domain('acme', 'site'),
                    })
                  }}
                >
                  Domain: finish cleanup
                </button>
              </nav>
              <DomainMenuHost key={state} fixture={fixture} />
              <output data-domain-last-request className="sr-only">
                {JSON.stringify(lastRequest)}
              </output>
            </NextIntlClientProvider>
          </TooltipProvider>
        </ToastProvider>
      </SpaContext.Provider>
    </QueryClientProvider>
  )
}

function DomainMenuHost({ fixture }: { fixture: ReturnType<typeof createAppDomainsFixture> }) {
  const [open, setOpen] = useState(true)
  const app =
    useQuery(duetQueryOptions.workspaces.app(fixture.api, 'acme', 'site')).data?.app ?? fixture.app
  const actions = useAppActions('acme')
  return (
    <div className="min-h-[680px] p-6">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-medium">Customer portal</h2>
        {actions.menuFor(app)}
      </div>
      <a
        data-domain-primary-link
        href={app.canonicalUrl}
        className="mt-3 block text-sm text-primary underline"
      >
        {app.canonicalUrl}
      </a>
      {open && <AppDomainDialog workspaceSlug="acme" app={app} onClose={() => setOpen(false)} />}
      {actions.dialogs}
    </div>
  )
}
