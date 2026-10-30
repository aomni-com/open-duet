'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'
import { useRef, useState } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'

import type { Agent, AgentEffectiveConfig, App, SessionSummary } from '@repo/contract'
import { bucketOf, ROOT_AGENT_SCOPE } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import { useAgentActions } from '../../spa/agents/agent-actions'
import { duetQueryKeys } from '../../spa/api/query-keys'
import { SpaContext, type SpaApi, type SpaContextValue } from '../../spa/context'
import { agentSkillsQueryOptions } from '../../spa/drive/agent-profile'
import { DriveFileIconClientProvider } from '../../spa/drive/drive-file-icon'
import AgentDetailRoute from '../../spa/routes/agents'
import TrainRoute from '../../spa/routes/train'
import { ToastProvider } from '../../spa/shell/toast'
import { createDriveFileIconFixture } from './drive-file-icon-fixture'
import { workspaceSessionProjection } from './session-fixture'

const WORKSPACE = 'acme'
type Locale = 'en' | 'es-419'

// The five states the human checks (D4): a healthy agent, a shared replica, a
// disabled one, a broken one, and one whose files are missing. Each variant is a
// fully-seeded slug the detail route resolves from the cached `listAgents`
// (firewall: the list is the only source).
type Variant = {
  slug: string
  agent: Agent
  readme: string | null
  skills: readonly string[]
  sessions: readonly SessionSummary[]
  config?: AgentEffectiveConfig
}

export function AgentDetailPlayground() {
  const [locale, setLocale] = useState<Locale>('en')
  const [slug, setSlug] = useState('research')
  const [surface, setSurface] = useState<'detail' | 'train'>('detail')
  const [driveIcons] = useState(() => createDriveFileIconFixture(['agents/research/icon.svg']))
  const queryClient = useRef<QueryClient | null>(null)
  if (queryClient.current === null) queryClient.current = seededClient()

  return (
    <QueryClientProvider client={queryClient.current}>
      <SpaContext.Provider value={CONTEXT}>
        <ToastProvider>
          <DriveFileIconClientProvider client={driveIcons.client}>
            <NextIntlClientProvider
              key={locale}
              locale={locale}
              messages={locale === 'es-419' ? appEs : appEn}
              onError={() => {}}
            >
              <nav aria-label="Agent detail fixture controls" className="sr-only">
                {VARIANTS.map(variant => (
                  <button key={variant.slug} type="button" onClick={() => setSlug(variant.slug)}>
                    Agent: {variant.slug}
                  </button>
                ))}
                {/* Duet is not a VARIANT because it is not an agent row — it is
                    the reserved slug the route resolves without one. */}
                <button type="button" onClick={() => setSlug(ROOT_AGENT_SCOPE)}>
                  Agent: {ROOT_AGENT_SCOPE}
                </button>
                <button type="button" onClick={() => setLocale('en')}>
                  English
                </button>
                <button type="button" onClick={() => setLocale('es-419')}>
                  Español
                </button>
                <button type="button" onClick={() => setSurface('detail')}>
                  Surface: detail
                </button>
                <button type="button" onClick={() => setSurface('train')}>
                  Surface: train
                </button>
              </nav>

              <div className="h-screen bg-background" data-runtime-locale lang={locale}>
                <MemoryRouter
                  key={`${slug}:${locale}:${surface}`}
                  initialEntries={[
                    surface === 'train'
                      ? `/w/${WORKSPACE}/train/${slug}`
                      : `/w/${WORKSPACE}/agents/${slug}`,
                  ]}
                >
                  <AgentActionsProbe />
                  <Routes>
                    <Route
                      path="/w/:workspaceSlug/agents/:agentSlug"
                      element={<AgentDetailRoute />}
                    />
                    <Route path="/w/:workspaceSlug/train/:agentSlug" element={<TrainRoute />} />
                  </Routes>
                </MemoryRouter>
              </div>

              <output
                className="sr-only"
                data-testid="agent-detail-state"
                data-playground-wait-for-frame
                data-playground-frame-ready="true"
              >
                {JSON.stringify({ locale, slug, surface })}
              </output>
            </NextIntlClientProvider>
          </DriveFileIconClientProvider>
        </ToastProvider>
      </SpaContext.Provider>
    </QueryClientProvider>
  )
}

function AgentActionsProbe() {
  const actions = useAgentActions(WORKSPACE)
  const location = useLocation()

  return (
    <div className="sr-only">
      <button
        type="button"
        onClick={() =>
          actions.onMenuAction(
            { name: 'Encoded anchor', anchorPath: 'agents/Market briefs/東京 100%' },
            'open-in-drive',
          )
        }
      >
        Open encoded anchor in Drive
      </button>
      <button type="button" onClick={() => actions.onMenuAction({ name: 'Duet' }, 'open-in-drive')}>
        Open anchorless agent in Drive
      </button>
      <button
        type="button"
        onClick={() =>
          actions.onMenuAction(
            { name: 'Malformed anchor', anchorPath: '/agents/research' },
            'open-in-drive',
          )
        }
      >
        Open malformed anchor in Drive
      </button>
      <output data-testid="agent-action-location">{location.pathname}</output>
      {actions.dialogs}
    </div>
  )
}

// The route only closes over `api` inside query functions, and a fully-seeded
// client with an infinite `staleTime` never fetches, so the stub is never called.
const CONTEXT = {
  api: {} as unknown as SpaApi,
  // Duet's name lives on the workspace identity, because the drive root has no
  // agent row to carry one — so the root variant reads it from here.
  identity: { workspaces: [{ slug: WORKSPACE, duetName: 'Milo' }] },
  trainUploads: {},
  transitionWorkspace: async () => undefined,
  createWorkspace: async () => ({}),
  logout: async () => {},
} as unknown as SpaContextValue

function agent(overrides: Partial<Agent> & Pick<Agent, 'id' | 'slug' | 'anchorPath'>): Agent {
  return {
    workspaceId: 'workspace_acme',
    anchorId: `anchor_${overrides.id}`,
    anchorState: 'active',
    createdAt: 1_749_950_000_000,
    updatedAt: 1_750_000_050_000,
    ...overrides,
  }
}

function session(
  id: string,
  title: string,
  turnStatus: SessionSummary['turnStatus'],
): SessionSummary {
  return {
    id,
    ...workspaceSessionProjection(),
    turnStatus,
    bucket: bucketOf({ turnStatus }),
    title,
    titleOrigin: 'manual',
    titleStatus: 'complete',
    createdAt: Date.UTC(2026, 6, 10, 8),
    updatedAt: Date.UTC(2026, 6, 20, 9),
    lastEventSeq: 4,
    unread: false,
  }
}

function app(id: string, slug: string, name: string, anchorPath: string): App {
  return {
    id,
    workspaceId: 'workspace_acme',
    anchorId: `anchor_${id}`,
    anchorPath,
    anchorState: 'active',
    command: 'bun run start',
    apiScopes: [],
    port: 4173,
    slug,
    name,
    visibility: 'folder',
    canonicalUrl: `https://${slug}--acme.duet.so`,
    runtimeStatus: 'reconciled',
    createdByUserId: 'user_fixture',
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
}

const ROOT_README = `# Duet

Runs the drive itself, and whatever no other agent has claimed.

Ask it anything that is not one agent's job: moving files around, checking on
work in flight, or starting something that does not have a home yet.
`

const RESEARCH_README = `# Research

Synthesizes sources into decision-ready briefs.

## How it works

- Pulls from the drive, the web, and connected tools.
- Cites every claim back to a source.
- Ends with a one-paragraph recommendation.
`

const SCHEDULER_README = `# Nightly Scheduler

Runs the overnight export relay and verifies the results.
`

const APPS: readonly App[] = [
  // Under no agent's anchor, so `groupAppsByAgent` files it under `.root` and
  // the default agent's page is the only one that shows it. Without one of
  // these, that page's Apps card renders "No apps yet" and proves nothing.
  app('app_root_inbox', 'inbox', 'Drive inbox', 'apps/inbox'),
  app('app_research_briefs', 'briefs', 'Brief builder', 'agents/research/briefs'),
  app('app_research_sources', 'sources', 'Source library', 'agents/research/sources'),
  app('app_finance_forecast', 'forecast', 'Forecast board', 'agents/finance-copilot/forecast'),
  app(
    'app_hidden_onboarding',
    'hidden-picker',
    'Hidden onboarding picker',
    'agents/onboarded-hidden/.onboarding/picker',
  ),
  app(
    'app_hidden_regular',
    'hidden-briefs',
    'Visible sibling app',
    'agents/onboarded-hidden/briefs',
  ),
  app(
    'app_visible_onboarding',
    'visible-picker',
    'Visible onboarding picker',
    'agents/onboarded-visible/.onboarding/picker',
  ),
]

const VARIANTS: readonly Variant[] = [
  {
    slug: 'research',
    agent: agent({
      id: 'agent_research',
      slug: 'research',
      name: 'Research',
      anchorPath: 'agents/research',
      icon: 'icon.svg',
    }),
    readme: RESEARCH_README,
    skills: ['deep-research', 'summarize', 'cite', 'fact-check', 'outline'],
    sessions: [
      session('research_1', 'Compare vector database vendors', 'ask'),
      session('research_2', 'Summarize the Q3 competitor moves', 'complete'),
      session('research_3', 'Draft the market-entry brief', 'running'),
    ],
  },
  {
    slug: 'finance-copilot',
    agent: agent({
      id: 'agent_finance',
      slug: 'finance-copilot',
      name: 'Finance Copilot',
      anchorPath: 'agents/finance-copilot',
      sourceShareId: 'share_finance',
    }),
    readme: '# Finance Copilot\n\nModels revenue scenarios and pipeline forecasts.\n',
    skills: ['forecasting', 'modeling'],
    sessions: [session('finance_1', 'Forecast the December pipeline', 'running')],
    config: {
      readable: true,
      tags: [],
      trainable: true,
      onboarding: { kind: 'chat' },
    },
  },
  {
    slug: 'non-trainable',
    agent: agent({
      id: 'agent_non_trainable',
      slug: 'non-trainable',
      name: 'Non-trainable Agent',
      anchorPath: 'agents/non-trainable',
    }),
    readme: '# Non-trainable Agent\n\nThis agent ships with a fixed knowledge base.\n',
    skills: ['fixed-knowledge'],
    sessions: [],
    config: { readable: true, trainable: false, tags: [] },
  },
  {
    slug: 'onboarded-hidden',
    agent: agent({
      id: 'agent_onboarded_hidden',
      slug: 'onboarded-hidden',
      name: 'Onboarded Hidden App',
      anchorPath: 'agents/onboarded-hidden',
      onboardedAt: 1_750_000_100_000,
    }),
    readme: '# Onboarded Hidden App\n\nIts setup app disappears after onboarding.\n',
    skills: [],
    sessions: [],
    config: {
      readable: true,
      tags: [],
      trainable: true,
      onboarding: {
        kind: 'app',
        app: '.onboarding/picker',
        hideAfterOnboarded: true,
      },
    },
  },
  {
    slug: 'onboarded-visible',
    agent: agent({
      id: 'agent_onboarded_visible',
      slug: 'onboarded-visible',
      name: 'Onboarded Visible App',
      anchorPath: 'agents/onboarded-visible',
      onboardedAt: 1_750_000_100_000,
    }),
    readme: '# Onboarded Visible App\n\nIts setup app remains a normal app.\n',
    skills: [],
    sessions: [],
    config: {
      readable: true,
      tags: [],
      trainable: true,
      onboarding: {
        kind: 'app',
        app: '.onboarding/picker',
        hideAfterOnboarded: false,
      },
    },
  },
  {
    slug: 'nightly-scheduler',
    agent: agent({
      id: 'agent_scheduler',
      slug: 'nightly-scheduler',
      name: 'Nightly Scheduler',
      anchorPath: 'agents/nightly-scheduler',
      disabledAt: 1_750_000_090_000,
    }),
    readme: SCHEDULER_README,
    skills: ['cron'],
    sessions: [],
    config: {
      readable: true,
      tags: [],
      trainable: true,
    },
  },
  {
    slug: 'legacy-importer',
    agent: agent({
      id: 'agent_legacy',
      slug: 'legacy-importer',
      name: 'Legacy Importer',
      anchorPath: 'agents/legacy-importer',
      anchorState: 'broken',
    }),
    // A broken anchor means the folder is gone: the reads 404, so the canvas
    // degrades to an empty README and no skills — the health pill carries
    // the broken state.
    readme: null,
    skills: [],
    sessions: [session('legacy_1', 'Import the 2024 archive', 'interrupted')],
  },
  {
    slug: 'blank-agent',
    agent: agent({
      id: 'agent_blank',
      slug: 'blank-agent',
      name: 'Blank Agent',
      anchorPath: 'agents/blank-agent',
    }),
    // A healthy anchor whose files were never written: every read 404s, and the
    // canvas stays readable — an empty README note and no skills.
    readme: null,
    skills: [],
    sessions: [],
  },
]

function seededClient(): QueryClient {
  // An infinite staleTime and no retries: the seeded cache is authoritative and
  // nothing ever fetches, so the canvas is deterministic and the stub api is
  // never called.
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })

  client.setQueryData(duetQueryKeys.workspaces.agents.list(WORKSPACE), {
    pages: [{ items: VARIANTS.map(variant => variant.agent), nextCursor: null }],
    pageParams: [undefined],
  })
  for (const variant of VARIANTS) {
    client.setQueryData(
      duetQueryKeys.workspaces.agents.lookup(WORKSPACE, { slug: variant.agent.slug }),
      variant.agent,
    )
  }

  // The drive root's own reads, keyed on ROOT_AGENT_SCOPE exactly as the route
  // asks for them. It owns the global skills and the apps no agent claimed.
  client.setQueryData(duetQueryKeys.workspaces.agents.profile(WORKSPACE, ROOT_AGENT_SCOPE), {
    role: 'Runs the drive itself, and whatever no other agent has claimed.',
    skills: ['remember', 'schedule-task', 'find-skills'],
  })
  seedSkills(client, ROOT_AGENT_SCOPE, '', ['remember', 'schedule-task', 'find-skills'])
  client.setQueryData(
    duetQueryKeys.workspaces.agents.readme(WORKSPACE, ROOT_AGENT_SCOPE),
    ROOT_README,
  )
  client.setQueryData(duetQueryKeys.workspaces.apps.list(WORKSPACE), {
    pages: [
      {
        items: APPS,
        // The healthy detail fixture keeps one older page behind the explicit
        // control so the visual baseline owns the agent Apps continuation.
        nextCursor: 'older-apps',
        meta: { capabilities: { register: false } },
      },
    ],
    pageParams: [undefined],
  })

  // The pinned Duet card's session preview (roster) belongs to the drive root.
  seedSessions(client, ROOT_AGENT_SCOPE, [
    session('root_1', 'Prepare the launch readiness report', 'running'),
    session('root_2', 'Reconcile the weekly inventory', 'complete'),
  ])

  for (const variant of VARIANTS) {
    const agentId = variant.agent.id
    client.setQueryData(duetQueryKeys.workspaces.agents.profile(WORKSPACE, agentId), {
      role: variant.readme?.split('\n').find(line => line.trim() && !line.startsWith('#')),
      skills: variant.skills,
    })
    seedSkills(client, agentId, variant.agent.anchorPath, variant.skills)
    client.setQueryData(duetQueryKeys.workspaces.agents.readme(WORKSPACE, agentId), variant.readme)
    client.setQueryData(
      duetQueryKeys.workspaces.agents.config(WORKSPACE, agentId),
      variant.config ?? { readable: true, trainable: true, tags: [] },
    )
    seedSessions(client, agentId, variant.sessions)
  }
  return client
}

function seedSkills(
  client: QueryClient,
  agentId: string,
  anchorPath: string,
  skills: readonly string[],
): void {
  client.setQueryData(
    agentSkillsQueryOptions(CONTEXT.api, WORKSPACE, { id: agentId, anchorPath }).queryKey,
    { pages: [{ items: [...skills], nextCursor: null }], pageParams: [undefined] },
  )
}

function seedSessions(
  client: QueryClient,
  agentId: string,
  sessions: readonly SessionSummary[],
): void {
  client.setQueryData(
    duetQueryKeys.workspaces.sessions.list(WORKSPACE, {
      search: '',
      archived: 'exclude',
      agentId,
    }),
    { pages: [{ items: sessions, nextCursor: null }], pageParams: [undefined] },
  )
}
