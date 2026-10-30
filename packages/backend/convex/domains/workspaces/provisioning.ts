import { v } from 'convex/values'

import { mutation, query } from '../../_generated/server'
import {
  activeWorkspacesForSnapshotImpl,
  beginOperatorReprovisionImpl,
  servicingDecommissionCandidatesImpl,
  markRetiredImpl,
  markServicingArchivedImpl,
  markAdminArchivedImpl,
  markUnhealthyWorkspacesImpl,
  operatorReprovisionPlanImpl,
  recordOperatorReprovisionDeferredImpl,
  recordSnapshotImpl,
  sweepLeakedWorkspaceVmTeardownsImpl,
} from './provisioningCore'
import { registerVmImpl } from './registration'
import {
  restoreForVmImpl,
  gatewayConnectionBySlugImpl,
  gatewayConnectionForBackupImpl,
  gatewayConnectionByVmTokenImpl,
  workspaceForVmTerminalRelayImpl,
} from './vmToken'

export const registerVmArgs = v.object({
  internalKey: v.string(),
  provisioningTokenHash: v.string(),
  workspaceHint: v.string(),
  vmName: v.optional(v.string()),
  sshDest: v.optional(v.string()),
  httpsUrl: v.optional(v.string()),
  runtimeVersion: v.optional(v.string()),
  imageVersion: v.optional(v.string()),
  deliverModelCredentials: v.optional(v.boolean()),
  now: v.number(),
})

export const registerVm = mutation({
  args: registerVmArgs,
  handler: (ctx, args) => registerVmImpl(ctx, args),
})

export const markUnhealthyWorkspacesArgs = v.object({
  internalKey: v.string(),
  now: v.optional(v.number()),
  staleAfterMs: v.optional(v.number()),
})

export const markUnhealthyWorkspaces = mutation({
  args: markUnhealthyWorkspacesArgs,
  handler: (ctx, args) => markUnhealthyWorkspacesImpl(ctx, args),
})

export const sweepLeakedWorkspaceVmTeardownsArgs = v.object({
  internalKey: v.string(),
  now: v.optional(v.number()),
})

export const sweepLeakedWorkspaceVmTeardowns = mutation({
  args: sweepLeakedWorkspaceVmTeardownsArgs,
  handler: (ctx, args) => sweepLeakedWorkspaceVmTeardownsImpl(ctx, args),
})

export const servicingDecommissionCandidatesArgs = v.object({
  internalKey: v.string(),
  now: v.number(),
  /* Restrict the sweep to one workspace. The cron never passes this — its job
     is the fleet — but the staging journey that provokes a decommission MUST:
     it calls this action against live staging, and an unscoped call from a
     test is the fleet-wide reaper pointed at every real workspace whose row
     happens to qualify in that instant. */
  workspaceId: v.optional(v.id('workspaces')),
  /* The rows a budget-bound pass deferred, for the continuation that finishes
     them: a chain only ever completes the queue its cron started with. */
  workspaceIds: v.optional(v.array(v.id('workspaces'))),
})

export const servicingDecommissionCandidates = query({
  args: servicingDecommissionCandidatesArgs,
  handler: (ctx, args) => servicingDecommissionCandidatesImpl(ctx, args),
})

export const operatorReprovisionPlanArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  actorId: v.optional(v.id('users')),
})

export const operatorReprovisionPlan = query({
  args: operatorReprovisionPlanArgs,
  handler: (ctx, args) => operatorReprovisionPlanImpl(ctx, args),
})

export const markRetiredArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  lifecycleBackupId: v.optional(v.id('workspaceBackups')),
  now: v.number(),
})

export const markServicingArchivedArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  servicingStatus: v.union(v.literal('paused'), v.literal('banned')),
  servicingStatusChangedAt: v.number(),
  expectedVmName: v.optional(v.string()),
  expectedVmTokenNonce: v.optional(v.string()),
  lifecycleBackupId: v.optional(v.id('workspaceBackups')),
  now: v.number(),
})

export const markServicingArchived = mutation({
  args: markServicingArchivedArgs,
  handler: (ctx, args) => markServicingArchivedImpl(ctx, args),
})

export const markAdminArchivedArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  lifecycleBackupId: v.optional(v.id('workspaceBackups')),
  now: v.number(),
})

export const markAdminArchived = mutation({
  args: markAdminArchivedArgs,
  handler: (ctx, args) => markAdminArchivedImpl(ctx, args),
})

export const markRetired = mutation({
  args: markRetiredArgs,
  handler: (ctx, args) => markRetiredImpl(ctx, args),
})

export const beginOperatorReprovisionArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  imageRef: v.optional(v.string()),
  lifecycleBackupId: v.optional(v.id('workspaceBackups')),
  previousVmName: v.optional(v.string()),
  actorId: v.optional(v.id('users')),
  now: v.number(),
})

export const beginOperatorReprovision = mutation({
  args: beginOperatorReprovisionArgs,
  handler: (ctx, args) => beginOperatorReprovisionImpl(ctx, args),
})

export const recordOperatorReprovisionDeferredArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  activeAgentSessions: v.number(),
  activeTrainJobs: v.number(),
  actorId: v.optional(v.id('users')),
  now: v.number(),
})

export const recordOperatorReprovisionDeferred = mutation({
  args: recordOperatorReprovisionDeferredArgs,
  handler: (ctx, args) => recordOperatorReprovisionDeferredImpl(ctx, args),
})

export const recordSnapshotArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  snapshotVmName: v.string(),
  now: v.number(),
})

export const recordSnapshot = mutation({
  args: recordSnapshotArgs,
  handler: (ctx, args) => recordSnapshotImpl(ctx, args),
})

export const activeWorkspacesForSnapshotArgs = v.object({ internalKey: v.string() })

export const activeWorkspacesForSnapshot = query({
  args: activeWorkspacesForSnapshotArgs,
  handler: (ctx, args) => activeWorkspacesForSnapshotImpl(ctx, args),
})

export const restoreForVmArgs = v.object({
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  vmTokenHash: v.string(),
})

export const restoreForVm = query({
  args: restoreForVmArgs,
  handler: (ctx, args) => restoreForVmImpl(ctx, args),
})

export const gatewayConnectionBySlugArgs = v.object({
  internalKey: v.string(),
  slug: v.string(),
  allowPaused: v.optional(v.boolean()),
})

export const gatewayConnectionBySlug = query({
  args: gatewayConnectionBySlugArgs,
  handler: (ctx, args) => gatewayConnectionBySlugImpl(ctx, args),
})

export const gatewayConnectionForBackup = query({
  args: { internalKey: v.string(), backupId: v.id('workspaceBackups'), attemptId: v.string() },
  handler: gatewayConnectionForBackupImpl,
})

export const gatewayConnectionByVmTokenArgs = v.object({
  internalKey: v.string(),
  vmTokenHash: v.string(),
})

export const gatewayConnectionByVmToken = query({
  args: gatewayConnectionByVmTokenArgs,
  handler: (ctx, args) => gatewayConnectionByVmTokenImpl(ctx, args),
})

export const workspaceForVmTerminalRelay = query({
  args: { internalKey: v.string(), vmTokenHash: v.string() },
  handler: (ctx, args) => workspaceForVmTerminalRelayImpl(ctx, args),
})
