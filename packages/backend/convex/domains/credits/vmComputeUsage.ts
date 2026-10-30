import { v, type Infer } from 'convex/values'

import {
  integrateVmUsage,
  isChargeableVmComputeFee,
  vmComputeFeeMicroUsd,
  vmUsageDayWindow,
  type VmUsageWindow,
} from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import { internalMutation, type MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { listVmUsagePointsForWindow } from '../workspaces/vmTelemetry'
import { applyLedgerEntryWithDb } from './ledger'
import { reconcileServicingStatus } from './subscriptions'

/**
 * The reference is the idempotency key AND the collision guard.
 *
 * The daily cron only ever charges COMPLETED days; teardown only ever charges
 * the current one. They therefore cannot target the same key, so the ledger's
 * reference check is a safety net rather than the mechanism keeping them apart.
 *
 * `dayKey` is `currentDayKey()`'s dashed form -- the same format the daily usage
 * rollups already use. A second `yyyymmdd` formatter would exist only to differ
 * from the first, and force anyone comparing a ledger reference to a rollup row
 * to translate between them.
 */
export function vmUsageReference(workspaceId: Id<'workspaces'>, dayKey: string): string {
  return `vm_usage:${workspaceId}:${dayKey}`
}

export type VmComputeChargeResult =
  | {
      status: 'applied'
      reference: string
      amountMicroUsd: number
      coreHours: number
      gbHours: number
    }
  | { status: 'below_charge_floor'; amountMicroUsd: number }
  | { status: 'already_applied' | 'no_billable_interval' | 'servicing_exempt' | 'stale_identity' }

/**
 * THE sole producer of `vm_usage:` ledger entries.
 *
 * Nothing else may call `applyLedgerEntryWithDb` with that reference prefix --
 * in particular teardown must call THIS rather than computing a partial-day fee
 * inline, or the pricing rule acquires a second owner that can drift.
 */
export async function applyVmComputeWindowWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    dayKey: string
    expectedVmName?: string
    window?: VmUsageWindow
    now: number
  },
): Promise<VmComputeChargeResult> {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) return { status: 'stale_identity' }
  // A delayed charge must not bill a replacement VM for its predecessor.
  if (args.expectedVmName !== undefined && workspace.vmName !== args.expectedVmName) {
    return { status: 'stale_identity' }
  }
  // Duet pays for these. Re-checked here rather than trusted from the candidate
  // query, because the exemption can be granted between the two.
  if (workspace.servicingExemptAt !== undefined) return { status: 'servicing_exempt' }

  const dayWindow = args.window ?? vmUsageDayWindow(args.dayKey)
  // Never bill past the present: a partial day must stop at `now`.
  const window = { startAt: dayWindow.startAt, endAt: Math.min(dayWindow.endAt, args.now) }
  if (window.endAt <= window.startAt) return { status: 'no_billable_interval' }

  const points = await listVmUsagePointsForWindow(ctx, {
    workspaceId: args.workspaceId,
    startAt: window.startAt,
    endAt: window.endAt,
  })
  const totals = integrateVmUsage(points, window)
  // A day with no data and a day with genuinely zero usage are different facts.
  // Only one of them should leave a row.
  if (totals === null) return { status: 'no_billable_interval' }

  const amountMicroUsd = vmComputeFeeMicroUsd(totals)
  /* Below the floor is not worth a ledger row, three usage rollups and a
     spend-cap increment. Reported separately from `no_billable_interval` so a
     day we measured as trivial stays distinguishable from a day we could not
     measure at all. */
  if (!isChargeableVmComputeFee(amountMicroUsd)) {
    return { status: 'below_charge_floor', amountMicroUsd }
  }

  const reference = vmUsageReference(args.workspaceId, args.dayKey)
  const applied = await applyLedgerEntryWithDb(ctx, {
    workspaceId: args.workspaceId,
    amountMicroUsd: -amountMicroUsd,
    type: 'usage',
    reference,
    transactionMetadata: { usageKind: 'vm_compute' },
    usageRollup: {},
    now: args.now,
  })
  if (!applied.applied) return { status: 'already_applied' }

  /* The ledger does NOT reconcile servicing, and a trial's entitlement depends
     on its balance staying above the hard-block floor. Without this call a fee
     can drop a trial under the floor and leave the workspace fully serviced
     until some unrelated event happens to fire. Subscribers are entitled by
     subscription state regardless of balance and are unaffected. */
  await reconcileServicingStatus(ctx, workspace.billingUserId, args.now)

  return {
    status: 'applied',
    reference,
    amountMicroUsd,
    coreHours: totals.coreHours,
    gbHours: totals.gbHours,
  }
}

export const chargeWorkspaceVmComputeDayArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  dayKey: v.string(),
  expectedVmName: v.optional(v.string()),
  now: v.number(),
})

export async function chargeWorkspaceVmComputeDayImpl(
  ctx: MutationCtx,
  args: Infer<typeof chargeWorkspaceVmComputeDayArgs>,
): Promise<VmComputeChargeResult> {
  requireApiInternalKey(args.internalKey)
  return await applyVmComputeWindowWithDb(ctx, {
    workspaceId: args.workspaceId,
    dayKey: args.dayKey,
    ...(args.expectedVmName === undefined ? {} : { expectedVmName: args.expectedVmName }),
    now: args.now,
  })
}

export const chargeWorkspaceVmComputeDay = internalMutation({
  args: chargeWorkspaceVmComputeDayArgs,
  handler: (ctx, args) => chargeWorkspaceVmComputeDayImpl(ctx, args),
})
