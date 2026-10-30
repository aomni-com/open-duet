import type { Agent, App, MarketplaceAgentSubscription } from '@repo/contract'

export type OnboardingChainStep = { slug: string }

export type OnboardingChainConfig = {
  onboarding:
    | { kind: 'chat' }
    | { kind: 'app'; runtimeStatus: App['runtimeStatus'] | undefined; appSlug?: string }
    | undefined
}

export type OnboardingChainState =
  | { phase: 'installing'; step: OnboardingChainStep }
  | { phase: 'ready'; step: OnboardingChainStep; last: boolean }
  | { phase: 'skipped'; step: OnboardingChainStep }
  | { phase: 'done' }

type ChainSubscription = Pick<
  MarketplaceAgentSubscription,
  'id' | 'agentId' | 'agentName' | 'state'
>

type ChainAgent = Pick<Agent, 'id' | 'slug' | 'onboardedAt'>

export function nextChainState({
  steps,
  completedSlugs,
  subscriptions,
  agents,
  configs,
}: {
  steps: readonly OnboardingChainStep[]
  completedSlugs: readonly string[]
  subscriptions: readonly ChainSubscription[]
  agents: readonly ChainAgent[]
  configs: ReadonlyMap<string, OnboardingChainConfig>
}): OnboardingChainState {
  const completed = new Set(completedSlugs)
  for (const [index, step] of steps.entries()) {
    if (completed.has(step.slug)) continue
    const subscription = subscriptionFor(step, subscriptions)
    if (
      subscription === undefined ||
      subscription.state === 'error' ||
      subscription.state === 'detached'
    ) {
      return { phase: 'skipped', step }
    }
    if (subscription.state !== 'active') return { phase: 'installing', step }
    const agent = agents.find(candidate => candidate.id === subscription.agentId)
    if (agent === undefined) return { phase: 'installing', step }
    if (agent.onboardedAt !== undefined) continue
    const config = configs.get(agent.id)
    if (config === undefined) return { phase: 'installing', step }
    if (config.onboarding === undefined) return { phase: 'skipped', step }
    if (
      config.onboarding.kind === 'app' &&
      config.onboarding.runtimeStatus === 'reconcile_failed'
    ) {
      return { phase: 'skipped', step }
    }
    if (config.onboarding.kind === 'app' && config.onboarding.runtimeStatus !== 'reconciled') {
      return { phase: 'installing', step }
    }
    return {
      phase: 'ready',
      step,
      last: !steps
        .slice(index + 1)
        .some(candidate =>
          couldRequireOnboarding(candidate, completed, subscriptions, agents, configs),
        ),
    }
  }
  return { phase: 'done' }
}

function subscriptionFor(
  step: OnboardingChainStep,
  subscriptions: readonly ChainSubscription[],
): ChainSubscription | undefined {
  return subscriptions.find(candidate => candidate.agentName === step.slug)
}

function couldRequireOnboarding(
  step: OnboardingChainStep,
  completed: ReadonlySet<string>,
  subscriptions: readonly ChainSubscription[],
  agents: readonly ChainAgent[],
  configs: ReadonlyMap<string, OnboardingChainConfig>,
): boolean {
  if (completed.has(step.slug)) return false
  const subscription = subscriptionFor(step, subscriptions)
  if (
    subscription === undefined ||
    subscription.state === 'error' ||
    subscription.state === 'detached'
  ) {
    return false
  }
  if (subscription.state !== 'active') return true
  const agent = agents.find(candidate => candidate.id === subscription.agentId)
  if (agent === undefined) return true
  if (agent.onboardedAt !== undefined) return false
  const config = configs.get(agent.id)
  return (
    config === undefined ||
    (config.onboarding !== undefined &&
      !(config.onboarding.kind === 'app' && config.onboarding.runtimeStatus === 'reconcile_failed'))
  )
}
