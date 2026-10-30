import { describe, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import schema from '../../schema'
import { starterAgentsForUserImpl } from './starterAgents'

describe('campaign official-agent derivation', () => {
  test('returns the attributed campaign agents in definition order', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'campaign-agent-fixture@example.test',
        createdAt: 100,
        updatedAt: 100,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
      })
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'fixture-campaign',
        action: 'signup',
        acquiredByUserId: userId,
        signals: {},
        createdAt: 100,
        expiresAt: 200,
      })
      await ctx.db.patch(userId, { acquisitionAttributionId: attributionId })

      expect(
        await starterAgentsForUserImpl(ctx, userId, () => ({
          enabled: true,
          attributionWindowMs: 100,
          starterAgents: ['fixture-analyst', 'fixture-researcher'],
        })),
      ).toEqual(['fixture-analyst', 'fixture-researcher'])
    })
  })

  test('returns no agents without claimed attribution or for a disabled campaign', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'campaign-agent-none@example.test',
        createdAt: 100,
        updatedAt: 100,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
      })
      expect(
        await starterAgentsForUserImpl(ctx, userId, () => ({
          enabled: true,
          attributionWindowMs: 100,
          starterAgents: ['fixture-researcher'],
        })),
      ).toEqual([])

      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'fixture-disabled',
        action: 'signup',
        acquiredByUserId: userId,
        signals: {},
        createdAt: 100,
        expiresAt: 200,
      })
      await ctx.db.patch(userId, { acquisitionAttributionId: attributionId })
      expect(
        await starterAgentsForUserImpl(ctx, userId, () => ({
          enabled: false,
          attributionWindowMs: 100,
          starterAgents: ['fixture-researcher'],
        })),
      ).toEqual([])
    })
  })

  test('keeps a claimed attribution authoritative after its window expires', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'campaign-agent-expired@example.test',
        createdAt: 100,
        updatedAt: 100,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
      })
      const attributionId = await ctx.db.insert('campaignAttributions', {
        campaignSlug: 'fixture-expired',
        action: 'signup',
        acquiredByUserId: userId,
        signals: {},
        createdAt: 100,
        expiresAt: 101,
      })
      await ctx.db.patch(userId, { acquisitionAttributionId: attributionId })

      expect(
        await starterAgentsForUserImpl(ctx, userId, () => ({
          enabled: true,
          attributionWindowMs: 1,
          starterAgents: ['fixture-researcher'],
        })),
      ).toEqual(['fixture-researcher'])
    })
  })
})
