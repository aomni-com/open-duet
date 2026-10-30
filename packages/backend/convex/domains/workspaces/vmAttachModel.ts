import { type GenericMutationCtx, type GenericQueryCtx } from 'convex/server'
import { v } from 'convex/values'

import {
  VmProviderHttpsUrlSchema,
  VmProviderNameSchema,
  VmProviderSshDestSchema,
  VmVersionMetadataSchema,
} from '@repo/contract'

import type { DataModel, Id } from '../../_generated/dataModel'
import { internalMutation, internalQuery } from '../../_generated/server'
import { writeAuditEvent } from '../audit/model'
import { pinRecoveryBackup } from './lifecycleState'
import { auditActor } from './provisioningShared'
import { desiredVmDiskGb } from './vmDiskPolicy'
import { desiredWorkspaceVmCaps } from './vmSizePolicy'

type MutationCtx = GenericMutationCtx<DataModel>
type QueryCtx = GenericQueryCtx<DataModel>

export const workspaceVmAttachPlan = internalQuery({
  args: { workspaceId: v.id('workspaces'), now: v.number() },
  handler: (ctx, args) => workspaceVmAttachPlanImpl(ctx, args),
})

export const prepareWorkspaceVmAttach = internalMutation({
  args: {
    workspaceId: v.id('workspaces'),
    imageRef: v.string(),
    provisioningTokenHash: v.string(),
    provisioningTokenExpiresAt: v.number(),
    vmTokenNonce: v.string(),
    now: v.number(),
  },
  handler: (ctx, args) => prepareWorkspaceVmAttachImpl(ctx, args),
})

export const recordWorkspaceVmAttach = internalMutation({
  args: {
    workspaceId: v.id('workspaces'),
    diskGb: v.number(),
    vmName: v.string(),
    sshDest: v.string(),
    httpsUrl: v.optional(v.string()),
    imageRef: v.string(),
    vmTokenNonce: v.string(),
    now: v.number(),
  },
  handler: (ctx, args) => recordWorkspaceVmAttachImpl(ctx, args),
})

async function workspaceVmAttachPlanImpl(
  ctx: QueryCtx,
  args: { workspaceId: Id<'workspaces'>; now: number },
) {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired') {
    throw new Error('Workspace not found')
  }
  return {
    imageRef: workspace.imageRef,
    diskGb: await desiredVmDiskGb(ctx, workspace),
    vmCaps: await desiredWorkspaceVmCaps(ctx, workspace, args.now),
    vmName: workspace.vmName,
    vmTokenNonce: workspace.vmTokenNonce,
    attachAllowed:
      workspace.onboardedAt !== undefined &&
      (workspace.servicingStatus === undefined || workspace.servicingStatus === 'active'),
    // Carried into the plan because the VM's tags are decided at create time and
    // cannot be corrected later without a rebuild.
    ephemeral: workspace.ephemeral,
  }
}

async function prepareWorkspaceVmAttachImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    imageRef: string
    provisioningTokenHash: string
    provisioningTokenExpiresAt: number
    vmTokenNonce: string
    now: number
  },
) {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired') {
    throw new Error('Workspace not found')
  }
  if (
    workspace.onboardedAt === undefined ||
    (workspace.servicingStatus !== undefined && workspace.servicingStatus !== 'active')
  ) {
    return { ok: false as const }
  }
  await pinRecoveryBackup(ctx, workspace)
  const imageRef = VmVersionMetadataSchema.parse(args.imageRef)
  await ctx.db.patch(args.workspaceId, {
    status: 'provisioning',
    updatedAt: args.now,
    nextVmImageRef: imageRef,
    provisioningTokenHash: args.provisioningTokenHash,
    provisioningTokenExpiresAt: args.provisioningTokenExpiresAt,
    provisioningTokenUsedAt: undefined,
    vmCleanupPending: true,
    vmTokenNonce: args.vmTokenNonce,
    vmTokenHash: undefined,
    syncthingDeviceId: undefined,
  })
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.provisioning_started',
    actorId: auditActor(workspace),
    at: args.now,
    provenance: { imageRef, source: 'workspace_vm_attach' },
  })
  return { ok: true as const }
}

async function recordWorkspaceVmAttachImpl(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    diskGb: number
    vmName: string
    sshDest: string
    httpsUrl?: string
    imageRef: string
    vmTokenNonce: string
    now: number
  },
) {
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired') {
    throw new Error('Workspace not found')
  }
  if (workspace.servicingStatus !== undefined && workspace.servicingStatus !== 'active') {
    return { ok: false as const }
  }
  const vmName = VmProviderNameSchema.parse(args.vmName)
  const sshDest = VmProviderSshDestSchema.parse(args.sshDest)
  const httpsUrl =
    args.httpsUrl === undefined ? undefined : VmProviderHttpsUrlSchema.parse(args.httpsUrl)
  await pinRecoveryBackup(ctx, workspace)
  const imageRef = VmVersionMetadataSchema.parse(args.imageRef)
  await ctx.db.patch(args.workspaceId, {
    vmDiskGb: args.diskGb,
    vmName,
    sshDest,
    httpsUrl,
    vmCleanupPending: true,
    vmTokenNonce: args.vmTokenNonce,
    imageRef,
    updatedAt: args.now,
  })
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.vm_attached',
    actorId: auditActor(workspace),
    at: args.now,
    provenance: {
      vmName,
      imageRef,
      source: 'workspace_vm_attach',
    },
  })
  return { ok: true as const }
}
