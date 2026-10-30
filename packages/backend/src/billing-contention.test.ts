import { describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import { currentMonthKey } from '@repo/contract'

import { applyLedgerEntryWithDb, runPreflightWithDb } from '../convex/domains/credits/ledger'
import {
  backfillWorkspaceSpendingRow,
  workspaceMonthlySpend,
} from '../convex/domains/credits/workspaceSpend'
import schema from '../convex/schema'

describe('billing contention boundaries', () => {
  test('backfill preserves live charges and retires the legacy spending fields', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const now = Date.UTC(2030, 8, 11)
    await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'migration@example.test',
        createdAt: now,
        updatedAt: now,
        memberDirectoryRevision: 0,
        paidCreditBalanceMicroUsd: 10_000_000,
        monthlyCreditBalanceMicroUsd: 0,
      })
      const workspaceId = await ctx.db.insert('workspaces', {
        name: 'Migrating',
        slug: 'migrating',
        status: 'active',
        createdAt: now,
        billingUserId: userId,
        billing: {
          maxMonthlySpendMicroUsd: 150,
          monthlySpendMicroUsd: 100,
          monthlySpendPeriodKey: currentMonthKey(now),
        },
      })
      await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
      const before = (await ctx.db.get(workspaceId))!
      expect(await workspaceMonthlySpend(ctx, before, now)).toBe(100)
      await applyLedgerEntryWithDb(ctx, {
        workspaceId,
        amountMicroUsd: -25,
        type: 'usage',
        reference: 'during-backfill',
        now,
      })
      await backfillWorkspaceSpendingRow(ctx, (await ctx.db.get(workspaceId))!)
      await backfillWorkspaceSpendingRow(ctx, (await ctx.db.get(workspaceId))!)
      const after = (await ctx.db.get(workspaceId))!
      expect(after.billing).toEqual({ maxMonthlySpendMicroUsd: 150 })
      expect(await workspaceMonthlySpend(ctx, after, now)).toBe(125)
      expect(await workspaceMonthlySpend(ctx, after, Date.UTC(2030, 9, 1))).toBe(0)
    })
  })

  test('a delayed prior-month charge cannot erase current-month spend', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const september = Date.UTC(2030, 8, 30)
    const october = Date.UTC(2030, 9, 1)
    await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'rollover@example.test',
        createdAt: september,
        updatedAt: september,
        memberDirectoryRevision: 0,
        paidCreditBalanceMicroUsd: 10_000_000,
        monthlyCreditBalanceMicroUsd: 0,
        billing: { trialExpiresAt: october + 86_400_000 },
      })
      const workspaceId = await ctx.db.insert('workspaces', {
        name: 'Rollover',
        slug: 'rollover',
        status: 'active',
        servicingStatus: 'active',
        createdAt: september,
        billingUserId: userId,
        billing: { maxMonthlySpendMicroUsd: 200 },
      })
      await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
      await applyLedgerEntryWithDb(ctx, {
        workspaceId,
        amountMicroUsd: -200,
        type: 'usage',
        reference: 'october',
        now: october,
      })
      await applyLedgerEntryWithDb(ctx, {
        workspaceId,
        amountMicroUsd: -50,
        type: 'usage',
        reference: 'september-late',
        now: september,
      })
      expect(await runPreflightWithDb(ctx, { workspaceId, now: october })).toMatchObject({
        proceed: false,
        reason: 'monthly_cap',
        tier: 'workspace',
        workspaceMonthlySpendMicroUsd: 200,
        accountMonthlySpendMicroUsd: 200,
        balanceMicroUsd: 9_999_750,
      })
    })
  })

  test('charging preserves workspace state while enforcing its exact monthly cap', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const now = Date.now()
    const fixture = await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'busy@example.test',
        createdAt: now,
        updatedAt: now,
        memberDirectoryRevision: 0,
        paidCreditBalanceMicroUsd: 10_000_000,
        monthlyCreditBalanceMicroUsd: 0,
        billing: { trialExpiresAt: now + 86_400_000 },
      })
      const workspaceId = await ctx.db.insert('workspaces', {
        name: 'Busy workspace',
        slug: 'busy',
        status: 'active',
        servicingStatus: 'active',
        createdAt: now,
        billingUserId: userId,
        billing: { maxMonthlySpendMicroUsd: 100 },
      })
      await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
      return { workspaceId, before: await ctx.db.get(workspaceId) }
    })
    await t.run(async ctx => {
      const charge = {
        workspaceId: fixture.workspaceId,
        amountMicroUsd: -100,
        type: 'usage' as const,
        reference: 'service:contention:final',
        now,
      }
      expect(await applyLedgerEntryWithDb(ctx, charge)).toMatchObject({
        applied: true,
        newBalanceMicroUsd: 9_999_900,
      })
      expect(await applyLedgerEntryWithDb(ctx, charge)).toMatchObject({
        applied: false,
        newBalanceMicroUsd: 9_999_900,
      })
      expect(
        await runPreflightWithDb(ctx, { workspaceId: fixture.workspaceId, now }),
      ).toMatchObject({
        proceed: false,
        reason: 'monthly_cap',
        tier: 'workspace',
        workspaceMonthlySpendMicroUsd: 100,
      })
    })
    expect(await t.run(ctx => ctx.db.get(fixture.workspaceId))).toEqual(fixture.before)
  })
})
