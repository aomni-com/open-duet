import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import { v } from 'convex/values'

import type { WorkspaceVmCaps } from '@repo/contract'

import type { DataModel, Id } from '../../_generated/dataModel'
import { internalMutation, internalQuery } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { auditActor } from './provisioningShared'
import { desiredWorkspaceVmCaps } from './vmSizePolicy'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>

// A safety ceiling against an unbounded read, not a paginator: there is no
// cursor, so this always takes the same first 500 candidates by
// lastHeartbeatAt ascending. The live fleet (~20) is far below that, so every
// candidate is checked every run today. That is NOT a designed guarantee once
// the fleet passes 500 — candidates past the cutoff would only rotate into
// view by incidental heartbeat reordering, not by an owned cursor. Add real
// pagination before the fleet gets anywhere close to this number.
const WORKSPACE_VM_SIZE_SWEEP_LIMIT = 500

export interface SizeCandidate {
  workspaceId: Id<'workspaces'>
  vmName: string
  vmCaps: WorkspaceVmCaps
}

export const workspaceVmSizeCandidates = internalQuery({
  args: { internalKey: v.string(), now: v.number() },
  handler: (ctx, args) => workspaceVmSizeCandidatesImpl(ctx, args),
})

export async function workspaceVmSizeCandidatesImpl(
  ctx: QueryCtx,
  args: { internalKey: string; now: number },
): Promise<SizeCandidate[]> {
  requireApiInternalKey(args.internalKey)
  const workspaces = await ctx.db
    .query('workspaces')
    .withIndex('by_status_lastHeartbeat', q => q.eq('status', 'active'))
    .filter(q => q.neq(q.field('vmName'), undefined))
    .take(WORKSPACE_VM_SIZE_SWEEP_LIMIT)
  return await Promise.all(
    workspaces.map(async workspace => ({
      workspaceId: workspace._id,
      vmName: workspace.vmName as string,
      vmCaps: await desiredWorkspaceVmCaps(ctx, workspace, args.now),
    })),
  )
}

// Thin: record-only, mirroring recordWorkspaceVmResize. No cpu/memory field is
// patched onto the workspace row because none is cached there — the sweep
// re-derives "current size" from the lobby's live report every run instead of
// trusting a value that could itself drift from reality, which is the same
// class of staleness that left the whole fleet undersized for five days.
export const recordWorkspaceVmSizeResize = internalMutation({
  args: {
    workspaceId: v.id('workspaces'),
    vmName: v.string(),
    cpu: v.number(),
    memory: v.string(),
    now: v.number(),
  },
  handler: (ctx, args) => recordWorkspaceVmSizeResizeImpl(ctx, args),
})

async function recordWorkspaceVmSizeResizeImpl(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; vmName: string; cpu: number; memory: string; now: number },
): Promise<void> {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) return
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.vm_size_resized',
    actorId: auditActor(workspace),
    provenance: {
      source: 'workspace_vm_size_sweep',
      vmName: args.vmName,
      cpu: args.cpu,
      memory: args.memory,
    },
    at: args.now,
  })
}
