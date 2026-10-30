import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import {
  chargeWorkspaceVmComputeDayArgs,
  chargeWorkspaceVmComputeDayImpl,
} from '../domains/credits/vmComputeUsage'
import {
  recordWorkspaceVmSamplesArgs,
  recordWorkspaceVmSamplesImpl,
  workspaceVmUsageCandidatesArgs,
  workspaceVmUsageCandidatesImpl,
} from '../domains/workspaces/vmUsageModel'

export const seedTelemetrySamplesForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    samples: v.array(
      v.object({
        at: v.number(),
        cpuCores: v.optional(v.number()),
        cpuNominalCores: v.optional(v.number()),
        memUsedBytes: v.optional(v.number()),
        memTotalBytes: v.optional(v.number()),
        fsUsedGb: v.optional(v.number()),
        fsTotalGb: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    for (const sample of args.samples) {
      await ctx.db.insert('vmTelemetrySamples', {
        workspaceId: args.workspaceId,
        ...sample,
      })
    }
  },
})

export const rawTelemetrySamplesForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('vmTelemetrySamples')
      .withIndex('by_workspace_at', q => q.eq('workspaceId', args.workspaceId))
      .take(1000)
  },
})

/**
 * Test seam for the metering writer.
 *
 * `recordWorkspaceVmSamples` is an `internalMutation` so only the sweep action
 * can reach it in production. Dedup is the load-bearing behaviour of the whole
 * fee -- `stat --range=24h` re-returns the same points every sweep -- and it can
 * only be proven against a real database, so the test path gets its own door
 * rather than the production one being widened.
 */
export const recordVmSamplesForTest = mutation({
  args: recordWorkspaceVmSamplesArgs,
  handler: (ctx, args) => recordWorkspaceVmSamplesImpl(ctx, args),
})

/**
 * Test seam for the charge owner, for the same reason as the writer above:
 * `chargeWorkspaceVmComputeDay` is an `internalMutation` so only the cron and
 * teardown can reach it in production, but it is the one function in this
 * feature that can take money incorrectly and it must be provable against a
 * real database.
 */
export const chargeVmComputeDayForTest = mutation({
  args: chargeWorkspaceVmComputeDayArgs,
  handler: (ctx, args) => chargeWorkspaceVmComputeDayImpl(ctx, args),
})

/**
 * Test seam for the metering candidate query.
 *
 * `workspaceVmUsageCandidates` is an `internalQuery` so only the sweep can
 * reach it in production. It is also where the decision lives that a VM keeps
 * being metered while its workspace is `unhealthy` — killing the gateway must
 * not buy an exemption from the fee — so that decision needs a test that drives
 * the real query rather than a fake.
 */
export const vmUsageCandidatesForTest = query({
  args: workspaceVmUsageCandidatesArgs,
  handler: (ctx, args) => workspaceVmUsageCandidatesImpl(ctx, args),
})
