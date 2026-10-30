import type { DuetApiClient } from '../api/client'

export type MarketplaceAgentCatalogSource = Pick<DuetApiClient, 'listMarketplaceCatalog'>

/**
 * The team step's "picked for you" read. A narrow source like the catalog —
 * not an `OnboardingService` method — because it is a fire-and-forget read
 * the wizard may drop on the floor, not part of the completion orchestration.
 */
export type OnboardingRecommendationsSource = Pick<DuetApiClient, 'recommendOnboardingAgents'>

export type OnboardingPaymentSource = Pick<
  DuetApiClient,
  'createOnboardingPaymentIntent' | 'completeOnboardingPayment' | 'onboardingPaymentStatus'
>

export type OnboardingDraft = {
  duetName: string
  selectedAgentNames: readonly string[]
  /** The composed purpose paragraph (`composePurpose`/`customPurpose` output). */
  purpose?: string
  /** Analytics-only goal id: `<goalId>` for a preset goal, `'custom'` otherwise. */
  goal?: string
}

export type OnboardingService = {
  completeOnboarding(draft: OnboardingDraft): Promise<{
    duetName: string
    destination: string
    onboardedAt: number
    warning?: 'agent-install-failed'
  }>
}

type WorkspaceOnboardingApi = Pick<DuetApiClient, 'completeWorkspaceOnboarding'>

export function createWorkspaceOnboardingService({
  workspaceSlug,
  destination,
  api,
}: {
  workspaceSlug: string
  destination: string
  api: WorkspaceOnboardingApi
}): OnboardingService {
  return {
    async completeOnboarding({ duetName, selectedAgentNames, purpose, goal }) {
      const completion = {
        duetName,
        ...(purpose === undefined ? {} : { purpose }),
        ...(goal === undefined ? {} : { goal }),
      }
      const response = await api.completeWorkspaceOnboarding(
        workspaceSlug,
        selectedAgentNames.length === 0
          ? { ...completion, skip: true }
          : { ...completion, selectedNames: [...selectedAgentNames] },
      )
      return {
        duetName: response.duetName,
        destination,
        onboardedAt: response.onboardedAt,
        // Only failures for agents this user picked are worth telling them
        // about. A campaign's agent failing is unactionable for them, and
        // showing it would put an error in front of everyone registering
        // through that campaign.
        ...(response.pullError !== undefined ||
        response.results.some(result => !result.ok && result.campaign !== true)
          ? { warning: 'agent-install-failed' as const }
          : {}),
      }
    },
  }
}

export function createMockOnboardingService({
  delayMs = 720,
  now = Date.now,
}: { delayMs?: number; now?: () => number } = {}): OnboardingService {
  return {
    async completeOnboarding({ duetName }) {
      await delay(delayMs / 2)
      return { duetName, destination: '/', onboardedAt: now() }
    },
  }
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise(resolve => setTimeout(resolve, ms))
}
