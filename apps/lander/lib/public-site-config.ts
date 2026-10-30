import {
  MODEL_TIERS,
  SUBSCRIPTION_PLANS,
  TYPICAL_MESSAGE_USAGE,
  estimateTierMessages,
  SubscriptionPlanIdSchema,
  WORKSPACE_LIMIT_BY_PLAN,
  bonusPercentForPlan,
  microUsdToDollars,
  TRIAL_WINDOW_MS,
  workspaceVmCapsForPlan,
} from '@repo/contract'

export const SUPPORT_EMAIL = 'team@duet.so'

const DAY_MS = 24 * 60 * 60 * 1000

export const TRIAL_DAYS = TRIAL_WINDOW_MS / DAY_MS

/**
 * The assumption behind every "about N messages" number, in the units the
 * footnote states it in. Exported so the page shows its working rather than
 * asking a reader to trust a bare count.
 */
export const PUBLIC_TYPICAL_MESSAGE = {
  inputTokensK:
    (TYPICAL_MESSAGE_USAGE.uncachedInputTokens + TYPICAL_MESSAGE_USAGE.cachedInputTokens) / 1_000,
  outputTokensK: TYPICAL_MESSAGE_USAGE.outputTokens / 1_000,
  tierLabel: MODEL_TIERS.balanced.label,
} as const

/**
 * Messages a credit grant buys at Standard rates.
 *
 * Standard is the yardstick for all three plans so the estimates are comparable.
 * Max defaults to a more expensive model tier; the copy footnotes the shared
 * tier so readers understand the estimate is not a cap.
 */
export function estimateStandardMessages(creditsMicroUsd: number): number {
  return estimateTierMessages('balanced', creditsMicroUsd)
}

export const PUBLIC_SUBSCRIPTION_PLANS = SubscriptionPlanIdSchema.options.map(id => {
  const caps = workspaceVmCapsForPlan(id)
  return {
    id,
    monthlyPrice: `$${microUsdToDollars(SUBSCRIPTION_PLANS[id].monthlyPriceMicroUsd)}`,
    // The grant itself, not just the bonus percentage over list price: "20%
    // more credits" is unreadable without the base it is 20% more than.
    //
    // A bare count, never "$60": credits happen to map 1:1 to dollars today,
    // but printing them as money teaches buyers to read the balance as a refund
    // they are owed rather than as metered usage (David, 2026-08-25).
    monthlyCredits: microUsdToDollars(SUBSCRIPTION_PLANS[id].monthlyCreditsMicroUsd),
    bonusPercent: bonusPercentForPlan(id),
    estimatedMessages: estimateStandardMessages(SUBSCRIPTION_PLANS[id].monthlyCreditsMicroUsd),
    // The workspace VM this plan provisions. Read from the sizing rail rather
    // than restated, so a resize cannot leave the pricing page behind.
    vmCpuCores: caps.cpu,
    vmRamGb: Number(caps.memory.replace('GB', '')),
    storageGb: SUBSCRIPTION_PLANS[id].storageGb,
    // The membership threshold for creating another workspace. Public because an
    // agent meets it as a `workspace_limit_reached` refusal and has to explain
    // to its human which plan clears it.
    workspaceLimit: WORKSPACE_LIMIT_BY_PLAN[id],
  }
})

/**
 * The models the Max tier discloses. Public copy names these as the frontier
 * models Duet routes between, so it reads the list the product itself
 * discloses in the tier picker instead of a hand-kept marketing one.
 */
export const PUBLIC_FRONTIER_MODELS = MODEL_TIERS.frontier.disclosedModels.map(({ label }) => label)

/**
 * The biggest workspace VM marketing may claim. The sizing rail widens the VM
 * per plan (4/8, 8/16, 10/24), so there is no single true "every workspace is N
 * cores" — such a claim overstates Starter and understates Max at once. Copy
 * that cannot name a plan says "up to" these; the pricing cards state their own
 * plan's real size from `PUBLIC_SUBSCRIPTION_PLANS`.
 */
export const PUBLIC_MAX_VM_CPU_CORES = Math.max(
  ...PUBLIC_SUBSCRIPTION_PLANS.map(plan => plan.vmCpuCores),
)
export const PUBLIC_MAX_VM_RAM_GB = Math.max(...PUBLIC_SUBSCRIPTION_PLANS.map(plan => plan.vmRamGb))
export const PUBLIC_MAX_STORAGE_GB = Math.max(
  ...Object.values(SUBSCRIPTION_PLANS).map(plan => plan.storageGb),
)

/**
 * The tier ladder as public copy may state it. Token rates are deliberately
 * absent: they are internal pricing and never published.
 */
export const PUBLIC_TIERS = Object.values(MODEL_TIERS).map(({ id, label, description }) => ({
  id,
  label,
  description,
}))
