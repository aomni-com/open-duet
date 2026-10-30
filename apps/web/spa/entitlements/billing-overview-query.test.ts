import { expect, test } from 'bun:test'

import { DuetApiError } from '../api/client'
import { billingOverviewQueryBehavior } from './billing-overview-query'
import { deriveWorkspaceWall } from './subscribe-wall'

test('a 403 overview settles to null with no-retry/no-poll policy and no active-workspace wall', async () => {
  let calls = 0
  const denied = new DuetApiError(403, 'forbidden')
  const options = billingOverviewQueryBehavior(
    {
      async userBilling() {
        calls += 1
        throw denied
      },
    },
    10,
  )

  const overview = await options.queryFn({ signal: new AbortController().signal })

  expect(overview).toBeNull()
  expect(calls).toBe(1)
  expect(options.retry(0, denied)).toBe(false)
  expect(options.refetchInterval({ state: { status: 'success', data: overview } })).toBe(false)
  expect(
    deriveWorkspaceWall(
      {
        id: 'workspace_1',
        slug: 'fixture',
        name: 'Fixture',
        status: 'active',
        servicingStatus: 'active',
        role: 'owner',
        billingUserId: 'admin_1',
        funding: { plan: null, active: true },
        creditRecovery: null,
        defaultTier: { effective: 'balanced' },
      },
      'admin_1',
      overview ?? undefined,
    ),
  ).toBeNull()
})
