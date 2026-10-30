import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { applyWalletDelta, walletOf } from '../domains/credits/wallet'
import { createOrLinkUserForAuth } from '../domains/users/model'
import { insertWorkspaceMember } from '../domains/workspaces/memberDirectory'

export const auditEvents = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.query('adminAuditEvents').take(1000)
  },
})

export const seedUnpaidPayers = mutation({
  args: {
    internalKey: v.string(),
    startIndex: v.number(),
    count: v.number(),
    balanceMicroUsd: v.number(),
    now: v.number(),
    // false seeds inconsistent billing data: a live workspace whose billing
    // user holds no owner membership, which the ledger refuses to charge.
    ownerMembership: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    for (let offset = 0; offset < args.count; offset += 1) {
      const index = args.startIndex + offset
      const userId = await createOrLinkUserForAuth(ctx, {
        existingUserId: null,
        type: 'oauth',
        profile: {
          email: `admin-pagination-${args.now}-${index}@example.test`,
          emailVerified: false,
        },
      })
      const user = await ctx.db.get(userId)
      if (user === null) throw new Error('Seeded user not found')
      await ctx.db.patch(userId, { createdAt: args.now, updatedAt: args.now })
      await applyWalletDelta(ctx, user, {
        paidDeltaMicroUsd: args.balanceMicroUsd,
        monthlyDeltaMicroUsd: 0,
      })
      const workspaceId = await ctx.db.insert('workspaces', {
        slug: `admin-page-${index}`,
        name: `Admin page ${index}`,
        status: 'active',
        createdAt: args.now,
        billingUserId: userId,
      })
      if (args.ownerMembership ?? true)
        await insertWorkspaceMember(ctx, { workspaceId, userId, role: 'owner' })
    }
  },
})

/**
 * One active workspace with a VM and, optionally, a telemetry sample — the
 * shape the fleet-health view reports on. Omitting the sample fields seeds a
 * live VM the sampler has not reached yet, which the view counts as `missing`.
 */
export const seedFleetVm = mutation({
  args: {
    internalKey: v.string(),
    slug: v.string(),
    vmName: v.string(),
    runtimeVersion: v.string(),
    lastHeartbeatAt: v.number(),
    now: v.number(),
    sample: v.optional(
      v.object({
        at: v.number(),
        cpuCores: v.number(),
        cpuNominalCores: v.number(),
        memUsedBytes: v.number(),
        memTotalBytes: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const ownerId = await createOrLinkUserForAuth(ctx, {
      existingUserId: null,
      type: 'oauth',
      profile: { email: `fleet-${args.slug}-${args.now}@example.test`, emailVerified: false },
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: args.slug,
      name: args.slug,
      status: 'active',
      createdAt: args.now,
      billingUserId: ownerId,
      vmName: args.vmName,
      runtimeVersion: args.runtimeVersion,
      lastHeartbeatAt: args.lastHeartbeatAt,
    })
    if (args.sample !== undefined) {
      await ctx.db.insert('vmTelemetrySamples', { workspaceId, ...args.sample })
    }
    return { workspaceId }
  },
})

export const seedSettledGeneration = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    model: v.string(),
    upstreamCostMicroUsd: v.number(),
    billedCostMicroUsd: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.insert('gatewayGenerations', {
      workspaceId: args.workspaceId,
      userId: args.userId,
      modality: 'text',
      model: args.model,
      tier: 'frontier',
      billingMode: 'post_response',
      chargeToWorkspace: true,
      status: 'settled',
      upstreamGenerationId: `gen-${args.model}-${args.now}`,
      upstreamCostMicroUsd: args.upstreamCostMicroUsd,
      billedCostMicroUsd: args.billedCostMicroUsd,
      upstreamMetadata: { provider: 'anthropic' },
      createdAt: args.now,
      updatedAt: args.now,
      settledAt: args.now,
    })
    return null
  },
})

export const seedDeletedWorkspaceTombstones = mutation({
  args: { internalKey: v.string(), count: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    // One synthetic owner for all tombstones: retired e2e workspaces keep their
    // rows forever, and the free-credit report must not count them as scale.
    const ownerId = await createOrLinkUserForAuth(ctx, {
      existingUserId: null,
      type: 'oauth',
      profile: { email: `admin-tombstones-${args.now}@example.test`, emailVerified: false },
    })
    await ctx.db.patch(ownerId, { billing: { firstPaidAt: args.now } })
    for (let index = 0; index < args.count; index += 1) {
      await ctx.db.insert('workspaces', {
        slug: `admin-tomb-${args.now}-${index}`,
        name: `Tombstone ${index}`,
        status: 'deleted',
        createdAt: args.now,
        billingUserId: ownerId,
      })
    }
  },
})

export const markSeededPayersPaid = mutation({
  args: { internalKey: v.string(), now: v.number(), count: v.number() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    for (let index = 0; index < args.count; index += 1) {
      const user = await ctx.db
        .query('users')
        .withIndex('by_email', q =>
          q.eq('email', `admin-pagination-${args.now}-${index}@example.test`),
        )
        .unique()
      // `subscriptionEverActivatedAt` is the fact the free-credit report reads
      // to decide a payer is no longer unpaid; `firstPaidAt` alone would leave
      // the seeded users counted forever and leak into later tests.
      if (user !== null)
        await ctx.db.patch(user._id, {
          billing: {
            ...user.billing,
            firstPaidAt: args.now,
            subscriptionEverActivatedAt: args.now,
          },
        })
    }
  },
})

export const countPositiveUnpaidPayers = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const users = await ctx.db.query('users').take(1000)
    return users.filter(
      user =>
        user.billing?.subscriptionEverActivatedAt === undefined && walletOf(user).paidMicroUsd > 0,
    ).length
  },
})

/**
 * Whole-database snapshot for the seed's idempotence oracle. Referenced only by
 * name from `official-hub-seed.test.ts` — a symbol grep will not find it, which
 * is exactly how it once got deleted as dead.
 */
export const officialHubSeedSnapshot = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return {
      runs: await ctx.db.query('officialHub').take(1000),
      workspaces: await ctx.db.query('workspaces').take(1000),
      anchors: await ctx.db.query('anchors').take(1000),
      agents: await ctx.db.query('agents').take(1000),
      apps: await ctx.db.query('apps').take(1000),
      publishes: await ctx.db.query('publishes').take(1000),
      subscriptions: await ctx.db.query('agentSubscriptions').take(1000),
      listings: await ctx.db.query('agentListings').take(1000),
    }
  },
})
