'use client'

import { HeroAgentViz } from '@/components/landing/hero-agents'

/** The animated agent-team visualization — a mission-control world of named
 * agents working sessions in parallel. Generic across landers: the agents
 * are GTM/Product/Ops/Social, not tied to any vertical. */
export function AgentTeamPlayground() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <HeroAgentViz />
    </div>
  )
}
