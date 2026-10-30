import { normalizeDrivePath, type Agent, type AgentEffectiveConfig, type App } from '@repo/contract'

export type AgentOnboardingTarget = { kind: 'chat' } | { kind: 'app'; appSlug?: string }

export function agentTrainSurface(config: AgentEffectiveConfig): 'enabled' | 'disabled' {
  return !config.readable || config.trainable ? 'enabled' : 'disabled'
}

export function visibleAgentApps(
  agent: Pick<Agent, 'onboardedAt'>,
  config: AgentEffectiveConfig,
  anchorPath: string,
  apps: App[],
): App[] {
  if (
    !config.readable ||
    config.onboarding?.kind !== 'app' ||
    !config.onboarding.hideAfterOnboarded ||
    agent.onboardedAt === undefined
  ) {
    return apps
  }
  const onboardingApp = resolveOnboardingApp(config, anchorPath, apps)
  return onboardingApp === undefined ? apps : apps.filter(app => app !== onboardingApp)
}

export function resolveOnboardingApp(
  config: AgentEffectiveConfig,
  anchorPath: string,
  apps: App[],
): App | undefined {
  const cwd = onboardingAppCwd(config, anchorPath)
  return cwd === undefined ? undefined : apps.find(app => app.anchorPath === cwd)
}

export function onboardingAppCwd(
  config: AgentEffectiveConfig,
  anchorPath: string,
): string | undefined {
  if (!config.readable || config.onboarding?.kind !== 'app') return undefined
  const path = normalizeDrivePath(`${anchorPath}/${config.onboarding.app}`)
  return path.ok ? path.relativePath : undefined
}

export function isAgentOnboardingAppPending(
  locked: boolean,
  config: AgentEffectiveConfig,
  anchorPath: string,
  apps: App[],
): boolean {
  return (
    locked &&
    config.readable &&
    config.onboarding?.kind === 'app' &&
    resolveOnboardingApp(config, anchorPath, apps) === undefined
  )
}

export function agentOnboardingTarget(
  config: AgentEffectiveConfig,
  anchorPath: string,
  apps: App[],
): AgentOnboardingTarget | undefined {
  if (!config.readable || config.onboarding === undefined) return undefined
  if (config.onboarding.kind === 'chat') return { kind: 'chat' }
  const app = resolveOnboardingApp(config, anchorPath, apps)
  return {
    kind: 'app',
    ...(app?.runtimeStatus === 'reconciled' ? { appSlug: app.slug } : {}),
  }
}
