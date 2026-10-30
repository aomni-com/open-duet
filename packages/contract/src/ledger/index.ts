import { z } from 'zod'

const MICRO_USD_PER_USD = 1_000_000

export const HARD_BLOCK_FLOOR_MICRO_USD = MICRO_USD_PER_USD
export const LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD = 2 * MICRO_USD_PER_USD
export const DEFAULT_TRIAL_GRANT_MICRO_USD = 5 * MICRO_USD_PER_USD
export const TRIAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_RESERVATION_ESTIMATE_MICRO_USD = 2 * MICRO_USD_PER_USD
export const DEFAULT_AUTO_TOPUP_THRESHOLD_MICRO_USD = 5 * MICRO_USD_PER_USD
export const MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD = 5 * MICRO_USD_PER_USD
export const DEFAULT_AUTO_TOPUP_AMOUNT_MICRO_USD = 20 * MICRO_USD_PER_USD
export const MIN_AUTO_TOPUP_AMOUNT_MICRO_USD = 5 * MICRO_USD_PER_USD
export const AUTO_TOPUP_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000

export const MicroUsdAmountSchema = z.number().int()
export type MicroUsdAmount = z.infer<typeof MicroUsdAmountSchema>

export const PreflightBlockReasonSchema = z.enum([
  'insufficient_credits',
  'monthly_cap',
  'subscription_required',
])
export type PreflightBlockReason = z.infer<typeof PreflightBlockReasonSchema>
export const BillingTierSchema = z.enum(['account', 'workspace'])
export type BillingTier = z.infer<typeof BillingTierSchema>

export const PreflightDecisionSchema = z.object({
  proceed: z.boolean(),
  reason: PreflightBlockReasonSchema.optional(),
  tier: BillingTierSchema.optional(),
  // The derived spendable total: monthlyCreditBalanceMicroUsd + paidCreditBalanceMicroUsd.
  balanceMicroUsd: MicroUsdAmountSchema,
  monthlyCreditBalanceMicroUsd: MicroUsdAmountSchema,
  paidCreditBalanceMicroUsd: MicroUsdAmountSchema,
  // monthlySpend* and monthly_cap are spend-cap telemetry, not the monthly credit bucket.
  accountMonthlySpendMicroUsd: MicroUsdAmountSchema,
  accountMonthlyCapMicroUsd: MicroUsdAmountSchema.optional(),
  workspaceMonthlySpendMicroUsd: MicroUsdAmountSchema,
  workspaceMonthlyCapMicroUsd: MicroUsdAmountSchema.optional(),
})
export type PreflightDecision = z.infer<typeof PreflightDecisionSchema>

export function dollarsToMicroUsd(dollars: number | string): MicroUsdAmount {
  const parsed = typeof dollars === 'number' ? dollars : Number(dollars)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(parsed * MICRO_USD_PER_USD)
}

/**
 * A monthly spend cap typed into a form, or null when there isn't one.
 *
 * Deliberately NOT `dollarsToMicroUsd`, which normalizes unparseable input to
 * 0. Zero is a perfectly sensible top-up amount but a catastrophic cap: it does
 * not mean "no cap", it means "block every request". So anything that is not a
 * finite positive number — blank, whitespace, `not-a-number`, `1e999`, a
 * negative — reads as NO CAP rather than a cap of nothing.
 */
export function optionalCapToMicroUsd(raw: string): MicroUsdAmount | null {
  if (raw.trim().length === 0) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.round(parsed * MICRO_USD_PER_USD)
}

export function microUsdToDollars(microUsd: MicroUsdAmount): number {
  return microUsd / MICRO_USD_PER_USD
}

// Usage-rollup period keys. Each is UTC and zero-padded so keys of one
// granularity sort lexicographically, which is what lets a report scan them as
// an index range. They travel on the wire as the `period` field, so their
// format is part of the billing contract rather than a backend detail.
export function currentMonthKey(now = Date.now()): string {
  const d = new Date(now)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

export function currentDayKey(now = Date.now()): string {
  const d = new Date(now)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${currentMonthKey(now)}-${dd}`
}

const DAY_MS = 24 * 60 * 60 * 1000

// ISO 8601: weeks run Monday–Sunday and belong to the year holding their
// Thursday, so a week straddling New Year is owned by one year alone and
// never splits into two partial rollup rows.
export function currentWeekKey(now = Date.now()): string {
  const monday = isoWeekMonday(now)
  const isoYear = new Date(monday + 3 * DAY_MS).getUTCFullYear()
  // Jan 4 is always in ISO week 1, so its Monday anchors the year's weeks.
  const firstMonday = isoWeekMonday(Date.UTC(isoYear, 0, 4))
  const week = (monday - firstMonday) / (7 * DAY_MS) + 1
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

export function isoWeekMonday(ts: number): number {
  const d = new Date(ts)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return midnight - ((d.getUTCDay() + 6) % 7) * DAY_MS
}
