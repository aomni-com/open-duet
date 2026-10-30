import { expect, test } from 'bun:test'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'

import { resolveAgentConfig, type Agent } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { ROOT_TRAIN_SCOPE } from '../api/client'
import { duetQueryKeys } from '../api/query-keys'
import { duetQueryOptions } from '../api/query-options'
import type { TrainScope } from '../api/train-scope'
import { SpaContext, type SpaApi, type SpaContextValue } from '../context'
import { ToastProvider } from '../shell/toast'
import TrainRoute from './train'
import { invalidateTrainRecordCollections, TrainRecordDetail } from './train/train-record-detail'
import {
  legacyTrainRecordRedirectPath,
  retrainTargetFromSearch,
  retrainTrainPath,
  trainPathWithoutRetrain,
  trainPath,
  trainRecordPath,
} from './train/train-routes'
import { normalizeTrainSourceUrl } from './train/train-source-url'
import {
  activeJobsPolling,
  InheritedMemoriesCard,
  phaseCopyKey,
  planFileSelection,
  observeJobCompletions,
  TrainJobsCard,
  TrainRecordsCard,
  TrainSourceCard,
} from './train/train-surface'

const RECORD = {
  slug: 'support-handbook',
  memoryId: 'mem_support',
  createdAt: '2026-07-10T12:04:00.000Z',
  observedDate: '2026-07-10',
  headline: 'Customer support handbook',
  fileCount: 4,
  hasArchive: true,
}

const TRAIN_SCOPES: TrainScope[] = [ROOT_TRAIN_SCOPE, { kind: 'agent', agentSlug: 'research' }]
const RESEARCH: Agent = {
  id: 'agent_research',
  workspaceId: 'workspace_acme',
  anchorId: 'anchor_research',
  anchorPath: 'agents/research',
  anchorState: 'active',
  slug: 'research',
  name: 'Research',
  createdAt: 1,
  updatedAt: 2,
}
const SUPPORT: Agent = {
  ...RESEARCH,
  id: 'agent_support',
  anchorId: 'anchor_support',
  anchorPath: 'agents/support',
  slug: 'support',
  name: 'Customer Support',
}

test('keeps every Train scope inside the canonical computer hierarchy', () => {
  const agentScope = { kind: 'agent', agentSlug: 'customer success' } as const

  expect(trainPath('acme', ROOT_TRAIN_SCOPE)).toBe('/w/acme/train/root')
  expect(trainPath('acme', agentScope)).toBe('/w/acme/train/customer%20success')
  expect(trainRecordPath('acme', agentScope, 'support handbook')).toBe(
    '/w/acme/train/customer%20success/support%20handbook',
  )
})

test('invalidates the shared memory counts after a root memory changes', async () => {
  const api = {} as SpaApi
  const queryClient = new QueryClient()
  const counts = duetQueryOptions.workspaces.train.memoryCounts(api, 'acme').queryKey
  const records = duetQueryOptions.workspaces.train.recordList(
    api,
    'acme',
    ROOT_TRAIN_SCOPE,
  ).queryKey
  queryClient.setQueryData(counts, { rootCount: 1, counts: {}, trainableAgents: [] })
  queryClient.setQueryData(records, {
    pages: [{ items: [RECORD], nextCursor: null }],
    pageParams: [undefined],
  })

  await invalidateTrainRecordCollections(queryClient, api, 'acme', ROOT_TRAIN_SCOPE)

  expect(queryClient.getQueryState(counts)?.isInvalidated).toBe(true)
  expect(queryClient.getQueryState(records)?.isInvalidated).toBe(true)
})

test('accepts a bare website hostname by normalizing it to https', () => {
  expect(normalizeTrainSourceUrl('  Stripe.com  ')).toBe('https://stripe.com/')
  expect(normalizeTrainSourceUrl('docs.example.com:8443/handbook')).toBe(
    'https://docs.example.com:8443/handbook',
  )
  expect(() => normalizeTrainSourceUrl('mailto:alice@example.com')).toThrow()
  expect(() => normalizeTrainSourceUrl('http:/wiki.local')).toThrow()
})

test('a retrain target lives in the URL, so it survives a retry and can be cancelled', () => {
  // "Retry training" is the Train button relabeled after a failure, so a
  // target held in click-scoped state would be lost exactly when it is needed.
  // The URL keeps it — and because it also survives *success*, the page has to
  // be able to drop it, or a bookmarked link would silently overwrite a
  // memory weeks later.
  expect(retrainTargetFromSearch(new URLSearchParams('retrain=support-handbook'))).toBe(
    'support-handbook',
  )
  expect(retrainTargetFromSearch(new URLSearchParams(''))).toBeUndefined()
  expect(retrainTargetFromSearch(new URLSearchParams('retrain='))).toBeUndefined()
  expect(retrainTrainPath('acme', ROOT_TRAIN_SCOPE, 'support-handbook')).toBe(
    '/w/acme/train/root?retrain=support-handbook',
  )
  // A slug with a space round-trips. Asserting the encoding itself would pin
  // `+` versus `%20`, which is a detail of the encoder rather than a contract:
  // what matters is that the page reads back the slug that was written.
  const spaced = retrainTrainPath('acme', { kind: 'agent', agentSlug: 'research' }, 'customer care')
  expect(spaced.startsWith('/w/acme/train/research?')).toBe(true)
  expect(retrainTargetFromSearch(new URLSearchParams(spaced.split('?')[1]))).toBe('customer care')
  // Cancel drops only the retrain parameter.
  expect(
    trainPathWithoutRetrain('acme', ROOT_TRAIN_SCOPE, new URLSearchParams('retrain=x&tab=jobs')),
  ).toBe('/w/acme/train/root?tab=jobs')
  expect(trainPathWithoutRetrain('acme', ROOT_TRAIN_SCOPE, new URLSearchParams('retrain=x'))).toBe(
    '/w/acme/train/root',
  )
})

test('redirects legacy Train query links to canonical memory routes', () => {
  expect(
    legacyTrainRecordRedirectPath(
      'acme',
      ROOT_TRAIN_SCOPE,
      new URLSearchParams('record=support-handbook'),
    ),
  ).toBe('/w/acme/train/root/support-handbook')
  expect(
    legacyTrainRecordRedirectPath(
      'acme',
      { kind: 'agent', agentSlug: 'research' },
      new URLSearchParams('record=customer%20care'),
    ),
  ).toBe('/w/acme/train/research/customer%20care')
  expect(
    legacyTrainRecordRedirectPath('acme', ROOT_TRAIN_SCOPE, new URLSearchParams('record=')),
  ).toBeUndefined()
})

test('renders a root memory detail as its own route instead of inside Train', () => {
  const api = {} as SpaApi
  const queryClient = new QueryClient()
  queryClient.setQueryData(
    duetQueryOptions.workspaces.train.record(api, 'acme', ROOT_TRAIN_SCOPE, RECORD.slug).queryKey,
    { record: { ...RECORD, content: 'Dedicated reading canvas.' } },
  )
  const context = {
    api,
    activeWorkspaceSlug: 'acme',
    trainUploads: {},
    identity: { workspaces: [{ slug: 'acme', duetName: 'Duet' }] },
  } as SpaContextValue
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SpaContext.Provider value={context}>
        <ToastProvider>
          <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
            <MemoryRouter initialEntries={['/w/acme/train/root/support-handbook']}>
              <Routes>
                <Route
                  path="/w/:workspaceSlug/train/:agentSlug/:memorySlug"
                  element={<TrainRoute />}
                />
              </Routes>
            </MemoryRouter>
          </NextIntlClientProvider>
        </ToastProvider>
      </SpaContext.Provider>
    </QueryClientProvider>,
  )

  expect(html).toContain('Dedicated reading canvas.')
  expect(html).not.toContain('New training')
})

test('renders memory content as markdown and lists what it was trained from', () => {
  const api = {} as SpaApi
  const queryClient = new QueryClient()
  queryClient.setQueryData(
    duetQueryOptions.workspaces.train.record(api, 'acme', ROOT_TRAIN_SCOPE, RECORD.slug).queryKey,
    {
      record: {
        ...RECORD,
        content: '## Plans\n\n- **Starter** is 50,000 events\n- Team is 2,000,000\n',
        sources: [
          {
            relPath: 'url-titan-dev-pricing-a1b2c3d4.md',
            bytes: 4096,
            url: 'https://titan.dev/pricing',
            title: 'Pricing — Titan',
            scrapedAt: '2026-08-17T00:00:00.000Z',
          },
          { relPath: 'contract-2026.pdf', bytes: 421_888 },
        ],
      },
    },
  )
  const context = {
    api,
    activeWorkspaceSlug: 'acme',
    trainUploads: {},
    identity: { workspaces: [{ slug: 'acme', duetName: 'Duet' }] },
  } as SpaContextValue
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SpaContext.Provider value={context}>
        <ToastProvider>
          <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
            <MemoryRouter initialEntries={['/w/acme/train/root/support-handbook']}>
              <Routes>
                <Route
                  path="/w/:workspaceSlug/train/:agentSlug/:memorySlug"
                  element={<TrainRoute />}
                />
              </Routes>
            </MemoryRouter>
          </NextIntlClientProvider>
        </ToastProvider>
      </SpaContext.Provider>
    </QueryClientProvider>,
  )

  // Markdown is parsed into elements, not printed as characters.
  expect(html).toContain('<h2')
  expect(html).toContain('<li>')
  expect(html).toContain('<strong>Starter</strong>')
  expect(html).not.toContain('## Plans')
  // A scraped page reads as its URL, not as the slugified filename the
  // scraper happened to produce.
  expect(html).toContain('>titan.dev/pricing<')
  // The slugified filename is fine in the href — it is the file's address —
  // but it must never be the label the reader sees.
  expect(html).not.toContain('>url-titan-dev-pricing-a1b2c3d4.md<')
  // An ordinary file keeps its name and shows its size.
  expect(html).toContain('contract-2026.pdf')
  expect(html).toContain('412 KB')
  // Each source links to the bytes the archive kept.
  expect(html).toContain('/records/support-handbook/sources/contract-2026.pdf')
})

test('a pruned archive disables Retrain and says why', () => {
  const api = {} as SpaApi
  const queryClient = new QueryClient()
  queryClient.setQueryData(
    duetQueryOptions.workspaces.train.record(api, 'acme', ROOT_TRAIN_SCOPE, RECORD.slug).queryKey,
    { record: { ...RECORD, hasArchive: false, content: 'Body.' } },
  )
  const context = {
    api,
    activeWorkspaceSlug: 'acme',
    trainUploads: {},
    identity: { workspaces: [{ slug: 'acme', duetName: 'Duet' }] },
  } as SpaContextValue
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SpaContext.Provider value={context}>
        <ToastProvider>
          <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
            <MemoryRouter initialEntries={['/w/acme/train/root/support-handbook']}>
              <Routes>
                <Route
                  path="/w/:workspaceSlug/train/:agentSlug/:memorySlug"
                  element={<TrainRoute />}
                />
              </Routes>
            </MemoryRouter>
          </NextIntlClientProvider>
        </ToastProvider>
      </SpaContext.Provider>
    </QueryClientProvider>,
  )

  // The button is present but inert, and the reason sits where the sources
  // would have been — a disabled control with no explanation is a dead end.
  expect(html).toContain('>Retrain<')
  expect(html).toContain('disabled=""')
  expect(html).toContain('The original sources are no longer available.')
})

test('uses the canonical nested route to select one agent for both Train panes', () => {
  const api = {} as SpaApi
  const queryClient = new QueryClient()
  const scope = { kind: 'agent', agentSlug: RESEARCH.slug } as const
  queryClient.setQueryData(duetQueryOptions.workspaces.agents(api, 'acme').queryKey, {
    pages: [{ items: [RESEARCH, SUPPORT], nextCursor: null }],
    pageParams: [undefined],
  })
  queryClient.setQueryData(
    duetQueryOptions.workspaces.agentLookup(api, 'acme', { slug: RESEARCH.slug }).queryKey,
    RESEARCH,
  )
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.config('acme', RESEARCH.id),
    resolveAgentConfig(undefined),
  )
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.config('acme', SUPPORT.id),
    resolveAgentConfig(undefined),
  )
  queryClient.setQueryData(duetQueryOptions.workspaces.train.memoryCounts(api, 'acme').queryKey, {
    rootCount: 1,
    counts: { research: 2, support: 1 },
    trainableAgents: ['research'],
  })
  queryClient.setQueryData(
    duetQueryOptions.workspaces.train.jobPages(api, 'acme', scope).queryKey,
    {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    },
  )
  queryClient.setQueryData(
    duetQueryOptions.workspaces.train.recordList(api, 'acme', scope).queryKey,
    { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] },
  )
  queryClient.setQueryData(duetQueryOptions.workspaces.apps(api, 'acme').queryKey, {
    pages: [{ items: [], nextCursor: null, meta: { capabilities: { register: false } } }],
    pageParams: [undefined],
  })
  const context = {
    api,
    activeWorkspaceSlug: 'acme',
    trainUploads: {},
    identity: { workspaces: [{ slug: 'acme', duetName: 'Duet' }] },
  } as SpaContextValue
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SpaContext.Provider value={context}>
        <ToastProvider>
          <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
            <MemoryRouter initialEntries={['/w/acme/train/research']}>
              <Routes>
                <Route
                  path="/w/:workspaceSlug/train/:agentSlug/:memorySlug?"
                  element={<TrainRoute />}
                />
              </Routes>
            </MemoryRouter>
          </NextIntlClientProvider>
        </ToastProvider>
      </SpaContext.Provider>
    </QueryClientProvider>,
  )

  expect(html).toContain('Research memory')
  // An agent scope needs no description: the title already names it, so the
  // header stays two lines beside its avatar.
  expect(html).not.toContain('Train this agent on trusted sources')
  expect(html).toContain('Memory library')
  // Scope selection lives in the rail, which the workspace shell mounts a layer
  // above this route — so what the rail lists is pinned where it renders, in
  // train-rail.test.tsx, not through a mount that cannot show it.
  expect(html).not.toContain('Training target')
})

/* A child agent's Train page names whoever it inherits from. The route only
   looks up the agent it is scoped to, so an inherited memory's owner has to be
   resolved on its own — otherwise the parent reads as its bare slug. */
test('a child agent names the ancestor its inherited memories come from', () => {
  const api = {} as SpaApi
  const queryClient = new QueryClient()
  const CHILD: Agent = {
    ...RESEARCH,
    id: 'agent_child',
    anchorId: 'anchor_child',
    anchorPath: 'agents/research/child',
    slug: 'child',
    name: 'Research Child',
  }
  const scope = { kind: 'agent', agentSlug: CHILD.slug } as const
  for (const agent of [CHILD, RESEARCH]) {
    queryClient.setQueryData(
      duetQueryOptions.workspaces.agentLookup(api, 'acme', { slug: agent.slug }).queryKey,
      agent,
    )
  }
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.config('acme', CHILD.id),
    resolveAgentConfig(undefined),
  )
  queryClient.setQueryData(duetQueryOptions.workspaces.train.memoryCounts(api, 'acme').queryKey, {
    rootCount: 0,
    counts: { child: 1 },
    trainableAgents: ['child'],
  })
  queryClient.setQueryData(
    duetQueryOptions.workspaces.train.jobPages(api, 'acme', scope).queryKey,
    { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] },
  )
  queryClient.setQueryData(
    duetQueryOptions.workspaces.train.recordList(api, 'acme', scope).queryKey,
    {
      pages: [
        {
          items: [
            {
              ...RECORD,
              slug: 'parent-brief',
              headline: 'Parent brief',
              inherited: true,
              ownerAgentSlug: 'research',
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    },
  )
  const context = {
    api,
    activeWorkspaceSlug: 'acme',
    trainUploads: {},
    identity: { workspaces: [{ slug: 'acme', duetName: 'Duet' }] },
  } as SpaContextValue
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SpaContext.Provider value={context}>
        <ToastProvider>
          <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
            <MemoryRouter initialEntries={['/w/acme/train/child']}>
              <Routes>
                <Route
                  path="/w/:workspaceSlug/train/:agentSlug/:memorySlug?"
                  element={<TrainRoute />}
                />
              </Routes>
            </MemoryRouter>
          </NextIntlClientProvider>
        </ToastProvider>
      </SpaContext.Provider>
    </QueryClientProvider>,
  )

  expect(html).toContain('Research Child memory')
  expect(html).toContain('From Research')
  expect(html).not.toContain('From research')
})

test('keeps global training beside global memory, with the roster rail as the picker', () => {
  const api = {} as SpaApi
  const queryClient = new QueryClient()
  queryClient.setQueryData(duetQueryOptions.workspaces.agents(api, 'acme').queryKey, {
    pages: [{ items: [RESEARCH], nextCursor: null }],
    pageParams: [undefined],
  })
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.config('acme', RESEARCH.id),
    resolveAgentConfig(undefined),
  )
  queryClient.setQueryData(
    duetQueryOptions.workspaces.train.jobPages(api, 'acme', ROOT_TRAIN_SCOPE).queryKey,
    { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] },
  )
  queryClient.setQueryData(
    duetQueryOptions.workspaces.train.recordList(api, 'acme', ROOT_TRAIN_SCOPE).queryKey,
    { pages: [{ items: [RECORD], nextCursor: null }], pageParams: [undefined] },
  )
  queryClient.setQueryData(duetQueryOptions.workspaces.train.memoryCounts(api, 'acme').queryKey, {
    rootCount: 1,
    counts: { research: 2 },
    trainableAgents: ['research'],
  })
  queryClient.setQueryData(duetQueryOptions.workspaces.apps(api, 'acme').queryKey, {
    pages: [{ items: [], nextCursor: null, meta: { capabilities: { register: false } } }],
    pageParams: [undefined],
  })
  const context = {
    api,
    activeWorkspaceSlug: 'acme',
    trainUploads: {},
    identity: { workspaces: [{ slug: 'acme', duetName: 'Duet' }] },
  } as SpaContextValue
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SpaContext.Provider value={context}>
        <ToastProvider>
          <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
            <MemoryRouter initialEntries={['/w/acme/train/root']}>
              <Routes>
                <Route path="/w/:workspaceSlug/train/:agentSlug" element={<TrainRoute />} />
              </Routes>
            </MemoryRouter>
          </NextIntlClientProvider>
        </ToastProvider>
      </SpaContext.Provider>
    </QueryClientProvider>,
  )

  expect(html).toContain('Global memory')
  // The agent directory that used to sit on this page is gone: the roster and
  // each agent's memory depth are the rail's, and the rail renders above this
  // route (train-rail.test.tsx owns both).
  expect(html).not.toContain('Training target')
})

test('attributes inherited memories and links each one to its owner Train page', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <MemoryRouter>
        <InheritedMemoriesCard
          workspaceSlug="acme"
          records={[
            {
              ...RECORD,
              slug: 'root-policy',
              headline: 'Root policy',
              inherited: true,
            },
            {
              ...RECORD,
              slug: 'parent-brief',
              headline: 'Parent brief',
              inherited: true,
              ownerAgentSlug: 'research',
            },
          ]}
        />
      </MemoryRouter>
    </NextIntlClientProvider>,
  )

  expect(html).toContain('Inherited memories')
  expect(html).toContain('From Duet')
  expect(html).toContain('From research')
  expect(html).toContain('/w/acme/train/root/root-policy')
  expect(html).toContain('/w/acme/train/research/parent-brief')
})

test('an inherited-memory prefix labels its count as loaded', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <MemoryRouter>
        <InheritedMemoriesCard workspaceSlug="acme" records={[]} incomplete />
      </MemoryRouter>
    </NextIntlClientProvider>,
  )

  expect(html).toContain('0 memories loaded')
  expect(html).toContain('<span aria-hidden="true">0 loaded</span>')
  expect(html).toContain('No inherited memories loaded yet')
  expect(html).not.toContain('No inherited memories</p>')
})

test('attributes an inherited memory to its owner display name and avatar', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <MemoryRouter>
        <InheritedMemoriesCard
          workspaceSlug="acme"
          agents={[RESEARCH]}
          records={[
            { ...RECORD, slug: 'root-policy', headline: 'Root policy', inherited: true },
            {
              ...RECORD,
              slug: 'parent-brief',
              headline: 'Parent brief',
              inherited: true,
              ownerAgentSlug: 'research',
            },
            {
              ...RECORD,
              slug: 'ancestor-brief',
              headline: 'Ancestor brief',
              inherited: true,
              ownerAgentSlug: 'unlisted',
            },
          ]}
        />
      </MemoryRouter>
    </NextIntlClientProvider>,
  )

  // A resolvable owner reads as its display name; the root owner keeps the
  // product name; an owner outside the roster falls back to its slug.
  expect(html).toContain('From Research')
  expect(html).toContain('From Duet')
  expect(html).toContain('From unlisted')
  // Each row carries the owner's canonical avatar instead of a repeated brain.
  expect(html).toContain('data-agent-avatar="duet"')
  expect(html).toContain('data-agent-avatar="dicebear"')
})

test('renders replica and inherited details without mutation controls', () => {
  const api = {} as SpaApi
  const scope = { kind: 'agent', agentSlug: 'research' } as const
  const context = {
    api,
    activeWorkspaceSlug: 'acme',
  } as SpaContextValue

  for (const { inherited, readOnly } of [
    { inherited: false, readOnly: true },
    { inherited: true, readOnly: false },
  ]) {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      duetQueryOptions.workspaces.train.record(api, 'acme', scope, RECORD.slug).queryKey,
      { record: { ...RECORD, inherited, content: 'Pinned memory content.' } },
    )
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SpaContext.Provider value={context}>
          <ToastProvider>
            <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
              {/* The detail view navigates on retrain, so it needs the router
                  context it always has in production. */}
              <MemoryRouter initialEntries={['/w/acme/train/research/support-handbook']}>
                <TrainRecordDetail
                  scope={scope}
                  slug={RECORD.slug}
                  readOnly={readOnly}
                  onBack={() => {}}
                />
              </MemoryRouter>
            </NextIntlClientProvider>
          </ToastProvider>
        </SpaContext.Provider>
      </QueryClientProvider>,
    )

    expect(html).toContain('Pinned memory content.')
    expect(html).toContain('Read-only')
    expect(html).not.toContain('>Edit<')
    expect(html).not.toContain('>Delete<')
    // A memory you cannot edit is a memory you cannot retrain — it lives in
    // an ancestor's store, or this is a replica.
    expect(html).not.toContain('>Retrain<')
  }
})

test('record detail trusts bounded upload metadata when a running job is absent from the jobs page', () => {
  const api = {} as SpaApi
  const queryClient = new QueryClient()
  queryClient.setQueryData(
    duetQueryOptions.workspaces.train.record(api, 'acme', ROOT_TRAIN_SCOPE, RECORD.slug).queryKey,
    { record: { ...RECORD, inherited: false, content: 'Pinned memory content.' } },
  )
  queryClient.setQueryData(duetQueryKeys.workspaces.train.uploads('acme', ROOT_TRAIN_SCOPE), {
    pages: [
      {
        items: [],
        nextCursor: null,
        meta: { totalBytes: 0, fileCount: 0, capBytes: 1024, running: true },
      },
    ],
    pageParams: [undefined],
  })
  const context = {
    api,
    activeWorkspaceSlug: 'acme',
    trainUploads: {
      list: async () => {
        throw new Error('seeded cache should own this read')
      },
    },
  } as unknown as SpaContextValue
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SpaContext.Provider value={context}>
        <ToastProvider>
          <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
            <MemoryRouter>
              <TrainRecordDetail
                scope={ROOT_TRAIN_SCOPE}
                slug={RECORD.slug}
                readOnly={false}
                onBack={() => {}}
              />
            </MemoryRouter>
          </NextIntlClientProvider>
        </ToastProvider>
      </SpaContext.Provider>
    </QueryClientProvider>,
  )
  expect(html).toContain('disabled="" title="This memory cannot be retrained right now."')
})

function renderRecordsCards({
  error,
  records = [RECORD],
}: {
  error?: string
  records?: (typeof RECORD)[]
}) {
  const context = { activeWorkspaceSlug: 'acme' } as SpaContextValue
  return TRAIN_SCOPES.map(scope =>
    renderToStaticMarkup(
      <SpaContext.Provider value={context}>
        <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
          <MemoryRouter>
            <TrainRecordsCard
              scope={scope}
              readOnly={false}
              records={records}
              loading={false}
              error={error}
              onRetry={() => {}}
            />
          </MemoryRouter>
        </NextIntlClientProvider>
      </SpaContext.Provider>,
    ),
  )
}

test('links trained memory cards to dedicated root and agent routes', () => {
  const [root, agent] = renderRecordsCards({})

  expect(root).toContain('href="/w/acme/train/root/support-handbook"')
  expect(agent).toContain('href="/w/acme/train/research/support-handbook"')
})

function renderTrainAt(path: string, routePath: string, recordsNextCursor: string | null = null) {
  const api = {} as SpaApi
  const queryClient = new QueryClient()
  const agentScope = { kind: 'agent', agentSlug: RESEARCH.slug } as const
  queryClient.setQueryData(duetQueryOptions.workspaces.agents(api, 'acme').queryKey, {
    pages: [{ items: [RESEARCH], nextCursor: null }],
    pageParams: [undefined],
  })
  queryClient.setQueryData(
    duetQueryOptions.workspaces.agentLookup(api, 'acme', { slug: RESEARCH.slug }).queryKey,
    RESEARCH,
  )
  queryClient.setQueryData(
    duetQueryKeys.workspaces.agents.config('acme', RESEARCH.id),
    resolveAgentConfig(undefined),
  )
  queryClient.setQueryData(duetQueryOptions.workspaces.train.memoryCounts(api, 'acme').queryKey, {
    rootCount: 1,
    counts: { research: 2 },
    trainableAgents: ['research'],
  })
  for (const scope of [ROOT_TRAIN_SCOPE, agentScope]) {
    queryClient.setQueryData(
      duetQueryOptions.workspaces.train.jobPages(api, 'acme', scope).queryKey,
      {
        pages: [{ items: [], nextCursor: null }],
        pageParams: [undefined],
      },
    )
    queryClient.setQueryData(
      duetQueryOptions.workspaces.train.recordList(api, 'acme', scope).queryKey,
      { pages: [{ items: [RECORD], nextCursor: recordsNextCursor }], pageParams: [undefined] },
    )
  }
  const context = {
    api,
    activeWorkspaceSlug: 'acme',
    trainUploads: {},
    identity: { workspaces: [{ slug: 'acme', duetName: 'Duet' }] },
  } as SpaContextValue
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SpaContext.Provider value={context}>
        <ToastProvider>
          <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path={routePath} element={<TrainRoute />} />
              </Routes>
            </MemoryRouter>
          </NextIntlClientProvider>
        </ToastProvider>
      </SpaContext.Provider>
    </QueryClientProvider>,
  )
}

function renderSourceCards(overrides: Partial<Parameters<typeof TrainSourceCard>[0]> = {}) {
  return TRAIN_SCOPES.map(scope =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <TrainSourceCard
          scope={scope}
          urlDraft=""
          uploads={{ files: [], totalBytes: 0, capBytes: 1024, running: false }}
          uploadsLoading={false}
          transfers={[]}
          urlAttempts={[]}
          pending={false}
          startError={false}
          canStart={false}
          onUrlDraft={() => {}}
          onAddUrl={() => {}}
          onDismissUrl={() => {}}
          onChooseFiles={() => {}}
          onCancelUpload={() => {}}
          onRemoveSource={() => {}}
          onRetryUploads={() => {}}
          onStart={() => {}}
          {...overrides}
        />
      </NextIntlClientProvider>,
    ),
  )
}

test('a failed first upload page keeps Train staging disabled and offers retry', () => {
  for (const html of renderSourceCards({ uploadsInitialError: true, onRetryUploads: () => {} })) {
    expect(html).toContain(appEn.duetTrain.uploadsError)
    expect(html).toContain(appEn.duetTrain.retry)
    expect(html).toMatch(/<input[^>]+id="train-url[^>]+disabled=""/)
  }
})

test('a later upload-list failure keeps the valid quota prefix and offers retry', () => {
  for (const html of renderSourceCards({
    uploads: {
      files: [{ filename: 'handbook.pdf', size: 40, uploadedAt: 1 }],
      fileCount: 2,
      totalBytes: 90,
      capBytes: 100,
      running: false,
    },
    uploadsRefreshFailed: true,
    onRetryUploads: () => {},
  })) {
    expect(html).toContain('handbook.pdf')
    expect(html).toContain(appEn.duetTrain.uploadsError)
    expect(html).toContain(appEn.duetTrain.retry)
    expect(html).not.toMatch(/<input[^>]+id="train-url[^>]+disabled=""/)
  }
})

test('renders real upload progress, cancellation, and quota rejections', () => {
  const rendered = renderSourceCards({
    uploads: { files: [], totalBytes: 512, capBytes: 1024, running: false },
    transfers: [
      {
        file: new File(['abcd'], 'active.bin'),
        progress: 50,
        status: 'uploading',
      },
      {
        file: new File(['x'], 'cancelled.bin'),
        progress: 0,
        status: 'cancelled',
      },
      {
        file: new File(['x'], 'too-large.bin'),
        progress: 0,
        status: 'failed',
        error: 'quota',
      },
    ],
  })

  for (const html of rendered) {
    expect(html).toContain('Upload progress: 50%')
    expect(html).toContain('transform:scaleX(0.5)')
    expect(html).toContain('Cancelled')
    expect(html).toContain('No room for this file. Remove a source and try again.')
    // The cap is enforced, but never drawn: reserved storage is our bookkeeping,
    // not something the person training has to reason about.
    expect(html).not.toContain('storage reserved')
  }
})

test('renders staged URLs as URLs and pending or failed URL attempts distinctly', () => {
  const rendered = renderSourceCards({
    uploads: {
      files: [
        {
          filename: 'url-docs.md',
          size: 12,
          uploadedAt: 1,
          url: 'https://docs.example.com/',
        },
      ],
      totalBytes: 12,
      capBytes: 1024,
      running: false,
    },
    urlAttempts: [
      { url: 'https://pending.example.com/', status: 'pending' },
      {
        url: 'https://failed.example.com/',
        status: 'failed',
        detail: 'timeout',
      },
    ],
  })

  for (const html of rendered) {
    expect(html).toContain('https://docs.example.com/')
    expect(html).not.toContain('url-docs.md')
    expect(html).toContain('Fetching page…')
    expect(html).toContain('timeout')
  }
})

test('offers explicit bounded-page continuation for sources and job history', () => {
  for (const html of renderSourceCards({ uploadsHasMore: true, onLoadMore: () => {} })) {
    expect(html).toContain('Load more')
  }
  const jobs = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <TrainJobsCard
        scope={ROOT_TRAIN_SCOPE}
        jobs={[]}
        loading={false}
        error={false}
        hasMore
        onLoadMore={() => {}}
        onRetry={() => {}}
      />
    </NextIntlClientProvider>,
  )
  expect(jobs).toContain('Load more')
  expect(jobs).toContain('No training jobs loaded yet')
  expect(jobs).not.toContain('No training jobs yet')

  const records = renderTrainAt(
    '/w/acme/train/root',
    '/w/:workspaceSlug/train/:agentSlug',
    'older-records',
  )
  expect(records).toContain('Load more')
  expect(records).toContain('1 memory loaded')
})

test('continuation failures preserve loaded Train rows and name the retry', () => {
  for (const html of renderSourceCards({
    uploadsHasMore: true,
    uploadsPageFailed: true,
    onLoadMore: () => {},
  })) {
    expect(html).toContain('Try loading more again')
  }

  const jobs = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <TrainJobsCard
        scope={ROOT_TRAIN_SCOPE}
        jobs={[]}
        loading={false}
        error={false}
        hasMore
        pageFailed
        onLoadMore={() => {}}
        onRetry={() => {}}
      />
    </NextIntlClientProvider>,
  )
  expect(jobs).toContain('Try loading more again')
  expect(jobs).not.toContain('No training jobs yet')
})

test('keeps an in-flight URL as the single owner while its refreshed upload arrives', () => {
  const rendered = renderSourceCards({
    uploads: {
      files: [
        {
          filename: 'url-docs.md',
          size: 931,
          uploadedAt: 1,
          url: 'https://docs.example.com/handbook',
        },
      ],
      totalBytes: 931,
      capBytes: 2048,
      running: false,
    },
    urlAttempts: [{ url: 'https://docs.example.com/handbook', status: 'pending' }],
  })

  for (const html of rendered) {
    expect(html).toContain('Fetching page…')
    expect(html.match(/<li /g) ?? []).toHaveLength(1)
  }
})

test('renders localized coarse copy instead of raw active job phases', () => {
  const rendered = TRAIN_SCOPES.map(scope =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <TrainJobsCard
          scope={scope}
          jobs={[
            {
              jobId: 'train_running',
              userId: 'user_demo',
              workspaceId: 'workspace_acme',
              state: 'running',
              phase: 'snapshotting',
              createdAt: 1,
              updatedAt: 2,
            },
          ]}
          loading={false}
          error={false}
          onRetry={() => {}}
        />
      </NextIntlClientProvider>,
    ),
  )

  for (const html of rendered) {
    expect(html).toContain('Preparing your sources…')
    expect(html).not.toContain('snapshotting')
  }
  expect(
    ['preparing', 'snapshotting', 'training', 'finalizing', 'cleanup'].map(phase =>
      phaseCopyKey(phase as Parameters<typeof phaseCopyKey>[0]),
    ),
  ).toEqual(['preparing', 'preparing', 'training', 'finishing', 'finishing'])
})

test('keeps staging and Start available while another training job is running', () => {
  const rendered = renderSourceCards({
    uploads: {
      files: [{ filename: 'retained.pdf', size: 12, uploadedAt: 1 }],
      totalBytes: 12,
      capBytes: 1024,
      running: true,
    },
    transfers: [
      {
        file: new File(['x'], 'uploading.bin'),
        progress: 20,
        status: 'uploading',
      },
    ],
    urlAttempts: [{ url: 'https://pending.example.com/', status: 'pending' }],
    canStart: true,
  })

  for (const html of rendered) {
    expect(html).not.toContain('type="url" disabled=""')
    expect(html).not.toContain('staging is locked')
    expect(html).toContain('Remove retained.pdf')
    expect(html).toContain('Start training')
  }
})

test('notes silently restored sources from the initial non-running listing', () => {
  const rendered = renderSourceCards({
    uploads: {
      files: [{ filename: 'retained.pdf', size: 12, uploadedAt: 1 }],
      totalBytes: 12,
      capBytes: 1024,
      running: false,
    },
    restored: true,
  })

  for (const html of rendered) {
    expect(html).toContain('These sources are from last time.')
  }
})

test('observes each nonterminal-to-done transition once and stays silent after reload', () => {
  const running = {
    jobId: 'train_1',
    userId: 'user_demo',
    workspaceId: 'workspace_acme',
    state: 'running' as const,
    phase: 'training' as const,
    createdAt: 1,
    updatedAt: 2,
  }
  const done = {
    ...running,
    state: 'done' as const,
    phase: 'done' as const,
    updatedAt: 3,
  }

  const reloaded = observeJobCompletions(undefined, [done])
  expect(reloaded.completedJobIds).toEqual([])

  const observedRunning = observeJobCompletions(undefined, [running])
  const completed = observeJobCompletions(observedRunning.states, [done])
  expect(completed.completedJobIds).toEqual(['train_1'])

  const repeated = observeJobCompletions(completed.states, [done])
  expect(repeated.completedJobIds).toEqual([])
})

test('aligns active job polling to the five-second status rail', () => {
  expect(
    activeJobsPolling.refetchInterval({
      state: {
        data: {
          jobs: [
            {
              jobId: 'train_running',
              userId: 'user_demo',
              workspaceId: 'workspace_acme',
              state: 'running',
              phase: 'training',
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        },
      },
    }),
  ).toBe(5_000)
  expect(activeJobsPolling.refetchInterval({ state: { data: { items: [] } } })).toBe(false)
})

test('re-selecting a filename overwrites the queued source and aborts only its old PUT', () => {
  let aborted = 0
  const oldFile = new File(['old'], 'same.bin')
  const replacement = new File(['replacement'], 'same.bin')
  const plan = planFileSelection({
    staged: { files: [], totalBytes: 0, capBytes: 100, running: false },
    transfers: {
      'same.bin': {
        file: oldFile,
        progress: 20,
        status: 'uploading',
        request: {
          done: new Promise(() => {}),
          abort: () => {
            aborted += 1
          },
        },
      },
    },
    queue: [],
    files: [replacement],
  })

  for (const request of plan.abort) request.abort()
  expect(plan.transfers['same.bin']?.file).toBe(replacement)
  expect(plan.queue).toEqual(['same.bin'])
  expect(aborted).toBe(1)
})

test('rejects a file locally when overwrite-aware budget math cannot fit it', () => {
  const plan = planFileSelection({
    staged: {
      files: [{ filename: 'same.bin', size: 40, uploadedAt: 1 }],
      totalBytes: 90,
      capBytes: 100,
      running: false,
    },
    transfers: {},
    queue: [],
    files: [new File([new Uint8Array(60)], 'same.bin')],
  })

  expect(plan.error).toBe('quota')
  expect(plan.transfers['same.bin']?.status).toBe('failed')
  expect(plan.queue).toEqual([])
})

test('defers an unloaded possible replacement to the authoritative upload store', () => {
  const plan = planFileSelection({
    staged: {
      files: [{ filename: 'visible.bin', size: 10, uploadedAt: 1 }],
      fileCount: 200,
      totalBytes: 100,
      capBytes: 100,
      running: false,
    },
    transfers: {},
    queue: [],
    files: [new File([new Uint8Array(5)], 'possibly-hidden.bin')],
  })

  expect(plan.error).toBeUndefined()
  expect(plan.transfers['possibly-hidden.bin']?.status).toBe('queued')
  expect(plan.queue).toEqual(['possibly-hidden.bin'])
})

test('keeps the destructive banner and retry for records errors', () => {
  for (const html of renderRecordsCards({ error: 'gateway_unavailable' })) {
    expect(html).toContain('Trained memories could not be loaded.')
    expect(html).toContain('Try again')
  }
})

test('the website field takes a bare hostname and says so', () => {
  // The whole point of the field is that you type what you would say out loud.
  expect(normalizeTrainSourceUrl('stripe.com')).toBe('https://stripe.com/')
  expect(normalizeTrainSourceUrl('WWW.Stripe.com/docs')).toBe('https://www.stripe.com/docs')
  expect(normalizeTrainSourceUrl('stripe.com/docs?tab=api#auth')).toBe(
    'https://stripe.com/docs?tab=api#auth',
  )

  for (const html of renderSourceCards()) {
    // `type="url"` would make the browser reject `stripe.com` before our
    // normalizer ever sees it, so the field stays text with a url inputMode.
    expect(html.toLowerCase()).toContain('inputmode="url"')
    expect(html).not.toContain('type="url"')
    expect(html).toContain('placeholder="stripe.com"')
    // Nothing to add yet, so Add does not invite a click that only errors.
    const addTagStart = html!.lastIndexOf('<button', html!.indexOf('Add</button>'))
    const addOpenTag = html!.slice(addTagStart, html!.indexOf('>', addTagStart) + 1)
    expect(addOpenTag).toContain('disabled=""')
  }
})

test('a bad URL is reported at the field, not at the far end of the card', () => {
  const [html] = renderSourceCards({
    urlDraft: 'not a url',
    urlError: 'Enter a valid website URL.',
  })

  expect(html).toContain('Enter a valid website URL.')
  expect(html).toContain('aria-invalid="true"')
  expect(html).toContain('aria-describedby="train-url-error"')
  expect(html).toContain('id="train-url-error"')
  // The message sits between the field and the file picker, so it is visible
  // without scrolling past the staged sources.
  const errorIndex = html!.indexOf('Enter a valid website URL.')
  expect(errorIndex).toBeLessThan(html!.indexOf('Choose files'))
})

test('a file-count refusal is reported at the file picker, not at the URL field', () => {
  const [html] = renderSourceCards({ fileError: 'Up to 200 files.' })

  const fileErrorIndex = html!.indexOf('Up to 200 files.')
  expect(fileErrorIndex).toBeGreaterThan(html!.indexOf('Choose files'))
  expect(html).not.toContain('aria-invalid="true"')
})

test('the page names the scope you are editing, at both scopes', () => {
  const global = renderTrainAt('/w/acme/train/root', '/w/:workspaceSlug/train/:agentSlug')

  // The serif page title is the scope, so "which memory am I editing" is
  // answered before you read anything else.
  expect(global).toContain('Global memory')
  expect(global).toContain('Sources you train here become memory every agent can use.')
  // ...and the action names it too, rather than a generic "New training".
  expect(global).toContain('New global training')
  // The library card no longer repeats the page title.
  expect(global).toContain('Memory library')

  const agent = renderTrainAt(
    '/w/acme/train/research',
    '/w/:workspaceSlug/train/:agentSlug/:memorySlug?',
  )

  expect(agent).toContain('Research memory')
  expect(agent).not.toContain('New global training')
  expect(agent).not.toContain('Global memory')
})
