import { describe, expect, test } from 'bun:test'

import { SUBSCRIPTION_PLANS } from '../plans/index'
import { workspaceVmCapsForPlan } from '../resources/index'
import {
  VM_USAGE_MAX_POINT_GAP_MS,
  VM_USAGE_MIN_CHARGEABLE_MICRO_USD,
  isChargeableVmComputeFee,
  VM_USAGE_PLANS,
  integrateVmUsage,
  saturatedMonthlyFeeMicroUsd,
  vmComputeFeeMicroUsd,
  vmComputeFeeStaysUnderGrant,
  vmUsageDayWindow,
} from './index'

const DAY = vmUsageDayWindow('2026-08-09')
const HOUR = 60 * 60 * 1000
const TICK = 10 * 60 * 1000 // the provider's nominal cadence; a full hour would trip the gap clamp
const point = (atMs: number, cpuCores: number, memUsedGb = 0) => ({
  at: DAY.startAt + atMs,
  cpuCores,
  memUsedGb,
})

describe('the affordability constraint', () => {
  // The reason the rates are what they are: a VM pegged for a month must cost
  // less than its plan's grant, so abuse costs an abuser their AI budget and
  // can never put an honest user into debt. If this fails, the rates are wrong
  // -- do not relax the assertion.
  test.each(VM_USAGE_PLANS)('a %s VM saturated for 30 days stays under its grant', plan => {
    expect(vmComputeFeeStaysUnderGrant(plan)).toBe(true)
  })

  test('Starter is the binding tier, and binds with room to spare', () => {
    // Grants scale faster than VM widths, so a single flat rate is naturally
    // progressive in the user's favour. Starter is both the cheapest plan to
    // abuse and the tightest ratio -- if any tier ever fails first, something
    // about plan sizing changed and the rates need re-deriving.
    const share = (plan: (typeof VM_USAGE_PLANS)[number]) =>
      saturatedMonthlyFeeMicroUsd(plan) / SUBSCRIPTION_PLANS[plan].monthlyCreditsMicroUsd

    expect(share('starter')).toBeGreaterThan(share('pro'))
    expect(share('pro')).toBeGreaterThan(share('max'))
    expect(share('starter')).toBeLessThan(0.8)
  })

  test('derives widths from the caps table rather than restating them', () => {
    // Proves the guard actually tracks the source of truth: bump the table and
    // the number moves.
    const caps = workspaceVmCapsForPlan('max')
    const expected = vmComputeFeeMicroUsd({
      coreHours: caps.cpu * 24 * 30,
      gbHours: Number(caps.memory.replace('GB', '')) * 24 * 30,
    })

    expect(saturatedMonthlyFeeMicroUsd('max')).toBe(expected)
  })
})

describe('the minimum chargeable fee', () => {
  // The fee deters pool abuse; it is not a collections mechanism. Without a
  // floor every workspace grows a ledger row, three usage rollups and a
  // spend-cap increment every day for fractions of a cent.
  const dailyFee = (cores: number, memGb: number) =>
    vmComputeFeeMicroUsd({ coreHours: cores * 24, gbHours: memGb * 24 })

  test('an idle VM is never worth charging', () => {
    // Measured idle floor on the live fleet: ~0.02 cores, ~0.1 GiB.
    expect(isChargeableVmComputeFee(dailyFee(0.02, 0.1))).toBe(false)
  })

  test('the busiest legitimate workspace is never worth charging', () => {
    // Busiest real VM measured: 0.144 cores, 0.48 GiB.
    expect(isChargeableVmComputeFee(dailyFee(0.144, 0.48))).toBe(false)
  })

  test('a saturated VM clears the floor by a wide margin', () => {
    // Starter at full tilt. If the floor ever rose near this, abuse would go
    // free -- that is the property worth pinning, not the constant itself.
    const saturated = dailyFee(4, 8)

    expect(isChargeableVmComputeFee(saturated)).toBe(true)
    expect(saturated).toBeGreaterThan(VM_USAGE_MIN_CHARGEABLE_MICRO_USD * 3)
  })

  test('the floor sits above honest use and below abuse', () => {
    expect(dailyFee(0.144, 0.48)).toBeLessThan(VM_USAGE_MIN_CHARGEABLE_MICRO_USD)
    expect(dailyFee(4, 8)).toBeGreaterThan(VM_USAGE_MIN_CHARGEABLE_MICRO_USD)
  })

  test('exactly at the floor charges', () => {
    expect(isChargeableVmComputeFee(VM_USAGE_MIN_CHARGEABLE_MICRO_USD)).toBe(true)
    expect(isChargeableVmComputeFee(VM_USAGE_MIN_CHARGEABLE_MICRO_USD - 1)).toBe(false)
  })
})

describe('vmUsageDayWindow', () => {
  test('spans exactly one UTC day from a currentDayKey-shaped key', () => {
    expect(DAY.endAt - DAY.startAt).toBe(24 * HOUR)
    expect(new Date(DAY.startAt).toISOString()).toBe('2026-08-09T00:00:00.000Z')
  })

  test('rejects anything that is not a day key', () => {
    expect(() => vmUsageDayWindow('20260809')).toThrow(/day key/)
  })
})

describe('integrateVmUsage', () => {
  test('bills one core-hour for one core across one hour', () => {
    // Six 10-minute intervals: a single hour-long gap would (correctly) trip
    // the clamp, so real cadence is the only honest way to express an hour.
    const hour = Array.from({ length: 7 }, (_, index) => point(index * TICK, 1))
    const totals = integrateVmUsage(hour, DAY)

    expect(totals).toMatchObject({ points: 6 })
    expect(totals!.coreHours).toBeCloseTo(1, 10)
  })

  test('bills memory alongside cpu', () => {
    const hour = Array.from({ length: 7 }, (_, index) => point(index * TICK, 0, 2))
    const totals = integrateVmUsage(hour, DAY)

    expect(totals!.gbHours).toBeCloseTo(2, 10)
    expect(totals!.coreHours).toBe(0)
  })

  test('derives every interval from timestamps, never a fixed cadence', () => {
    // The live fleet's gaps run 1 to 17.5 minutes against a nominal 10. A fixed
    // assumption would be wrong on both tails, so feed deliberately uneven ones.
    const minutes = (count: number) => count * 60 * 1000
    const totals = integrateVmUsage(
      [point(minutes(3), 1), point(minutes(10), 1), point(minutes(29), 1)],
      DAY,
    )

    // 7 + 19 minutes at one core. The first point bills nothing: it has no
    // predecessor, so there is no measured interval behind it.
    expect(totals!.coreHours).toBeCloseTo(26 / 60, 10)
  })

  test('a point owns the interval behind it, so a spike does not smear backwards', () => {
    const totals = integrateVmUsage([point(0, 0), point(TICK, 4)], DAY)

    // Step, not trapezoid: the busy reading covers its own preceding interval
    // at full height. A trapezoid would average it with the idle point before.
    expect(totals!.coreHours).toBeCloseTo(4 / 6, 10)
  })

  test('sorts unordered input', () => {
    const unordered = integrateVmUsage([point(2 * TICK, 1), point(0, 1), point(TICK, 1)], DAY)
    const ordered = integrateVmUsage([point(0, 1), point(TICK, 1), point(2 * TICK, 1)], DAY)

    expect(unordered).toEqual(ordered!)
  })

  test('keeps the first of duplicate timestamps', () => {
    const totals = integrateVmUsage([point(0, 1), point(TICK, 1), point(TICK, 99)], DAY)

    expect(totals!.coreHours).toBeCloseTo(1 / 6, 10)
  })

  describe('a gap longer than the clamp bills nothing', () => {
    test('so a provider outage under-bills instead of inventing load', () => {
      const beyond = VM_USAGE_MAX_POINT_GAP_MS + 60_000
      const totals = integrateVmUsage([point(0, 4), point(beyond, 4)], DAY)

      expect(totals).toBeNull()
    })

    test('an outage straddling the window start bills nothing', () => {
      // The clamp must be measured on the TRUE interval, not the one clipped to
      // the window. Clipping first would let a five-hour outage bill a full
      // clamp of load at the first post-outage reading's rate -- charging for
      // time nothing observed.
      const outage = integrateVmUsage(
        [{ at: DAY.startAt - 5 * HOUR, cpuCores: 4, memUsedGb: 8 }, point(30 * 60 * 1000, 4, 8)],
        DAY,
      )

      expect(outage).toBeNull()
    })

    test('a first point with no predecessor at all bills nothing', () => {
      // Otherwise it would bill from midnight at its own rate.
      expect(integrateVmUsage([point(30 * 60 * 1000, 4, 8)], DAY)).toBeNull()
    })

    test('but ordinary jitter is never clamped', () => {
      // p99 on the live fleet was 977s; the clamp sits far above it.
      const jitter = 17.5 * 60 * 1000
      const totals = integrateVmUsage([point(0, 1), point(jitter, 1)], DAY)

      expect(totals!.coveredMs).toBe(jitter)
    })
  })

  describe('the window is a hard boundary', () => {
    test('clips an interval that starts before the day', () => {
      const totals = integrateVmUsage(
        [{ at: DAY.startAt - TICK, cpuCores: 1, memUsedGb: 0 }, point(TICK, 1)],
        DAY,
      )

      expect(totals!.coveredMs).toBe(TICK)
    })

    test('ignores points beyond the day', () => {
      const totals = integrateVmUsage(
        [point(0, 1), { at: DAY.endAt + HOUR, cpuCores: 99, memUsedGb: 0 }],
        DAY,
      )

      expect(totals).toBeNull()
    })
  })

  describe('nothing billable returns null, never a zero charge', () => {
    // A day with no data and a day with genuinely zero usage are different
    // facts. Only one of them should leave a ledger row.
    test('no points', () => {
      expect(integrateVmUsage([], DAY)).toBeNull()
    })

    test('a single point has no interval behind it inside the window', () => {
      expect(integrateVmUsage([point(0, 4)], DAY)).toBeNull()
    })
  })

  test('a genuinely idle VM rounds to no charge at all', () => {
    // The measured idle floor is ~0.02 cores. Over a full day that is far below
    // one micro-dollar, which is why no allowance is needed.
    const idle = Array.from({ length: 144 }, (_, index) => point(index * 10 * 60 * 1000, 0.02, 0.1))
    const totals = integrateVmUsage(idle, DAY)

    expect(totals!.coreHours).toBeCloseTo(0.02 * 23.83, 1)
    expect(vmComputeFeeMicroUsd(totals!)).toBeLessThan(3_000) // under $0.003 for the day
  })
})
