import type {
  Agent,
  MarketplaceAgentSubscription,
  MarketplaceListingSummary,
  SessionInitialHistorySnapshot,
  SessionSnapshot,
  SessionSummary,
  WhoamiResponse,
  WorkspaceSummary,
} from '@repo/contract'

import { DuetApiError } from '../../spa/api/client'
import type { TrainUploadsClient } from '../../spa/api/train-uploads'
import type { SpaApi } from '../../spa/context'
import { workspaceSessionProjection } from './session-fixture'
import {
  createFixtureApi,
  createSessionStore,
  createTrainUploadsFixture,
  OWNER_APP_CAPABILITIES,
} from './spa-fixture'

/* ============================================================================
   One registration, replayable.

   The product decides where a new account goes — the SPA's root redirect sends
   an owner whose workspace has no `onboardedAt` to `/w/:slug/onboarding`, and
   the onboarding route sends it on to `/w/:slug/agents` once the backend
   stamps one. So this fixture does not script a route order; it only holds the
   two facts the product reads (has this workspace been onboarded, and what did
   the campaign ask for) and lets the real code do the walking.

   Everything the journey needs to MOVE lives in this closure: the workspace's
   onboarding stamp, the subscriptions an install produces, and the agent the
   hand-off opens a session with. Time is the only other input — an install
   takes `INSTALL_MS` of wall clock, because a first run that resolves
   instantly hides the surface a first run actually shows.
   ========================================================================= */

/* How long a freshly-subscribed agent stays "installing" before it lands. Held
   under the chain's own poll interval so the wait resolves on the next poll —
   long enough to see the wait, short enough to replay a run repeatedly. */
const INSTALL_MS = 1_800

/** How long the unhappy run's catalog stays down before a retry can win. */
const CATALOG_RECOVERS_MS = 2_000

/** Mirrors the official hub's first-run shelf: verified publisher, no installs. */
const CATALOG: readonly MarketplaceListingSummary[] = [
  {
    id: 'listing-research-assistant',
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'research-assistant',
    title: 'Research Assistant',
    summary: 'Builds source-backed research briefs with a clear review trail.',
    skills: ['Web research', 'Source comparison', 'Brief writing'],
    tags: ['marketing', 'personal'] as const,
    appNames: ['Insights Board'],
    installs: 0,
    availability: 'available',
  },
  {
    id: 'listing-writing-editor',
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'writing-editor',
    title: 'Writing Editor',
    summary:
      "Edits drafts for structure, clarity, voice, and factual discipline while preserving the author's intent.",
    skills: ['Editorial review', 'Fact checking'],
    tags: ['marketing'] as const,
    appNames: [],
    installs: 0,
    availability: 'available',
  },
  {
    id: 'listing-data-analyst',
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'data-analyst',
    title: 'Data Analyst',
    summary: 'Turns messy datasets into reproducible analyses and decision-ready charts.',
    skills: ['Data profiling', 'Analysis', 'Visualization'],
    tags: ['operations', 'personal'] as const,
    appNames: ['Findings Dashboard'],
    installs: 0,
    availability: 'available',
  },
]

/** What a campaign landing page pre-picked for the registrant. */
const CAMPAIGN_STARTERS = ['research-assistant'] as const

export type JourneyRun = 'fresh' | 'campaign' | 'unhappy'

/** Where the run has got to, as the fixture's own calls reveal it. */
export type JourneyPhase = 'setup' | 'installing' | 'meeting' | 'drive'

export const JOURNEY_RUNS = [
  {
    id: 'fresh',
    label: 'Fresh sign-up',
    detail: 'Goal tapped through on defaults, agents picked by hand, ends in the workspace.',
  },
  {
    id: 'campaign',
    label: 'Campaign sign-up',
    detail: 'A starter agent arrives pre-picked: no team step, install wait, hand-off.',
  },
  {
    id: 'unhappy',
    label: 'Unhappy path',
    detail: 'Catalog fails first, the first "Enter Drive" fails.',
  },
] as const satisfies readonly { id: JourneyRun; label: string; detail: string }[]

export function createOnboardingJourney({
  run,
  workspaceId,
  onPhase,
}: {
  run: JourneyRun
  /* A new id per restart: the install chain remembers its cursor in
     sessionStorage under the workspace id, so a replayed campaign run would
     otherwise be told it had already finished. */
  workspaceId: string
  onPhase: (phase: JourneyPhase) => void
}): { identity: WhoamiResponse; api: SpaApi; trainUploads: TrainUploadsClient } {
  const workspace: WorkspaceSummary = {
    id: workspaceId,
    slug: 'acme',
    name: "Ada's Drive",
    status: 'active',
    servicingStatus: 'active',
    role: 'owner',
    billingUserId: 'user_owner',
    funding: { plan: null, active: true },
    creditRecovery: null,
    defaultTier: { effective: 'balanced' },
    ...(run === 'campaign' ? { onboarding: { starterAgents: [...CAMPAIGN_STARTERS] } } : {}),
  }
  const initialIdentity: WhoamiResponse = {
    user: { id: 'user_owner', email: 'ada@example.com', name: 'Ada Lovelace' },
    workspaces: [workspace],
    scopes: ['ws:acme:admin'],
    versions: { api: 1 },
    internalAdmin: false,
  }

  const runStartedAt = Date.now()
  let identity = initialIdentity
  let subscriptions: MarketplaceAgentSubscription[] = []
  let agents: Agent[] = []
  let installedAt: number | undefined
  let completionAttempts = 0
  const sessions: SessionSummary[] = []
  const snapshots: Record<string, SessionSnapshot> = {}
  const history: Record<string, SessionInitialHistorySnapshot> = {}

  /* The shell fixture answers the hundred product endpoints the workspace needs the
     moment this journey lands on it. Only the calls a first run actually moves
     through are overridden below. */
  const base = createFixtureApi(
    { current: identity },
    { current: createSessionStore() },
    { current: [] },
    { current: [] },
    {
      current: {
        id: 'user_owner',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        name: 'Ada Lovelace',
      },
    },
    { current: [] },
    { current: [] },
    { current: [] },
    () => {},
    () => {},
    () => {},
  )

  function install(names: readonly string[], at: number): void {
    names.forEach(name => {
      const listing = CATALOG.find(candidate => candidate.agentName === name)
      subscriptions = [
        ...subscriptions,
        {
          id: `subscription_${name}`,
          listingId: listing?.id ?? `listing-${name}`,
          agentName: name,
          path: `agents/${name}`,
          mode: 'subscribe',
          state: 'installing',
        },
      ]
      agents = [
        ...agents,
        {
          id: `agent_${name}`,
          workspaceId,
          anchorId: `anchor_${name}`,
          anchorPath: `agents/${name}`,
          anchorState: 'active',
          slug: name,
          name: listing?.title ?? name,
          listingSubscriptionId: `subscription_${name}`,
          createdAt: at,
          updatedAt: at,
        },
      ]
    })
  }

  /** An install lands on the clock, so the wait state is a state you can see. */
  function settleInstalls(): readonly MarketplaceAgentSubscription[] {
    if (installedAt === undefined || Date.now() - installedAt < INSTALL_MS) return subscriptions
    subscriptions = subscriptions.map(subscription =>
      subscription.state === 'installing'
        ? {
            ...subscription,
            agentId: `agent_${subscription.agentName}`,
            anchorId: `anchor_${subscription.agentName}`,
            state: 'active',
            appliedEtag: 'etag-installed',
            acknowledgedEtag: 'etag-installed',
            lastAppliedAt: installedAt,
          }
        : subscription,
    )
    return subscriptions
  }

  const api: SpaApi = {
    ...base,
    whoami: async () => identity,
    /* Recovery is on the clock rather than on a call count: the catalog is
       loaded by an effect, and an effect fires twice under React's development
       double-mount — a "fail the first call" rule would spend its failure on a
       call nobody saw. Any load inside the opening window fails; a retry, which
       a reader can only click after reading the error, is outside it. */
    listMarketplaceCatalog: async () => {
      if (run === 'unhappy' && Date.now() - runStartedAt < CATALOG_RECOVERS_MS) {
        throw new DuetApiError(503, 'unavailable')
      }
      return {
        items: [...CATALOG],
        nextCursor: null,
        meta: { canPublishListings: false },
      }
    },
    completeWorkspaceOnboarding: async (_workspaceSlug, input) => {
      completionAttempts += 1
      if (run === 'unhappy' && completionAttempts === 1) {
        throw new DuetApiError(500, 'internal')
      }
      const onboardedAt = Date.now()
      // A campaign's starters are installed by the server, not by the picker —
      // that run never shows the team step, so its names cannot be in `input`.
      const chosen = 'skip' in input ? [] : input.selectedNames
      install(run === 'campaign' ? CAMPAIGN_STARTERS : chosen, onboardedAt)
      installedAt = onboardedAt
      identity = {
        ...identity,
        workspaces: [{ ...workspace, duetName: input.duetName, onboardedAt }],
      }
      onPhase(run === 'campaign' ? 'installing' : 'drive')
      return { duetName: input.duetName, onboardedAt, results: [] }
    },
    // Keep the journey on the real onboarding payment step without loading
    // Stripe. This is the provider edge of the fixture; production still
    // performs the authorization and saves the payment method on the server.
    onboardingPaymentStatus: async () => ({ ready: true }),
    createOnboardingPaymentIntent: async () => ({
      status: 'ready' as const,
      paymentMethodReadyAt: Date.now(),
    }),
    completeOnboardingPayment: async () => ({ ready: true }),
    listMarketplaceAgentSubscriptions: async () => ({
      items: [...settleInstalls()],
      nextCursor: null,
    }),
    listAgents: async () => ({
      items: agents.map(agent => ({ ...agent })),
      nextCursor: null,
    }),
    readWorkspaceFile: async (_workspaceSlug, path) => {
      const slug = path.match(/^agents\/([^/]+)\/agent\.json$/)?.[1]
      if (slug === undefined || !agents.some(agent => agent.slug === slug)) {
        throw new DuetApiError(404, 'not_found')
      }
      const data = new TextEncoder().encode(JSON.stringify({ onboarding: { kind: 'chat' } }))
      return { data, etag: null, contentType: 'application/json', size: data.byteLength }
    },
    listWorkspaceFiles: async () => ({ items: [], nextCursor: null }),
    listApps: async () => ({
      items: [],
      nextCursor: null,
      meta: { capabilities: OWNER_APP_CAPABILITIES },
    }),
    listSessions: async () => ({ items: [...sessions], nextCursor: null }),
    getSession: async (_workspaceSlug, sessionId) => {
      const snapshot = snapshots[sessionId]
      if (snapshot === undefined) throw new DuetApiError(404, 'not_found')
      return snapshot
    },
    getSessionHistory: async (_workspaceSlug, sessionId) => ({
      items: [...(history[sessionId]?.events ?? [])].toReversed(),
      nextCursor: null,
    }),
    openAgentOnboardingSession: async (_workspaceSlug, agentSlug) => {
      const agent = agents.find(candidate => candidate.slug === agentSlug)
      if (agent === undefined) throw new DuetApiError(404, 'not_found')
      const sessionId = `session_onboarding_${agentSlug}`
      if (snapshots[sessionId] === undefined) {
        const createdAt = Date.now()
        const summary: SessionSummary = {
          id: sessionId,
          ...workspaceSessionProjection(),
          turnStatus: 'ask',
          bucket: 'asking',
          title: `Meet ${agent.name ?? agent.slug}`,
          titleOrigin: 'auto',
          titleStatus: 'complete',
          createdAt,
          updatedAt: createdAt,
          lastEventSeq: 1,
          unread: false,
          agent: { id: agent.id, name: agent.name ?? agent.slug },
        }
        sessions.unshift(summary)
        snapshots[sessionId] = {
          ...summary,
          workspaceId,
          lastDeliveredInputSeq: 1,
          cwd: agent.anchorPath,
        }
        history[sessionId] = {
          events: [
            {
              seq: 1,
              createdAt,
              event: {
                type: 'step',
                step: {
                  type: 'text',
                  text: `I'm your ${agent.name ?? agent.slug}. Tell me what you're working on and I'll set myself up around it.`,
                },
              },
            },
          ],
        }
      }
      onPhase('meeting')
      return { sessionId }
    },
    setAgentOnboarded: async (_workspaceSlug, agentSlug) => {
      const at = Date.now()
      agents = agents.map(agent =>
        agent.slug === agentSlug ? { ...agent, onboardedAt: at, updatedAt: at } : agent,
      )
      const agent = agents.find(candidate => candidate.slug === agentSlug)
      if (agent === undefined) throw new DuetApiError(404, 'not_found')
      return { agent }
    },
  }

  return { identity: initialIdentity, api, trainUploads: createTrainUploadsFixture() }
}
