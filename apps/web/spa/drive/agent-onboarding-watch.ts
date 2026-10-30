'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'

import type { Agent } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import { duetQueryOptions } from '../api/query-options'
import type { SpaApi } from '../context'
import { useSpa } from '../context'
import { useChainOwnedOnboarding } from '../onboarding/onboarding-chain-context'
import { agentsMapUrl } from './agents-map-url'

export const ONBOARDING_WATCH_POLL_MS = 2_500

export type OnboardingCompleteNavigationState = {
  onboardingComplete: {
    agentId: string
    agentSlug: string
    agentName: string
  }
}

type AgentsQueryOptions = ReturnType<typeof duetQueryOptions.workspaces.agentLookup>
type OnboardingWatchQueryOptions = AgentsQueryOptions & {
  refetchInterval: (query: { state: { data: Agent | null | undefined } }) => number | false
}

export function onboardingWatchQueryOptions(
  api: Pick<SpaApi, 'listAgents'>,
  workspaceSlug: string,
  agentId: string,
  intervalMs = ONBOARDING_WATCH_POLL_MS,
): OnboardingWatchQueryOptions {
  return {
    ...duetQueryOptions.workspaces.agentLookup(api, workspaceSlug, { id: agentId }),
    refetchInterval: (query: { state: { data: Agent | null | undefined } }) => {
      return query.state.data?.onboardedAt === undefined ? intervalMs : false
    },
  }
}

export function onboardingFlipStep(
  navigatedAgentIds: Set<string>,
  agent: Pick<Agent, 'id' | 'slug' | 'onboardedAt'> | undefined,
): agent is Pick<Agent, 'id' | 'slug' | 'onboardedAt'> & { onboardedAt: number } {
  if (agent?.onboardedAt === undefined || navigatedAgentIds.has(agent.id)) {
    return false
  }
  navigatedAgentIds.add(agent.id)
  return true
}

export function useOnboardingWatch(workspaceSlug: string, agentId: string | undefined): void {
  const { api } = useSpa()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const navigatedAgentIds = useRef(new Set<string>())
  const chainOwned = useChainOwnedOnboarding(agentId)
  const agents = useQuery({
    ...onboardingWatchQueryOptions(api, workspaceSlug, agentId ?? ''),
    enabled: agentId !== undefined && !chainOwned,
  })
  const agent = agents.data ?? undefined

  useEffect(() => {
    if (chainOwned) return
    if (!onboardingFlipStep(navigatedAgentIds.current, agent)) return
    void queryClient.invalidateQueries({
      queryKey: duetQueryKeys.workspaces.agents.all(workspaceSlug),
    })
    void queryClient.invalidateQueries({
      queryKey: duetQueryKeys.workspaces.apps.all(workspaceSlug),
    })
    navigate(
      agentsMapUrl(workspaceSlug, {
        kind: 'agent',
        agentSlug: agent.slug,
        card: { kind: 'default' },
      }),
      {
        state: {
          onboardingComplete: {
            agentId: agent.id,
            agentSlug: agent.slug,
            agentName: agent.name ?? agent.slug,
          },
        } satisfies OnboardingCompleteNavigationState,
      },
    )
  }, [agent, chainOwned, navigate, queryClient, workspaceSlug])
}
