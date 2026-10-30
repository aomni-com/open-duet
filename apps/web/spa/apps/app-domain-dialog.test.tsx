import { afterEach, expect, test } from 'bun:test'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { AppDomain } from '@repo/contract'
import { TooltipProvider } from '@repo/ui/components/shadcn/tooltip'

import { createAppDomainsFixture } from '../../components/playground/app-domains-fixture'
import appEn from '../../messages/en/app.json'
import { duetQueryKeys } from '../api/query-keys'
import { SpaContext, type SpaContextValue } from '../context'
import { AppDomainPanel } from './app-domain-dialog'

const clients: QueryClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
})

function queryClient() {
  const client = new QueryClient()
  clients.push(client)
  return client
}

test('operator-required domain repair preserves diagnostics and suppresses ordinary mutation controls', () => {
  const fixture = createAppDomainsFixture('operator-repair')
  const client = queryClient()
  const domain: AppDomain = {
    id: 'domain_1',
    workspaceId: 'workspace_acme',
    appId: 'app_site',
    hostname: 'portal.example.com',
    status: 'removing',
    records: [],
    conflicts: [],
    lastError: 'The provider operation has an uncertain outcome.',
    operatorRepairRequired: true,
    createdAt: 1,
    updatedAt: 1,
  }
  client.setQueryData(duetQueryKeys.workspaces.apps.domain('acme', 'site'), { domain })
  const context = { api: fixture.api } as unknown as SpaContextValue
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <QueryClientProvider client={client}>
        <SpaContext.Provider value={context}>
          <TooltipProvider>
            <AppDomainPanel workspaceSlug="acme" app={fixture.app} />
          </TooltipProvider>
        </SpaContext.Provider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  )
  expect(markup).toContain('Domain repair needs support')
  expect(markup).toContain('The provider operation has an uncertain outcome.')
  expect(markup).not.toContain('>Recheck<')
  expect(markup).not.toContain('>Retry cleanup<')
  expect(markup).not.toContain('>Remove domain<')
})

test('cached active-domain checking retains its address, disables recheck, and enables removal', async () => {
  const fixture = createAppDomainsFixture('active')
  const domain = (await fixture.api.getAppDomain('acme', 'site')).domain!
  const client = queryClient()
  client.setQueryData(duetQueryKeys.workspaces.apps.domain('acme', 'site'), {
    domain: { ...domain, checking: true },
  })
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <QueryClientProvider client={client}>
        <SpaContext.Provider value={{ api: fixture.api } as unknown as SpaContextValue}>
          <TooltipProvider>
            <AppDomainPanel workspaceSlug="acme" app={fixture.app} />
          </TooltipProvider>
        </SpaContext.Provider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  )
  const buttons = [...markup.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)]
  expect(markup).toContain('Rechecking…')
  expect(markup).toContain('href="https://portal.example.com"')
  expect(buttons.find(([, , body]) => body?.includes('Rechecking…'))?.[1]).toContain('disabled=""')
  const removal = buttons.find(([, , body]) => body?.includes('Remove domain'))
  expect(removal).toBeDefined()
  expect(removal?.[1]).not.toContain('disabled=""')
})

test('a queued failed-domain recheck identifies the retained diagnostic as a previous result', async () => {
  const fixture = createAppDomainsFixture('failed')
  const domain = (await fixture.api.getAppDomain('acme', 'site')).domain!
  const client = queryClient()
  client.setQueryData(duetQueryKeys.workspaces.apps.domain('acme', 'site'), {
    domain: { ...domain, checking: true },
  })
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <QueryClientProvider client={client}>
        <SpaContext.Provider value={{ api: fixture.api } as unknown as SpaContextValue}>
          <TooltipProvider>
            <AppDomainPanel workspaceSlug="acme" app={fixture.app} />
          </TooltipProvider>
        </SpaContext.Provider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  )
  expect(markup).toContain('Previous check')
  expect(markup).toContain(domain.lastError!)
  expect(markup).toContain('Rechecking…')
})
