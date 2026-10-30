'use node'

import { v } from 'convex/values'

import { action } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import {
  chargeWorkspaceVmComputeImpl,
  sweepWorkspaceVmTelemetryImpl,
} from '../domains/workspaces/vmUsage'

/**
 * Live-journey seams for the VM compute fee.
 *
 * The sweep and the charge are `internalAction`s so only the crons can reach
 * them in production. The staging journey has to drive the REAL provider path
 * on demand rather than waiting an hour for a cron tick — a journey that
 * substituted a fake would prove nothing about exe.dev, which is the entire
 * thing this feature bets on.
 *
 * Both are idempotent: samples dedup on the provider timestamp, and the charge
 * dedups on its ledger reference.
 */
export const sweepVmTelemetryForTest = action({
  args: { internalKey: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await sweepWorkspaceVmTelemetryImpl(ctx, {
      internalKey: args.internalKey,
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    })
  },
})

export const chargeVmComputeForTest = action({
  args: {
    internalKey: v.string(),
    dayKey: v.optional(v.string()),
    limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await chargeWorkspaceVmComputeImpl(ctx, {
      internalKey: args.internalKey,
      ...(args.dayKey === undefined ? {} : { dayKey: args.dayKey }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      ...(args.now === undefined ? {} : { now: args.now }),
    })
  },
})
