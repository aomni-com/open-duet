import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import schema from '../convex/schema'

test('usage rollup indexes isolate granularity, dimensions, and daily pruning', async () => {
  const t = convexTest(schema, {
    '../convex/_generated/api.ts': async () => ({}),
  })

  await t.run(async ctx => {
    const now = Date.UTC(2026, 6, 23)
    const userId = await ctx.db.insert('users', {
      email: 'usage-index-oracle@example.com',
      createdAt: now,
      updatedAt: now,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'usage-index-oracle',
      name: 'Usage index oracle',
      status: 'active',
      createdAt: now,
      billingUserId: userId,
    })
    await Promise.all([
      ctx.db.insert('usageRollups', {
        workspaceId,
        granularity: 'daily',
        periodKey: '2026-07-15',
        spendMicroUsd: 1,
        updatedAt: now,
      }),
      ctx.db.insert('usageRollups', {
        workspaceId,
        granularity: 'monthly',
        periodKey: '2026-12',
        spendMicroUsd: 2,
        updatedAt: now,
      }),
      ctx.db.insert('usageRollups', {
        workspaceId,
        granularity: 'monthly',
        periodKey: '2026-07',
        appSlug: 'alpha',
        spendMicroUsd: 3,
        updatedAt: now,
      }),
      ctx.db.insert('usageRollups', {
        workspaceId,
        granularity: 'monthly',
        periodKey: '2026-07',
        appSlug: 'beta',
        spendMicroUsd: 4,
        updatedAt: now,
      }),
      ctx.db.insert('usageRollups', {
        workspaceId,
        granularity: 'monthly',
        periodKey: '2024-01',
        spendMicroUsd: 5,
        updatedAt: now,
      }),
      ctx.db.insert('usageRollups', {
        workspaceId,
        granularity: 'weekly',
        periodKey: '2026-W30',
        spendMicroUsd: 6,
        updatedAt: now,
      }),
      ctx.db.insert('usageRollups', {
        workspaceId,
        granularity: 'weekly',
        periodKey: '2026-W05',
        spendMicroUsd: 7,
        updatedAt: now,
      }),
    ])

    // Zero-padded week numbers keep the index range ordered, so W05 precedes
    // W30 rather than sorting as the string "5".
    const weekly = await ctx.db
      .query('usageRollups')
      .withIndex('by_workspace_granularity_period', q =>
        q
          .eq('workspaceId', workspaceId)
          .eq('granularity', 'weekly')
          .gte('periodKey', '2026-W01')
          .lte('periodKey', '9999-W99'),
      )
      .take(10)
    expect(weekly.map(row => [row.periodKey, row.spendMicroUsd])).toEqual([
      ['2026-W05', 7],
      ['2026-W30', 6],
    ])

    const monthly = await ctx.db
      .query('usageRollups')
      .withIndex('by_workspace_granularity_period', q =>
        q
          .eq('workspaceId', workspaceId)
          .eq('granularity', 'monthly')
          .gte('periodKey', '2026-01')
          .lte('periodKey', '2026-12'),
      )
      .take(10)
    expect(monthly.map(row => [row.granularity, row.periodKey])).toEqual([
      ['monthly', '2026-07'],
      ['monthly', '2026-07'],
      ['monthly', '2026-12'],
    ])

    for (const appSlug of ['alpha', 'beta']) {
      const dimension = await ctx.db
        .query('usageRollups')
        .withIndex('by_workspace_granularity_period_dimension', q =>
          q
            .eq('workspaceId', workspaceId)
            .eq('granularity', 'monthly')
            .eq('periodKey', '2026-07')
            .eq('userId', undefined)
            .eq('appId', undefined)
            .eq('appSlug', appSlug),
        )
        .unique()
      expect(dimension?.appSlug).toBe(appSlug)
      expect(dimension?.spendMicroUsd).toBe(appSlug === 'alpha' ? 3 : 4)
    }

    const pruneCandidates = await ctx.db
      .query('usageRollups')
      .withIndex('by_granularity_period', q =>
        q.eq('granularity', 'daily').lte('periodKey', '2026-07-15'),
      )
      .take(10)
    expect(pruneCandidates.map(row => [row.granularity, row.periodKey])).toEqual([
      ['daily', '2026-07-15'],
    ])
  })
})
