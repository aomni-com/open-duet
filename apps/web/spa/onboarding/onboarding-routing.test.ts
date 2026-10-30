import { expect, test } from 'bun:test'

import type { WorkspaceSummary } from '@repo/contract'

import { onboardingGatePath } from './onboarding-routing'

const workspace = {
  id: 'workspace_1',
  slug: 'acme',
  name: 'Acme',
  status: 'active',
  servicingStatus: 'active',
  role: 'owner',
  billingUserId: 'user_1',
  funding: { plan: null, active: true },
  creditRecovery: null,
  defaultTier: { effective: 'balanced' },
} satisfies WorkspaceSummary

test.each(['editor', 'viewer'] as const)(
  'an invited %s never receives workspace onboarding',
  role => {
    expect(onboardingGatePath({ ...workspace, role })).toBeNull()
    expect(onboardingGatePath({ ...workspace, role, onboardedAt: 1_700_000_000_000 })).toBeNull()
  },
)
