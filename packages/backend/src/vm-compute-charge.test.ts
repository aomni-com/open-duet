import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  DEFAULT_TRIAL_GRANT_MICRO_USD,
  HARD_BLOCK_FLOOR_MICRO_USD,
  VM_USAGE_CPU_MICRO_USD_PER_CORE_HOUR,
  VM_USAGE_MIN_CHARGEABLE_MICRO_USD,
  vmComputeFeeMicroUsd,
  vmUsageDayWindow,
} from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = new URL('..', import.meta.url).pathname
const INTERNAL_KEY = 'vm-compute-charge-internal-key'
const DAY_KEY = '2026-08-09'
const DAY = vmUsageDayWindow(DAY_KEY)
const TICK = 10 * 60 * 1000
const AFTER_DAY = DAY.endAt + TICK

let convex: ConvexDevFixture
let sequence = 0

// Size the fixture to cross the configured billing floor.
const FIXTURE_CORES = Math.max(
  4,
  Math.ceil(VM_USAGE_MIN_CHARGEABLE_MICRO_USD / (6 * VM_USAGE_CPU_MICRO_USD_PER_CORE_HOUR)),
)
const FIXTURE_FEE = vmComputeFeeMicroUsd({ coreHours: FIXTURE_CORES * 6, gbHours: 8 * 6 })

function saturatedHours(hours = 6, startOffsetMs = 0) {
  const ticks = hours * 6
  return Array.from({ length: ticks + 1 }, (_, index) => ({
    at: DAY.startAt + startOffsetMs + index * TICK,
    cpuCores: FIXTURE_CORES,
    cpuNominalCores: FIXTURE_CORES,
    memUsedGb: 8,
    memTotalGb: 8,
  }))
}

async function freshWorkspace(
  label: string,
  options: { servicingExempt?: boolean } = {},
): Promise<{ workspaceId: string; email: string; userId: string }> {
  sequence += 1
  const email = uniqueEmail(`vm-charge-${label}-${sequence}`)
  const owner = await signInWithMagicLink<{ _id: string }>(convex, email, `VM Charge ${label}`)
  const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `vm-charge-${label}-${sequence}-${Date.now()}`,
    name: `VM Charge ${label}`,
    ...(options.servicingExempt === true ? { servicingExempt: true } : {}),
  })) as string
  return { workspaceId, email, userId: owner.user._id }
}

async function seed(workspaceId: string, points: ReturnType<typeof saturatedHours>) {
  await mutate(convex, 'testing/vmTelemetry:recordVmSamplesForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    points,
  })
}

async function charge(workspaceId: string, overrides: Record<string, unknown> = {}) {
  return await mutate(convex, 'testing/vmTelemetry:chargeVmComputeDayForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    dayKey: DAY_KEY,
    now: AFTER_DAY,
    ...overrides,
  })
}

async function workspaceServicingStatus(workspaceId: string): Promise<string | undefined> {
  const rows = (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as { servicingStatus?: string } | null
  return rows?.servicingStatus
}

async function ledgerEntries(workspaceId: string) {
  const entries = (await query(convex, 'testing/credits:listWorkspaceTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<{ amountMicroUsd: number; type: string; metadata?: { usageKind?: string } }>
  return { entries }
}

describe('the VM compute charge', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: 'https://app-staging.duet.so',
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('prices a measured hour exactly as the pricing kernel does', async () => {
    const { workspaceId } = await freshWorkspace('priced')
    await seed(workspaceId, saturatedHours())

    const result = await charge(workspaceId)

    expect(result).toMatchObject({ status: 'applied', amountMicroUsd: FIXTURE_FEE })
  })

  test('charging the same day twice moves the balance once', async () => {
    // The daily cron and teardown can both reach a day if a retry lands oddly.
    const { workspaceId } = await freshWorkspace('idempotent')
    await seed(workspaceId, saturatedHours())

    const first = await charge(workspaceId)
    const second = await charge(workspaceId)
    const { entries } = await ledgerEntries(workspaceId)

    expect(first).toMatchObject({ status: 'applied' })
    expect(second).toEqual({ status: 'already_applied' })
    expect(entries.filter(entry => entry.amountMicroUsd === -FIXTURE_FEE)).toHaveLength(1)
  })

  describe('nothing billable writes no row at all', () => {
    // Never a zero-value entry: a day we have no data for and a day of genuine
    // zero usage are different facts, and only one deserves a trace.
    test('a day with no samples', async () => {
      const { workspaceId } = await freshWorkspace('no-samples')

      expect(await charge(workspaceId)).toEqual({ status: 'no_billable_interval' })
      expect((await ledgerEntries(workspaceId)).entries).toHaveLength(0)
    })

    test('a single sample, which has no interval behind it', async () => {
      const { workspaceId } = await freshWorkspace('one-sample')
      await seed(workspaceId, saturatedHours().slice(0, 1))

      expect(await charge(workspaceId)).toEqual({ status: 'no_billable_interval' })
    })

    test('a measured zero-usage VM is declined as not worth billing', async () => {
      // Distinct from `no_billable_interval`: we HAVE data for this day, the
      // usage is simply too small to be worth a row. Keeping the two statuses
      // apart is what lets an unmeasurable day stay visible as one.
      const { workspaceId } = await freshWorkspace('idle')
      await seed(
        workspaceId,
        saturatedHours().map(point => ({ ...point, cpuCores: 0, memUsedGb: 0 })),
      )

      expect(await charge(workspaceId)).toMatchObject({ status: 'below_charge_floor' })
      expect((await ledgerEntries(workspaceId)).entries).toHaveLength(0)
    })
  })

  test('a servicing-exempt workspace is never charged', async () => {
    // Duet pays for these; the hub is one.
    const { workspaceId } = await freshWorkspace('exempt', { servicingExempt: true })
    await seed(workspaceId, saturatedHours())

    expect(await charge(workspaceId)).toEqual({ status: 'servicing_exempt' })
    expect((await ledgerEntries(workspaceId)).entries).toHaveLength(0)
  })

  test('a charge aimed at a replaced VM is dropped, not misattributed', async () => {
    const { workspaceId } = await freshWorkspace('stale')
    await seed(workspaceId, saturatedHours())

    expect(await charge(workspaceId, { expectedVmName: 'a-vm-this-workspace-never-had' })).toEqual({
      status: 'stale_identity',
    })
  })

  test('a partial day stops at now rather than billing the future', async () => {
    const { workspaceId } = await freshWorkspace('partial')
    await seed(
      workspaceId,
      saturatedHours().map((point, index) =>
        index <= 3 ? { ...point, cpuCores: 0, memUsedGb: 0 } : point,
      ),
    )

    const result = (await charge(workspaceId, { now: DAY.startAt + 3 * TICK })) as {
      status: string
      amountMicroUsd: number
    }

    // Billable samples are in the future; the measured prefix is idle.
    expect(result.status).toBe('below_charge_floor')
  })

  test('a fee that empties a trial pauses the workspace, because the ledger will not', async () => {
    /* applyLedgerEntryWithDb does NOT reconcile servicing, and a trial's
       entitlement depends on its balance staying above the $1 hard-block floor.
       Without the explicit reconcile in the charge owner, a fee can drop a trial
       under the floor and leave the workspace fully serviced until some
       unrelated event happens to fire. This is the single easiest thing in the
       slice to leave out, so it gets a named test. */
    const { workspaceId, userId } = await freshWorkspace('trial-pause')
    // Drain the trial to just above the floor, then let the fee cross it.
    await mutate(convex, 'testing/credits:applyAccountAdjustmentForTest', {
      internalKey: INTERNAL_KEY,
      userId,
      amountMicroUsd: -(DEFAULT_TRIAL_GRANT_MICRO_USD - (HARD_BLOCK_FLOOR_MICRO_USD + 1)),
      reference: `drain-${workspaceId}`,
      now: AFTER_DAY,
    })
    await seed(workspaceId, saturatedHours())

    expect(await workspaceServicingStatus(workspaceId)).toBe('active')
    expect(await charge(workspaceId)).toMatchObject({ status: 'applied' })
    expect(await workspaceServicingStatus(workspaceId)).toBe('paused')
  })

  test('the fee never routes through preflight, so no card is charged by a background job', async () => {
    // Auto-topup is scheduled only by runPreflightWithDb. This holds by
    // construction -- until someone "helpfully" routes the fee through it.
    const { workspaceId } = await freshWorkspace('no-topup')
    await seed(workspaceId, saturatedHours())

    await charge(workspaceId)
    const scheduled = (await query(convex, 'testing/credits:listScheduledCreditFunctionsForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ name: string }>

    expect(scheduled.filter(row => row.name.includes('topup'))).toEqual([])
  })
})
