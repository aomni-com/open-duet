import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

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

import {
  RETENTION_MS,
  TELEMETRY_CHART_POINT_LIMIT,
  downsampleTelemetrySamples,
} from '../convex/domains/workspaces/vmTelemetry'

const BACKEND_DIR = new URL('..', import.meta.url).pathname
const INTERNAL_KEY = 'test-vm-telemetry-internal-key'

let convex: ConvexDevFixture
let retentionWorkspaceId: string
let historyWorkspaceId: string

describe('VM telemetry chart downsampling', () => {
  test('averages consecutive buckets and keeps the newest timestamp in each bucket', () => {
    const samples = Array.from({ length: 5 }, (_, index) => ({
      at: index + 1,
      cpuPct: (index + 1) * 10,
      memUsedMb: (index + 1) * 100,
      diskUsedMb: 7_400,
    }))

    expect(downsampleTelemetrySamples(samples, 2)).toEqual([
      { at: 3, cpuPct: 20, memUsedMb: 200, diskUsedMb: 7_400 },
      { at: 5, cpuPct: 45, memUsedMb: 450, diskUsedMb: 7_400 },
    ])
    expect(downsampleTelemetrySamples(samples, TELEMETRY_CHART_POINT_LIMIT)).toEqual(samples)
    const thirtyDays = Array.from({ length: 30 * 24 * 12 }, (_, index) => ({
      at: index * 10 * 60 * 1000,
      cpuPct: index % 100,
    }))
    expect(downsampleTelemetrySamples(thirtyDays, TELEMETRY_CHART_POINT_LIMIT)).toHaveLength(
      TELEMETRY_CHART_POINT_LIMIT,
    )
    const justOverLimit = Array.from({ length: TELEMETRY_CHART_POINT_LIMIT + 1 }, (_, index) => ({
      at: index,
      cpuPct: index,
    }))
    expect(downsampleTelemetrySamples(justOverLimit, TELEMETRY_CHART_POINT_LIMIT)).toHaveLength(
      TELEMETRY_CHART_POINT_LIMIT,
    )
  })
})

describe('VM telemetry persistence', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: 'http://localhost:3000',
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
      },
      reset: true,
    })
    const owner = await signInWithMagicLink(
      convex,
      uniqueEmail('vm-telemetry-owner'),
      'VM Telemetry Owner',
    )
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    retentionWorkspaceId = (await mutate(
      owner.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: `vm-telemetry-${Date.now()}`,
        name: 'VM Telemetry Workspace',
      },
    )) as string
    historyWorkspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: `vm-telemetry-history-${Date.now()}`,
      name: 'VM Telemetry History Workspace',
    })) as string
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('rejects callers without the API internal key', async () => {
    await expect(
      mutate(convex, 'domains/workspaces/vmTelemetry:pruneTelemetrySamples', {
        internalKey: 'wrong-key',
        now: Date.UTC(2026, 6, 15),
      }),
    ).rejects.toThrow('Unauthorized API internal key')
  })

  test('self-schedules full batches until every stale sample is pruned', async () => {
    const now = Date.UTC(2026, 6, 15)
    const cutoff = now - RETENTION_MS
    await mutate(convex, 'testing/vmTelemetry:seedTelemetrySamplesForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: retentionWorkspaceId,
      samples: [
        { at: cutoff - 3_000, cpuCores: 0.1 },
        { at: cutoff - 2_000, cpuCores: 0.2 },
        { at: cutoff, cpuCores: 0.3 },
        { at: cutoff + 1, cpuCores: 0.4 },
        { at: now, cpuCores: 0.5 },
      ],
    })

    expect(
      await mutate(convex, 'domains/workspaces/vmTelemetry:pruneTelemetrySamples', {
        internalKey: INTERNAL_KEY,
        now,
        limit: 2,
      }),
    ).toEqual({ pruned: 2, done: false })

    await expectTelemetrySamples([
      expect.objectContaining({ at: cutoff + 1, cpuCores: 0.4 }),
      expect.objectContaining({ at: now, cpuCores: 0.5 }),
    ])
    expect(
      await mutate(convex, 'domains/workspaces/vmTelemetry:pruneTelemetrySamples', {
        internalKey: INTERNAL_KEY,
        now,
        limit: 2,
      }),
    ).toEqual({ pruned: 0, done: true })
  })

  describe('history', () => {
    beforeAll(async () => {
      await mutate(convex, 'testing/vmTelemetry:seedTelemetrySamplesForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: historyWorkspaceId,
        samples: [
          {
            at: 300,
            cpuCores: 1.2,
            cpuNominalCores: 4,
            memUsedBytes: 300 * 1024 * 1024,
            memTotalBytes: 1000 * 1024 * 1024,
            fsUsedGb: 7.42,
          },
          { at: 100, cpuCores: 0.4, cpuNominalCores: 4 },
          {
            at: 200,
            cpuCores: 0.8,
            cpuNominalCores: 4,
            memUsedBytes: 200 * 1024 * 1024,
            memTotalBytes: 1000 * 1024 * 1024,
            fsUsedGb: 7.4,
          },
        ],
      })
    })

    test('re-sampling the same window inserts nothing the second time', async () => {
      // THE load-bearing test of this feature. `stat --range=24h` re-returns the
      // same points on every sweep, so an hourly sampler sees each one about six
      // times. If dedup is wrong by a millisecond of timestamp parsing, every
      // point is stored repeatedly and every bill is a multiple -- and after the
      // fact that is indistinguishable from real usage.
      // Reuses the fixture workspace; these timestamps do not collide with the
      // seeded 100/200/300 above.
      const dedupWorkspaceId = historyWorkspaceId
      const points = [
        {
          at: 1_000,
          cpuCores: 0.5,
          cpuNominalCores: 4,
          memUsedGb: 0.5,
          memTotalGb: 8,
        },
        {
          at: 2_000,
          cpuCores: 0.6,
          cpuNominalCores: 4,
          memUsedGb: 0.5,
          memTotalGb: 8,
        },
      ]

      const first = await mutate(convex, 'testing/vmTelemetry:recordVmSamplesForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: dedupWorkspaceId,
        points,
      })
      const replay = await mutate(convex, 'testing/vmTelemetry:recordVmSamplesForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: dedupWorkspaceId,
        points,
      })
      const overlapping = await mutate(convex, 'testing/vmTelemetry:recordVmSamplesForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: dedupWorkspaceId,
        points: [
          ...points,
          {
            at: 3_000,
            cpuCores: 0.7,
            cpuNominalCores: 4,
            memUsedGb: 0.5,
            memTotalGb: 8,
          },
        ],
      })

      expect(first).toEqual({ inserted: 2, skipped: 0 })
      expect(replay).toEqual({ inserted: 0, skipped: 2 })
      expect(overlapping).toEqual({ inserted: 1, skipped: 2 })

      const stored = (await query(convex, 'testing/vmTelemetry:rawTelemetrySamplesForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: dedupWorkspaceId,
      })) as Array<{ at: number }>
      const deduped = stored.map(row => row.at).filter(at => at >= 1_000)
      expect(deduped.sort((a, b) => a - b)).toEqual([1_000, 2_000, 3_000])
    })

    test('a sample destined for a replaced VM is dropped, not misattributed', async () => {
      // A delayed write landing after a reprovision must not charge the new VM
      // for the dead one's usage.
      const result = await mutate(convex, 'testing/vmTelemetry:recordVmSamplesForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: historyWorkspaceId,
        expectedVmName: 'a-vm-this-workspace-never-had',
        points: [
          {
            at: 9_000,
            cpuCores: 4,
            cpuNominalCores: 4,
            memUsedGb: 8,
            memTotalGb: 8,
          },
        ],
      })

      expect(result).toEqual({ inserted: 0, skipped: 1 })
      const stored = (await query(convex, 'testing/vmTelemetry:rawTelemetrySamplesForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: historyWorkspaceId,
      })) as Array<{ at: number }>
      expect(stored.map(row => row.at)).not.toContain(9_000)
    })

    test('returns an internal actor’s bounded range in ascending time order', async () => {
      const actor = await signInWithMagicLink(
        convex,
        uniqueEmail('vm-telemetry-history-actor'),
        'VM Telemetry History Actor',
      )
      const actorId = (actor.user as { _id: string })._id
      await mutate(convex, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: historyWorkspaceId,
        userId: actorId,
        role: 'viewer',
      })

      const samples = await query(convex, 'domains/workspaces/vmTelemetry:listTelemetryHistory', {
        internalKey: INTERNAL_KEY,
        actorId,
        workspaceId: historyWorkspaceId,
        sinceAt: 150,
        now: 300,
        limit: 2,
      })

      // Stored as absolute cores; the chart's percentage is derived on read.
      expect(samples).toEqual([
        expect.objectContaining({ at: 200, cpuPct: 20 }),
        expect.objectContaining({ at: 300, cpuPct: 30 }),
      ])
    })

    test('stores provider units raw, so no presentation decision is baked into the record', async () => {
      const samples = (await query(convex, 'testing/vmTelemetry:rawTelemetrySamplesForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: historyWorkspaceId,
      })) as Array<Record<string, unknown>>

      // Absolute cores, not a percentage: the percentage is clamped to 100 for
      // the chart, and a clamp reaching the fee would undercharge a saturated
      // 10-core VM by 2.5x.
      expect(samples).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            at: 100,
            cpuCores: 0.4,
            cpuNominalCores: 4,
          }),
          expect.objectContaining({ at: 200, fsUsedGb: 7.4 }),
        ]),
      )
      // Filesystem fields are optional -- a point without them is still billable.
      expect(samples.find(sample => sample.at === 100)).not.toHaveProperty('fsUsedGb')
    })

    test('rejects an internal actor who is not a workspace member', async () => {
      const outsider = await signInWithMagicLink(
        convex,
        uniqueEmail('vm-telemetry-history-outsider'),
        'VM Telemetry History Outsider',
      )
      const outsiderId = (outsider.user as { _id: string })._id
      await expect(
        query(convex, 'domains/workspaces/vmTelemetry:listTelemetryHistory', {
          internalKey: INTERNAL_KEY,
          actorId: outsiderId,
          workspaceId: historyWorkspaceId,
          sinceAt: 0,
          now: 300,
        }),
      ).rejects.toThrow('Requires viewer access')
    })

    test('rejects an internal service read without an actor identity', async () => {
      await expect(
        query(convex, 'domains/workspaces/vmTelemetry:listTelemetryHistory', {
          internalKey: INTERNAL_KEY,
          workspaceId: historyWorkspaceId,
          sinceAt: 0,
          now: 300,
        }),
      ).rejects.toThrow('actorId is required with internalKey')
    })
  })
})

async function expectTelemetrySamples(expected: unknown[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const samples = (await query(convex, 'testing/vmTelemetry:rawTelemetrySamplesForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: retentionWorkspaceId,
    })) as unknown[]
    if (samples.length === expected.length) {
      expect(samples).toEqual(expected)
      return
    }
    await Bun.sleep(20)
  }
  throw new Error('Timed out waiting for telemetry retention to finish')
}
