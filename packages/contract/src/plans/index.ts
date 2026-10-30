import { z } from 'zod'

export const SubscriptionPlanIdSchema = z.enum(['starter', 'pro', 'max'])
export type SubscriptionPlanId = z.infer<typeof SubscriptionPlanIdSchema>

interface SubscriptionPlan {
  monthlyPriceMicroUsd: number
  monthlyCreditsMicroUsd: number
  storageGb: number
}

export const SUBSCRIPTION_PLANS = {
  starter: {
    monthlyPriceMicroUsd: 20_000_000,
    monthlyCreditsMicroUsd: 20_000_000,
    storageGb: 20,
  },
  pro: {
    monthlyPriceMicroUsd: 50_000_000,
    monthlyCreditsMicroUsd: 60_000_000,
    storageGb: 50,
  },
  max: {
    monthlyPriceMicroUsd: 200_000_000,
    monthlyCreditsMicroUsd: 250_000_000,
    storageGb: 100,
  },
} as const satisfies Record<SubscriptionPlanId, SubscriptionPlan>

export const WORKSPACE_LIMIT_BY_PLAN = {
  starter: 1,
  pro: 3,
  max: 10,
} as const satisfies Record<SubscriptionPlanId, number>

export const VM_IMAGE_HEADROOM_GB = 8

export function vmDiskGbForPlan(planId: SubscriptionPlanId): number {
  return SUBSCRIPTION_PLANS[planId].storageGb + VM_IMAGE_HEADROOM_GB
}

export function bonusPercentForPlan(planId: SubscriptionPlanId): number {
  const plan = SUBSCRIPTION_PLANS[planId]
  return Math.round(
    ((plan.monthlyCreditsMicroUsd - plan.monthlyPriceMicroUsd) * 100) / plan.monthlyPriceMicroUsd,
  )
}

/** Warn when used storage rises above this fraction. */
export const STORAGE_WARNING_RATIO = 0.9
