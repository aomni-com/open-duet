import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import { v } from 'convex/values'

import type { DataModel, Id } from '../../_generated/dataModel'
import { internalMutation, internalQuery } from '../../_generated/server'
import { writeAuditEvent } from '../audit/model'
import { auditActor } from './provisioningShared'
import { desiredVmDiskGb } from './vmDiskPolicy'

type MutationCtx = GenericMutationCtx<DataModel>
type QueryCtx = GenericQueryCtx<DataModel>

export const workspaceVmResizePlan = internalQuery({
  args: { workspaceId: v.id('workspaces') },
  handler: (ctx, args) => workspaceVmResizePlanImpl(ctx, args),
})

export const recordWorkspaceVmResize = internalMutation({
  args: {
    workspaceId: v.id('workspaces'),
    expectedVmName: v.string(),
    diskGb: v.number(),
    now: v.number(),
  },
  handler: (ctx, args) => recordWorkspaceVmResizeImpl(ctx, args),
})

async function workspaceVmResizePlanImpl(ctx: QueryCtx, args: { workspaceId: Id<'workspaces'> }) {
  const workspace = await ctx.db.get(args.workspaceId)
  if (
    workspace === null ||
    workspace.status === 'deleted' ||
    workspace.status === 'retired' ||
    workspace.status === 'archived'
  ) {
    return null
  }
  return {
    vmName: workspace.vmName,
    vmDiskGb: workspace.vmDiskGb,
    desiredDiskGb: await desiredVmDiskGb(ctx, workspace),
  }
}

async function recordWorkspaceVmResizeImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    expectedVmName: string
    diskGb: number
    now: number
  },
) {
  const workspace = await ctx.db.get(args.workspaceId)
  if (
    workspace === null ||
    workspace.vmName !== args.expectedVmName ||
    (workspace.vmDiskGb !== undefined && workspace.vmDiskGb >= args.diskGb)
  ) {
    return { recorded: false as const }
  }
  await ctx.db.patch(args.workspaceId, { vmDiskGb: args.diskGb, updatedAt: args.now })
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.vm_disk_resized',
    actorId: auditActor(workspace),
    provenance: {
      source: 'workspace_vm_disk_resize',
      vmName: args.expectedVmName,
    },
    at: args.now,
  })
  return { recorded: true as const }
}
