'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useEffect, useState } from 'react'

import type { MarketplaceListingSummary } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { DuetApiClient } from '../../spa/api/client'
import { OnboardingExperience } from '../../spa/onboarding/onboarding-experience'
import {
  createInitialOnboardingState,
  onboardingReducer,
  type OnboardingState,
} from '../../spa/onboarding/onboarding-flow'
import { ONBOARDING_GOALS } from '../../spa/onboarding/onboarding-goals'
import {
  createMockOnboardingService,
  type MarketplaceAgentCatalogSource,
  type OnboardingRecommendationsSource,
  type OnboardingService,
} from '../../spa/onboarding/onboarding-service'

const basePlaygroundService = createMockOnboardingService({ delayMs: 0 })
const playgroundService = {
  ...basePlaygroundService,
  async completeOnboarding() {
    throw new Error('Deterministic completion failure')
  },
} satisfies OnboardingService

// The visual playground must never load Stripe. Returning the same ready
// state the production API exposes after a successful authorization lets the
// real payment step render and gate completion without a provider call.
const playgroundPaymentSource = {
  async onboardingPaymentStatus() {
    return { ready: true as const }
  },
  async createOnboardingPaymentIntent() {
    return { status: 'ready' as const, paymentMethodReadyAt: Date.now() }
  },
  async completeOnboardingPayment() {
    return { ready: true as const }
  },
}

const PLAYGROUND_LISTINGS: MarketplaceListingSummary[] = [
  {
    id: 'listing-research-assistant',
    appNames: ['Insights Board'],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'research-assistant',
    title: 'Research Assistant',
    summary: 'Builds source-backed research briefs with a clear review trail.',
    skills: ['web-research', 'source-comparison', 'brief-writing'],
    tags: ['marketing', 'personal'],
    installs: 0,
    availability: 'available',
  },
  {
    id: 'listing-writing-editor',
    appNames: [],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'writing-editor',
    title: 'Writing Editor',
    summary: 'Turns working drafts into clear, decision-ready writing.',
    skills: ['editorial-review', 'fact-checking'],
    tags: ['marketing'],
    installs: 0,
    availability: 'available',
  },
  {
    id: 'listing-data-analyst',
    appNames: ['Findings Dashboard'],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'data-analyst',
    title: 'Data Analyst',
    summary: 'Profiles datasets, explains patterns, and keeps caveats visible.',
    skills: ['data-profiling', 'analysis', 'visualization'],
    tags: ['operations', 'personal'],
    installs: 0,
    availability: 'available',
  },
  {
    id: 'listing-seo-optimizer',
    appNames: [],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'seo-optimizer',
    title: 'SEO Optimizer',
    summary: 'Tunes pages and posts so the right searches find them.',
    skills: ['keyword-research', 'on-page-seo'],
    tags: ['marketing'],
    installs: 0,
    availability: 'available',
  },
  {
    id: 'listing-outreach-writer',
    appNames: [],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'outreach-writer',
    title: 'Outreach Writer',
    summary: 'Drafts personal, reply-worthy outreach and follow-up sequences.',
    skills: ['cold-email', 'follow-up-sequences'],
    tags: ['sales'],
    installs: 0,
    availability: 'available',
  },
  {
    id: 'listing-inbox-assistant',
    appNames: [],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'inbox-assistant',
    title: 'Inbox Assistant',
    summary: 'Triages email, drafts replies, and keeps the important threads warm.',
    skills: ['email-triage', 'draft-replies'],
    tags: ['operations', 'personal'],
    installs: 0,
    availability: 'available',
  },
]

const playgroundApi = new DuetApiClient()

/**
 * The real catalog when there is one, the fixture when there is not.
 *
 * The playground runs on the product's own origin, so a signed-in developer's
 * session reaches the real endpoint and the step fills with the actual
 * official agents — which is the only way to judge a picker against the
 * catalog it will really face. Signed out, or with no API running, the
 * request fails and the fixture takes over: that is also what keeps the
 * Docker visual gate deterministic, since it photographs this page with no
 * session at all.
 */
const playgroundCatalogSource = {
  async listMarketplaceCatalog(
    options: { signal?: AbortSignal; cursor?: string; verifiedPublisher?: boolean } = {},
  ) {
    if (new URL(window.location.href).searchParams.get('catalog') === 'error') {
      throw new Error('Deterministic catalog failure')
    }
    try {
      const live = await playgroundApi.listMarketplaceCatalog(options)
      if (live.items.length > 0) return live
    } catch {
      // Signed out, or no API on this machine — the fixture below is the point.
    }
    const paged = new URL(window.location.href).searchParams.get('catalog') === 'paged'
    return {
      items:
        paged && options.cursor === undefined
          ? PLAYGROUND_LISTINGS.slice(0, 4)
          : paged
            ? PLAYGROUND_LISTINGS.slice(4)
            : PLAYGROUND_LISTINGS,
      nextCursor: paged && options.cursor === undefined ? 'older-official-agents' : null,
      meta: { canPublishListings: false },
    }
  },
} satisfies MarketplaceAgentCatalogSource

/**
/**
 * `?recommendations=pending` holds the rail's skeleton on screen (the request
 * simply never settles); `?recommendations=error` exercises the silent
 * collapse to the plain catalog; `?recommendations=slow` settles after a real
 * timer. The default answers instantly with four
 * picks, reasons phrased the way the recommender echoes a goal.
 *
 * Deliberately canned, where the catalog beside it is live: a recommendation
 * is a platform-paid model call, and a fixture that spends money every time
 * someone opens it to check a margin is a fixture nobody should have to think
 * twice about opening. Real model output belongs in the staging journey,
 * which mints its own workspace to earn it.
 */
const playgroundRecommendationsSource = {
  // Honors the abort signal the way the real client's fetch does: a source
  // that shrugs off a cancellation would paint a rail the product never gets.
  async recommendOnboardingAgents(_workspaceSlug: string, _input: unknown, signal?: AbortSignal) {
    const mode = new URL(window.location.href).searchParams.get('recommendations')
    const abortable = (ms: number | null) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        const timer = ms === null ? null : setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => {
          if (timer !== null) clearTimeout(timer)
          reject(signal.reason)
        })
      })
    if (mode === 'pending') await abortable(null)
    if (mode === 'error') throw new Error('Deterministic recommendations failure')
    // `slow` answers after a real timer, the way a network does. The instant
    // default settles inside the same tick that fires the request, so it can
    // never show the request being cancelled by the render its own start causes.
    if (mode === 'slow') await abortable(400)
    return {
      recommendations: [
        {
          agentName: 'outreach-writer',
          reason: 'You said outreach and follow-up are your bottleneck — this one owns it.',
        },
        {
          agentName: 'research-assistant',
          reason: 'Scouts the B2B leads you want before you write a word.',
        },
        {
          agentName: 'seo-optimizer',
          reason: 'Turns your growth goal into search traffic that compounds.',
        },
        {
          agentName: 'writing-editor',
          reason: 'Keeps every pitch sharp while it is still just you writing.',
        },
      ],
    }
  },
} satisfies OnboardingRecommendationsSource

/**
 * `?goal=<goalId>` opens the flow mid-journey with that goal picked (its smart
 * defaults seeded, follow-ups showing); `?goal=custom` opens the goal step
 * with "Write your own" expanded; `?q=<n>` opens at the nth follow-up question
 * of that goal, clamped to the questions it actually has, and `?q=done` jumps
 * to the ready summary. Same convention as `?catalog=error`, but the state is
 * derived through the real reducer so a fixture can never seed a state the
 * product itself cannot reach.
 */
function initialStateForParams(params: URLSearchParams): Partial<OnboardingState> | undefined {
  const goal = params.get('goal')
  if (goal === null) return undefined
  if (goal === 'custom') {
    return {
      ...onboardingReducer(createInitialOnboardingState(), { type: 'choose-custom-goal' }),
      step: 'goal',
    }
  }
  const preset = ONBOARDING_GOALS.find(candidate => candidate.id === goal)
  if (preset === undefined) return undefined
  let state: OnboardingState = {
    ...onboardingReducer(createInitialOnboardingState(), { type: 'pick-goal', goalId: preset.id }),
    step: 'follow-ups',
  }
  // Walk forward through the reducer rather than setting the index directly:
  // the recap reads the answers those steps leave behind.
  const question = params.get('q')
  if (question === 'done') return { ...state, step: 'ready' }
  for (let step = 1; step < Math.min(Number(question ?? '1'), preset.questions.length); step += 1) {
    state = onboardingReducer(state, { type: 'next-question' })
  }
  return state
}

/**
 * `?campaign=<name,name>` arrives the way a campaign registrant does: those
 * agents are already installing, so the wizard is identity → ready and the
 * celebration counts them. Absent means an organic signup and the full walk.
 */
function starterAgentsForParams(params: URLSearchParams): readonly string[] {
  return (params.get('campaign') ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
}

export function OnboardingPlayground() {
  // Params are read after mount: the playground page is statically
  // prerendered, and a URL-dependent first render would break hydration.
  const [params, setParams] = useState<
    | { initialState: Partial<OnboardingState> | undefined; starterAgents: readonly string[] }
    | 'reading-url'
  >('reading-url')
  useEffect(() => {
    const search = new URL(window.location.href).searchParams
    setParams({
      initialState: initialStateForParams(search),
      starterAgents: starterAgentsForParams(search),
    })
  }, [])
  if (params === 'reading-url') return null
  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <OnboardingExperience
        service={playgroundService}
        catalogSource={playgroundCatalogSource}
        recommendationsSource={playgroundRecommendationsSource}
        paymentSource={playgroundPaymentSource}
        initialState={params.initialState}
        starterAgents={params.starterAgents}
        onComplete={() => {}}
      />
    </NextIntlClientProvider>
  )
}
