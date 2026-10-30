import type { RunId } from '@convex-dev/action-retrier'
import { v } from 'convex/values'

import {
  SUBSCRIPTION_PLANS,
  TRIAL_WINDOW_MS,
  WORKSPACE_MEMBER_LIMIT,
  type SubscriptionPlanId,
} from '@repo/contract'

import type { Id } from '../_generated/dataModel'
import { mutation, query } from '../_generated/server'
import {
  continueSessionTerminalizationForScope,
  continueSessionTerminalizationForWorkspace,
} from '../domains/agentSessions/events'
import { deleteWorkspaceMembershipGeneration } from '../domains/agentSessions/membershipRemoval'
import { hashSecret, requireApiInternalKey } from '../domains/apiKeys/model'
import {
  expireMonthlyCreditsForTestWithDb,
  reconcileServicingStatus,
  resetMonthlyCreditsForTestWithDb,
} from '../domains/credits/subscriptions'
import { requireCurrentUserId } from '../domains/workspaces/authorization'
import { createWorkspaceRow } from '../domains/workspaces/birth'
import { reslugArchivedWorkspaceCollision } from '../domains/workspaces/internal'
import {
  insertWorkspaceMember,
  writeMemberDirectoryEntry,
} from '../domains/workspaces/memberDirectory'
import { deleteWorkspaceImpl } from '../domains/workspaces/mutations'
import { reconcileWorkspaceVmDisks } from '../domains/workspaces/vmDiskPolicy'
import { deriveVmToken } from '../domains/workspaces/vmToken'
import { retrier } from '../utils'

export const createWorkspaceForTest = mutation({
  args: {
    internalKey: v.string(),
    slug: v.string(),
    name: v.string(),
    // Defaults to bypassing the owner billing gate: most fixtures provision
    // many workspaces per user. The cap's own tests pass false to exercise
    // the production gate through this helper.
    bypassWorkspaceLimit: v.optional(v.boolean()),
    // "Duet pays for this workspace" -- the official hub is the real case.
    // Exposed so the VM compute fee can prove it never bills one.
    servicingExempt: v.optional(v.boolean()),
    // Born the way a person's FIRST workspace is, with onboarding still owed.
    // Fixtures default to already-onboarded, which silently makes completing
    // onboarding a no-op — including the analytics it would have emitted.
    requiresOnboarding: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const ownerUserId = await requireCurrentUserId(ctx)
    const { workspaceId } = await createWorkspaceRow(ctx, {
      ownerUserId,
      slug: args.slug,
      name: args.name,
      bypassWorkspaceLimit: args.bypassWorkspaceLimit ?? true,
      ...(args.servicingExempt === true ? { servicingExempt: true } : {}),
      ...(args.requiresOnboarding === true ? { requiresOnboarding: true } : {}),
    })
    return workspaceId
  },
})

export const continueAgentSessionTerminalizationForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    now: v.number(),
  },
  handler: (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return continueSessionTerminalizationForWorkspace(ctx, args.workspaceId, args.now)
  },
})

export const markWorkspaceLiveForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    now: v.number(),
    vmDiskGb: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    // Mirror registration: the stored hash must match the derived vmToken so
    // hash-authenticated internal queries resolve the workspace like they do
    // for a really provisioned VM. A workspace that already registered keeps
    // its credentials — tests hold the registered token.
    const vmTokenNonce = workspace.vmTokenNonce ?? `nonce-${workspace._id}`
    const vmTokenHash =
      workspace.vmTokenHash ?? (await hashSecret(await deriveVmToken(workspace._id, vmTokenNonce)))
    await ctx.db.patch(args.workspaceId, {
      status: 'active',
      vmName: `vm-${workspace.slug}`,
      httpsUrl: `https://${workspace.slug}.example.test`,
      vmTokenNonce,
      vmTokenHash,
      ...(args.vmDiskGb === undefined ? {} : { vmDiskGb: args.vmDiskGb }),
      updatedAt: args.now,
    })
  },
})

/** Legacy completed-workspace fixture: preserve access without inventing a card. */
export const markWorkspaceOnboardedForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    now: v.number(),
    duetName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    await ctx.db.patch(args.workspaceId, {
      onboardedAt: workspace.onboardedAt ?? args.now,
      ...(args.duetName === undefined ? {} : { duetName: workspace.duetName ?? args.duetName }),
      updatedAt: args.now,
    })
  },
})

export const setWorkspaceServicingForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    servicingStatus: v.union(v.literal('active'), v.literal('paused'), v.literal('banned')),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, {
      servicingStatus: args.servicingStatus,
      servicingStatusChangedAt: args.now,
    })
    /* Backdating a pause has to backdate the entitlement that ended it, or the
       fixture describes a state production cannot reach: a workspace paused a
       week ago whose payer's trial has not run out yet. The decommission sweep
       refuses that on purpose — an entitled payer inside the window means the
       window has not been served — so a helper that moved only the pause would
       be writing the anomaly the sweep exists to survive. */
    if (args.servicingStatus === 'active') return
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) return
    const payer = await ctx.db.get(workspace.billingUserId)
    if (payer?.billing?.trialExpiresAt === undefined) return
    if (payer.billing.trialExpiresAt <= args.now) return
    await ctx.db.patch(payer._id, {
      billing: { ...payer.billing, trialExpiresAt: args.now },
    })
  },
})

export const setVmModelCredentialRetryForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    retryAt: v.number(),
    scopeKey: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, {
      vmModelCredentialRetryAt: args.retryAt,
      vmModelCredentialRetryScopeKey: args.scopeKey,
    })
  },
})

export const setWorkspacePartialVmIdentityForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, {
      vmName: 'partial-vm',
      httpsUrl: undefined,
      vmTokenNonce: undefined,
    })
  },
})

export const setWorkspaceSyncthingDeviceIdForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    syncthingDeviceId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if ((await ctx.db.get(args.workspaceId)) === null) throw new Error('Workspace not found')
    await ctx.db.patch(args.workspaceId, { syncthingDeviceId: args.syncthingDeviceId })
  },
})

export const prepareWorkspaceForRegistration = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.optional(v.id('workspaces')),
    slug: v.string(),
    name: v.string(),
    imageRef: v.string(),
    lifecycleBackupId: v.optional(v.id('workspaceBackups')),
    provisioningTokenHash: v.string(),
    provisioningTokenExpiresAt: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if ((await ctx.db.get(args.actorId)) === null) throw new Error('Actor not found')
    const workspaceId =
      args.workspaceId ??
      (
        await createWorkspaceRow(ctx, {
          ownerUserId: args.actorId,
          slug: args.slug,
          name: args.name,
          // This fixture registers VMs; it exercises the creation gate only by
          // accident. Suites built on it provision dozens of workspaces for one
          // actor, which no plan capacity covers. The workspace creation limit has
          // its own coverage through the real API path in
          // `auth-workspaces.test.ts` and `apps/api`, so bypassing here loses
          // nothing — and matches `createWorkspaceForTest`, which already
          // defaults to bypassing for the same reason.
          bypassWorkspaceLimit: true,
        })
      ).workspaceId
    const workspace = await ctx.db.get(workspaceId)
    if (workspace === null || workspace.createdByUserId !== args.actorId) {
      throw new Error('Workspace fixture owner mismatch')
    }
    await ctx.db.patch(workspaceId, {
      status: 'provisioning',
      imageRef: args.imageRef,
      lifecycleBackupId: args.lifecycleBackupId,
      provisioningTokenHash: args.provisioningTokenHash,
      provisioningTokenExpiresAt: args.provisioningTokenExpiresAt,
      provisioningTokenUsedAt: undefined,
      updatedAt: args.now,
    })
    return { workspaceId }
  },
})

export const activateCurrentUserTrialForTest = mutation({
  args: { internalKey: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const userId = await requireCurrentUserId(ctx)
    const user = await ctx.db.get(userId)
    if (user === null) throw new Error('User not found')
    if (user.monthlyCreditBalanceMicroUsd !== 0) {
      await expireMonthlyCreditsForTestWithDb(ctx, {
        userId,
        reference: `subscription_expiry:test_trial:${userId}:${args.now}`,
        reason: 'test_trial_fixture',
        now: args.now,
      })
    }
    const refreshed = await ctx.db.get(userId)
    if (refreshed === null) throw new Error('User not found')
    await ctx.db.patch(userId, {
      billing: {
        ...refreshed.billing,
        firstPaidAt: undefined,
        subscriptionEverActivatedAt: undefined,
        subscription: undefined,
        // A trial account has no entitlement clock; leftover synthetic-epoch
        // fields make later paid invoices look stale and silently ignored.
        monthlyCreditEpoch: undefined,
        monthlyCreditExpiresAt: undefined,
        trialExpiresAt: args.now + TRIAL_WINDOW_MS,
      },
    })
  },
})

export const activateCurrentUserSyntheticSubscriptionForTest = mutation({
  args: {
    internalKey: v.string(),
    now: v.optional(v.number()),
    plan: v.optional(v.union(v.literal('starter'), v.literal('pro'), v.literal('max'))),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const userId = await requireCurrentUserId(ctx)
    return await activateSyntheticSubscription(ctx, userId, args.now ?? Date.now(), args.plan)
  },
})

export const lapseCurrentUserSyntheticSubscriptionForTest = mutation({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const userId = await requireCurrentUserId(ctx)
    const user = await ctx.db.get(userId)
    if (user?.billing?.subscription === undefined) throw new Error('Subscription not found')
    await ctx.db.patch(userId, {
      billing: {
        ...user.billing,
        subscription: { ...user.billing.subscription, status: 'canceled' },
      },
    })
  },
})

export const addWorkspaceMemberForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    role: v.union(v.literal('owner'), v.literal('editor'), v.literal('viewer')),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const existing = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', args.workspaceId).eq('userId', args.userId),
      )
      .unique()
    if (existing !== null) {
      if (existing.role !== args.role) {
        await ctx.db.patch(existing._id, { role: args.role })
        const updated = await ctx.db.get(existing._id)
        if (updated === null) throw new Error('Workspace membership disappeared')
        await writeMemberDirectoryEntry(ctx, updated)
      }
      return existing._id
    }
    return await insertWorkspaceMember(ctx, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      role: args.role,
    })
  },
})

export const fillWorkspaceMemberCapacityForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    targetCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const targetCount = args.targetCount ?? WORKSPACE_MEMBER_LIMIT
    if (!Number.isInteger(targetCount) || targetCount < 0 || targetCount > WORKSPACE_MEMBER_LIMIT) {
      throw new Error('Workspace member capacity fixture target is invalid')
    }
    const existing = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q => q.eq('workspaceId', args.workspaceId))
      .take(WORKSPACE_MEMBER_LIMIT)
    for (let index = existing.length; index < targetCount; index += 1) {
      const userId = await ctx.db.insert('users', {
        email: `capacity-${args.workspaceId}-${index}@example.test`,
        memberDirectoryRevision: 0,
        createdAt: index + 1,
        updatedAt: index + 1,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
      })
      await insertWorkspaceMember(ctx, { workspaceId: args.workspaceId, userId, role: 'viewer' })
    }
    return targetCount
  },
})

export const setWorkspaceDefaultTierRawForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    value: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, { defaultModelId: args.value })
  },
})

// "Unpaid" now means no *active subscription*, not merely a missing
// firstPaidAt — entitlement reads isSubscriber everywhere. Dropping the
// subscription alongside the payment stamp keeps this the one fixture that
// means "this user has no paid entitlement at all".
export const clearCurrentUserPaidForTest = mutation({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const userId = await requireCurrentUserId(ctx)
    const user = await ctx.db.get(userId)
    if (user === null) throw new Error('User not found')
    const { firstPaidAt: _, subscription: __, ...billing } = user.billing ?? {}
    await ctx.db.patch(userId, { billing })
  },
})

export const setCurrentUserSubscriptionCancelAtPeriodEndForTest = mutation({
  args: { internalKey: v.string(), cancelAtPeriodEnd: v.boolean() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const userId = await requireCurrentUserId(ctx)
    const user = await ctx.db.get(userId)
    if (user?.billing?.subscription === undefined) throw new Error('Subscription not found')
    await ctx.db.patch(userId, {
      billing: {
        ...user.billing,
        subscription: { ...user.billing.subscription, cancelAtPeriodEnd: args.cancelAtPeriodEnd },
      },
    })
  },
})

export const activateSyntheticSubscriptionByEmailForTest = mutation({
  args: {
    internalKey: v.string(),
    email: v.string(),
    now: v.optional(v.number()),
    plan: v.optional(v.union(v.literal('starter'), v.literal('pro'), v.literal('max'))),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const user = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', args.email.trim().toLowerCase()))
      .unique()
    if (user === null) throw new Error('User not found')
    return await activateSyntheticSubscription(ctx, user._id, args.now ?? Date.now(), args.plan)
  },
})

async function activateSyntheticSubscription(
  ctx: Parameters<typeof resetMonthlyCreditsForTestWithDb>[0],
  userId: Parameters<typeof resetMonthlyCreditsForTestWithDb>[1]['userId'],
  now: number,
  plan: SubscriptionPlanId = 'starter',
) {
  const existing = await ctx.db.get(userId)
  if (
    existing?.billing?.firstPaidAt !== undefined &&
    existing.billing.subscription !== undefined &&
    existing.billing.subscription.plan === plan &&
    (existing.billing.subscription.status === 'active' ||
      existing.billing.subscription.status === 'trialing') &&
    existing.billing.monthlyCreditExpiresAt !== undefined &&
    now < existing.billing.monthlyCreditExpiresAt
  ) {
    return { userId }
  }
  const periodEnd = Math.max(
    now + 30 * 24 * 60 * 60 * 1_000,
    (existing?.billing?.monthlyCreditExpiresAt ?? 0) + 1,
  )
  await resetMonthlyCreditsForTestWithDb(ctx, {
    userId,
    invoiceId: `in_test_${userId}_${now}`,
    plan,
    allotmentMicroUsd: SUBSCRIPTION_PLANS[plan].monthlyCreditsMicroUsd,
    periodStart: now,
    periodEnd,
    now,
  })
  const user = await ctx.db.get(userId)
  if (user === null) throw new Error('User not found')
  await ctx.db.patch(userId, {
    billing: {
      ...user.billing,
      firstPaidAt: user.billing?.firstPaidAt ?? now,
      subscriptionEverActivatedAt: user.billing?.subscriptionEverActivatedAt ?? now,
      subscription: {
        stripeSubscriptionId: `sub_test_${userId}`,
        stripePriceId: `price_test_${plan}`,
        plan,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        latestLifecycleEventCreatedAt: now,
        latestLifecycleEventId: `evt_test_${userId}_${now}`,
      },
    },
  })
  await reconcileServicingStatus(ctx, userId, now)
  await reconcileWorkspaceVmDisks(ctx, userId, now)
  return { userId }
}

/**
 * Drive the servicing reconciler directly, so a test can prove what it does to
 * a workspace without waiting for the minute-interval cron that normally calls
 * it.
 */
export const reconcileServicingStatusForTest = mutation({
  args: { internalKey: v.string(), userId: v.id('users'), now: v.number() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await reconcileServicingStatus(ctx, args.userId, args.now)
    return { reconciled: true as const }
  },
})

/**
 * The live workspaces a test identity owns, so a journey's cleanup can delete
 * them before retiring the user. `retireUserIdentity` refuses while any of the
 * user's workspaces is not yet `deleted`, and an identity minted through
 * `login-as` with `create: true` always has one it never asked for.
 */
export const workspacesByOwnerForTest = query({
  args: { internalKey: v.string(), userId: v.id('users') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const rows = await ctx.db
      .query('workspaces')
      .withIndex('by_billing_user', q => q.eq('billingUserId', args.userId))
      .take(100)
    return rows.filter(row => row.status !== 'deleted').map(row => ({ _id: row._id }))
  },
})

export const deleteWorkspaceByIdForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    if (workspace.createdByUserId === undefined) throw new Error('Workspace creator not found')
    await deleteWorkspaceImpl(ctx, {
      workspaceId: workspace._id,
      actorId: workspace.createdByUserId,
      ...(args.now === undefined ? {} : { now: args.now }),
    })
    return { workspaceId: workspace._id, vmName: workspace.vmName }
  },
})

export const resetCurrentUserWorkspaceMembershipsForTest = mutation({
  args: {
    internalKey: v.string(),
    keepWorkspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const userId = await requireCurrentUserId(ctx)
    const memberships = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_user_and_workspace', q => q.eq('userId', userId))
      .take(1_001)
    if (memberships.length > 1_000) throw new Error('Test user has too many memberships')
    if (!memberships.some(membership => membership.workspaceId === args.keepWorkspaceId)) {
      throw new Error('Kept workspace membership not found')
    }

    let removed = 0
    for (const membership of memberships) {
      if (membership.workspaceId === args.keepWorkspaceId) continue
      const workspace = await ctx.db.get(membership.workspaceId)
      if (workspace !== null && workspace.status !== 'deleted') {
        await deleteWorkspaceImpl(ctx, {
          workspaceId: workspace._id,
          actorId: workspace.createdByUserId ?? userId,
        })
      }
      await deleteWorkspaceMembershipGeneration(ctx, membership, Date.now())
      removed += 1
    }
    return { removed }
  },
})

export const markWorkspaceVmTeardownLeakedForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    status: v.union(v.literal('deleted'), v.literal('retired')),
    retryAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null || workspace.vmName === undefined) {
      throw new Error('Attached workspace required')
    }
    await ctx.db.patch(args.workspaceId, {
      status: args.status,
      vmTeardownRunId: undefined,
      attachAfterVmTeardown: undefined,
      vmTokenHash: undefined,
      syncthingDeviceId: undefined,
      vmCleanupRetryAt: args.retryAt,
    })
  },
})

export const rawUserByEmailForTest = query({
  args: { internalKey: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', args.email.trim().toLowerCase()))
      .unique()
  },
})

export const rawWorkspacesForTest = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.query('workspaces').collect()
  },
})

/**
 * Cancels the workspace's live provisioning runs (vm attach, vm teardown) so a
 * test can drive prepare->register manually without the product's async
 * pipeline re-preparing tokens underneath it. Cancellation is asynchronous:
 * each run's onComplete mutation clears its run-id field on the workspace row,
 * so callers poll rawWorkspaceByIdForTest until both fields are undefined —
 * only then are all actors provably dead and their bookkeeping flushed. Use
 * the test-harness settleWorkspaceProvisioning helper, which does both steps.
 *
 * Side effect worth knowing: cancelling a teardown that was going to
 * recommission (attachAfterVmTeardown) legitimately marks the workspace
 * unhealthy via that run's onComplete. Callers that go on to register
 * manually re-establish status through prepareWorkspaceForRegistration.
 */
export const settleWorkspaceProvisioningForTest = mutation({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    const runIds = [workspace.vmAttachRunId, workspace.vmTeardownRunId].filter(
      (runId): runId is string => runId !== undefined,
    )
    for (const runId of runIds) {
      try {
        await retrier.cancel(ctx, runId as RunId)
      } catch {
        // The run finished between our read and the cancel; its onComplete
        // clears the field either way, which is what callers poll for.
      }
    }
    return { pendingRuns: runIds.length }
  },
})

export const rawWorkspaceByIdForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.get(args.workspaceId)
  },
})

export const rawShareSyncReportsForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('shareSyncRealizations')
      .withIndex('by_workspace_share', q => q.eq('workspaceId', args.workspaceId))
      .take(501)
  },
})

export const newestNonDeletedWorkspaceBySlugForTest = query({
  args: { internalKey: v.string(), slug: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('workspaces')
      .withIndex('by_slug_status', q => q.eq('slug', args.slug.trim().toLowerCase()))
      .order('desc')
      .filter(q => q.neq(q.field('status'), 'deleted'))
      .first()
  },
})

export const workspaceMembersForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q => q.eq('workspaceId', args.workspaceId))
      .take(100)
  },
})

export const deleteMembershipGenerationForTest = mutation({
  args: {
    internalKey: v.string(),
    membershipId: v.id('workspaceMembers'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const membership = await ctx.db.get(args.membershipId)
    if (membership === null) return
    await deleteWorkspaceMembershipGeneration(ctx, membership, args.now, { schedule: false })
  },
})

export const workspaceMemberDirectoryForTest = query({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('workspaceMemberDirectory')
      .withIndex('by_workspace_order', q => q.eq('workspaceId', args.workspaceId))
      .take(1_000)
  },
})

export const setMemberDirectoryOrderForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    membershipId: v.id('workspaceMembers'),
    normalizedName: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.db
      .query('workspaceMemberDirectory')
      .withIndex('by_membership', q => q.eq('membershipId', args.membershipId))
      .unique()
    if (row === null || row.workspaceId !== args.workspaceId) {
      throw new Error('Workspace member directory row not found')
    }
    await ctx.db.patch(row._id, { normalizedName: args.normalizedName })
  },
})

export const seedMemberDirectoryMembershipsForTest = mutation({
  args: {
    internalKey: v.string(),
    userId: v.id('users'),
    count: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (!Number.isInteger(args.count) || args.count < 0 || args.count > 120) {
      throw new Error('Directory membership fixture count must be between 0 and 120')
    }
    if ((await ctx.db.get(args.userId)) === null) throw new Error('User not found')
    for (let index = 0; index < args.count; index += 1) {
      const workspaceId = await ctx.db.insert('workspaces', {
        slug: `profile-fanout-${args.userId}-${index}`,
        name: `Profile fanout ${index}`,
        status: 'active',
        createdAt: args.now,
        billingUserId: args.userId,
      })
      await insertWorkspaceMember(ctx, { workspaceId, userId: args.userId, role: 'viewer' })
    }
    return { inserted: args.count }
  },
})

export const userMemberDirectoryForTest = query({
  args: { internalKey: v.string(), userId: v.id('users') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('workspaceMemberDirectory')
      .withIndex('by_user_and_membership', q => q.eq('userId', args.userId))
      .take(200)
  },
})

/**
 * Force a workspace's lifecycle status. Retirement, archival and deletion are
 * what "a publisher's origin went away" actually means to the marketplace
 * availability sweep, and driving the real transitions would provision VMs.
 */
export const setWorkspaceStatusForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    status: v.union(
      v.literal('provisioning'),
      v.literal('active'),
      v.literal('unhealthy'),
      v.literal('archived'),
      v.literal('retired'),
      v.literal('deleted'),
    ),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, { status: args.status })
  },
})

/** Raw slug write that skips the availability check, to stage a slug collision. */
export const setWorkspaceSlugForTest = mutation({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces'), slug: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, { slug: args.slug })
  },
})

/** One row of the `reslugArchivedWorkspaceCollisions` migration. */
export const reslugArchivedWorkspaceCollisionForTest = mutation({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    await reslugArchivedWorkspaceCollision(ctx, workspace)
  },
})

export const clearWorkspaceCreatedByForTest = mutation({
  args: { internalKey: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, { createdByUserId: undefined })
  },
})

export const setWorkspaceCreatedByForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    actorId: v.id('users'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, { createdByUserId: args.actorId })
  },
})

export const createStaleHealthSweepCohortForTest = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    poisonCount: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    let firstPoisonWorkspaceId: Id<'workspaces'> | undefined
    for (let index = 0; index < args.poisonCount; index += 1) {
      const workspaceId = await ctx.db.insert('workspaces', {
        slug: `health-poison-${args.now}-${index}`,
        name: `Health poison ${index}`,
        status: 'active',
        createdAt: args.now,
        billingUserId: args.actorId,
        lastHeartbeatAt: index + 1,
      })
      firstPoisonWorkspaceId ??= workspaceId
    }
    const healthyWorkspaceId = await ctx.db.insert('workspaces', {
      slug: `health-tail-${args.now}`,
      name: 'Health sweep tail',
      status: 'active',
      createdAt: args.now,
      createdByUserId: args.actorId,
      billingUserId: args.actorId,
      lastHeartbeatAt: args.poisonCount + 1,
    })
    return { healthyWorkspaceId, firstPoisonWorkspaceId }
  },
})

export const terminalizeProvisioningFailureSessionsForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return continueSessionTerminalizationForScope(
      ctx,
      { workspaceId: args.workspaceId, reason: 'workspace_provisioning_failed' },
      args.now,
    )
  },
})

/** Seed an in-flight VM handoff without running the external action retrier. */
export const setWorkspaceVmHandoffForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    status: v.union(v.literal('active'), v.literal('archived'), v.literal('provisioning')),
    servicingStatus: v.union(v.literal('active'), v.literal('paused')),
    vmName: v.optional(v.string()),
    vmTokenNonce: v.optional(v.string()),
    vmAttachRunId: v.optional(v.string()),
    vmTeardownRunId: v.optional(v.string()),
    attachAfterVmTeardown: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, {
      status: args.status,
      servicingStatus: args.servicingStatus,
      vmName: args.vmName,
      vmTokenNonce: args.vmTokenNonce,
      vmAttachRunId: args.vmAttachRunId,
      vmTeardownRunId: args.vmTeardownRunId,
      attachAfterVmTeardown: args.attachAfterVmTeardown,
    })
  },
})

/** Force servicing status: pausing for real needs a billing lifecycle. */
export const setServicingStatusForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    servicingStatus: v.union(v.literal('active'), v.literal('paused')),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.workspaceId, { servicingStatus: args.servicingStatus })
  },
})
