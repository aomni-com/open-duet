import { afterEach, beforeEach, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'

import { priceTierUsageMicroUsd } from '@repo/contract'

import schema from '../../schema'

const INTERNAL_KEY = 'routed-settlement-test'
const settle = makeFunctionReference<'mutation'>(
  'domains/modelGateway/model:settleRoutedGeneration',
)

beforeEach(() => {
  process.env.DUET_API_INTERNAL_KEY = INTERNAL_KEY
})
afterEach(() => {
  delete process.env.DUET_API_INTERNAL_KEY
})

test('settles routed usage directly with flat-rate billing and unknown upstream cost', async () => {
  const t = convexTest(schema, {
    '../../_generated/api.ts': async () => ({}),
    '../../domains/modelGateway/model.ts': () => import('./model'),
    '../../domains/credits/settlementQueue.ts': () => import('../credits/settlementQueue'),
  })
  const componentDir =
    dirname(fileURLToPath(import.meta.resolve('@convex-dev/batch-worker/package.json'))) +
    '/src/component'
  const componentSchema = await import(`${componentDir}/schema.ts`)
  t.registerComponent('billingWorker', componentSchema.default, {
    './_generated/api.ts': () => import(`${componentDir}/_generated/api.ts`),
    './future.ts': () => import(`${componentDir}/future.ts`),
    './kick.ts': () => import(`${componentDir}/kick.ts`),
    './lib.ts': () => import(`${componentDir}/lib.ts`),
    './logging.ts': () => import(`${componentDir}/logging.ts`),
    './loop.ts': () => import(`${componentDir}/loop.ts`),
    './monitor.ts': () => import(`${componentDir}/monitor.ts`),
    './shared.ts': () => import(`${componentDir}/shared.ts`),
  })
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'routed@example.test',
      createdAt: 1,
      updatedAt: 1,
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 20_000_000,
      monthlyCreditBalanceMicroUsd: 0,
      billing: { trialExpiresAt: 100_000 },
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'routed',
      name: 'Routed',
      status: 'active',
      billingUserId: userId,
      createdAt: 1,
    })
    await ctx.db.insert('workspaceMembers', { userId, workspaceId, role: 'owner' })
    const generationId = await ctx.db.insert('gatewayGenerations', {
      workspaceId,
      userId,
      modality: 'text',
      model: 'openai/gpt-5.6-sol',
      tier: 'balanced',
      billingMode: 'post_response',
      chargeToWorkspace: true,
      status: 'forwarding',
      createdAt: 10,
      updatedAt: 10,
    })
    return { userId, workspaceId, generationId }
  })
  const usage = { uncachedInputTokens: 100, cachedInputTokens: 20, outputTokens: 10 }
  await t.mutation(settle, {
    internalKey: INTERNAL_KEY,
    generationId: ids.generationId,
    upstreamGenerationId: 'chatcmpl-routed-1',
    provider: 'openai',
    usage,
    now: 20,
  })
  const generation = await t.run(ctx => ctx.db.get(ids.generationId))
  expect(generation).toMatchObject({
    status: 'reconciling',
    upstreamGenerationId: 'chatcmpl-routed-1',
    upstreamMetadata: { provider: 'openai', routeSource: 'configured_upstream', usage },
  })
  expect(generation?.upstreamCostMicroUsd).toBeUndefined()
  const pending = await t.run(ctx => ctx.db.query('billingSettlements').collect())
  expect(pending).toContainEqual(
    expect.objectContaining({
      status: 'pending',
      operation: { kind: 'generation', generationId: ids.generationId, occurredAt: 20 },
    }),
  )
  await t.mutation(
    makeFunctionReference<'mutation'>('domains/credits/settlementQueue:applyBatch'),
    {
      ids: [pending[0]!._id],
    },
  )
  const expected = priceTierUsageMicroUsd('balanced', usage)
  const settled = await t.run(ctx => ctx.db.get(ids.generationId))
  expect(settled).toMatchObject({ status: 'settled', billedCostMicroUsd: expected })
  expect(await t.run(ctx => ctx.db.query('creditTransactions').collect())).toContainEqual(
    expect.objectContaining({
      type: 'usage',
      amountMicroUsd: -expected,
      reference: 'ai_generation:chatcmpl-routed-1',
    }),
  )
})
