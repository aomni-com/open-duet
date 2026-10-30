import { expect, test } from 'bun:test'

import { workspaceVmCapsForPlan } from '@repo/contract'

import type { Doc, Id } from '../convex/_generated/dataModel'
import { desiredWorkspaceVmCaps } from '../convex/domains/workspaces/vmSizePolicy'

const BILLING_USER_ID = 'billing-user' as Id<'users'>
const WORKSPACE = { billingUserId: BILLING_USER_ID } as Doc<'workspaces'>

test('uses large resources only while a Pro or Max subscription is live', async () => {
  const activePro = user({ plan: 'pro', status: 'active', monthlyCreditExpiresAt: 9_000 })
  const lapsedPro = user({ plan: 'pro', status: 'canceled', monthlyCreditExpiresAt: 20_000 })

  expect(await desiredWorkspaceVmCaps(ctxFor(activePro), WORKSPACE, 10_000)).toEqual(
    workspaceVmCapsForPlan('pro'),
  )
  expect(await desiredWorkspaceVmCaps(ctxFor(lapsedPro), WORKSPACE, 10_000)).toEqual(
    workspaceVmCapsForPlan(undefined),
  )
})

// The subscription plan must survive the entitlement hop; the shared resource
// policy owns sizing, and this boundary owns selecting its correct plan.
test('selects Max resources while live, and the free floor once lapsed', async () => {
  const activeMax = user({ plan: 'max', status: 'active', monthlyCreditExpiresAt: 9_000 })
  const lapsedMax = user({ plan: 'max', status: 'canceled', monthlyCreditExpiresAt: 20_000 })

  expect(await desiredWorkspaceVmCaps(ctxFor(activeMax), WORKSPACE, 10_000)).toEqual(
    workspaceVmCapsForPlan('max'),
  )
  expect(await desiredWorkspaceVmCaps(ctxFor(lapsedMax), WORKSPACE, 10_000)).toEqual(
    workspaceVmCapsForPlan(undefined),
  )
})

function ctxFor(user: Doc<'users'>) {
  return {
    db: { get: async () => user },
  } as unknown as Parameters<typeof desiredWorkspaceVmCaps>[0]
}

function user(args: {
  plan: 'pro' | 'max'
  status: 'active' | 'canceled'
  monthlyCreditExpiresAt: number
}): Doc<'users'> {
  return {
    _id: BILLING_USER_ID,
    _creationTime: 1,
    billing: {
      monthlyCreditExpiresAt: args.monthlyCreditExpiresAt,
      subscription: { plan: args.plan, status: args.status },
    },
  } as Doc<'users'>
}
