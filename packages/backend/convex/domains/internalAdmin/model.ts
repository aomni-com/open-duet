import { ConvexError, v } from 'convex/values'

import {
  INTERNAL_ADMIN_STALE_HEARTBEAT_MS,
  InternalAdminCreateUserRequestSchema,
  matchesInternalAdminEmail,
  type InternalAdminRefusal,
  ModelRouterPolicySchema,
  validateModelRouterPolicy,
} from '@repo/contract'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { mutation, query } from '../../_generated/server'
import { usageRollupGranularityValidator } from '../../validators'
import { terminalizeOpenSessionsForWorkspace } from '../agentSessions/events'
import { requireApiInternalKey } from '../apiKeys/model'
import { applyLedgerEntryWithDb } from '../credits/ledger'
import { resetTopupFailureBilling } from '../credits/paymentRecovery'
import { reconcileServicingStatus } from '../credits/subscriptions'
import { walletOf } from '../credits/wallet'
import { bootstrapUser } from '../invitations/model'
import { takedownListingImpl } from '../marketplace/listings'
import { readInferenceMargin } from '../modelGateway/marginRollup'
import { normalizeEmail } from '../users/identity'
import { createOrLinkUserForAuth } from '../users/model'
import { reassignWorkspacePayer } from '../workspaces/billingUser'
import { readUpdatesControl, setUpdatesPausedImpl } from '../workspaces/vmSync'
import { cpuPctFromCores } from '../workspaces/vmTelemetry'
import { deriveVmToken } from '../workspaces/vmToken'
import { METERED_STATUSES } from '../workspaces/vmUsageModel'

/**
 * Operator reads are Convex queries and operator writes are mutations, and the
 * audit row for a read is written by `recordAudit`, a separate mutation the API
 * calls once the read has been served. A read that audited itself had to be a
 * mutation, and a mutation whose read set spans the fleet (the free-credit
 * report touches every live workspace) loses the write conflict to the VM
 * heartbeat on every retry: `persistVmSyncObservation` patches some workspace
 * row every few hundred milliseconds across the fleet. Queries cannot conflict.
 */
const readAccess = {
  internalKey: v.string(),
  actorId: v.id('users'),
}
export const provenance = {
  ...readAccess,
  requestId: v.string(),
  reason: v.string(),
  now: v.number(),
}
const ADMIN_GLOBAL_READ_LIMIT = 1000
const ADMIN_WORKSPACE_MEMBER_LIMIT = 500
const ADMIN_USAGE_ROW_LIMIT = 1000
const ADMIN_LOOKUP_MEMBERSHIP_LIMIT = 50
const ADMIN_FEEDBACK_LIMIT = 1000

const MODEL_ROUTER_SCOPE = 'global' as const

/** Read the currently active global model-router policy. */
export const modelRouterPolicy = query({
  args: readAccess,
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const row = await ctx.db
      .query('modelRouterPolicies')
      .withIndex('by_scope', q => q.eq('scope', MODEL_ROUTER_SCOPE))
      .unique()
    return row === null
      ? { version: 1 as const, rules: [], updatedAt: 0 }
      : { version: row.version, rules: row.rules, updatedAt: row.updatedAt }
  },
})

/** Replace the active policy atomically and leave an operator audit row. */
export const setModelRouterPolicy = mutation({
  args: { ...provenance, policy: v.any() },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    const parsed = ModelRouterPolicySchema.safeParse({
      ...(args.policy as object),
      version: 1,
      updatedAt: args.now,
    })
    if (!parsed.success || validateModelRouterPolicy(parsed.data) !== null)
      throw adminRefusal('invalid_request')
    const existing = await ctx.db
      .query('modelRouterPolicies')
      .withIndex('by_scope', q => q.eq('scope', MODEL_ROUTER_SCOPE))
      .unique()
    const value = {
      scope: MODEL_ROUTER_SCOPE,
      version: 1 as const,
      rules: parsed.data.rules,
      updatedAt: args.now,
    }
    if (existing === null) await ctx.db.insert('modelRouterPolicies', value)
    else await ctx.db.replace(existing._id, value)
    const auditId = await audit(
      ctx,
      args,
      actor.email,
      'admin.model_router.update',
      MODEL_ROUTER_SCOPE,
    )
    return { version: 1 as const, rules: parsed.data.rules, updatedAt: args.now, auditId }
  },
})

export const createUser = mutation({
  args: { ...provenance, email: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    const input = InternalAdminCreateUserRequestSchema.safeParse({ email: args.email })
    if (!input.success) throw adminRefusal('invalid_request')
    const email = normalizeEmail(input.data.email)
    const existing = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', email))
      .unique()
    if (existing !== null) throw adminRefusal('user_already_exists')
    const userId = await createOrLinkUserForAuth(ctx, {
      existingUserId: null,
      type: 'credentials',
      profile: { email },
    })
    const { workspaceId } = await bootstrapUser(ctx, userId)
    const workspace = await ctx.db.get(workspaceId)
    if (workspace === null) throw new Error('Created workspace disappeared')
    await audit(ctx, args, actor.email, 'admin.user.create', email, workspaceId)
    return { userId, email, workspaceId, workspaceSlug: workspace.slug }
  },
})

export const search = query({
  args: { ...readAccess, identifier: v.string() },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const identifier = args.identifier.trim().toLowerCase()
    const rows = identifier.length === 0 ? [] : await searchWorkspaces(ctx, identifier)
    const workspaces = await Promise.all(rows.map(row => workspaceSummary(ctx, row)))
    // The normalized identifier is what the audit names as the search target.
    return { workspaces, identifier }
  },
})

export const workspaceDetail = query({
  args: { ...readAccess, workspaceId: v.id('workspaces'), month: v.string() },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw adminRefusal('not_found')
    const members = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q => q.eq('workspaceId', args.workspaceId))
      .take(ADMIN_WORKSPACE_MEMBER_LIMIT + 1)
    if (members.length > ADMIN_WORKSPACE_MEMBER_LIMIT) throw adminRefusal('admin_dataset_too_large')
    const usageRows = await ctx.db
      .query('usageRollups')
      .withIndex('by_workspace_granularity_period', q =>
        q
          .eq('workspaceId', args.workspaceId)
          .eq('granularity', 'monthly')
          .eq('periodKey', args.month),
      )
      .take(ADMIN_USAGE_ROW_LIMIT + 1)
    if (usageRows.length > ADMIN_USAGE_ROW_LIMIT) throw adminRefusal('admin_dataset_too_large')
    const users = new Map<string, { email: string; name?: string }>()
    for (const member of members) {
      const user = await ctx.db.get(member.userId)
      if (user !== null) users.set(String(member.userId), { email: user.email, name: user.name })
    }
    const memberUsage = members.map(member => {
      const rows = usageRows.filter(row => String(row.userId) === String(member.userId))
      const user = users.get(String(member.userId))!
      return {
        userId: member.userId,
        email: user.email,
        ...(user.name === undefined ? {} : { name: user.name }),
        role: member.role,
        spendMicroUsd: rows.reduce((sum, row) => sum + row.spendMicroUsd, 0),
        inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
        outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      }
    })
    const workspaceRows = usageRows.filter(
      row => row.userId === undefined && row.appId === undefined,
    )
    const ledgerRows = await ctx.db
      .query('creditTransactions')
      .withIndex('by_workspace_created', q => q.eq('workspaceId', args.workspaceId))
      .order('desc')
      .take(100)
    // Sync health over the most recent relay batches: dropped read markers and
    // event overflow are otherwise write-only telemetry.
    const batchRows = await ctx.db
      .query('fileEventBatches')
      .withIndex('by_workspace_recorded', q => q.eq('workspaceId', args.workspaceId))
      .order('desc')
      .take(100)
    return {
      workspace: await workspaceSummary(ctx, workspace),
      usage: {
        month: args.month,
        spendMicroUsd: workspaceRows.reduce((sum, row) => sum + row.spendMicroUsd, 0),
        inputTokens: workspaceRows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
        outputTokens: workspaceRows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
        members: memberUsage,
      },
      ledger: ledgerRows.map(row => ({
        id: row._id,
        amountMicroUsd: row.amountMicroUsd,
        type: row.type,
        reference: row.reference,
        createdAt: row.createdAt,
      })),
      syncHealth: {
        batches: batchRows.length,
        droppedReads: batchRows.reduce((sum, row) => sum + row.droppedReads, 0),
        overflow: batchRows.reduce((sum, row) => sum + row.overflow, 0),
        ...(batchRows.length === 0 ? {} : { lastRecordedAt: batchRows[0]!.recordedAt }),
      },
    }
  },
})

export const listAdminAudit = query({
  args: {
    ...readAccess,
    workspaceId: v.optional(v.id('workspaces')),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 100), 1), 500)
    const rows =
      args.workspaceId === undefined
        ? await ctx.db.query('adminAuditEvents').order('desc').take(limit)
        : await ctx.db
            .query('adminAuditEvents')
            .withIndex('by_workspace', q => q.eq('workspaceId', args.workspaceId))
            .order('desc')
            .take(limit)
    return {
      events: rows.map(row => ({
        id: row._id,
        ...(row.workspaceId === undefined ? {} : { workspaceId: row.workspaceId }),
        actorEmail: row.actorEmail,
        action: row.action,
        target: row.target,
        reason: row.reason,
        requestId: row.requestId,
        status: row.status,
        ...(row.detail === undefined ? {} : { detail: row.detail }),
        at: row.at,
      })),
    }
  },
})

export const listFeedback = query({
  args: { ...readAccess, archived: v.boolean() },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const rows = args.archived
      ? await ctx.db
          .query('feedback')
          .withIndex('by_archived_createdAt', q => q.gt('archivedAt', 0))
          .order('desc')
          .take(ADMIN_FEEDBACK_LIMIT + 1)
      : await ctx.db
          .query('feedback')
          .withIndex('by_archived_createdAt', q => q.eq('archivedAt', undefined))
          .order('desc')
          .take(ADMIN_FEEDBACK_LIMIT + 1)
    if (rows.length > ADMIN_FEEDBACK_LIMIT) throw adminRefusal('admin_dataset_too_large')
    return {
      feedback: rows.map(row => ({
        id: row._id,
        content: row.content,
        source: row.source,
        createdAt: row.createdAt,
        archivedAt: row.archivedAt,
      })),
    }
  },
})

/**
 * Operator takedown of a marketplace listing.
 *
 * The abuse lever: it removes the listing from the catalog immediately and
 * drains every subscriber's ownership in bounded, self-continuing batches.
 * Files are never deleted from a subscriber's drive — takedown detaches, it does
 * not reach into someone else's workspace.
 *
 * Confirmation is required because this is irreversible for every installer at
 * once, and the audit records which operator pulled it.
 */
export const takedownMarketplaceListing = mutation({
  args: {
    ...provenance,
    listingId: v.id('agentListings'),
    confirmation: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    if (args.confirmation !== 'TAKE DOWN LISTING') throw adminRefusal('confirmation_mismatch')
    const listing = await ctx.db.get(args.listingId)
    if (listing === null) throw adminRefusal('not_found')
    const result = await takedownListingImpl(ctx, {
      internalKey: requireInternalKeyForScheduledDrain(),
      listingId: args.listingId,
      now: args.now,
    })
    const auditId = await audit(
      ctx,
      args,
      actor.email,
      'admin.marketplace.takedown',
      args.listingId,
    )
    return { ok: true as const, auditId, ...result }
  },
})

/**
 * The drain reschedules itself through the internalKey-guarded mutation, so the
 * operator path has to supply it. Reading it here keeps the key out of the wire
 * — an operator never sends it.
 */
function requireInternalKeyForScheduledDrain(): string {
  const key = process.env.DUET_API_INTERNAL_KEY
  if (key === undefined || key === '') throw new Error('DUET_API_INTERNAL_KEY is not configured')
  return key
}

export const mutateFeedback = mutation({
  args: {
    ...provenance,
    feedbackId: v.id('feedback'),
    operation: v.union(v.literal('archive'), v.literal('unarchive'), v.literal('delete')),
    confirmation: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    const row = await ctx.db.get(args.feedbackId)
    if (row === null) throw adminRefusal('not_found')
    if (args.operation === 'delete') {
      if (args.confirmation !== 'DELETE') throw adminRefusal('confirmation_mismatch')
      await ctx.db.delete(args.feedbackId)
    } else
      await ctx.db.patch(
        args.feedbackId,
        args.operation === 'archive'
          ? { archivedAt: args.now, archivedByUserId: args.actorId }
          : { archivedAt: undefined, archivedByUserId: undefined },
      )
    const auditId = await audit(
      ctx,
      args,
      actor.email,
      `admin.feedback.${args.operation}`,
      args.feedbackId,
    )
    return { ok: true as const, auditId }
  },
})

export const freeCredits = query({
  args: { ...readAccess },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const unpaid = await unpaidBilledUsers(ctx)
    return {
      totalFreeCreditsMicroUsd: unpaid.reduce(
        (sum, entry) => sum + Math.max(0, walletOf(entry.user).paidMicroUsd),
        0,
      ),
      unpaidUserCount: unpaid.length,
      usersWithBalanceCount: unpaid.filter(entry => walletOf(entry.user).paidMicroUsd > 0).length,
    }
  },
})

/**
 * The reset's enumeration leg: which payers hold a free balance right now.
 * Enumeration is a query so it never conflicts with fleet writes; the per-user
 * mutation re-derives the amount itself, so this list is a plan, not a claim.
 */
export const freeCreditResetTargets = query({
  args: { ...readAccess },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const unpaid = await unpaidBilledUsers(ctx)
    return unpaid
      .filter(entry => walletOf(entry.user).paidMicroUsd > 0)
      .map(entry => entry.user._id)
  },
})

/**
 * One payer's leg of the reset. Its read set is that payer's rows alone, so a
 * heartbeat landing on some other workspace cannot fail it. The ledger reference
 * carries the request id, so a retried leg is a no-op rather than a second
 * debit, and a payer who paid between enumeration and this leg is skipped.
 */
export const resetFreeCreditsForUser = mutation({
  args: { ...provenance, userId: v.id('users') },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const user = await ctx.db.get(args.userId)
    if (user === null || user.billing?.subscriptionEverActivatedAt !== undefined)
      return { removedMicroUsd: 0 }
    const amount = walletOf(user).paidMicroUsd
    if (amount <= 0) return { removedMicroUsd: 0 }
    const workspace = await liveBilledWorkspace(ctx, user._id)
    if (workspace === undefined) return { removedMicroUsd: 0 }
    const entry = await applyLedgerEntryWithDb(ctx, {
      workspaceId: workspace._id,
      userId: args.actorId,
      amountMicroUsd: -amount,
      type: 'adjustment',
      reference: `admin-free-reset:${args.requestId}:${user._id}`,
      metadata: { note: args.reason },
      now: args.now,
    })
    if (!entry.applied) return { removedMicroUsd: 0 }
    await reconcileServicingStatus(ctx, user._id, args.now)
    return { removedMicroUsd: amount }
  },
})

export const vmUpdates = query({
  args: { ...readAccess },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const control = await readUpdatesControl(ctx)
    return {
      // Missing singleton = updates flow; the row is an explicit brake.
      paused: control?.paused ?? false,
      ...(control?.reason === undefined ? {} : { reason: control.reason }),
      ...(control === null ? {} : { updatedAt: control.updatedAt }),
    }
  },
})

function tallyBy<T>(
  rows: readonly T[],
  key: (row: T) => string | undefined,
): { label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const label = key(row)
    if (label === undefined) continue
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

const BYTES_PER_MIB = 1024 * 1024

/**
 * Fleet-wide model spend: what calls cost upstream against what they billed,
 * per UTC period and per tier/model/provider, read from the folded rollup rather
 * than the per-call ledger (which no single query can scan). `now` is the
 * request time, an argument so each request gets a fresh cache key; `through`
 * pages back to an older window.
 */
export const inferenceMargin = query({
  args: {
    ...readAccess,
    granularity: usageRollupGranularityValidator,
    now: v.number(),
    through: v.optional(v.number()),
  },
  handler: async (ctx, { granularity, now, through, ...access }) => {
    await requireInternalAdmin(ctx, access)
    return await readInferenceMargin(ctx, { granularity, now, through })
  },
})

/**
 * The live-fleet snapshot: version convergence, heartbeat freshness, and the
 * newest CPU/memory sample per live VM. "Live" is the metered status set (the
 * VMs the sampler bills), read one status bucket at a time through
 * `by_status_vmName`. Exclude workspaces without VMs in the index before
 * applying the cap, so they cannot displace live VMs from the snapshot.
 * Each bucket is capped at `ADMIN_GLOBAL_READ_LIMIT` and a
 * bucket that overflows sets `truncated` rather than throwing
 * `admin_dataset_too_large`: a health view must not go blank exactly when the
 * fleet is largest.
 *
 * `now` is the caller's request time, not `Date.now()`: a query's wall clock is
 * not a database dependency, so a cached result would keep serving the original
 * heartbeat/sample ages even after a VM stops beating. Taking it as an argument
 * gives each request a fresh cache key.
 */
export const fleetHealth = query({
  args: { ...readAccess, now: v.number() },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const now = args.now
    let truncated = false
    const live: Doc<'workspaces'>[] = []
    for (const status of METERED_STATUSES) {
      const rows = await ctx.db
        .query('workspaces')
        .withIndex('by_status_vmName', q => q.eq('status', status).gt('vmName', undefined))
        .take(ADMIN_GLOBAL_READ_LIMIT + 1)
      if (rows.length > ADMIN_GLOBAL_READ_LIMIT) {
        truncated = true
        rows.length = ADMIN_GLOBAL_READ_LIMIT
      }
      live.push(...rows)
    }

    const vms = await Promise.all(
      live.map(async workspace => {
        const sample = await ctx.db
          .query('vmTelemetrySamples')
          .withIndex('by_workspace_at', q => q.eq('workspaceId', workspace._id))
          .order('desc')
          .first()
        const cpuPct = cpuPctFromCores(sample?.cpuCores, sample?.cpuNominalCores)
        return {
          workspaceId: workspace._id,
          slug: workspace.slug,
          ...(workspace.vmName === undefined ? {} : { vmName: workspace.vmName }),
          status: workspace.status,
          ...(workspace.servicingStatus === undefined
            ? {}
            : { servicingStatus: workspace.servicingStatus }),
          ...(workspace.runtimeVersion === undefined
            ? {}
            : { runtimeVersion: workspace.runtimeVersion }),
          ...(workspace.lastHeartbeatAt === undefined
            ? {}
            : { heartbeatAgeMs: now - workspace.lastHeartbeatAt }),
          ...(sample?.cpuCores === undefined ? {} : { cpuCores: sample.cpuCores }),
          ...(cpuPct === undefined ? {} : { cpuPct }),
          ...(sample?.memUsedBytes === undefined
            ? {}
            : { memUsedMb: sample.memUsedBytes / BYTES_PER_MIB }),
          ...(sample?.memTotalBytes === undefined
            ? {}
            : { memTotalMb: sample.memTotalBytes / BYTES_PER_MIB }),
          ...(sample === null ? {} : { sampleAgeMs: now - sample.at }),
        }
      }),
    )
    // Busiest first: a runaway VM reads as ~1 whole core, which is what an
    // operator opens this view to find.
    vms.sort((left, right) => (right.cpuCores ?? -1) - (left.cpuCores ?? -1))

    const staleHeartbeatCount = live.filter(
      workspace =>
        workspace.lastHeartbeatAt === undefined ||
        now - workspace.lastHeartbeatAt > INTERNAL_ADMIN_STALE_HEARTBEAT_MS,
    ).length
    const sampleAges = vms.flatMap(vm => (vm.sampleAgeMs === undefined ? [] : [vm.sampleAgeMs]))
    const control = await readUpdatesControl(ctx)
    return {
      generatedAt: now,
      activeCount: live.length,
      truncated,
      versions: {
        runtime: tallyBy(live, workspace => workspace.runtimeVersion),
      },
      staleHeartbeatCount,
      updates: {
        paused: control?.paused ?? false,
        ...(control?.reason === undefined ? {} : { reason: control.reason }),
      },
      telemetry: {
        withSample: sampleAges.length,
        missing: live.length - sampleAges.length,
        ...(sampleAges.length === 0
          ? {}
          : {
              newestSampleAgeMs: Math.min(...sampleAges),
              oldestSampleAgeMs: Math.max(...sampleAges),
            }),
      },
      vms,
    }
  },
})

export const setVmUpdates = mutation({
  args: { ...provenance, paused: v.boolean() },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    // Pausing defers runtime activation while workspace servicing continues.
    await setUpdatesPausedImpl(ctx, {
      internalKey: args.internalKey,
      paused: args.paused,
      reason: args.reason,
      now: args.now,
    })
    const auditId = await audit(
      ctx,
      args,
      actor.email,
      args.paused ? 'admin.vmUpdates.pause' : 'admin.vmUpdates.resume',
      'global',
    )
    return { ok: true as const, auditId }
  },
})

export const mutateWorkspace = mutation({
  args: {
    ...provenance,
    workspaceId: v.id('workspaces'),
    operation: v.union(
      v.literal('payer'),
      v.literal('credit'),
      v.literal('ban'),
      v.literal('unpause'),
      v.literal('dispute_clear'),
      v.literal('servicing_exempt'),
      v.literal('message'),
      v.literal('suspension'),
    ),
    newBillingUserId: v.optional(v.id('users')),
    amountMicroUsd: v.optional(v.number()),
    message: v.optional(v.string()),
    exempt: v.optional(v.boolean()),
    suspended: v.optional(v.boolean()),
    confirmation: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw adminRefusal('not_found')
    if (args.operation === 'payer') {
      if (args.newBillingUserId === undefined) throw adminRefusal('invalid_request')
      await reassignWorkspacePayer(ctx, { ...args, newBillingUserId: args.newBillingUserId })
    } else if (args.operation === 'credit') {
      const amountMicroUsd = args.amountMicroUsd
      if (
        amountMicroUsd === undefined ||
        !Number.isSafeInteger(amountMicroUsd) ||
        amountMicroUsd === 0 ||
        Math.abs(amountMicroUsd) > 10_000_000_000
      )
        throw adminRefusal('invalid_request')
      await applyLedgerEntryWithDb(ctx, {
        workspaceId: workspace._id,
        userId: args.actorId,
        amountMicroUsd,
        type: 'adjustment',
        reference: `admin:${args.requestId}`,
        metadata: { note: args.reason },
        now: args.now,
      })
      await reconcileServicingStatus(ctx, workspace.billingUserId, args.now)
    } else if (args.operation === 'unpause') {
      const payer = await ctx.db.get(workspace.billingUserId)
      if (payer === null) throw new Error('Billing user not found')
      await ctx.db.patch(payer._id, { billing: resetTopupFailureBilling(payer.billing, args.now) })
      // An immediate operator override; the next billing reconciliation still applies.
      if (workspace.servicingStatus === 'paused') {
        await ctx.db.patch(workspace._id, {
          servicingStatus: 'active',
          servicingStatusChangedAt: args.now,
          updatedAt: args.now,
        })
      }
    } else if (args.operation === 'ban') {
      await ctx.db.patch(workspace._id, {
        servicingStatus: 'banned',
        servicingStatusChangedAt: args.now,
        updatedAt: args.now,
      })
      await terminalizeOpenSessionsForWorkspace(ctx, workspace._id, args.now)
    } else if (args.operation === 'dispute_clear') {
      const payer = await ctx.db.get(workspace.billingUserId)
      if (payer === null) throw new Error('Billing user not found')
      await ctx.db.patch(payer._id, {
        billing: { ...payer.billing, disputeFlaggedAt: undefined },
      })
      await reconcileServicingStatus(ctx, payer._id, args.now)
    } else if (args.operation === 'servicing_exempt') {
      if (args.exempt === undefined) throw adminRefusal('invalid_request')
      await ctx.db.patch(workspace._id, {
        servicingExemptAt: args.exempt ? args.now : undefined,
        updatedAt: args.now,
      })
      // The reconciler is the ONE writer of servicing status: granting must not
      // stamp 'active' here, and revoking must not leave a stale exemption's
      // verdict behind. Both directions converge through the same owner.
      await reconcileServicingStatus(ctx, workspace.billingUserId, args.now)
    } else if (args.operation === 'message') {
      const message = args.message?.trim() ?? ''
      if (message.length > 1000) throw adminRefusal('invalid_request')
      await ctx.db.patch(workspace._id, { adminMessage: message || undefined, updatedAt: args.now })
    } else {
      if (args.suspended === undefined) throw adminRefusal('invalid_request')
      if (args.suspended && args.confirmation !== workspace.slug)
        throw adminRefusal('confirmation_mismatch')
      await ctx.db.patch(
        workspace._id,
        args.suspended
          ? {
              suspendedAt: args.now,
              suspendedByUserId: args.actorId,
              suspensionReason: args.reason,
              updatedAt: args.now,
            }
          : {
              suspendedAt: undefined,
              suspendedByUserId: undefined,
              suspensionReason: undefined,
              updatedAt: args.now,
            },
      )
    }
    const auditId = await audit(
      ctx,
      args,
      actor.email,
      `admin.workspace.${args.operation}`,
      workspace.slug,
      workspace._id,
    )
    return { ok: true as const, auditId }
  },
})

/**
 * The audit row for an operator read, or the `started` row of a multi-step
 * effect with no single workspace (`finalizeEffect` closes it). The API calls
 * it after the read has been served, so a refused read leaves no row.
 */
export const recordAudit = mutation({
  args: {
    ...provenance,
    action: v.string(),
    target: v.string(),
    workspaceId: v.optional(v.id('workspaces')),
    detail: v.optional(v.string()),
    status: v.optional(v.union(v.literal('started'), v.literal('completed'))),
  },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    const auditId = await audit(
      ctx,
      args,
      actor.email,
      args.action,
      args.target,
      args.workspaceId,
      args.detail,
      args.status,
    )
    return { auditId }
  },
})

export const authorizeEffect = mutation({
  args: { ...provenance, workspaceId: v.id('workspaces'), action: v.string(), target: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireInternalAdmin(ctx, args)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw adminRefusal('not_found')
    const auditId = await audit(
      ctx,
      args,
      actor.email,
      args.action,
      args.target,
      workspace._id,
      undefined,
      'started',
    )
    return {
      auditId,
      workspace: {
        id: workspace._id,
        slug: workspace.slug,
        vmName: workspace.vmName,
        sshDest: workspace.sshDest,
        httpsUrl: workspace.httpsUrl,
        ...(workspace.vmTokenNonce === undefined
          ? {}
          : { vmToken: await deriveVmToken(workspace._id, workspace.vmTokenNonce) }),
      },
    }
  },
})

export const workspaceBackup = query({
  args: { ...readAccess, workspaceId: v.id('workspaces'), backupId: v.id('workspaceBackups') },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const backup = await ctx.db.get(args.backupId)
    if (!backup || backup.workspaceId !== args.workspaceId) throw adminRefusal('not_found')
    return backup
  },
})

export const finalizeEffect = mutation({
  args: {
    ...provenance,
    auditId: v.id('adminAuditEvents'),
    success: v.boolean(),
    outcome: v.optional(v.literal('accepted')),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireInternalAdmin(ctx, args)
    const row = await ctx.db.get(args.auditId)
    if (
      row === null ||
      row.actorId !== args.actorId ||
      row.requestId !== args.requestId ||
      row.status !== 'started'
    )
      throw new Error('Admin effect audit mismatch')
    await ctx.db.patch(row._id, {
      status: args.success ? (args.outcome ?? 'completed') : 'failed',
      ...(args.detail === undefined ? {} : { detail: args.detail.slice(0, 1000) }),
    })
    return { auditId: row._id }
  },
})

/**
 * A refusal the operator must be able to tell apart (see the contract's
 * `INTERNAL_ADMIN_REFUSALS`). Plain errors stay plain: they are failures, and
 * the API reports them as one.
 */
export function adminRefusal(
  error: InternalAdminRefusal['error'],
): ConvexError<InternalAdminRefusal> {
  return new ConvexError({ error })
}

export async function requireInternalAdmin(
  ctx: QueryCtx,
  args: { internalKey: string; actorId: Id<'users'> },
) {
  requireApiInternalKey(args.internalKey)
  const actor = await ctx.db.get(args.actorId)
  if (actor === null) throw adminRefusal('internal_admin_required')
  if (!matchesInternalAdminEmail(actor.email)) throw adminRefusal('internal_admin_required')
  return actor
}

export async function audit(
  ctx: MutationCtx,
  args: { actorId: Id<'users'>; requestId: string; reason: string; now: number },
  actorEmail: string,
  action: string,
  target: string,
  workspaceId?: Id<'workspaces'>,
  detail?: string,
  status: 'started' | 'completed' | 'failed' = 'completed',
) {
  const reason = args.reason.trim()
  if (reason.length < 3 || reason.length > 500) throw adminRefusal('invalid_request')
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(args.requestId)) throw adminRefusal('invalid_request')
  return await ctx.db.insert('adminAuditEvents', {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    actorId: args.actorId,
    actorEmail,
    action,
    target: target.slice(0, 500),
    reason,
    requestId: args.requestId,
    status,
    ...(detail === undefined ? {} : { detail: detail.slice(0, 1000) }),
    at: args.now,
  })
}

async function searchWorkspaces(ctx: QueryCtx, identifier: string) {
  const normalizedId = ctx.db.normalizeId('workspaces', identifier)
  if (normalizedId !== null) {
    const direct = await ctx.db.get(normalizedId)
    if (direct !== null) return [direct]
  }
  const bySlug = await ctx.db
    .query('workspaces')
    .withIndex('by_slug_status', q => q.eq('slug', identifier))
    .first()
  if (bySlug !== null) return [bySlug]
  const matchingUsers: Doc<'users'>[] = []
  if (identifier.includes('@')) {
    const user = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', identifier))
      .unique()
    if (user !== null) matchingUsers.push(user)
  } else if (identifier.startsWith('cus_')) {
    matchingUsers.push(
      ...(await ctx.db
        .query('users')
        .withIndex('by_stripe_customer', q => q.eq('billing.stripeCustomerId', identifier))
        .take(20)),
    )
  }
  const matches = new Map<string, Doc<'workspaces'>>()
  for (const user of matchingUsers) {
    const billed = await ctx.db
      .query('workspaces')
      .withIndex('by_billing_user', q => q.eq('billingUserId', user._id))
      .take(ADMIN_LOOKUP_MEMBERSHIP_LIMIT + 1)
    if (billed.length > ADMIN_LOOKUP_MEMBERSHIP_LIMIT) throw adminRefusal('admin_dataset_too_large')
    for (const workspace of billed) matches.set(String(workspace._id), workspace)
    const memberships = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_user_and_workspace', q => q.eq('userId', user._id))
      .take(ADMIN_LOOKUP_MEMBERSHIP_LIMIT + 1)
    if (memberships.length > ADMIN_LOOKUP_MEMBERSHIP_LIMIT)
      throw adminRefusal('admin_dataset_too_large')
    for (const member of memberships) {
      const workspace = await ctx.db.get(member.workspaceId)
      if (workspace !== null) matches.set(String(workspace._id), workspace)
    }
  }
  if (matches.size === 0) {
    const workspaces = await ctx.db
      .query('workspaces')
      .withSearchIndex('search_name', q => q.search('name', identifier))
      .take(20)
    for (const workspace of workspaces) matches.set(String(workspace._id), workspace)
  }
  return [...matches.values()].slice(0, 20)
}

/**
 * The free-credit report's domain: users who have never paid and are the
 * billing user of at least one live workspace. Workspaces are never
 * enumerated — deleted-workspace tombstones accumulate without bound (every
 * retired workspace keeps its row), so the exact-or-refuse cap must count
 * billing users, not dead rows. Membership is probed per user through
 * `by_billing_user`.
 */
async function unpaidBilledUsers(
  ctx: QueryCtx,
): Promise<Array<{ user: Doc<'users'>; workspace: Doc<'workspaces'> }>> {
  const users = await allUsers(ctx)
  const result: Array<{ user: Doc<'users'>; workspace: Doc<'workspaces'> }> = []
  for (const user of users) {
    if (user.billing?.subscriptionEverActivatedAt !== undefined) continue
    const workspace = await liveBilledWorkspace(ctx, user._id)
    if (workspace !== undefined) result.push({ user, workspace })
  }
  return result
}

/**
 * A user's own workspaces are few; the safety ceiling guards pathological data,
 * and a live workspace is preferred as the reset's charge target.
 */
async function liveBilledWorkspace(
  ctx: QueryCtx,
  userId: Id<'users'>,
): Promise<Doc<'workspaces'> | undefined> {
  const billed = await ctx.db
    .query('workspaces')
    .withIndex('by_billing_user', q => q.eq('billingUserId', userId))
    .take(50)
  return billed.find(row => row.status !== 'deleted')
}

async function allUsers(ctx: QueryCtx): Promise<Doc<'users'>[]> {
  const rows = await ctx.db.query('users').take(ADMIN_GLOBAL_READ_LIMIT + 1)
  if (rows.length > ADMIN_GLOBAL_READ_LIMIT) throw adminRefusal('admin_dataset_too_large')
  return rows
}

async function workspaceSummary(ctx: QueryCtx, workspace: Doc<'workspaces'>) {
  const payer = await ctx.db.get(workspace.billingUserId)
  if (payer === null) throw new Error('Billing user not found')
  const members = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspace._id))
    .take(ADMIN_WORKSPACE_MEMBER_LIMIT + 1)
  if (members.length > ADMIN_WORKSPACE_MEMBER_LIMIT) throw adminRefusal('admin_dataset_too_large')
  return {
    id: workspace._id,
    slug: workspace.slug,
    name: workspace.name,
    status: workspace.status,
    servicingStatus: workspace.servicingStatus ?? 'active',
    suspended: workspace.suspendedAt !== undefined,
    billingUserId: workspace.billingUserId,
    billingEmail: payer.email,
    stripeCustomerId: payer.billing?.stripeCustomerId,
    disputeFlaggedAt: payer.billing?.disputeFlaggedAt,
    servicingExemptAt: workspace.servicingExemptAt,
    paidCreditBalanceMicroUsd: walletOf(payer).paidMicroUsd,
    monthlyCreditBalanceMicroUsd: walletOf(payer).monthlyMicroUsd,
    memberCount: members.length,
    vmName: workspace.vmName,
    sshDest: workspace.sshDest,
    runtimeVersion: workspace.runtimeVersion,
    imageVersion: workspace.imageVersion,
    lastHeartbeatAt: workspace.lastHeartbeatAt,
    adminMessage: workspace.adminMessage,
  }
}
