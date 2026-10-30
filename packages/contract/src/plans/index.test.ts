import { afterEach, describe, expect, test } from 'bun:test'

import {
  bonusPercentForPlan,
  SUBSCRIPTION_PLANS,
  VM_IMAGE_HEADROOM_GB,
  vmDiskGbForPlan,
} from './index'

const originalStarter = { ...SUBSCRIPTION_PLANS.starter }

afterEach(() => {
  Object.assign(SUBSCRIPTION_PLANS.starter, originalStarter)
})

describe('subscription plan derivations', () => {
  test('adds VM image headroom to fixed advertised storage', () => {
    Object.assign(SUBSCRIPTION_PLANS.starter, { storageGb: 73 })
    expect(vmDiskGbForPlan('starter')).toBe(73 + VM_IMAGE_HEADROOM_GB)
  })

  test('derives bonuses from fixed credit and price fixtures, rounding to whole percent', () => {
    for (const [credits, price, bonus] of [
      [20_000_000, 20_000_000, 0],
      [24_000_000, 20_000_000, 20],
      [25_100_000, 20_000_000, 26],
    ] as const) {
      Object.assign(SUBSCRIPTION_PLANS.starter, {
        monthlyPriceMicroUsd: price,
        monthlyCreditsMicroUsd: credits,
      })
      expect(bonusPercentForPlan('starter')).toBe(bonus)
    }
  })
})
