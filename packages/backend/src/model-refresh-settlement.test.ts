import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import { MODEL_SELECTIONS, type ModelSelectionId } from '@repo/contract'

import { applyGenerationSettlement } from '../convex/domains/modelGateway/settlement'
import schema from '../convex/schema'

test('an upgraded selection keeps its customer tariff and delayed generations keep theirs', async () => {
  // Billing selection is the contract here; live tariffs are adjustable.
  const tiers = ['anthropic-max', 'openai-max', 'frontier', 'balanced'] as const
  const originalRates = tiers.map(tier => MODEL_SELECTIONS[tier].rates)
  for (const tier of tiers) {
    MODEL_SELECTIONS[tier].rates = {
      inputTokensPer1M: 2,
      cachedInputTokensPer1M: 1,
      outputTokensPer1M: 3,
    }
  }
  try {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'model-refresh@example.com',
        createdAt: 1,
        updatedAt: 1,
        paidCreditBalanceMicroUsd: 1_000_000,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
      })
      const workspaceId = await ctx.db.insert('workspaces', {
        slug: 'model-refresh',
        name: 'Model refresh',
        status: 'active',
        createdAt: 1,
        billingUserId: userId,
      })
      await ctx.db.insert('workspaceMembers', {
        workspaceId,
        userId,
        role: 'owner',
      })

      let expectedBalance = 1_000_000
      const selections: Array<[ModelSelectionId, string[], number]> = [
        ['anthropic-max', ['anthropic/claude-opus-5', 'anthropic/claude-opus-5.5'], 64],
        ['openai-max', ['openai/gpt-5.6-sol', 'openai/gpt-6-sol', 'openai/gpt-6.1-sol'], 64],
        [
          'frontier',
          [
            'anthropic/claude-opus-5',
            'anthropic/claude-opus-5.5',
            'openai/gpt-5.6-sol',
            'openai/gpt-6-sol',
            'openai/gpt-6.1-sol',
          ],
          64,
        ],
        [
          'balanced',
          ['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-6-sol', 'openai/gpt-6.1-sol'],
          64,
        ],
      ]
      for (const [tier, models, customerCost] of selections) {
        for (const model of models) {
          for (const upstreamCostMicroUsd of [1, 10_000]) {
            const upstreamGenerationId = `${tier}:${model}:${upstreamCostMicroUsd}`
            const generationId = await ctx.db.insert('gatewayGenerations', {
              workspaceId,
              userId,
              modality: 'text',
              model,
              tier,
              billingMode: 'post_response',
              chargeToWorkspace: true,
              status: 'reconciling',
              upstreamGenerationId,
              upstreamCostMicroUsd,
              upstreamMetadata: {
                usage: { uncachedInputTokens: 7, cachedInputTokens: 11, outputTokens: 13 },
              },
              createdAt: 1,
              updatedAt: 1,
            })
            const generation = (await ctx.db.get(generationId))!
            await applyGenerationSettlement(ctx, generation, 2)
            expectedBalance -= customerCost
            expect((await ctx.db.get(generationId))?.billedCostMicroUsd).toBe(customerCost)
            expect((await ctx.db.get(userId))?.paidCreditBalanceMicroUsd).toBe(expectedBalance)
            const transaction = await ctx.db
              .query('creditTransactions')
              .filter(q => q.eq(q.field('reference'), `ai_generation:${upstreamGenerationId}`))
              .unique()
            expect(transaction?.amountMicroUsd).toBe(-customerCost)
            expect((await ctx.db.get(generationId))?.upstreamCostMicroUsd).toBe(
              upstreamCostMicroUsd,
            )
            await applyGenerationSettlement(ctx, (await ctx.db.get(generationId))!, 3)
            expect((await ctx.db.get(userId))?.paidCreditBalanceMicroUsd).toBe(expectedBalance)
          }
        }
      }
    })
  } finally {
    for (const [index, tier] of tiers.entries())
      MODEL_SELECTIONS[tier].rates = originalRates[index]!
  }
})
