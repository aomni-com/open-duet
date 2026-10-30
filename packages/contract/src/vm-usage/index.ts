import {
  SUBSCRIPTION_PLANS,
  SubscriptionPlanIdSchema,
  type SubscriptionPlanId,
} from '../plans/index'
import { workspaceVmCapsForPlan } from '../resources/index'

/**
 * What a workspace VM costs per unit of what it actually consumed.
 *
 * These two numbers are the whole pricing policy. They were derived from one
 * constraint: a single VM saturated 24/7 for a month must still cost LESS than
 * that plan's monthly credit grant. The fee's job is to turn stolen compute
 * into lost AI budget, never into debt — so a miner loses their ability to use
 * Duet's models, and an honest user with a runaway process cannot end up owing
 * money. `vmComputeFeeStaysUnderGrant` below is what stops that property from
 * silently lapsing.
 *
 * Nothing enforces the constraint at runtime. It is a property of these two
 * constants, checked by a test.
 */
export const VM_USAGE_CPU_MICRO_USD_PER_CORE_HOUR = 3_000
export const VM_USAGE_MEM_MICRO_USD_PER_GB_HOUR = 600

/**
 * An interval longer than this bills nothing.
 *
 * Measured, not guessed. Over the HTTPS transport production uses, the gap
 * between consecutive points is a flat 600–601 s across the live fleet. (An
 * earlier reading of 61–1,049 s came from probing over SSH, which is not how
 * the backend talks to exe.dev — see `specs/done/vm-compute-fees/research/`.)
 *
 * Thirty-five minutes is therefore very conservative, and deliberately so: a
 * larger clamp only ever ACCEPTS more intervals, so erring high costs nothing
 * while erring low would silently stop billing during ordinary jitter. What it
 * must stay well below is a real provider outage, so a multi-hour gap never
 * bills hours of assumed load.
 *
 * The invariant is one-directional: under-bill, never over-bill. We decline to
 * charge for time we have no measurement of.
 */
export const VM_USAGE_MAX_POINT_GAP_MS = 35 * 60 * 1000

/**
 * A day's fee below this is not worth charging.
 *
 * The fee exists to deter pool abuse, not to collect pennies. An idle VM costs
 * about $0.003 a day and the busiest legitimate workspace on the fleet about
 * $0.017 — so without a floor, every workspace grows a ledger row, three usage
 * rollups and a spend-cap increment every single day, for amounts nobody will
 * ever look at. At 500 workspaces that is 500 rows and 1,500 scheduled
 * mutations a day to bill roughly a dollar in total.
 *
 * Ten cents a day is well above anything honest use produces and far below what
 * abuse costs: a saturated Starter VM runs about $0.40 a day, four times the
 * floor, and a saturated Max VM about $1.07.
 *
 * Usage under the floor is DROPPED, not carried forward. Carrying it would need
 * per-workspace running state to fix an exposure of at most $3 a month of
 * compute — about 3% of one VM sustained, which is not the abuse this exists to
 * stop.
 */
export const VM_USAGE_MIN_CHARGEABLE_MICRO_USD = 100_000

const MS_PER_HOUR = 60 * 60 * 1000
const HOURS_PER_MONTH = 24 * 30

/**
 * One usable provider observation, in the units the fee bills in.
 *
 * Lives here rather than in `@repo/exe` because it is a BILLING type: the
 * pricing kernel below is its main consumer, and a provider client has no
 * business owning the shape money is computed from. `@repo/exe` re-exports it
 * so the parser that produces it can name its own return type.
 */
export interface VmUsagePoint {
  /** ms epoch, parsed from the provider timestamp and nothing else. */
  at: number
  cpuCores: number
  cpuNominalCores: number
  memUsedGb: number
  memTotalGb: number
  fsUsedGb?: number
  fsTotalGb?: number
}

export interface VmUsageWindow {
  startAt: number
  endAt: number
}

export interface VmUsageTotals {
  coreHours: number
  gbHours: number
  points: number
  coveredMs: number
  firstPointAt: number
  lastPointAt: number
}

/** UTC bounds for a `currentDayKey()`-shaped key, e.g. `2026-08-09`. */
export function vmUsageDayWindow(dayKey: string): VmUsageWindow {
  const startAt = Date.parse(`${dayKey}T00:00:00.000Z`)
  if (!Number.isFinite(startAt)) throw new Error(`Not a day key: ${dayKey}`)
  return { startAt, endAt: startAt + 24 * MS_PER_HOUR }
}

/**
 * Turn irregular observations into billable hours.
 *
 * Each point owns the interval BEHIND it, up to the gap clamp and clipped to
 * the window. That is a step integration, and it is the correct shape when the
 * provider reports an average over the preceding interval rather than an
 * instantaneous reading.
 *
 * No cadence is assumed anywhere: every interval comes from the difference
 * between two real timestamps. The provider's cadence is nominally ten minutes
 * and in practice close to it, but a fixed-interval assumption would still be
 * wrong at every window edge and across any gap.
 *
 * Returns `null` when there is nothing billable — which the caller must treat
 * as "write no ledger row at all", never as a zero-value charge. A day with no
 * data and a day with genuinely zero usage are different facts, and only one of
 * them should leave a trace.
 */
export function integrateVmUsage(
  points: readonly Pick<VmUsagePoint, 'at' | 'cpuCores' | 'memUsedGb'>[],
  window: VmUsageWindow,
): VmUsageTotals | null {
  const sorted = [...points].sort((left, right) => left.at - right.at)

  let coreHours = 0
  let gbHours = 0
  let coveredMs = 0
  let counted = 0
  let firstPointAt = Number.POSITIVE_INFINITY
  let lastPointAt = Number.NEGATIVE_INFINITY
  let previousAt: number | undefined

  for (const point of sorted) {
    if (point.at === previousAt) continue // duplicate timestamp: keep the first
    const intervalStart = previousAt
    previousAt = point.at

    // No predecessor means no measured interval. Falling back to the window
    // start would invent one -- the first point after an outage would bill from
    // midnight at its own rate, which is exactly the assumed load this refuses
    // to charge for.
    if (intervalStart === undefined) continue
    if (point.at <= window.startAt || intervalStart >= window.endAt) continue

    // Clamp on the TRUE interval between the two readings, before clipping.
    // Clamping the clipped duration instead would let a multi-hour outage that
    // straddles a window edge bill up to a full clamp of load it never
    // measured.
    if (point.at - intervalStart > VM_USAGE_MAX_POINT_GAP_MS) continue

    const from = Math.max(intervalStart, window.startAt)
    const to = Math.min(point.at, window.endAt)
    const durationMs = to - from
    if (durationMs <= 0) continue

    const hours = durationMs / MS_PER_HOUR
    coreHours += point.cpuCores * hours
    gbHours += point.memUsedGb * hours
    coveredMs += durationMs
    counted += 1
    firstPointAt = Math.min(firstPointAt, point.at)
    lastPointAt = Math.max(lastPointAt, point.at)
  }

  if (counted === 0) return null
  return { coreHours, gbHours, points: counted, coveredMs, firstPointAt, lastPointAt }
}

/**
 * Rounded once, at the end. A rounded zero means no charge.
 *
 * This is the raw price of the usage. Whether it is worth billing at all is a
 * separate question — see `isChargeableVmComputeFee`.
 */
export function vmComputeFeeMicroUsd(totals: Pick<VmUsageTotals, 'coreHours' | 'gbHours'>): number {
  return Math.round(
    totals.coreHours * VM_USAGE_CPU_MICRO_USD_PER_CORE_HOUR +
      totals.gbHours * VM_USAGE_MEM_MICRO_USD_PER_GB_HOUR,
  )
}

/** Whether a day's fee clears the floor and is worth a ledger row at all. */
export function isChargeableVmComputeFee(microUsd: number): boolean {
  return microUsd >= VM_USAGE_MIN_CHARGEABLE_MICRO_USD
}

/**
 * What a plan's VM costs if it is pegged for a whole month — the number the
 * affordability constraint is about. Derived from the plan's own width so a
 * future resize cannot leave this behind.
 */
export function saturatedMonthlyFeeMicroUsd(plan: SubscriptionPlanId): number {
  const caps = workspaceVmCapsForPlan(plan)
  const memoryGb = Number(caps.memory.replace('GB', ''))
  return vmComputeFeeMicroUsd({
    coreHours: caps.cpu * HOURS_PER_MONTH,
    gbHours: memoryGb * HOURS_PER_MONTH,
  })
}

/**
 * The affordability constraint, as a predicate rather than a comment.
 *
 * Reads plan widths and grants rather than restating them, so widening Max when
 * the pool grows, or trimming a grant, fails the test and forces someone to
 * re-derive the rates deliberately.
 */
export function vmComputeFeeStaysUnderGrant(plan: SubscriptionPlanId): boolean {
  return saturatedMonthlyFeeMicroUsd(plan) < SUBSCRIPTION_PLANS[plan].monthlyCreditsMicroUsd
}

export const VM_USAGE_PLANS = SubscriptionPlanIdSchema.options
