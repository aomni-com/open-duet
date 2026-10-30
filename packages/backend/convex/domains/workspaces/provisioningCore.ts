import type { Infer } from 'convex/values'

import {
  RESTORE_STALL_MS,
  SERVICING_ARCHIVE_AFTER_MS,
  VM_SYNC_STALE_MS,
  VmProviderNameSchema,
  VmVersionMetadataSchema,
} from '@repo/contract'

import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import {
  terminalizeOpenSessionsForWorkspace,
  terminalizeSessionsForProvisioningFailure,
} from '../agentSessions/events'
import { requireApiInternalKey, revokeVmModelKeyForWorkspace } from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { stopStalledRestore } from '../workspaceBackups/restore'
import { assertActorRole } from './authorization'
import { finishRecovery } from './lifecycleState'
import type {
  activeWorkspacesForSnapshotArgs,
  beginOperatorReprovisionArgs,
  servicingDecommissionCandidatesArgs,
  markRetiredArgs,
  markServicingArchivedArgs,
  markUnhealthyWorkspacesArgs,
  operatorReprovisionPlanArgs,
  recordOperatorReprovisionDeferredArgs,
  recordSnapshotArgs,
  sweepLeakedWorkspaceVmTeardownsArgs,
  markAdminArchivedArgs,
} from './provisioning'
import { auditActor } from './provisioningShared'
import { scheduleWorkspaceVmTeardown } from './vmTeardownSchedule'

export const PROVISIONING_TOKEN_EXPIRES_MS = 10 * 60 * 1000
const WORKSPACE_SWEEP_LIMIT = 1000
const WORKSPACE_ACTIVE_WORK_LIMIT = 500
const WORKSPACE_VM_TEARDOWN_SWEEP_LIMIT = 100
const WORKSPACE_VM_TEARDOWN_RETRY_MS = 5 * 60 * 1000
const WORKSPACE_HEALTH_SWEEP_RETRY_MS = 5 * 60 * 1000

function servicingDecommissionTargetStatus(
  servicingStatus: 'paused' | 'banned',
): 'archived' | 'retired' {
  return servicingStatus === 'paused' ? 'archived' : 'retired'
}

/**
 * Whether an unserviced workspace has actually completed its warning window.
 *
 * The sweep measures from `servicingStatusChangedAt`, which is only refreshed
 * when the VERDICT changes. A workspace whose verdict flipped to `paused`
 * transiently — its trial wallet not yet funded in the instant birth computed
 * it — and was never revisited keeps that first stamp for the whole trial. The
 * sweep then reads a long-expired pause on the day the trial ends and destroys
 * the workspace minutes later, with no warning window at all.
 *
 * So the stamp alone is not the window. A payer entitled at any point after the
 * stamp proves the workspace was serviced inside it, and the window can only
 * start where that entitlement ended.
 */
function servicingWindowStartedAt(input: {
  servicingStatusChangedAt: number
  entitledUntil?: number
}): number {
  return input.entitledUntil !== undefined && input.entitledUntil > input.servicingStatusChangedAt
    ? input.entitledUntil
    : input.servicingStatusChangedAt
}

/**
 * When the hourly sweep may end an unserviced workspace.
 *
 * A pause is a person's lapsed trial, and the window after it is the warning
 * the wall promises them. A ban is an operator's verdict that there is no
 * person to warn — the row is due the moment it was banned, trial or no
 * trial. Written as one function so the sweep's selection and its per-row
 * check cannot disagree about which stamp the clock runs from.
 */
export function servicingDecommissionDueAt(input: {
  servicingStatus: 'paused' | 'banned'
  servicingStatusChangedAt: number
  entitledUntil?: number
}): number {
  if (input.servicingStatus === 'banned') return input.servicingStatusChangedAt
  return servicingWindowStartedAt(input) + SERVICING_ARCHIVE_AFTER_MS
}

/**
 * An archive is pulled for a payer who may come back for their files: a
 * subscriber whose pause lapses into decommission. A ban never archives,
 * subscriber or not — the operator has already decided nobody is coming back,
 * and the pull is the expensive step of a decommission (twenty seconds a row
 * against a farm) for bytes nothing will read.
 */
export function servicingDecommissionDisposition(input: {
  servicingStatus: 'paused' | 'banned'
  everSubscribed: boolean
}): {
  archive: boolean
  targetStatus: 'archived' | 'retired'
} {
  return {
    archive: input.servicingStatus === 'paused' && input.everSubscribed,
    targetStatus: servicingDecommissionTargetStatus(input.servicingStatus),
  }
}

/**
 * The statuses a workspace can be decommissioned FROM.
 *
 * Both mean "this workspace still holds a VM". The pair is written once
 * because the sweep that selects rows and the mutation that ends them have to
 * agree: a candidacy the closer refuses is an hourly sweep that never finishes
 * anything.
 */
const DECOMMISSIONABLE_STATUSES = ['active', 'unhealthy'] as const

function isDecommissionableStatus(
  status: Doc<'workspaces'>['status'],
): status is (typeof DECOMMISSIONABLE_STATUSES)[number] {
  return DECOMMISSIONABLE_STATUSES.some(candidate => candidate === status)
}

/**
 * What a failed archive pull does to the decommission it was blocking.
 *
 * `retry` is a bet that the VM answers on a later pass, and it is only a bet
 * worth making while the VM is still answering at all. An `unhealthy`
 * workspace is one the sync rail has not heard from in `VM_SYNC_STALE_MS`, and
 * this sweep does not even look at it until the whole window has run past the
 * pause — so
 * "try again next hour" is a loop with no exit, and the VM of a workspace
 * nobody pays for becomes immortal. There the archive is abandoned and the
 * teardown proceeds; `workspace.servicing_archived_without_archive` is what
 * says so afterwards.
 *
 * The same loop exists for a VM that answers but whose archive keeps failing,
 * so the bet is bounded in time as well: `overdueMs` past the row's due time
 * the archive is abandoned too. The archive must never hold the teardown.
 */
export const ARCHIVE_RETRY_GRACE_MS = 24 * 60 * 60 * 1000

export function dispositionAfterArchiveFailure(
  workspaceStatus: 'active' | 'unhealthy',
  overdueMs: number,
): 'teardown' | 'retry' {
  if (workspaceStatus === 'unhealthy') return 'teardown'
  return overdueMs >= ARCHIVE_RETRY_GRACE_MS ? 'teardown' : 'retry'
}

export async function markUnhealthyWorkspacesImpl(
  ctx: MutationCtx,
  args: Infer<typeof markUnhealthyWorkspacesArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const now = args.now ?? Date.now()
  const staleBefore = now - (args.staleAfterMs ?? VM_SYNC_STALE_MS)
  const changed: string[] = []
  const unattempted = await ctx.db
    .query('workspaces')
    .withIndex('by_status_healthSweepRetryAt_lastHeartbeat', q =>
      q
        .eq('status', 'active')
        .eq('healthSweepRetryAt', undefined)
        .gt('lastHeartbeatAt', 0)
        .lte('lastHeartbeatAt', staleBefore),
    )
    .take(WORKSPACE_SWEEP_LIMIT)
  const retries =
    unattempted.length === WORKSPACE_SWEEP_LIMIT
      ? []
      : await ctx.db
          .query('workspaces')
          .withIndex('by_status_healthSweepRetryAt_lastHeartbeat', q =>
            q.eq('status', 'active').gt('healthSweepRetryAt', 0).lte('healthSweepRetryAt', now),
          )
          .take(WORKSPACE_SWEEP_LIMIT - unattempted.length)
  const candidates = [...unattempted, ...retries]
  for (const workspace of candidates) {
    try {
      if (workspace.pendingBackupLifecycle?.phase === 'restoring') {
        const backup = await ctx.db.get(workspace.pendingBackupLifecycle.backupId)
        if (
          !backup?.restoration ||
          backup.restoration.vmGeneration !== workspace.vmTokenNonce ||
          backup.restoration.lastProgressAt + RESTORE_STALL_MS <= now
        )
          await stopStalledRestore(ctx, workspace)
        else await ctx.db.patch(workspace._id, { healthSweepRetryAt: now + RESTORE_STALL_MS })
        continue
      }

      // Resolve the actor before the patch: a caught throw between writes
      // would commit the status change without its audit event.
      const actorId = auditActor(workspace)
      await ctx.db.patch(workspace._id, {
        status: 'unhealthy',
        updatedAt: now,
      })
      await writeAuditEvent(ctx, {
        workspaceId: workspace._id,
        event: 'workspace.became_unhealthy',
        actorId,
        at: now,
        provenance: { lastHeartbeatAt: workspace.lastHeartbeatAt },
      })
      changed.push(workspace._id)
    } catch (error) {
      await ctx.db.patch(workspace._id, {
        healthSweepRetryAt: now + WORKSPACE_HEALTH_SWEEP_RETRY_MS,
      })
      console.error(`health sweep failed for ${workspace._id}: ${String(error)}`)
    }
  }
  const expiredProvisioning = await ctx.db
    .query('workspaces')
    .withIndex('by_status_provisioningTokenExpires', q =>
      q
        .eq('status', 'provisioning')
        .gt('provisioningTokenExpiresAt', 0)
        .lte('provisioningTokenExpiresAt', now),
    )
    // Provisioning expiry sweeps process the next expired batch; patched rows leave this index window.
    .take(WORKSPACE_SWEEP_LIMIT)
  for (const workspace of expiredProvisioning) {
    try {
      const actorId = auditActor(workspace)
      await scheduleWorkspaceVmTeardown(ctx, workspace._id)
      await terminalizeSessionsForProvisioningFailure(ctx, {
        workspaceId: workspace._id,
        now,
      })
      await ctx.db.patch(workspace._id, {
        status: 'unhealthy',
        updatedAt: now,
        provisioningTokenHash: undefined,
        provisioningTokenExpiresAt: undefined,
        vmTokenHash: undefined,
        syncthingDeviceId: undefined,
      })
      await writeAuditEvent(ctx, {
        workspaceId: workspace._id,
        event: 'workspace.provisioning_failed',
        actorId,
        at: now,
        provenance: {
          reason: 'provisioning token expired before VM registration',
        },
      })
      await finishRecovery(ctx, workspace, 'failed', 'provisioning_unhealthy')
      changed.push(workspace._id)
    } catch (error) {
      console.error(`provisioning expiry failed for ${workspace._id}: ${String(error)}`)
    }
  }
  return { changed }
}

export async function sweepLeakedWorkspaceVmTeardownsImpl(
  ctx: MutationCtx,
  args: Infer<typeof sweepLeakedWorkspaceVmTeardownsArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const now = args.now ?? Date.now()
  const scheduled: string[] = []
  for (const status of ['deleted', 'retired', 'archived'] as const) {
    const remaining = WORKSPACE_VM_TEARDOWN_SWEEP_LIMIT - scheduled.length
    if (remaining === 0) break
    const candidates = await ctx.db
      .query('workspaces')
      .withIndex('by_status_vmCleanupPending_vmTeardownRunId_retryAt', q =>
        q
          .eq('status', status)
          .eq('vmCleanupPending', true)
          .eq('vmTeardownRunId', undefined)
          .lte('vmCleanupRetryAt', now),
      )
      .take(remaining)
    for (const workspace of candidates) {
      try {
        await scheduleWorkspaceVmTeardown(ctx, workspace._id)
        scheduled.push(workspace._id)
      } catch (error) {
        await ctx.db.patch(workspace._id, {
          vmCleanupRetryAt: now + WORKSPACE_VM_TEARDOWN_RETRY_MS,
        })
        console.error(`teardown sweep failed for ${workspace._id}: ${String(error)}`)
      }
    }
  }
  return { scheduled }
}

export async function servicingDecommissionCandidatesImpl(
  ctx: QueryCtx,
  args: Infer<typeof servicingDecommissionCandidatesArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const servicingBefore = args.now - SERVICING_ARCHIVE_AFTER_MS
  /* Both live statuses, sharing one budget. `unhealthy` is not a lesser kind
     of workspace — it is a workspace whose VM stopped answering the sync rail,
     with the VM still allocated, still billed by the provider and still inside
     `METERED_STATUSES`. Scanning only the `active` bucket meant a workspace
     that fell unhealthy on its way to the deadline was never a candidate again,
     and nothing else in the system removes a live workspace's VM — so an
     unentitled payer's VM ran for good. Health is a fact about the VM;
     entitlement is a fact about the payer, and only the second one decides
     whether the VM lives. */
  const unserviced: Array<{
    workspace: Doc<'workspaces'>
    status: 'active' | 'unhealthy'
    servicingStatus: 'paused' | 'banned'
  }> = []
  if (args.workspaceId !== undefined) {
    const workspace = await ctx.db.get(args.workspaceId)
    if (
      workspace &&
      isDecommissionableStatus(workspace.status) &&
      (workspace.servicingStatus === 'paused' || workspace.servicingStatus === 'banned')
    ) {
      unserviced.push({
        workspace,
        status: workspace.status,
        servicingStatus: workspace.servicingStatus,
      })
    }
  } else
    for (const status of DECOMMISSIONABLE_STATUSES) {
      const remaining = WORKSPACE_SWEEP_LIMIT - unserviced.length
      if (remaining === 0) break
      const bucket = await ctx.db
        .query('workspaces')
        .withIndex('by_status_lastHeartbeat', q => q.eq('status', status))
        // A ban is due at once; a pause only once its stamp has aged the window.
        // The per-row check below applies the same rule with entitlement in hand.
        .filter(q =>
          q.and(
            q.neq(q.field('servicingStatusChangedAt'), undefined),
            q.or(
              q.eq(q.field('servicingStatus'), 'banned'),
              q.and(
                q.eq(q.field('servicingStatus'), 'paused'),
                q.lte(q.field('servicingStatusChangedAt'), servicingBefore),
              ),
            ),
          ),
        )
        // Patched rows leave the bucket, so later sweeps advance through the fleet.
        .take(remaining)
      for (const workspace of bucket) {
        // The index filter already excludes every other value; this is the
        // narrowing the compiler cannot read off a `.filter()` expression.
        const servicingStatus = workspace.servicingStatus
        if (servicingStatus !== 'paused' && servicingStatus !== 'banned') continue
        unserviced.push({ workspace, status, servicingStatus })
      }
    }
  const rows = await Promise.all(
    unserviced
      .filter(
        row =>
          (args.workspaceId === undefined || row.workspace._id === args.workspaceId) &&
          (args.workspaceIds === undefined || args.workspaceIds.includes(row.workspace._id)),
      )
      .map(async ({ workspace, status, servicingStatus }) => {
        if (servicingStatus === 'paused' && workspace.servicingExemptAt !== undefined) return null
        const billingUser = await ctx.db.get(workspace.billingUserId)
        const everSubscribed = billingUser?.billing?.subscriptionEverActivatedAt !== undefined
        const { archive, targetStatus } = servicingDecommissionDisposition({
          servicingStatus,
          everSubscribed,
        })
        /* The window has to have run UNSERVICED end to end — "continuously
           paused for the whole window", which is the rule this sweep exists to
           enforce. The stamp alone cannot say that: a verdict that flipped to
           `paused` early and was never revisited leaves a stamp far older than
           the moment the user actually lost service, and reading it as the
           window's start destroys a workspace whose week the user spent
           working. That happened, on 2026-08-12, thirteen minutes after a
           trial expired.

           The payer's TRIAL is the evidence, and deliberately only the trial:
           a trial that expired after the stamp proves a never-subscribed
           workspace was entitled inside the window, so the window starts at
           the expiry. A subscriber's paid period proves no such thing — a
           dispute or a failing top-up pauses a subscriber mid-period, and
           that pause is the real start of their window. Applied here rather
           than by the caller, so "candidate" means decommissionable — every
           consumer of this query inherits the guard. */
        // The index filter already excludes undefined; this narrows for the
        // compiler without weakening the query's own guarantee.
        if (workspace.servicingStatusChangedAt === undefined) return null
        const entitledUntil = everSubscribed ? undefined : billingUser?.billing?.trialExpiresAt
        const dueAt = servicingDecommissionDueAt({
          servicingStatus,
          servicingStatusChangedAt: workspace.servicingStatusChangedAt,
          ...(entitledUntil === undefined ? {} : { entitledUntil }),
        })
        if (dueAt > args.now) return null
        return {
          workspaceId: workspace._id,
          slug: workspace.slug,
          dueAt,
          /* The archive step reads this to tell an unreachable VM's failed pull
             apart from a transient one; see `dispositionAfterArchiveFailure`. */
          status,
          vmName: workspace.vmName,
          httpsUrl: workspace.httpsUrl,
          vmTokenNonce: workspace.vmTokenNonce,
          servicingStatus,
          servicingStatusChangedAt: workspace.servicingStatusChangedAt,
          archive,
          targetStatus,
        }
      }),
  )
  return rows.filter(row => row !== null)
}

export async function markServicingArchivedImpl(
  ctx: MutationCtx,
  args: Infer<typeof markServicingArchivedArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (
    workspace === null ||
    !isDecommissionableStatus(workspace.status) ||
    workspace.servicingStatus !== args.servicingStatus ||
    workspace.servicingStatusChangedAt !== args.servicingStatusChangedAt ||
    workspace.vmName !== args.expectedVmName ||
    workspace.vmTokenNonce !== args.expectedVmTokenNonce
  ) {
    return { ok: false as const }
  }
  const status = servicingDecommissionTargetStatus(args.servicingStatus)
  await ctx.db.patch(args.workspaceId, {
    status,
    updatedAt: args.now,
    lifecycleBackupId: args.lifecycleBackupId,
    provisioningTokenHash: undefined,
    provisioningTokenExpiresAt: undefined,
    provisioningTokenUsedAt: undefined,
    vmTokenHash: undefined,
    syncthingDeviceId: undefined,
  })
  await revokeVmModelKeyForWorkspace(ctx, {
    workspaceId: args.workspaceId,
    now: args.now,
  })
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event:
      status === 'archived' && args.lifecycleBackupId === undefined
        ? 'workspace.servicing_archived_without_archive'
        : args.servicingStatus === 'paused'
          ? 'workspace.servicing_archived'
          : 'workspace.retired',
    actorId: auditActor(workspace),
    at: args.now,
    provenance: {
      reason: args.servicingStatus,
      lifecycleBackupId: args.lifecycleBackupId,
      vmName: workspace.vmName,
    },
  })
  await scheduleWorkspaceVmTeardown(ctx, args.workspaceId)
  return { ok: true as const, status }
}

export async function markAdminArchivedImpl(
  ctx: MutationCtx,
  args: Infer<typeof markAdminArchivedArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired') {
    throw new Error('Workspace not found')
  }
  await ctx.db.patch(args.workspaceId, {
    status: 'archived',
    servicingStatus: 'paused',
    servicingStatusChangedAt: args.now,
    lifecycleBackupId: args.lifecycleBackupId,
    updatedAt: args.now,
    provisioningTokenHash: undefined,
    provisioningTokenExpiresAt: undefined,
    provisioningTokenUsedAt: undefined,
    vmTokenHash: undefined,
    syncthingDeviceId: undefined,
  })
  await revokeVmModelKeyForWorkspace(ctx, {
    workspaceId: args.workspaceId,
    now: args.now,
  })
  await terminalizeOpenSessionsForWorkspace(ctx, args.workspaceId, args.now)
  await scheduleWorkspaceVmTeardown(ctx, args.workspaceId)
  return { ok: true as const }
}

export async function operatorReprovisionPlanImpl(
  ctx: QueryCtx,
  args: Infer<typeof operatorReprovisionPlanArgs>,
) {
  requireApiInternalKey(args.internalKey)
  if (args.actorId !== undefined) {
    await assertActorRole(ctx, args.workspaceId, args.actorId, 'owner')
  }
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired') {
    throw new Error('Workspace not found')
  }
  if (
    workspace.status !== 'active' &&
    workspace.status !== 'unhealthy' &&
    workspace.status !== 'provisioning'
  ) {
    throw new Error(`Workspace is ${workspace.status}`)
  }
  if (workspace.status === 'provisioning') {
    return {
      workspaceId: workspace._id,
      slug: workspace.slug,
      status: workspace.status,
      imageRef: workspace.imageRef,
      activeAgentSessions: 0,
      activeTrainJobs: 0,
    }
  }
  // Unfinished work blocks a reprovision, and `bucket` is the only column that
  // knows what unfinished means. Counting `status` instead — as this did — misses
  // a state machine between states, which reports `turn complete` while it runs
  // on, and misses a job asleep on a clock entirely. Either would let a
  // reprovision proceed underneath live work.
  const unfinishedSessions: Doc<'agentSessions'>[] = []
  for (const bucket of ['asking', 'running', 'scheduled'] as const) {
    if (unfinishedSessions.length >= WORKSPACE_ACTIVE_WORK_LIMIT) break
    unfinishedSessions.push(
      ...(await ctx.db
        .query('agentSessions')
        .withIndex('by_workspace_bucket', q =>
          q.eq('workspaceId', args.workspaceId).eq('bucket', bucket),
        )
        // Reprovision only needs a blocking count; 500 is already above operator actionability.
        .take(WORKSPACE_ACTIVE_WORK_LIMIT)),
    )
  }
  const queuedTrainJobs = await ctx.db
    .query('trainJobs')
    .withIndex('by_workspace_state', q =>
      q.eq('workspaceId', args.workspaceId).eq('state', 'queued'),
    )
    // Reprovision only needs a blocking count; 500 queued jobs is already above operator actionability.
    .take(WORKSPACE_ACTIVE_WORK_LIMIT)
  const runningTrainJobs = await ctx.db
    .query('trainJobs')
    .withIndex('by_workspace_state', q =>
      q.eq('workspaceId', args.workspaceId).eq('state', 'running'),
    )
    // Reprovision only needs a blocking count; 500 running jobs is already above operator actionability.
    .take(WORKSPACE_ACTIVE_WORK_LIMIT)
  const activeAgentSessions = Math.min(unfinishedSessions.length, WORKSPACE_ACTIVE_WORK_LIMIT)
  const activeTrainJobs = queuedTrainJobs.length + runningTrainJobs.length
  return {
    workspaceId: workspace._id,
    slug: workspace.slug,
    status: workspace.status,
    vmName: workspace.vmName,
    httpsUrl: workspace.httpsUrl,
    vmTokenNonce: workspace.vmTokenNonce,
    imageRef: workspace.imageRef,
    activeAgentSessions,
    activeTrainJobs,
  }
}

export async function markRetiredImpl(ctx: MutationCtx, args: Infer<typeof markRetiredArgs>) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) return { ok: false as const }
  await ctx.db.patch(args.workspaceId, {
    status: 'retired',
    updatedAt: args.now,
    lifecycleBackupId: args.lifecycleBackupId,
    provisioningTokenHash: undefined,
    provisioningTokenExpiresAt: undefined,
    provisioningTokenUsedAt: undefined,
    vmTokenHash: undefined,
    syncthingDeviceId: undefined,
  })
  await revokeVmModelKeyForWorkspace(ctx, {
    workspaceId: args.workspaceId,
    now: args.now,
  })
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.retired',
    actorId: auditActor(workspace),
    at: args.now,
    provenance: {
      lifecycleBackupId: args.lifecycleBackupId,
      vmName: workspace.vmName,
    },
  })
  await scheduleWorkspaceVmTeardown(ctx, args.workspaceId)
  return { ok: true as const }
}

export async function beginOperatorReprovisionImpl(
  ctx: MutationCtx,
  args: Infer<typeof beginOperatorReprovisionArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired') {
    throw new Error('Workspace not found')
  }
  if (workspace.status === 'provisioning') {
    return { scheduled: false as const }
  }
  if (workspace.status !== 'active' && workspace.status !== 'unhealthy') {
    throw new Error(`Workspace is ${workspace.status}`)
  }
  await revokeVmModelKeyForWorkspace(ctx, {
    workspaceId: args.workspaceId,
    now: args.now,
  })
  const imageRef =
    args.imageRef === undefined ? undefined : VmVersionMetadataSchema.parse(args.imageRef)
  await ctx.db.patch(args.workspaceId, {
    status: 'provisioning',
    updatedAt: args.now,
    nextVmImageRef: imageRef,
    lifecycleBackupId: args.lifecycleBackupId,
    provisioningTokenHash: undefined,
    provisioningTokenExpiresAt: undefined,
    provisioningTokenUsedAt: undefined,
    vmTokenNonce: undefined,
    vmTokenHash: undefined,
    syncthingDeviceId: undefined,
  })
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.operator_reprovision_started',
    actorId: args.actorId ?? auditActor(workspace),
    at: args.now,
    provenance: {
      imageRef,
      lifecycleBackupId: args.lifecycleBackupId,
      previousVmName: args.previousVmName,
    },
  })
  const runId = await scheduleWorkspaceVmTeardown(ctx, args.workspaceId, {
    attachAfterTeardown: true,
    expectedIdentity: {
      vmName: workspace.vmName,
      vmTokenNonce: workspace.vmTokenNonce,
    },
  })
  return { scheduled: true as const, runId }
}

export async function recordOperatorReprovisionDeferredImpl(
  ctx: MutationCtx,
  args: Infer<typeof recordOperatorReprovisionDeferredArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null || workspace.status === 'deleted' || workspace.status === 'retired') {
    throw new Error('Workspace not found')
  }
  if (args.actorId !== undefined) {
    await assertActorRole(ctx, args.workspaceId, args.actorId, 'owner')
  }
  await writeAuditEvent(ctx, {
    workspaceId: args.workspaceId,
    event: 'workspace.operator_reprovision_deferred',
    actorId: args.actorId ?? auditActor(workspace),
    at: args.now,
    provenance: {
      reason: 'active_workspace_work',
      activeAgentSessions: args.activeAgentSessions,
      activeTrainJobs: args.activeTrainJobs,
    },
  })
  return { ok: true as const }
}

export async function recordSnapshotImpl(ctx: MutationCtx, args: Infer<typeof recordSnapshotArgs>) {
  requireApiInternalKey(args.internalKey)
  const workspace = await ctx.db.get(args.workspaceId)
  if (workspace === null) return
  const snapshotVmName = VmProviderNameSchema.parse(args.snapshotVmName)
  const snapshots = [snapshotVmName, ...(workspace.snapshotVmNames ?? [])].slice(0, 2)
  await ctx.db.patch(args.workspaceId, {
    lastSnapshotAt: args.now,
    snapshotVmNames: snapshots,
  })
}

export async function activeWorkspacesForSnapshotImpl(
  ctx: QueryCtx,
  args: Infer<typeof activeWorkspacesForSnapshotArgs>,
) {
  requireApiInternalKey(args.internalKey)
  const active = await ctx.db
    .query('workspaces')
    .withIndex('by_status_lastHeartbeat', q => q.eq('status', 'active'))
    .filter(q => q.neq(q.field('vmName'), undefined))
    // Snapshot orchestration caps the already-filtered operator candidate batch.
    .take(WORKSPACE_SWEEP_LIMIT)
  return active.map(workspace => ({
    workspaceId: workspace._id,
    vmName: workspace.vmName,
    snapshotVmNames: workspace.snapshotVmNames,
  }))
}
