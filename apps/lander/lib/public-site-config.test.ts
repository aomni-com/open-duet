import { expect, test } from 'bun:test'

import {
  MODEL_TIERS,
  SUBSCRIPTION_PLANS,
  bonusPercentForPlan,
  microUsdToDollars,
  TRIAL_WINDOW_MS,
  estimateTierMessages,
  WORKSPACE_LIMIT_BY_PLAN,
  workspaceVmCapsForPlan,
} from '@repo/contract'

import {
  PUBLIC_SUBSCRIPTION_PLANS,
  PUBLIC_TIERS,
  TRIAL_DAYS,
} from './public-site-config'

test('public subscription cards render the contract catalog', () => {
  for (const plan of PUBLIC_SUBSCRIPTION_PLANS) {
    expect(plan.monthlyPrice).toBe(
      `$${microUsdToDollars(SUBSCRIPTION_PLANS[plan.id].monthlyPriceMicroUsd)}`,
    )
    expect(plan.bonusPercent).toBe(bonusPercentForPlan(plan.id))
  }
})

// Each fact below is read from the rail that owns it rather than retyped into
// copy, so a resize, a grant change, or a new plan cannot leave a card behind.
test('each public card states the plan differences from the rails that own them', () => {
  for (const plan of PUBLIC_SUBSCRIPTION_PLANS) {
    const contractPlan = SUBSCRIPTION_PLANS[plan.id]
    const caps = workspaceVmCapsForPlan(plan.id)
    expect(plan.monthlyCredits).toBe(microUsdToDollars(contractPlan.monthlyCreditsMicroUsd))
    expect(plan.vmCpuCores).toBe(caps.cpu)
    expect(plan.vmRamGb).toBe(Number(caps.memory.replace('GB', '')))
    expect(plan.storageGb).toBe(contractPlan.storageGb)
    expect(plan.workspaceLimit).toBe(WORKSPACE_LIMIT_BY_PLAN[plan.id])
    expect(plan.estimatedMessages).toBe(
      estimateTierMessages('balanced', contractPlan.monthlyCreditsMicroUsd),
    )
  }
})

// A card only earns its price by out-stating the one below it. A plan that ties
// its neighbour on every axis here has nothing left to say, so this pins the
// ladder itself rather than any single number on it.
test('every stated difference rises strictly across the plan ladder', () => {
  const ladder = ['starter', 'pro', 'max'] as const
  expect(PUBLIC_SUBSCRIPTION_PLANS.map(plan => plan.id)).toEqual([...ladder])

  const rungs = ladder.map(id => {
    const plan = PUBLIC_SUBSCRIPTION_PLANS.find(candidate => candidate.id === id)
    if (!plan) throw new Error(`The public plan catalog must include ${id}`)
    return plan
  })
  for (const [index, rung] of rungs.slice(1).entries()) {
    const previous = rungs[index]
    if (!previous) throw new Error(`Missing rung below ${rung.id}`)
    expect(rung.estimatedMessages).toBeGreaterThan(previous.estimatedMessages)
    expect(rung.vmCpuCores).toBeGreaterThan(previous.vmCpuCores)
    expect(rung.vmRamGb).toBeGreaterThan(previous.vmRamGb)
    expect(rung.storageGb).toBeGreaterThan(previous.storageGb)
    expect(rung.workspaceLimit).toBeGreaterThan(previous.workspaceLimit)
  }
})

test('public trial duration is derived from the contract timebox', () => {
  expect(TRIAL_DAYS).toBe(TRIAL_WINDOW_MS / (24 * 60 * 60 * 1000))
})

test('the public tier ladder names the contract tiers and never carries their rates', () => {
  expect(PUBLIC_TIERS).toEqual(
    Object.values(MODEL_TIERS).map(({ id, label, description }) => ({ id, label, description })),
  )
})
