/* The drive inside an agent card is the drive, mounted somewhere else.

   `FilesSurface` reads the workspace's apps out of context — that is how a
   folder an app is anchored to draws as the app rather than as a folder — and
   the hooks that read it throw when nobody supplied it. So a mount point that
   forgets the provider does not degrade to a drive without apps: it takes the
   whole destination down to the route boundary. */
import { afterEach, expect, test } from 'bun:test'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import appEn from '../../../messages/en/app.json'
import { duetQueryKeys } from '../../api/query-keys'
import { SpaContext, type SpaApi, type SpaContextValue } from '../../context'
import { ToastProvider } from '../../shell/toast'
import { AgentDrive } from './agent-drive'

const clients: QueryClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
})

function renderAgentDrive(path: string, queryClient = new QueryClient()): string {
  clients.push(queryClient)
  /* A real mount always knows who is signed in — the drive stamps that identity
     on every file dropped into it, so a stub without one is not a smaller
     context, it is a context production never produces. */
  const spa = {
    api: {} as SpaApi,
    identity: { user: { id: 'user-one' } },
  } as unknown as SpaContextValue
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <QueryClientProvider client={queryClient}>
        <SpaContext.Provider value={spa}>
          <ToastProvider>
            <MemoryRouter>
              <AgentDrive workspaceSlug="acme" agentSlug="analyst" path={path} />
            </MemoryRouter>
          </ToastProvider>
        </SpaContext.Provider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  )
}

test('AgentDrive initial markup mounts the Files surface with its apps provider', () => {
  expect(renderAgentDrive('/agents/analyst')).toContain('data-files-surface')
})

test('supplied incomplete folder-app pages render an explicit continuation control', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(duetQueryKeys.workspaces.files.view('acme', '/agents/analyst'), {
    status: 'folder',
    requestedPath: '/agents/analyst',
    folderPath: '/agents/analyst',
    entries: [],
    pages: { first: { items: [], nextCursor: null }, continuations: [] },
    continuation: 'idle',
  })
  queryClient.setQueryData(duetQueryKeys.workspaces.apps.children('acme', 'agents/analyst'), {
    pages: [
      {
        items: [],
        nextCursor: 'page-2',
        meta: { capabilities: { register: false } },
      },
    ],
    pageParams: [undefined],
  })

  const html = renderAgentDrive('/agents/analyst', queryClient)
  expect(html).toContain('0 loaded')
  expect(html).toContain('More app details')
  expect(html).toContain('>Load more</button>')
})

test('supplied incomplete directory markup reports a loaded prefix', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(duetQueryKeys.workspaces.files.view('acme', '/agents/analyst'), {
    status: 'folder',
    requestedPath: '/agents/analyst',
    folderPath: '/agents/analyst',
    entries: [
      {
        name: 'first.md',
        path: '/agents/analyst/first.md',
        type: 'file',
        isDirectory: false,
        size: 12,
      },
    ],
    pages: {
      first: {
        items: [
          {
            name: 'first.md',
            path: '/agents/analyst/first.md',
            type: 'file',
            isDirectory: false,
            size: 12,
          },
        ],
        nextCursor: 'page-2',
      },
      continuations: [],
    },
    continuation: 'idle',
  })

  expect(renderAgentDrive('/agents/analyst', queryClient)).toContain('1 loaded')
})

test('client-hidden entries do not make a known nonempty folder claim it is empty', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(duetQueryKeys.workspaces.files.view('acme', '/agents/analyst'), {
    status: 'folder',
    requestedPath: '/agents/analyst',
    folderPath: '/agents/analyst',
    entries: [
      {
        name: '.secret',
        path: '/agents/analyst/.secret',
        type: 'file',
        isDirectory: false,
        size: 12,
      },
    ],
    pages: {
      first: {
        items: [
          {
            name: '.secret',
            path: '/agents/analyst/.secret',
            type: 'file',
            isDirectory: false,
            size: 12,
          },
        ],
        nextCursor: null,
      },
      continuations: [],
    },
    continuation: 'idle',
  })

  expect(renderAgentDrive('/agents/analyst', queryClient)).not.toContain('Empty folder')
})
