'use client'

import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import type { Agent, AgentEffectiveConfig, App, MarketplaceAgentSubscription } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import { duetQueryOptions } from '../api/query-options'
import { useSpa } from '../context'
import { agentConfigQueryOptions } from '../drive/agent-config'
import { onboardingAppCwd, resolveOnboardingApp } from '../drive/agent-onboarding-projection'
import {
  ONBOARDING_WATCH_POLL_MS,
  type OnboardingCompleteNavigationState,
} from '../drive/agent-onboarding-watch'
import { agentsMapUrl } from '../drive/agents-map-url'
import {
  nextChainState,
  type OnboardingChainConfig,
  type OnboardingChainStep,
} from './onboarding-chain'
import { ChainOwnedAgentContext } from './onboarding-chain-context'
import { chainStorageKey, readStoredChain, writeStoredChain } from './onboarding-chain-storage'
import { OnboardingChainTransition } from './onboarding-chain-transition'

type ActiveOnboarding = {
  id: string
  slug: string
  name: string
}

const EMPTY_CHAIN_STEPS: readonly string[] = []

export function OnboardingChainOrchestrator({ children }: { children: ReactNode }) {
  const { api, identity } = useSpa()
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [openingSlug, setOpeningSlug] = useState<string>()
  const [cursorState, setCursorState] = useState<{ key: string; cursor: number }>()
  const openingRef = useRef<string | undefined>(undefined)
  const activeOnboarding = useRef<ActiveOnboarding | undefined>(undefined)
  const finalizedRef = useRef<string | undefined>(undefined)

  const workspaceSlug = workspaceSlugFromPath(location.pathname)
  const workspace = identity.workspaces.find(candidate => candidate.slug === workspaceSlug)
  const projectedSteps = workspace?.onboarding?.starterAgents ?? EMPTY_CHAIN_STEPS
  const storageKey = workspace === undefined ? undefined : chainStorageKey(workspace.id)
  const stored = useMemo(
    () => readStoredChain(storageKey, projectedSteps),
    [projectedSteps, storageKey],
  )
  const stepSlugs = useMemo(
    () => (projectedSteps.length > 0 ? [...projectedSteps] : [...(stored?.steps ?? [])]),
    [projectedSteps, stored],
  )
  const steps = useMemo<OnboardingChainStep[]>(() => stepSlugs.map(slug => ({ slug })), [stepSlugs])
  const eligible =
    workspace?.role === 'owner' && workspace.onboardedAt !== undefined && steps.length > 0
  const cursor =
    eligible && storageKey !== undefined
      ? cursorState?.key === storageKey
        ? cursorState.cursor
        : (stored?.cursor ?? 0)
      : 0
  const enabled = eligible && cursor < steps.length
  const completedSlugs = stepSlugs.slice(0, cursor)

  const subscriptions = useQuery({
    ...duetQueryOptions.workspaces.agentSubscriptions(api, workspaceSlug ?? ''),
    enabled,
    refetchInterval: enabled ? ONBOARDING_WATCH_POLL_MS : false,
  })
  const agents = useInfiniteQuery({
    ...duetQueryOptions.workspaces.agents(api, workspaceSlug ?? ''),
    enabled,
    refetchInterval: enabled ? ONBOARDING_WATCH_POLL_MS : false,
  })
  const activeAgents = useMemo(
    () =>
      campaignAgentsWithLandedSubscriptions(
        steps,
        subscriptions.data?.items ?? [],
        agents.data?.items ?? [],
      ),
    [agents.data, steps, subscriptions.data],
  )
  const configQueries = useQueries({
    queries: activeAgents.map(agent => ({
      ...agentConfigQueryOptions(api, workspaceSlug ?? '', agent),
      enabled,
    })),
  })
  const appCwds = activeAgents.map((agent, index) => {
    const config = configQueries[index]?.data
    return config === undefined ? undefined : onboardingAppCwd(config, agent.anchorPath)
  })
  const appLookups = useQueries({
    queries: appCwds.map(cwd => ({
      ...duetQueryOptions.workspaces.appLookup(api, workspaceSlug ?? '', { cwd: cwd ?? '.' }),
      enabled: enabled && cwd !== undefined,
      refetchInterval: enabled && cwd !== undefined ? ONBOARDING_WATCH_POLL_MS : false,
    })),
    combine: results => ({
      items: results.flatMap(result => result.data?.items ?? []),
      allResolved: results.every(
        (result, index) => appCwds[index] === undefined || result.isSuccess,
      ),
    }),
  })
  const apps = appLookups.items
  const configs = useMemo(
    () =>
      projectChainConfigs(
        activeAgents,
        configQueries.map(query => query.data),
        apps,
      ),
    [activeAgents, apps, configQueries],
  )
  const liveReady =
    subscriptions.isSuccess &&
    agents.isSuccess &&
    configQueries.every(query => query.isSuccess) &&
    appLookups.allResolved
  const state =
    enabled && liveReady
      ? nextChainState({
          steps,
          completedSlugs,
          subscriptions: subscriptions.data?.items ?? [],
          agents: agents.data?.items ?? [],
          configs,
        })
      : enabled
        ? { phase: 'installing' as const, step: steps[cursor] ?? steps[0]! }
        : { phase: 'done' as const }
  const stateSlug = state.phase === 'done' ? undefined : state.step.slug
  const stateIndex =
    state.phase === 'done' ? steps.length : steps.findIndex(step => step.slug === state.step.slug)
  const currentAgent =
    state.phase === 'ready'
      ? agentForStep(state.step, subscriptions.data?.items ?? [], agents.data?.items ?? [])
      : undefined
  const currentConfig = currentAgent === undefined ? undefined : configs.get(currentAgent.id)
  const currentTargetKind = currentConfig?.onboarding?.kind
  const currentAppSlug =
    currentConfig?.onboarding?.kind === 'app' ? currentConfig.onboarding.appSlug : undefined

  useEffect(() => {
    if (!enabled || storageKey === undefined) return
    setCursorState(current =>
      current?.key === storageKey
        ? current
        : { key: storageKey, cursor: readStoredChain(storageKey, projectedSteps)?.cursor ?? 0 },
    )
  }, [enabled, projectedSteps, storageKey])

  useEffect(() => {
    activeOnboarding.current = undefined
    openingRef.current = undefined
    setOpeningSlug(undefined)
  }, [storageKey])

  // Seed the stored chain the moment the steps are known, before the cursor has
  // moved anywhere. The server only projects `onboarding.starterAgents` onto an
  // INCOMPLETE owner workspace, so the projection disappears the instant Duet's
  // own onboarding completes — which is exactly when the chain starts. Waiting
  // for the cursor to advance would mean a reload during the very first agent
  // finds neither a projection nor a stored list, and silently abandons the rest
  // of the campaign's agents.
  useEffect(() => {
    if (!enabled || storageKey === undefined || stepSlugs.length === 0) return
    if (readStoredChain(storageKey, stepSlugs) !== undefined) return
    writeStoredChain(storageKey, stepSlugs, cursor < 0 ? 0 : cursor)
  }, [cursor, enabled, stepSlugs, storageKey])

  useEffect(() => {
    if (!enabled || storageKey === undefined) return
    const nextCursor = state.phase === 'skipped' ? stateIndex + 1 : stateIndex
    if (nextCursor < 0 || nextCursor === cursor) return
    writeStoredChain(storageKey, stepSlugs, nextCursor)
    setCursorState({ key: storageKey, cursor: nextCursor })
  }, [cursor, enabled, state.phase, stateIndex, stepSlugs, storageKey])

  useEffect(() => {
    if (
      !eligible ||
      workspaceSlug === undefined ||
      state.phase !== 'ready' ||
      currentAgent === undefined
    ) {
      return
    }
    activeOnboarding.current = {
      id: currentAgent.id,
      slug: currentAgent.slug,
      name: currentAgent.name ?? currentAgent.slug,
    }
    if (stateSlug === undefined || openingRef.current === stateSlug) return
    openingRef.current = stateSlug
    setOpeningSlug(stateSlug)
    if (currentTargetKind === 'app') {
      if (currentAppSlug !== undefined) {
        /* On its agent's card, the one address an app has. The chain owns the
           completion watch here — see `useChainOwnedOnboarding` — so the card's
           own watch stands down and only one of them navigates. */
        navigate(
          agentsMapUrl(workspaceSlug, {
            kind: 'agent',
            agentSlug: currentAgent.slug,
            card: { kind: 'app', appSlug: currentAppSlug },
          }),
          { replace: true },
        )
      }
      setOpeningSlug(undefined)
      return
    }
    /* A chat setup lives on the agent's own surface: a locked agent opens its
       onboarding conversation on sight (open-or-create, keyed on the agent —
       see `agent-onboarding-session.ts`), so the chain only needs to land
       there. No create call here: two writers racing to open the same
       conversation is exactly what the query-owned open exists to prevent. */
    navigate(
      agentsMapUrl(workspaceSlug, {
        kind: 'agent',
        agentSlug: currentAgent.slug,
        card: { kind: 'default' },
      }),
      { replace: true },
    )
    setOpeningSlug(undefined)
  }, [
    currentAgent,
    currentAppSlug,
    currentTargetKind,
    eligible,
    navigate,
    state.phase,
    stateSlug,
    workspaceSlug,
  ])

  useEffect(() => {
    if (
      !eligible ||
      workspaceSlug === undefined ||
      storageKey === undefined ||
      state.phase !== 'done' ||
      finalizedRef.current === storageKey
    ) {
      return
    }
    finalizedRef.current = storageKey
    writeStoredChain(storageKey, stepSlugs, steps.length)
    setCursorState({ key: storageKey, cursor: steps.length })
    const completed = activeOnboarding.current
    activeOnboarding.current = undefined
    if (completed === undefined) return
    void queryClient.invalidateQueries({
      queryKey: duetQueryKeys.workspaces.agents.all(workspaceSlug),
    })
    void queryClient.invalidateQueries({
      queryKey: duetQueryKeys.workspaces.apps.all(workspaceSlug),
    })
    navigate(
      agentsMapUrl(workspaceSlug, {
        kind: 'agent',
        agentSlug: completed.slug,
        card: { kind: 'default' },
      }),
      {
        replace: true,
        state: {
          onboardingComplete: {
            agentId: completed.id,
            agentSlug: completed.slug,
            agentName: completed.name,
          },
        } satisfies OnboardingCompleteNavigationState,
      },
    )
  }, [
    eligible,
    navigate,
    queryClient,
    state.phase,
    stepSlugs,
    steps.length,
    storageKey,
    workspaceSlug,
  ])

  const ownedAgentId =
    eligible && activeOnboarding.current !== undefined ? activeOnboarding.current.id : undefined
  const wait =
    state.phase === 'installing' ? (
      <OnboardingChainTransition
        phase="installing"
        slug={state.step.slug}
        current={stateIndex + 1}
        total={steps.length}
      />
    ) : openingSlug !== undefined ? (
      <OnboardingChainTransition
        phase="handoff"
        slug={openingSlug}
        current={stateIndex + 1}
        total={steps.length}
      />
    ) : null

  return (
    <ChainOwnedAgentContext.Provider value={ownedAgentId}>
      {children}
      {wait}
    </ChainOwnedAgentContext.Provider>
  )
}

function campaignAgentsWithLandedSubscriptions(
  steps: readonly OnboardingChainStep[],
  subscriptions: readonly Pick<MarketplaceAgentSubscription, 'agentId' | 'agentName' | 'state'>[],
  agents: readonly Agent[],
): Agent[] {
  const stepNames = new Set(steps.map(step => step.slug))
  const activeAgentIds = new Set(
    subscriptions.flatMap(subscription =>
      stepNames.has(subscription.agentName) &&
      subscription.state === 'active' &&
      subscription.agentId !== undefined
        ? [subscription.agentId]
        : [],
    ),
  )
  return agents.filter(agent => activeAgentIds.has(agent.id))
}

function projectChainConfigs(
  agents: readonly Agent[],
  configs: readonly (AgentEffectiveConfig | undefined)[],
  apps: readonly App[],
): ReadonlyMap<string, OnboardingChainConfig> {
  const result = new Map<string, OnboardingChainConfig>()
  agents.forEach((agent, index) => {
    const config = configs[index]
    if (config === undefined) return
    if (config.onboarding?.kind !== 'app') {
      result.set(agent.id, {
        onboarding: config.onboarding?.kind === 'chat' ? { kind: 'chat' } : undefined,
      })
      return
    }
    const app = resolveOnboardingApp(config, agent.anchorPath, [...apps])
    result.set(agent.id, {
      onboarding: {
        kind: 'app',
        runtimeStatus: app?.runtimeStatus,
        ...(app === undefined ? {} : { appSlug: app.slug }),
      },
    })
  })
  return result
}

function agentForStep(
  step: OnboardingChainStep,
  subscriptions: readonly Pick<MarketplaceAgentSubscription, 'agentId' | 'agentName'>[],
  agents: readonly Agent[],
): Agent | undefined {
  const agentId = subscriptions.find(subscription => subscription.agentName === step.slug)?.agentId
  return agents.find(agent => agent.id === agentId)
}

function workspaceSlugFromPath(pathname: string): string | undefined {
  const encoded = pathname.match(/^\/w\/([^/]+)/)?.[1]
  if (encoded === undefined) return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}
