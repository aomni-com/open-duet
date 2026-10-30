import { v } from 'convex/values'

import { components } from '../_generated/api'
import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { applyAccountLedgerEntryWithDb } from '../domains/credits/ledger'
import {
  expireMonthlyCreditsForTestWithDb,
  resetMonthlyCreditsForTestWithDb,
} from '../domains/credits/subscriptions'
import { applyUsageRollupBatchImpl, scheduleUsageRollup } from '../domains/credits/usageRollups'
import { spendableBalance, walletOf } from '../domains/credits/wallet'

const subscriptionPlanValidator = v.union(v.literal('starter'), v.literal('pro'), v.literal('max'))

export const setBillingWorkerStoppedForTest = mutation({
  args: { internalKey: v.string(), userId: v.id('users'), stopped: v.boolean() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.runMutation(
      args.stopped ? components.billingWorker.lib.stop : components.billingWorker.lib.start,
      { name: args.userId },
    )
  },
})

export const pendingSettlementsForTest = query({
  args: { internalKey: v.string(), userId: v.id('users') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('billingSettlements')
      .withIndex('by_account_status', q =>
        q.eq('billingUserId', args.userId).eq('status', 'pending'),
      )
      .take(100)
  },
})

export const walletForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    const user = await ctx.db.get(workspace.billingUserId)
    if (user === null) throw new Error('Billing user not found')
    const wallet = walletOf(user)
    return {
      paidCreditBalanceMicroUsd: wallet.paidMicroUsd,
      monthlyCreditBalanceMicroUsd: wallet.monthlyMicroUsd,
      balanceMicroUsd: spendableBalance(wallet),
    }
  },
})

export const userBillingForTest = query({
  args: { internalKey: v.string(), userId: v.id('users') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return (await ctx.db.get(args.userId))?.billing ?? {}
  },
})

export const setAutoTopupThresholdRawForTest = mutation({
  args: {
    internalKey: v.string(),
    userId: v.id('users'),
    thresholdMicroUsd: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const user = await ctx.db.get(args.userId)
    if (user === null) throw new Error('User not found')
    await ctx.db.patch(args.userId, {
      billing: { ...user.billing, autoTopupThresholdMicroUsd: args.thresholdMicroUsd },
    })
  },
})

export const resetMonthlyCreditsForTest = mutation({
  args: {
    internalKey: v.string(),
    userId: v.id('users'),
    invoiceId: v.string(),
    plan: subscriptionPlanValidator,
    allotmentMicroUsd: v.number(),
    periodStart: v.number(),
    periodEnd: v.number(),
    invoiceCreatedAt: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await resetMonthlyCreditsForTestWithDb(ctx, args)
  },
})

export const expireMonthlyCreditsForTest = mutation({
  args: {
    internalKey: v.string(),
    userId: v.id('users'),
    reference: v.string(),
    reason: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await expireMonthlyCreditsForTestWithDb(ctx, args)
  },
})

export const applyAccountAdjustmentForTest = mutation({
  args: {
    internalKey: v.string(),
    userId: v.id('users'),
    amountMicroUsd: v.number(),
    reference: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await applyAccountLedgerEntryWithDb(ctx, {
      userId: args.userId,
      amountMicroUsd: args.amountMicroUsd,
      type: 'adjustment',
      reference: args.reference,
      now: args.now,
    })
  },
})

export const listTopupsForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('billingTopups')
      .withIndex('by_workspace_created', q => q.eq('workspaceId', args.workspaceId))
      .order('asc')
      .collect()
  },
})

export const listScheduledCreditFunctionsForTest = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const rows = await ctx.db.system.query('_scheduled_functions').take(1_000)
    return rows.filter(row => row.name.startsWith('domains/credits/'))
  },
})

export const listWorkspaceTransactionsForTest = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('creditTransactions')
      .withIndex('by_workspace_created', q => q.eq('workspaceId', args.workspaceId))
      .order('asc')
      .take(500)
  },
})

export const listAccountTransactionsForTest = query({
  args: {
    internalKey: v.string(),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('creditTransactions')
      .withIndex('by_user_created', q => q.eq('userId', args.userId))
      .order('asc')
      .take(500)
  },
})

/**
 * Applies a run of daily usage rollups in ONE transaction through the same
 * per-rollup impl the internal mutation uses. The read-cap test needs a
 * thousand distinct periods as a FIXTURE; a thousand awaited client round
 * trips (~40ms of committed write each) is not part of that contract.
 */
export const applyUsageRollupRunForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    count: v.number(),
    startIndex: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const start = args.startIndex ?? 0
    for (let index = 0; index < args.count; index += 1) {
      const period = `2026-${String(start + index).padStart(4, '0')}`
      await applyUsageRollupBatchImpl(ctx, {
        internalKey: args.internalKey,
        workspaceId: args.workspaceId,
        periodKeys: { daily: period, weekly: '2026-W01', monthly: '2026-01' },
        spendMicroUsd: 1,
      })
    }
    return null
  },
})

export const scheduleUsageRollupForTest = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    spendMicroUsd: v.number(),
    createdAt: v.number(),
    userId: v.optional(v.id('users')),
    dimensions: v.object({
      appId: v.optional(v.id('apps')),
      appSlug: v.optional(v.string()),
      inputTokens: v.optional(v.number()),
      outputTokens: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const before = (await ctx.db.system.query('_scheduled_functions').take(1000)).filter(row =>
      row.name.includes('applyUsageRollup'),
    ).length
    await scheduleUsageRollup(ctx, args)
    const after = (await ctx.db.system.query('_scheduled_functions').take(1000)).filter(row =>
      row.name.includes('applyUsageRollup'),
    ).length
    return after - before
  },
})
