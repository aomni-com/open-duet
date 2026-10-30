import { afterEach, beforeEach, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import { MODEL_SELECTIONS, PROVIDER_MODEL_ALIASES } from '@repo/contract'

import { internal } from '../convex/_generated/api'
import schema from '../convex/schema'

const originalSelections = Object.values(MODEL_SELECTIONS).map(selection => ({
  selection,
  closure: selection.closure,
  rates: { ...selection.rates },
}))
beforeEach(() => {
  for (const { selection } of originalSelections) {
    Object.assign(selection, { closure: [`fixture/${selection.id}`] })
    Object.assign(selection.rates, {
      inputTokensPer1M: 1,
      outputTokensPer1M: 3,
      cachedInputTokensPer1M: 0.5,
    })
  }
})
afterEach(() => {
  for (const { selection, closure, rates } of originalSelections) {
    Object.assign(selection, { closure })
    Object.assign(selection.rates, rates)
  }
})

function newTest() {
  return convexTest(schema, {
    '../convex/_generated/api.ts': async () => ({}),
    '../convex/domains/credits/settlementQueue.ts': () =>
      import('../convex/domains/credits/settlementQueue'),
    '../convex/domains/modelGateway/model.ts': () => import('../convex/domains/modelGateway/model'),
  })
}

test('a queued service replay cannot debit a replacement payer', async () => {
  const t = newTest()
  const fixture = await t.run(async ctx => {
    const users = []
    for (const email of ['payer-a@example.test', 'payer-b@example.test']) {
      users.push(
        await ctx.db.insert('users', {
          email,
          createdAt: 1,
          updatedAt: 1,
          memberDirectoryRevision: 0,
          paidCreditBalanceMicroUsd: 10_000,
          monthlyCreditBalanceMicroUsd: 0,
        }),
      )
    }
    const [payerA, payerB] = users
    const workspaceId = await ctx.db.insert('workspaces', {
      name: 'Transferred',
      slug: 'transferred',
      status: 'active',
      createdAt: 1,
      billingUserId: payerA!,
    })
    for (const userId of users)
      await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
    const operation = {
      kind: 'service' as const,
      workspaceId,
      userId: payerA!,
      amountMicroUsd: 100,
      occurredAt: 1,
      reference: 'service:firecrawl:crawl:one-job:final',
      metadata: { service: 'firecrawl', path: '/v2/crawl/one-job', method: 'GET' },
    }
    const first = await ctx.db.insert('billingSettlements', {
      billingUserId: payerA!,
      status: 'pending',
      operation,
    })
    return { payerA: payerA!, payerB: payerB!, workspaceId, operation, first }
  })
  await t.mutation(internal.domains.credits.settlementQueue.applyBatch, { ids: [fixture.first] })
  const replay = await t.run(async ctx => {
    await ctx.db.patch(fixture.workspaceId, { billingUserId: fixture.payerB })
    return await ctx.db.insert('billingSettlements', {
      billingUserId: fixture.payerB,
      status: 'pending',
      operation: fixture.operation,
    })
  })
  await t.mutation(internal.domains.credits.settlementQueue.applyBatch, { ids: [replay] })
  await t.run(async ctx => {
    expect((await ctx.db.get(fixture.payerA))?.paidCreditBalanceMicroUsd).toBe(9_900)
    expect((await ctx.db.get(fixture.payerB))?.paidCreditBalanceMicroUsd).toBe(10_000)
    expect(await ctx.db.get(replay)).toBeNull()
    expect(
      (await ctx.db.query('creditTransactions').collect()).map(row => ({
        userId: row.userId,
        reference: row.reference,
        amount: row.amountMicroUsd,
      })),
    ).toEqual([{ userId: fixture.payerA, reference: fixture.operation.reference, amount: -100 }])
  })
})

test.each(['balanced', 'openai-frontier'] as const)(
  'missing %s generation pricing leaves one repairable failed settlement',
  async tier => {
    // A model the tier's flat rate was priced against, read from the tier rather
    // than named: only those need token telemetry to price. Any other model bills
    // what it cost upstream and settles without it.
    const [flatRateModel] = MODEL_SELECTIONS[tier].closure
    if (flatRateModel === undefined) throw new Error('Fixture selection must cover its model')
    const t = newTest()
    const fixture = await t.run(async ctx => {
      const userId = await ctx.db.insert('users', {
        email: 'pricing@example.test',
        createdAt: 1,
        updatedAt: 1,
        memberDirectoryRevision: 0,
        paidCreditBalanceMicroUsd: 10_000,
        monthlyCreditBalanceMicroUsd: 0,
      })
      const workspaceId = await ctx.db.insert('workspaces', {
        name: 'Pricing',
        slug: 'pricing',
        status: 'active',
        createdAt: 1,
        billingUserId: userId,
      })
      await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
      const generationId = await ctx.db.insert('gatewayGenerations', {
        workspaceId,
        userId,
        modality: 'text',
        model: flatRateModel,
        tier,
        billingMode: 'post_response',
        chargeToWorkspace: true,
        status: 'reconciling',
        createdAt: 1,
        updatedAt: 1,
        upstreamGenerationId: 'pricing',
        upstreamCostMicroUsd: 100,
      })
      const settlementId = await ctx.db.insert('billingSettlements', {
        billingUserId: userId,
        status: 'pending',
        operation: { kind: 'generation', generationId, occurredAt: 1 },
      })
      return { settlementId, generationId, userId }
    })
    await t.mutation(internal.domains.credits.settlementQueue.applyBatch, {
      ids: [fixture.settlementId],
    })
    await t.run(async ctx => {
      expect(await ctx.db.get(fixture.settlementId)).toMatchObject({ status: 'failed' })
      expect((await ctx.db.get(fixture.generationId))?.error).toContain('missing token telemetry')
      expect((await ctx.db.get(fixture.userId))?.paidCreditBalanceMicroUsd).toBe(10_000)
    })
  },
)

test('a failed item rolls back its debit without blocking later settlements or replay', async () => {
  const t = newTest()
  const fixture = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'settlement@example.test',
      createdAt: 1,
      updatedAt: 1,
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 10_000,
      monthlyCreditBalanceMicroUsd: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      name: 'Settlement',
      slug: 'settlement',
      status: 'active',
      createdAt: 1,
      billingUserId: userId,
    })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
    const operation = {
      kind: 'service' as const,
      workspaceId,
      userId,
      amountMicroUsd: 100,
      occurredAt: 1,
      metadata: { service: 'fixture', path: '/', method: 'POST' },
    }
    // A corrupt reference fails inside ledger insertion, after the wallet has
    // been patched. The batch must roll back that item's entire transaction.
    const badId = await ctx.db.insert('billingSettlements', {
      billingUserId: userId,
      status: 'pending',
      operation: { ...operation, reference: '' },
    })
    const goodId = await ctx.db.insert('billingSettlements', {
      billingUserId: userId,
      status: 'pending',
      operation: { ...operation, reference: 'good' },
    })
    return { userId, workspaceId, badId, goodId }
  })
  const batch = internal.domains.credits.settlementQueue.applyBatch
  await t.mutation(batch, { ids: [fixture.badId, fixture.goodId] })
  await t.run(async ctx => {
    expect((await ctx.db.get(fixture.userId))?.paidCreditBalanceMicroUsd).toBe(9_900)
    expect(await ctx.db.get(fixture.goodId)).toBeNull()
    const failed = (await ctx.db.get(fixture.badId))!
    expect(failed.status).toBe('failed')
    expect(failed.error).toBeTruthy()
    expect(
      (await ctx.db.query('creditTransactions').collect()).map(row => ({
        reference: row.reference,
        amount: row.amountMicroUsd,
      })),
    ).toEqual([{ reference: 'good', amount: -100 }])
    await ctx.db.patch(failed._id, {
      status: 'pending',
      error: undefined,
      operation: { ...failed.operation, reference: 'repaired' } as typeof failed.operation,
    })
  })
  await t.mutation(batch, { ids: [fixture.badId, fixture.goodId] })
  await t.mutation(batch, { ids: [fixture.badId, fixture.goodId] })
  expect(
    await t.run(async ctx => (await ctx.db.get(fixture.userId))?.paidCreditBalanceMicroUsd),
  ).toBe(9_800)
})

test('provider aliases settle delayed generations at fixed rates exactly once after a target upgrade', async () => {
  const t = newTest()
  const fixture = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'alias-pricing@example.test',
      createdAt: 1,
      updatedAt: 1,
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 500_000_000,
      monthlyCreditBalanceMicroUsd: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      name: 'Aliases',
      slug: 'aliases',
      status: 'active',
      createdAt: 1,
      billingUserId: userId,
    })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
    const generations = []
    for (const alias of Object.values(PROVIDER_MODEL_ALIASES)) {
      const generationId = await ctx.db.insert('gatewayGenerations', {
        workspaceId,
        userId,
        modality: 'text',
        model: alias.closure[0]!,
        tier: alias.id,
        billingMode: 'post_response',
        chargeToWorkspace: true,
        status: 'reconciling',
        createdAt: 1,
        updatedAt: 1,
        upstreamGenerationId: alias.id,
        upstreamCostMicroUsd: 100,
        upstreamMetadata: {
          usage: {
            uncachedInputTokens: 1_000_000,
            cachedInputTokens: 1_000_000,
            outputTokens: 1_000_000,
          },
        },
      })
      const settlementId = await ctx.db.insert('billingSettlements', {
        billingUserId: userId,
        status: 'pending',
        operation: { kind: 'generation', generationId, occurredAt: 1 },
      })
      generations.push({ generationId, settlementId, alias: alias.id, model: alias.closure[0]! })
    }
    return { userId, generations }
  })
  const original = Object.values(PROVIDER_MODEL_ALIASES).map(alias => ({
    alias,
    modelName: alias.modelName,
    gatewayModelId: alias.gatewayModelId,
    closure: alias.closure,
  }))
  try {
    for (const { alias } of original) {
      alias.modelName = 'future-model'
      alias.gatewayModelId = 'fixture/future-model'
      alias.closure = [...alias.closure, alias.gatewayModelId]
    }
    const batch = internal.domains.credits.settlementQueue.applyBatch
    const ids = fixture.generations.map(row => row.settlementId)
    await t.mutation(batch, { ids })
    await t.mutation(batch, { ids })
    await t.run(async ctx => {
      for (const row of fixture.generations) {
        expect(await ctx.db.get(row.generationId)).toMatchObject({
          status: 'settled',
          tier: row.alias,
          model: row.model,
          billedCostMicroUsd: 4_500_000,
        })
      }
      expect((await ctx.db.get(fixture.userId))?.paidCreditBalanceMicroUsd).toBe(
        500_000_000 - fixture.generations.length * 4_500_000,
      )
      expect(
        (await ctx.db.query('creditTransactions').collect())
          .map(row => row.amountMicroUsd)
          .sort((a, b) => a - b),
      ).toEqual(fixture.generations.map(() => -4_500_000))
    })
  } finally {
    for (const { alias, modelName, gatewayModelId, closure } of original)
      Object.assign(alias, { modelName, gatewayModelId, closure })
  }
})
