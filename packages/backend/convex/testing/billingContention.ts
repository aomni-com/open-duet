import { v } from 'convex/values'

import { mutation } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { insertApiKey } from '../domains/apiKeys/storage'
import { applyAccountLedgerEntryWithDb } from '../domains/credits/ledger'
import { insertWorkspaceMember } from '../domains/workspaces/memberDirectory'

// This fixture exercises deployed accounting without provisioning a VM or
// involving an upstream provider. The ordinary teardown/identity rail owns cleanup.
export const createFixture = mutation({
  args: { internalKey: v.string(), runId: v.string(), hashedKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (!/^staging-e2e-billing-[a-z0-9-]+$/.test(args.runId))
      throw new Error('Invalid billing fixture run id')
    const email = `${args.runId}-admin@duet.so`
    const existing = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', email))
      .unique()
    if (existing !== null) {
      const workspace = await ctx.db
        .query('workspaces')
        .withIndex('by_slug_status', q => q.eq('slug', args.runId))
        .unique()
      if (workspace === null) throw new Error('Fixture workspace missing')
      return {
        userId: existing._id,
        workspaceId: workspace._id,
        workspaceSlug: workspace.slug,
        email,
      }
    }
    const now = Date.now()
    const userId = await ctx.db.insert('users', {
      email,
      name: args.runId,
      memberDirectoryRevision: 0,
      createdAt: now,
      updatedAt: now,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      ephemeralExpiresAt: now + 86_400_000,
      billing: { trialExpiresAt: now + 86_400_000 },
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: args.runId,
      name: args.runId,
      status: 'provisioning',
      servicingStatus: 'active',
      billingUserId: userId,
      createdByUserId: userId,
      createdAt: now,
    })
    await insertWorkspaceMember(ctx, { workspaceId, userId, role: 'owner' })
    await insertApiKey(ctx, {
      userId,
      kind: 'user',
      hashedKey: args.hashedKey,
      prefix: 'duet_sk_fixture',
      lastUsedAt: now,
    })
    await applyAccountLedgerEntryWithDb(ctx, {
      userId,
      amountMicroUsd: 10_000_000,
      type: 'grant',
      reference: `${args.runId}:seed`,
      now,
    })
    return { userId, workspaceId, workspaceSlug: args.runId, email }
  },
})
