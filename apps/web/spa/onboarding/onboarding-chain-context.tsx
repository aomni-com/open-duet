'use client'

import { createContext, useContext } from 'react'

export const ChainOwnedAgentContext = createContext<string | undefined>(undefined)

// True only when a chain is actually driving THIS agent, so the standalone
// onboarding watcher stands down and the chain owns the completion navigation.
// The `agentId !== undefined` guard matters: without it, "no chain running and
// no agent in view" compares `undefined === undefined` and answers "chain-owned",
// which is the wrong answer for any caller that does not already pre-check.
export function useChainOwnedOnboarding(agentId: string | undefined): boolean {
  const chainOwnedAgentId = useContext(ChainOwnedAgentContext)
  return agentId !== undefined && chainOwnedAgentId === agentId
}
