import { describe, expect, mock, test } from 'bun:test'

import {
  sweepWorkspaceVmTelemetryImpl,
  type WorkspaceVmStatExe,
} from '../convex/domains/workspaces/vmUsage'

const INTERNAL_KEY = 'vm-usage-sweep-key'
const CADENCE_MS = 10 * 60 * 1000

interface Candidate {
  workspaceId: string
  vmName: string
}

function providerPoints(count: number, cores = 0.5) {
  const end = 1_760_000_000_000
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(end - (count - 1 - index) * CADENCE_MS).toISOString(),
    cpu_cores: cores,
    cpu_nominal: 4,
    mem_used_bytes: 0.5 * 1024 ** 3,
    mem_total_bytes: 8 * 1024 ** 3,
    fs_used_gb: 7.5,
    fs_total_gb: 28,
  }))
}

/** A ctx whose recorded mutation calls are the assertion surface. */
function fakeCtx(options: {
  candidates: Candidate[]
  cursor?: string
  onRecord?: (args: Record<string, unknown>) => { inserted: number }
}) {
  const recorded: Array<Record<string, unknown>> = []
  return {
    recorded,
    ctx: {
      runQuery: async () => ({
        candidates: options.candidates,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      }),
      runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
        recorded.push(args)
        return options.onRecord?.(args) ?? { inserted: (args.points as unknown[]).length }
      },
    },
  }
}

const statExe = (points: ReturnType<typeof providerPoints>): WorkspaceVmStatExe => ({
  stat: async () => ({ points }),
})

describe('the metering sweep', () => {
  test('stores every usable point for each candidate', async () => {
    const { ctx, recorded } = fakeCtx({
      candidates: [
        { workspaceId: 'ws1', vmName: 'duet-ws-one' },
        { workspaceId: 'ws2', vmName: 'duet-ws-two' },
      ],
    })

    const result = await sweepWorkspaceVmTelemetryImpl(ctx, {
      internalKey: INTERNAL_KEY,
      exe: statExe(providerPoints(3)),
    })

    expect(result).toMatchObject({ sampled: 2, inserted: 6, failed: [] })
    expect(recorded).toHaveLength(2)
    expect(recorded[0]).toMatchObject({ workspaceId: 'ws1', expectedVmName: 'duet-ws-one' })
  })

  test('carries the VM name so a delayed write cannot bill a replacement VM', async () => {
    // A reprovision between the stat and the write would otherwise attribute a
    // dead VM's usage to the new one.
    const { ctx, recorded } = fakeCtx({
      candidates: [{ workspaceId: 'ws1', vmName: 'duet-ws-one' }],
    })

    await sweepWorkspaceVmTelemetryImpl(ctx, {
      internalKey: INTERNAL_KEY,
      exe: statExe(providerPoints(2)),
    })

    expect(recorded[0]!.expectedVmName).toBe('duet-ws-one')
  })

  test('one VM failing does not stop the sweep reaching the rest', async () => {
    // A single wedged VM must never become a permanent block on every workspace
    // behind it in the page.
    const { ctx, recorded } = fakeCtx({
      candidates: [
        { workspaceId: 'ws1', vmName: 'broken' },
        { workspaceId: 'ws2', vmName: 'fine' },
      ],
    })
    const exe: WorkspaceVmStatExe = {
      stat: async name => {
        if (name === 'broken') throw new Error('lobby exploded')
        return { points: providerPoints(2) }
      },
    }

    const result = await sweepWorkspaceVmTelemetryImpl(ctx, { internalKey: INTERNAL_KEY, exe })

    expect(result.sampled).toBe(1)
    expect(result.failed).toEqual([
      { vmName: 'broken', error: expect.stringContaining('lobby exploded') },
    ])
    expect(recorded.map(call => call.workspaceId)).toEqual(['ws2'])
  })

  test('a VM with no points writes nothing at all', async () => {
    // Distinct from "zero usage": an empty response means the provider told us
    // nothing, and inventing a zero row would read downstream as a measurement.
    const { ctx, recorded } = fakeCtx({
      candidates: [{ workspaceId: 'ws1', vmName: 'duet-ws-one' }],
    })

    const result = await sweepWorkspaceVmTelemetryImpl(ctx, {
      internalKey: INTERNAL_KEY,
      exe: statExe([]),
    })

    expect(result).toMatchObject({ sampled: 0, inserted: 0 })
    expect(recorded).toHaveLength(0)
  })

  test('a malformed envelope fails that VM without poisoning the others', async () => {
    const { ctx } = fakeCtx({
      candidates: [
        { workspaceId: 'ws1', vmName: 'garbage' },
        { workspaceId: 'ws2', vmName: 'fine' },
      ],
    })
    const exe = {
      stat: async (name: string) =>
        name === 'garbage' ? ({ nope: true } as never) : { points: providerPoints(2) },
    }

    const result = await sweepWorkspaceVmTelemetryImpl(ctx, { internalKey: INTERNAL_KEY, exe })

    expect(result.sampled).toBe(1)
    expect(result.failed[0]!.vmName).toBe('garbage')
  })

  test('a non-array points payload fails that VM without poisoning the others', async () => {
    const { ctx } = fakeCtx({
      candidates: [
        { workspaceId: 'ws1', vmName: 'garbage' },
        { workspaceId: 'ws2', vmName: 'fine' },
      ],
    })
    const exe = {
      stat: async (name: string) =>
        name === 'garbage' ? ({ points: {} } as never) : { points: providerPoints(2) },
    }

    const result = await sweepWorkspaceVmTelemetryImpl(ctx, { internalKey: INTERNAL_KEY, exe })

    expect(result.sampled).toBe(1)
    expect(result.failed).toEqual([
      { vmName: 'garbage', error: 'Error: exe stat `points` is not an array' },
    ])
  })

  test('passes the page cursor back so the caller can chain', async () => {
    const { ctx } = fakeCtx({
      candidates: [{ workspaceId: 'ws1', vmName: 'duet-ws-one' }],
      cursor: 'next-page',
    })

    const result = await sweepWorkspaceVmTelemetryImpl(ctx, {
      internalKey: INTERNAL_KEY,
      exe: statExe(providerPoints(2)),
    })

    expect(result.cursor).toBe('next-page')
  })

  test('never reaches for the provider lobby', async () => {
    // exe.list() returns VMs from BOTH staging and production -- one account
    // backs both. Driving from workspace rows is what keeps the sweep scoped.
    const list = mock(async () => [])
    const { ctx } = fakeCtx({ candidates: [{ workspaceId: 'ws1', vmName: 'duet-ws-one' }] })

    await sweepWorkspaceVmTelemetryImpl(ctx, {
      internalKey: INTERNAL_KEY,
      exe: { stat: async () => ({ points: providerPoints(2) }), list } as WorkspaceVmStatExe,
    })

    expect(list).not.toHaveBeenCalled()
  })

  test('runs concurrently rather than serially', async () => {
    // At p50 3.4s per call, a serial 500-VM sweep is ~28 minutes -- past what a
    // Convex action survives, and it fails as a partially-sampled day.
    let inFlight = 0
    let peak = 0
    const { ctx } = fakeCtx({
      candidates: Array.from({ length: 20 }, (_, index) => ({
        workspaceId: `ws${index}`,
        vmName: `vm${index}`,
      })),
    })
    const exe: WorkspaceVmStatExe = {
      stat: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Bun.sleep(5)
        inFlight -= 1
        return { points: providerPoints(2) }
      },
    }

    await sweepWorkspaceVmTelemetryImpl(ctx, { internalKey: INTERNAL_KEY, exe })

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
  })
})
