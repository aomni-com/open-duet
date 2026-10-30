import { describe, expect, test } from 'bun:test'

import { createWorkspaceOnboardingService } from './onboarding-service'

describe('workspace onboarding service', () => {
  test('completes with an optional official-agent selection', async () => {
    const inputs: unknown[] = []
    const service = createWorkspaceOnboardingService({
      workspaceSlug: 'acme',
      destination: '/w/acme/sessions',
      api: {
        async completeWorkspaceOnboarding(_workspaceSlug, input) {
          inputs.push(input)
          return { duetName: 'Milo', onboardedAt: 1_700_000_000_000, results: [] }
        },
      },
    })

    await expect(
      service.completeOnboarding({ duetName: 'Milo', selectedAgentNames: [] }),
    ).resolves.toEqual({
      duetName: 'Milo',
      destination: '/w/acme/sessions',
      onboardedAt: 1_700_000_000_000,
    })
    await service.completeOnboarding({
      duetName: 'Milo',
      selectedAgentNames: ['research-assistant'],
    })

    expect(inputs).toEqual([
      { duetName: 'Milo', skip: true },
      { duetName: 'Milo', selectedNames: ['research-assistant'] },
    ])
  })

  test('sends the composed purpose and goal id with both completion shapes', async () => {
    const inputs: unknown[] = []
    const service = createWorkspaceOnboardingService({
      workspaceSlug: 'acme',
      destination: '/w/acme/sessions',
      api: {
        async completeWorkspaceOnboarding(_workspaceSlug, input) {
          inputs.push(input)
          return { duetName: 'Milo', onboardedAt: 1, results: [] }
        },
      },
    })

    await service.completeOnboarding({
      duetName: 'Milo',
      selectedAgentNames: [],
      purpose: 'Goal: grow my business. Business: B2B services.',
      goal: 'grow-business',
    })
    await service.completeOnboarding({
      duetName: 'Milo',
      selectedAgentNames: ['research-assistant'],
      purpose: 'Ship a newsletter every week.',
      goal: 'custom',
    })

    expect(inputs).toEqual([
      {
        duetName: 'Milo',
        skip: true,
        purpose: 'Goal: grow my business. Business: B2B services.',
        goal: 'grow-business',
      },
      {
        duetName: 'Milo',
        selectedNames: ['research-assistant'],
        purpose: 'Ship a newsletter every week.',
        goal: 'custom',
      },
    ])
  })

  test('lets a completed onboarding continue when one optional agent fails to install', async () => {
    let campaign: true | undefined
    const service = createWorkspaceOnboardingService({
      workspaceSlug: 'acme',
      destination: '/w/acme/sessions',
      api: {
        async completeWorkspaceOnboarding() {
          return {
            duetName: 'Milo',
            onboardedAt: 1_700_000_000_000,
            results: [
              {
                name: 'research-assistant',
                ok: false as const,
                failure: { error: 'pull_failed' as const },
                ...(campaign === undefined ? {} : { campaign }),
              },
            ],
          }
        },
      },
    })

    await expect(
      service.completeOnboarding({
        duetName: 'Milo',
        selectedAgentNames: ['research-assistant'],
      }),
    ).resolves.toEqual({
      duetName: 'Milo',
      destination: '/w/acme/sessions',
      onboardedAt: 1_700_000_000_000,
      warning: 'agent-install-failed',
    })

    campaign = true
    await expect(
      service.completeOnboarding({ duetName: 'Milo', selectedAgentNames: [] }),
    ).resolves.toEqual({
      duetName: 'Milo',
      destination: '/w/acme/sessions',
      onboardedAt: 1_700_000_000_000,
    })
  })
})
