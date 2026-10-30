import { v, type Infer } from 'convex/values'

import type { VmUsagePoint } from '@repo/exe'

import type { Id } from '../../_generated/dataModel'
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { recordProviderTelemetrySamplesWithDb } from './vmTelemetry'

/**
 * Every workspace status that can still have a VM burning pool capacity.
 *
 * `unhealthy` is the load-bearing one. `markUnhealthyWorkspaces` flips a
 * workspace there when its gateway stops phoning home — and the VM keeps
 * running. Metering only `active`, which is what the VM-size sweep does, would
 * hand an abuser a one-command exemption (`systemctl stop` the gateway) from a
 * fee whose entire premise is being immune to VM-side tampering.
 *
 * `provisioning` is included because `vmAttach` records `vmName` before the
 * workspace goes active.
 */
export const METERED_STATUSES = ['active', 'unhealthy', 'provisioning'] as const

export interface VmUsageCandidate {
  workspaceId: Id<'workspaces'>
  vmName: string
  vmTokenNonce?: string
}

export const workspaceVmUsageCandidatesArgs = v.object({
  internalKey: v.string(),
  cursor: v.optional(v.string()),
  limit: v.optional(v.number()),
})

/**
 * Which VMs get metered, driven from THIS deployment's workspace rows.
 *
 * Never from `exe.list()`. One exe.dev account backs staging and production,
 * VM names are opaque hashes, and tags are the only environment marker — so
 * walking the lobby would attribute production VMs to staging workspaces. The
 * inverted loop looks more efficient and is wrong.
 */
export async function workspaceVmUsageCandidatesImpl(
  ctx: QueryCtx,
  args: Infer<typeof workspaceVmUsageCandidatesArgs>,
): Promise<{ candidates: VmUsageCandidate[]; cursor?: string }> {
  requireApiInternalKey(args.internalKey)
  const limit = args.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('limit must be an integer from 1 to 500')
  }

  const page = await ctx.db
    .query('workspaces')
    .withIndex('by_billing_user')
    .paginate({ cursor: args.cursor ?? null, numItems: limit })

  const candidates = page.page.flatMap(workspace =>
    workspace.vmName === undefined ||
    !(METERED_STATUSES as readonly string[]).includes(workspace.status)
      ? []
      : [
          {
            workspaceId: workspace._id,
            vmName: workspace.vmName,
            ...(workspace.vmTokenNonce === undefined
              ? {}
              : { vmTokenNonce: workspace.vmTokenNonce }),
          },
        ],
  )
  return { candidates, ...(page.isDone ? {} : { cursor: page.continueCursor }) }
}

export const workspaceVmUsageCandidates = internalQuery({
  args: workspaceVmUsageCandidatesArgs,
  handler: (ctx, args) => workspaceVmUsageCandidatesImpl(ctx, args),
})

export const recordWorkspaceVmSamplesArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  expectedVmName: v.optional(v.string()),
  points: v.array(
    v.object({
      at: v.number(),
      cpuCores: v.number(),
      cpuNominalCores: v.number(),
      memUsedGb: v.number(),
      memTotalGb: v.number(),
      fsUsedGb: v.optional(v.number()),
      fsTotalGb: v.optional(v.number()),
    }),
  ),
})

export async function recordWorkspaceVmSamplesImpl(
  ctx: MutationCtx,
  args: Infer<typeof recordWorkspaceVmSamplesArgs>,
): Promise<{ inserted: number; skipped: number }> {
  requireApiInternalKey(args.internalKey)
  return await recordProviderTelemetrySamplesWithDb(ctx, {
    workspaceId: args.workspaceId,
    ...(args.expectedVmName === undefined ? {} : { expectedVmName: args.expectedVmName }),
    points: args.points as VmUsagePoint[],
  })
}

export const recordWorkspaceVmSamples = internalMutation({
  args: recordWorkspaceVmSamplesArgs,
  handler: (ctx, args) => recordWorkspaceVmSamplesImpl(ctx, args),
})
