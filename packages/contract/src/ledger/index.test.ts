import { describe, expect, test } from 'bun:test'

import {
  currentDayKey,
  currentMonthKey,
  currentWeekKey,
  dollarsToMicroUsd,
  HARD_BLOCK_FLOOR_MICRO_USD,
  LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD,
  MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD,
  microUsdToDollars,
  optionalCapToMicroUsd,
  PreflightDecisionSchema,
  type PreflightBlockReason,
} from './index'

describe('ledger money conversion contract', () => {
  test('converts dollar amounts to integer micro-USD', () => {
    expect(dollarsToMicroUsd(1)).toBe(1_000_000)
    expect(dollarsToMicroUsd(0.1234564)).toBe(123_456)
    expect(dollarsToMicroUsd('12.34')).toBe(12_340_000)
  })

  test('normalizes invalid form values to zero micro-USD', () => {
    expect(dollarsToMicroUsd('not-a-number')).toBe(0)
    expect(dollarsToMicroUsd(Number.NaN)).toBe(0)
  })

  test('an unparseable spend cap is UNSET, never a zero-dollar cap', () => {
    // `dollarsToMicroUsd` deliberately normalizes bad form input to 0, which is
    // harmless for a top-up amount and dangerous for a CAP: 0 does not mean
    // "no cap", it means "block every request". A typo like `1e999` therefore
    // used to silently freeze all spend.
    expect(optionalCapToMicroUsd('')).toBeNull()
    expect(optionalCapToMicroUsd('   ')).toBeNull()
    expect(optionalCapToMicroUsd('not-a-number')).toBeNull()
    expect(optionalCapToMicroUsd('1e999')).toBeNull()
    expect(optionalCapToMicroUsd('-5')).toBeNull()
    expect(optionalCapToMicroUsd('0')).toBeNull()
    // A real cap still converts.
    expect(optionalCapToMicroUsd('12.34')).toBe(12_340_000)
  })

  test('converts micro-USD back to dollars', () => {
    expect(microUsdToDollars(12_340_000)).toBe(12.34)
  })
})

describe('usage period keys', () => {
  // Expectations are GNU/BSD `date -u +%G-W%V`, not this module's own arithmetic.
  test('keys a week by its ISO week-numbering year, which can differ from the calendar year', () => {
    expect(currentWeekKey(Date.UTC(2026, 6, 25))).toBe('2026-W30')
    // A January date owned by the previous ISO year, and a December date owned
    // by the next one — the two cases a getUTCFullYear() key gets wrong.
    expect(currentWeekKey(Date.UTC(2021, 0, 1))).toBe('2020-W53')
    expect(currentWeekKey(Date.UTC(2024, 11, 30))).toBe('2025-W01')
  })

  test('spans a 53-week year and starts weeks on Monday', () => {
    expect(currentWeekKey(Date.UTC(2026, 11, 31))).toBe('2026-W53')
    expect(currentWeekKey(Date.UTC(2027, 0, 3))).toBe('2026-W53')
    // Sunday closes a week; the next Monday opens the following one.
    expect(currentWeekKey(Date.UTC(2027, 0, 4))).toBe('2027-W01')
  })

  // Reports scan one granularity as an index range, so within a granularity
  // lexicographic order must equal chronological order. The scan's upper-bound
  // sentinels belong to the rollup module and are pinned there.
  test('sorts each granularity lexicographically in chronological order', () => {
    const instants = [
      Date.UTC(2026, 0, 5),
      Date.UTC(2026, 6, 25),
      Date.UTC(2026, 8, 9),
      Date.UTC(2026, 11, 31),
    ]
    for (const key of [currentDayKey, currentWeekKey, currentMonthKey]) {
      const keys = instants.map(ts => key(ts))
      expect([...keys].sort()).toEqual(keys)
    }
  })

  test('zero-pads day and month keys so single digits keep their place', () => {
    expect(currentDayKey(Date.UTC(2026, 8, 9))).toBe('2026-09-09')
    expect(currentMonthKey(Date.UTC(2026, 0, 31))).toBe('2026-01')
  })
})

describe('subscription ledger contract', () => {
  test('keeps the hard stop, recovery gate, and automatic top-up thresholds independent and ordered', () => {
    expect(HARD_BLOCK_FLOOR_MICRO_USD).toBeLessThan(LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD)
    expect(LOW_CREDIT_RECOVERY_THRESHOLD_MICRO_USD).toBeLessThan(MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD)
  })

  test('round-trips a two-bucket preflight decision with an exhaustive block reason', () => {
    const blockLabels = {
      insufficient_credits: 'Insufficient credits',
      monthly_cap: 'Monthly cap reached',
      subscription_required: 'Subscription required',
    } satisfies Record<PreflightBlockReason, string>
    const decision = {
      proceed: false,
      reason: 'subscription_required',
      balanceMicroUsd: 7_000_000,
      monthlyCreditBalanceMicroUsd: 2_000_000,
      paidCreditBalanceMicroUsd: 5_000_000,
      accountMonthlySpendMicroUsd: 0,
      workspaceMonthlySpendMicroUsd: 0,
    } as const

    expect(PreflightDecisionSchema.parse(decision)).toEqual(decision)
    expect(Object.keys(blockLabels)).toContain(decision.reason)
  })
})
