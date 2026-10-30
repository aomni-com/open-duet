import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { getFunctionName, makeFunctionReference, type FunctionReference } from 'convex/server'

import {
  VM_USAGE_MIN_CHARGEABLE_MICRO_USD,
  VM_USAGE_CPU_MICRO_USD_PER_CORE_HOUR,
} from '@repo/contract'

import type { Doc, Id } from '../convex/_generated/dataModel'
import { workspaceVmName } from '../convex/domains/workspaces/vmAttach'
import { removeVmForWorkspaceImpl } from '../convex/domains/workspaces/vmTeardown'
import schema from '../convex/schema'

const INTERNAL_KEY = 'vm-teardown-internal-key'
const previousKey = process.env.DUET_API_INTERNAL_KEY
beforeEach(() => {
  process.env.DUET_API_INTERNAL_KEY = INTERNAL_KEY
})
afterEach(() => {
  if (previousKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = previousKey
})
const TEN_MINUTES = 10 * 60 * 1000
const MIDDAY = Date.parse('2026-08-09T12:34:00.000Z')
const JUST_AFTER_MIDNIGHT = Date.parse('2026-08-09T00:02:00.000Z')

const RECORD_SAMPLES = 'domains/workspaces/vmUsageModel:recordWorkspaceVmSamples'
const CHARGE_DAY = 'domains/credits/vmComputeUsage:chargeWorkspaceVmComputeDay'

describe('removeVmForWorkspace', () => {
  test('clears recorded VM disk capacity alongside its identity', async () => {
    const seed = {
      status: 'deleted',
      vmName: 'capacity-recorded-vm',
      vmTokenNonce: 'capacity-recorded-generation',
      vmDiskGb: 58,
    } satisfies Partial<Doc<'workspaces'>>
    const harness = new TeardownHarness(seed)
    harness.providerVmNames.push('capacity-recorded-vm')

    await harness.remove()

    expect(harness.row).toEqual({ status: 'deleted' })
  })

  test('removes an attached VM and clears every connection field', async () => {
    const harness = new TeardownHarness({
      status: 'deleted',
      vmName: 'duet-workspace-vm',
      sshDest: 'exedev@duet-workspace-vm.exe.xyz',
      httpsUrl: 'https://duet-workspace-vm.exe.xyz',
      vmTokenNonce: 'old-generation-nonce',
      vmTokenHash: 'old-generation-hash',
    })
    harness.providerVmNames.push('duet-workspace-vm')

    await harness.remove()

    expect(harness.removeCalls).toEqual(['duet-workspace-vm'])
    expect(harness.row).toEqual({ status: 'deleted' })
  })

  test('preserves a retired transition while clearing its VM fields', async () => {
    const harness = new TeardownHarness({
      status: 'retired',
      vmName: 'retired-workspace-vm',
      sshDest: 'exedev@retired-workspace-vm.exe.xyz',
      httpsUrl: 'https://retired-workspace-vm.exe.xyz',
      vmTokenNonce: 'retired-generation-nonce',
      vmTokenHash: 'retired-generation-hash',
    })
    harness.providerVmNames.push('retired-workspace-vm')

    await harness.remove()

    expect(harness.removeCalls).toEqual(['retired-workspace-vm'])
    expect(harness.row).toEqual({ status: 'retired' })
  })

  test('does nothing when the workspace has no VM', async () => {
    const harness = new TeardownHarness({ status: 'deleted' })

    expect(await harness.remove()).toEqual({ removed: false })
    expect(harness.removeCalls).toEqual([])
    expect(harness.row).toEqual({ status: 'deleted' })
  })

  test('clears an SSH destination even when the VM identity is already gone', async () => {
    const harness = new TeardownHarness({
      status: 'retired',
      sshDest: 'exedev@already-gone.exe.xyz',
    })

    expect(await harness.remove()).toEqual({ removed: false })
    expect(harness.row).toEqual({ status: 'retired' })
  })

  test('clears stale VM fields when the provider no longer has the recorded VM', async () => {
    const harness = new TeardownHarness({
      status: 'deleted',
      vmName: 'already-removed-vm',
      vmTokenNonce: 'already-removed-nonce',
    })

    expect(await harness.remove()).toEqual({ removed: false })
    expect(harness.removeCalls).toEqual([])
    expect(harness.row).toEqual({ status: 'deleted' })
  })

  test('double delivery removes an attached VM only once', async () => {
    const harness = new TeardownHarness({
      status: 'deleted',
      vmName: 'double-delivery-vm',
      vmTokenNonce: 'double-delivery-nonce',
      vmDiskGb: 108,
    })
    harness.providerVmNames.push('double-delivery-vm')

    await harness.remove()
    await harness.remove()

    expect(harness.removeCalls).toEqual(['double-delivery-vm'])
    expect(harness.row).toEqual({ status: 'deleted' })
  })

  test('reconciles a half-created deterministic VM and clears its generation nonce', async () => {
    const harness = new TeardownHarness({
      status: 'unhealthy',
      vmTokenNonce: 'half-created-generation',
    })
    harness.providerVmNames.push(workspaceVmName(await harness.workspaceId()))

    await harness.remove()

    expect(harness.removeCalls).toEqual([workspaceVmName(await harness.workspaceId())])
    expect(harness.row).toEqual({ status: 'unhealthy' })
  })

  test('a delayed teardown preserves the replacement VM generation', async () => {
    const harness = new TeardownHarness({
      status: 'provisioning',
      vmName: 'duet-workspace-vm',
      vmTokenNonce: 'old-generation-nonce',
      vmTokenHash: 'old-generation-hash',
    })
    const scheduledIdentity = {
      vmName: 'duet-workspace-vm',
      vmTokenNonce: 'old-generation-nonce',
    }
    harness.providerVmNames.push('duet-workspace-vm')
    harness.row = {
      status: 'active',
      vmName: 'duet-workspace-vm',
      vmTokenNonce: 'replacement-generation-nonce',
      vmTokenHash: 'replacement-generation-hash',
    }

    expect(await harness.remove({ expectedIdentity: scheduledIdentity })).toEqual({
      removed: false,
    })
    expect(harness.removeCalls).toEqual([])
    expect(harness.row).toEqual({
      status: 'active',
      vmName: 'duet-workspace-vm',
      vmTokenNonce: 'replacement-generation-nonce',
      vmTokenHash: 'replacement-generation-hash',
    })
  })
})

describe('the teardown settlement', () => {
  function billableHarness() {
    const harness = new TeardownHarness({
      status: 'deleted',
      vmName: 'billable-vm',
      vmTokenNonce: 'billable-nonce',
    })
    harness.providerVmNames.push('billable-vm')
    return harness
  }

  test('settles the final window before the VM and the row are gone', async () => {
    /* THE slice. Statting after `exe.remove` returns nothing, and charging after
       the row is cleared cannot resolve the workspace the ledger bills. */
    const harness = billableHarness()

    await harness.remove()

    expect(harness.samplesAtRemoval).toHaveLength(harness.statPoints.length)
    expect(harness.ledgerAtRemoval.map(row => row.reference)).toEqual([
      `vm_usage:${await harness.workspaceId()}:2026-08-09`,
    ])
    expect(harness.appliedDayKeys).toEqual(['2026-08-09'])
    expect(harness.chargeCalls[0]).toMatchObject({
      dayKey: '2026-08-09',
      expectedVmName: 'billable-vm',
      now: MIDDAY,
    })
    expect(harness.recordedPoints[0]).toMatchObject({ expectedVmName: 'billable-vm' })
    expect(harness.samplesAtRemoval.map(row => row.at)).toEqual(
      harness.statPoints.map(point => Date.parse(point.timestamp)),
    )
  })

  test('charges yesterday too when the last samples reach back across midnight', async () => {
    // A teardown at 00:02 lands before the daily cron has closed yesterday.
    const harness = billableHarness()
    harness.statPoints = providerPoints(7, JUST_AFTER_MIDNIGHT)

    await harness.remove({ now: JUST_AFTER_MIDNIGHT })

    expect(harness.appliedDayKeys).toEqual(['2026-08-08', '2026-08-09'])
  })

  test('samples that stay inside today never reach for a second day key', async () => {
    const harness = billableHarness()

    await harness.remove()

    expect(harness.appliedDayKeys).toEqual(['2026-08-09'])
  })

  test('a VM too young to have emitted a point writes no samples', async () => {
    /* A new VM emits nothing for ~4-5 minutes (slice 00). Teardown NARROWS the
       create-and-destroy evasion; inside that window there is nothing to bill. */
    const harness = billableHarness()
    harness.statPoints = []

    await harness.remove()

    expect(harness.samplesAtRemoval).toEqual([])
    expect(harness.ledgerAtRemoval).toEqual([])
    expect(harness.recordedPoints).toEqual([])
  })

  test('a failed stat still removes the VM and clears the row', async () => {
    // A VM that survives its own teardown keeps burning shared pool capacity,
    // which costs more than an uncollected partial fee.
    const harness = billableHarness()
    harness.statError = new Error('lobby exploded')

    expect(await harness.remove()).toEqual({ removed: true, vmName: 'billable-vm' })
    expect(harness.removeCalls).toEqual(['billable-vm'])
    expect(harness.row).toEqual({ status: 'deleted' })
  })

  test('a failed stat still charges the day from samples already stored', async () => {
    // `stat` is a prefix, not a precondition: the charge reads stored rows, and
    // the last sweep is at most an interval old.
    const harness = billableHarness()
    await harness.seedSamples()
    harness.statError = new Error('lobby exploded')

    await harness.remove()

    expect(harness.ledgerAtRemoval.map(row => row.reference)).toEqual([
      `vm_usage:${await harness.workspaceId()}:2026-08-09`,
    ])
  })

  test('a failed charge still removes the VM and clears the row', async () => {
    const harness = billableHarness()
    harness.chargeError = new Error('ledger unavailable')

    expect(await harness.remove()).toEqual({ removed: true, vmName: 'billable-vm' })
    expect(harness.removeCalls).toEqual(['billable-vm'])
    expect(harness.row).toEqual({ status: 'deleted' })
  })

  test('a retried teardown does not charge the day twice', async () => {
    // The action-retrier re-enters the whole block after a failed removal.
    const harness = billableHarness()
    harness.removeError = new Error('provider timeout')

    await expect(harness.remove()).rejects.toThrow('provider timeout')
    const balanceAfterFirstAttempt = harness.paidBalanceAfter
    expect(balanceAfterFirstAttempt).toBeLessThan(1_000_000_000)
    harness.removeError = undefined
    await harness.remove()

    expect(harness.paidBalanceAfter).toBe(balanceAfterFirstAttempt)
    expect(harness.appliedDayKeys).toEqual(['2026-08-09'])
    expect(harness.removeCalls).toEqual(['billable-vm'])
  })

  test('never meters a VM the provider no longer has', async () => {
    const harness = new TeardownHarness({
      status: 'deleted',
      vmName: 'already-removed-vm',
      vmTokenNonce: 'already-removed-nonce',
    })

    await harness.remove()

    expect(harness.samplesAtRemoval).toEqual([])
    expect(harness.ledgerAtRemoval).toEqual([])
    expect(harness.removeCalls).toEqual([])
  })
})

/** Provider-shaped metrics ending `endAt`, at the real ten-minute cadence. */
function providerPoints(count: number, endAt: number) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(endAt - (count - 1 - index) * TEN_MINUTES).toISOString(),
    cpu_cores:
      Math.ceil(VM_USAGE_MIN_CHARGEABLE_MICRO_USD / VM_USAGE_CPU_MICRO_USD_PER_CORE_HOUR) * 100,
    cpu_nominal:
      Math.ceil(VM_USAGE_MIN_CHARGEABLE_MICRO_USD / VM_USAGE_CPU_MICRO_USD_PER_CORE_HOUR) * 100,
    mem_used_bytes: 1024 ** 3,
    mem_total_bytes: 8 * 1024 ** 3,
  }))
}

class TeardownHarness {
  readonly removeCalls: string[] = []
  readonly providerVmNames: string[] = []
  readonly recordedPoints: Array<Record<string, unknown>> = []
  readonly chargeCalls: Array<Record<string, unknown>> = []
  /** Observed references from the actual persisted ledger. */
  paidBalanceAfter = 1_000_000_000
  appliedDayKeys: string[] = []
  samplesAtRemoval: Array<Record<string, unknown>> = []
  ledgerAtRemoval: Array<{ reference?: string }> = []
  readonly t = convexTest(schema, {
    '../convex/_generated/api.ts': async () => ({}),
    '../convex/domains/workspaces/vmTeardownModel.ts': () =>
      import('../convex/domains/workspaces/vmTeardownModel'),
    '../convex/domains/workspaces/vmUsageModel.ts': () =>
      import('../convex/domains/workspaces/vmUsageModel'),
    '../convex/domains/credits/vmComputeUsage.ts': () =>
      import('../convex/domains/credits/vmComputeUsage'),
  })
  private id: Id<'workspaces'> | undefined
  private fields = new Set<string>()
  statPoints = providerPoints(7, MIDDAY - 4 * TEN_MINUTES)
  statError: Error | undefined
  chargeError: Error | undefined
  removeError: Error | undefined
  row: Record<string, unknown>

  readonly exe = {
    list: async () => {
      return this.providerVmNames.map(vmName => ({
        vm_name: vmName,
        ssh_dest: `exedev@${vmName}.exe.xyz`,
        status: 'running',
      }))
    },
    stat: async (_vmName: string, _range?: '24h' | '7d' | '30d') => {
      if (this.statError !== undefined) throw this.statError
      return { points: this.statPoints }
    },
    remove: async (vmName: string) => {
      if (this.removeError !== undefined) throw this.removeError
      this.samplesAtRemoval = await this.t.run(ctx => ctx.db.query('vmTelemetrySamples').collect())
      this.ledgerAtRemoval = await this.t.run(ctx => ctx.db.query('creditTransactions').collect())
      this.removeCalls.push(vmName)
      const index = this.providerVmNames.indexOf(vmName)
      if (index >= 0) this.providerVmNames.splice(index, 1)
    },
  }

  readonly ctx = {
    runQuery: async (ref: FunctionReference<'query'>, args: Record<string, unknown>) =>
      await this.t.query(ref, args),
    runMutation: async (ref: FunctionReference<'mutation'>, args: Record<string, unknown>) => {
      const name = getFunctionName(ref)
      if (name === RECORD_SAMPLES) this.recordedPoints.push(args)
      if (name === CHARGE_DAY) {
        this.chargeCalls.push(args)
        if (this.chargeError !== undefined) throw this.chargeError
      }
      return await this.t.mutation(ref, args)
    },
  }

  async workspaceId() {
    if (this.id !== undefined) return this.id
    this.id = await this.t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'teardown@example.test',
        memberDirectoryRevision: 0,
        paidCreditBalanceMicroUsd: 1_000_000_000,
        monthlyCreditBalanceMicroUsd: 0,
        createdAt: MIDDAY,
        updatedAt: MIDDAY,
      })
      const workspaceId = await ctx.db.insert('workspaces', {
        slug: 'teardown',
        name: 'Teardown',
        status: 'active',
        billingUserId: userId,
        createdAt: MIDDAY,
        ...this.row,
      } as Omit<Doc<'workspaces'>, '_id' | '_creationTime'>)
      await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
      return workspaceId
    })
    return this.id
  }

  async seedSamples() {
    const workspaceId = await this.workspaceId()
    await this.t.mutation(makeFunctionReference<'mutation'>(RECORD_SAMPLES), {
      internalKey: INTERNAL_KEY,
      workspaceId,
      expectedVmName: this.row.vmName,
      points: this.statPoints.map(point => ({
        at: Date.parse(point.timestamp),
        cpuCores: point.cpu_cores,
        cpuNominalCores: point.cpu_nominal,
        memUsedGb: point.mem_used_bytes / 1024 ** 3,
        memTotalGb: point.mem_total_bytes / 1024 ** 3,
      })),
    })
  }

  constructor(seed: Record<string, unknown>) {
    this.row = { ...seed }
  }

  async remove(
    options: {
      expectedIdentity?: { vmName?: string; vmTokenNonce?: string }
      now?: number
    } = {},
  ) {
    const workspaceId = await this.workspaceId()
    for (const key of Object.keys(this.row)) this.fields.add(key)
    await this.t.run(ctx =>
      ctx.db.patch(
        workspaceId,
        Object.fromEntries([...this.fields].map(key => [key, this.row[key]])),
      ),
    )
    try {
      return await removeVmForWorkspaceImpl(this.ctx, {
        workspaceId,
        exe: this.exe,
        env: { DUET_API_INTERNAL_KEY: INTERNAL_KEY },
        now: options.now ?? MIDDAY,
        ...(options.expectedIdentity === undefined
          ? {}
          : { expectedIdentity: options.expectedIdentity }),
      })
    } finally {
      const stored = (await this.t.run(ctx => ctx.db.get(workspaceId)))!
      this.row = Object.fromEntries(
        [...this.fields]
          .filter(key => stored[key as keyof typeof stored] !== undefined)
          .map(key => [key, stored[key as keyof typeof stored]]),
      )
      this.paidBalanceAfter = await this.t.run(
        async ctx => (await ctx.db.get(stored.billingUserId))!.paidCreditBalanceMicroUsd,
      )
      const ledger = await this.t.run(ctx => ctx.db.query('creditTransactions').collect())
      this.appliedDayKeys = ledger.map(row => row.reference?.split(':').at(-1)!).sort()
    }
  }
}
