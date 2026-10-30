import { afterEach, beforeEach, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'

import type { Id } from '../../_generated/dataModel'
import schema from '../../schema'
import type { readInferenceMargin } from './marginRollup'

const INTERNAL_KEY = 'inference-margin-test'
const fold = makeFunctionReference<'mutation'>('domains/modelGateway/model:foldInferenceMargin')
const inferenceMargin = makeFunctionReference<
  'query',
  {
    internalKey: string
    actorId: Id<'users'>
    granularity: 'daily' | 'weekly' | 'monthly'
    now: number
    through?: number
  },
  Awaited<ReturnType<typeof readInferenceMargin>>
>('domains/internalAdmin/model:inferenceMargin')

// 2026-09-14 (Mon) and 2026-09-16 (Wed): one ISO week, one month, two days.
const MONDAY = Date.UTC(2026, 8, 14, 12)
const WEDNESDAY = Date.UTC(2026, 8, 16, 12)

let previousKey: string | undefined
beforeEach(() => {
  previousKey = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = INTERNAL_KEY
})
afterEach(() => {
  if (previousKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = previousKey
})

function harness() {
  return convexTest(schema, {
    '../../_generated/api.ts': async () => ({}),
    '../../domains/modelGateway/model.ts': () => import('./model'),
    '../../domains/internalAdmin/model.ts': () => import('../internalAdmin/model'),
  })
}

type Harness = ReturnType<typeof harness>

async function seedOperator(t: Harness) {
  return await t.run(async ctx => {
    const actorId = await ctx.db.insert('users', {
      email: 'operator@duet.so',
      name: 'Operator',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'payer',
      name: 'Payer',
      status: 'active',
      billingUserId: actorId,
      createdAt: 1,
    })
    return { actorId, workspaceId }
  })
}

async function seedGeneration(
  t: Harness,
  ids: { actorId: Id<'users'>; workspaceId: Id<'workspaces'> },
  row: {
    createdAt: number
    status?: 'settled' | 'released' | 'reconciling'
    tier?: 'frontier' | 'balanced'
    model?: string
    provider?: string
    routeSource?: 'vercel' | 'configured_upstream'
    upstreamCostMicroUsd?: number
    billedCostMicroUsd?: number
  },
) {
  await t.run(async ctx => {
    await ctx.db.insert('gatewayGenerations', {
      workspaceId: ids.workspaceId,
      userId: ids.actorId,
      modality: 'text',
      model: row.model ?? 'anthropic/claude-opus-5',
      ...(row.tier === undefined ? {} : { tier: row.tier }),
      billingMode: 'post_response',
      chargeToWorkspace: true,
      status: row.status ?? 'settled',
      upstreamGenerationId: `gen-${row.createdAt}-${Math.random()}`,
      ...(row.upstreamCostMicroUsd === undefined
        ? {}
        : { upstreamCostMicroUsd: row.upstreamCostMicroUsd }),
      ...(row.billedCostMicroUsd === undefined
        ? {}
        : { billedCostMicroUsd: row.billedCostMicroUsd }),
      upstreamMetadata: {
        provider: row.provider ?? 'anthropic',
        ...(row.routeSource === undefined ? {} : { routeSource: row.routeSource }),
        usage: { uncachedInputTokens: 100, cachedInputTokens: 50, outputTokens: 10 },
      },
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      settledAt: row.createdAt,
    })
  })
}

test('settled generations fold into every period once, and unsettled ones wait', async () => {
  const t = harness()
  const ids = await seedOperator(t)
  await seedGeneration(t, ids, {
    createdAt: MONDAY,
    tier: 'frontier',
    upstreamCostMicroUsd: 1_000_000,
    billedCostMicroUsd: 2_500_000,
  })
  await seedGeneration(t, ids, {
    createdAt: WEDNESDAY,
    tier: 'frontier',
    upstreamCostMicroUsd: 3_000_000,
    billedCostMicroUsd: 4_000_000,
  })
  await seedGeneration(t, ids, { createdAt: WEDNESDAY, status: 'reconciling', tier: 'frontier' })

  await foldHistory(t)
  // A second pass must find nothing new: a settlement is counted exactly once.
  await foldHistory(t)

  const read = (granularity: 'daily' | 'weekly' | 'monthly') =>
    t.query(inferenceMargin, {
      internalKey: INTERNAL_KEY,
      actorId: ids.actorId,
      granularity,
      now: WEDNESDAY,
    })

  const monthly = await read('monthly')
  expect(monthly.totals).toEqual({
    calls: 2,
    upstreamCostMicroUsd: 4_000_000,
    billedCostMicroUsd: 6_500_000,
  })
  expect(monthly.periods.map(p => [p.period, p.calls])).toEqual([['2026-09', 2]])

  const weekly = await read('weekly')
  expect(weekly.periods.map(p => [p.period, p.billedCostMicroUsd])).toEqual([
    ['2026-W38', 6_500_000],
  ])

  const daily = await read('daily')
  expect(daily.periods.map(p => [p.period, p.upstreamCostMicroUsd, p.billedCostMicroUsd])).toEqual([
    ['2026-09-16', 3_000_000, 4_000_000],
    ['2026-09-14', 1_000_000, 2_500_000],
  ])
})

test('fold completion drains a finite backlog into its independently known sums', async () => {
  const t = harness()
  const ids = await seedOperator(t)
  const backlog = 201
  for (let index = 0; index < backlog; index++) {
    await seedGeneration(t, ids, {
      createdAt: MONDAY + index,
      tier: 'balanced',
      upstreamCostMicroUsd: 10,
      billedCostMicroUsd: 30,
    })
  }

  await foldHistory(t)

  const monthly = await t.query(inferenceMargin, {
    internalKey: INTERNAL_KEY,
    actorId: ids.actorId,
    granularity: 'monthly',
    now: WEDNESDAY,
  })
  expect(monthly.totals).toEqual({
    calls: backlog,
    upstreamCostMicroUsd: backlog * 10,
    billedCostMicroUsd: backlog * 30,
  })
})

test('the window holds the latest periods and splits spend by tier and by model', async () => {
  const t = harness()
  const ids = await seedOperator(t)
  const emptyWindow = await t.query(inferenceMargin, {
    internalKey: INTERNAL_KEY,
    actorId: ids.actorId,
    granularity: 'daily',
    now: WEDNESDAY,
  })
  const olderAt = Date.parse(emptyWindow.window.start) - 1
  await seedGeneration(t, ids, {
    createdAt: olderAt,
    tier: 'frontier',
    upstreamCostMicroUsd: 7_000_000,
    billedCostMicroUsd: 9_000_000,
  })
  await seedGeneration(t, ids, {
    createdAt: WEDNESDAY,
    tier: 'frontier',
    model: 'openai/gpt-5.6-sol',
    provider: 'openai',
    upstreamCostMicroUsd: 2_000_000,
    billedCostMicroUsd: 5_000_000,
  })
  await seedGeneration(t, ids, {
    createdAt: WEDNESDAY,
    tier: 'balanced',
    model: 'zai/glm-5.2',
    provider: 'fireworks',
    upstreamCostMicroUsd: 500_000,
    billedCostMicroUsd: 400_000,
  })
  await seedGeneration(t, ids, {
    createdAt: WEDNESDAY,
    model: 'openai/gpt-image-2',
    provider: 'openai',
    upstreamCostMicroUsd: 100_000,
    billedCostMicroUsd: 100_000,
  })
  await foldHistory(t)

  const read = (granularity: 'daily' | 'monthly', actorId = ids.actorId) =>
    t.query(inferenceMargin, { internalKey: INTERNAL_KEY, actorId, granularity, now: WEDNESDAY })

  // The historical row sits just outside the returned daily window.
  const daily = await read('daily')
  expect(daily.periods.map(p => p.period)).toEqual(['2026-09-16'])
  expect(daily.periods[0]?.tiers).toEqual([
    { tier: 'frontier', calls: 1, upstreamCostMicroUsd: 2_000_000, billedCostMicroUsd: 5_000_000 },
    { tier: 'balanced', calls: 1, upstreamCostMicroUsd: 500_000, billedCostMicroUsd: 400_000 },
    { calls: 1, upstreamCostMicroUsd: 100_000, billedCostMicroUsd: 100_000 },
  ])
  expect(daily.models.map(m => [m.tier, m.model, m.provider])).toEqual([
    ['frontier', 'openai/gpt-5.6-sol', 'openai'],
    ['balanced', 'zai/glm-5.2', 'fireworks'],
    [undefined, 'openai/gpt-image-2', 'openai'],
  ])

  const history = await t.query(inferenceMargin, {
    internalKey: INTERNAL_KEY,
    actorId: ids.actorId,
    granularity: 'monthly',
    now: WEDNESDAY,
    through: olderAt,
  })
  expect(history.models).toContainEqual({
    tier: 'frontier',
    model: 'anthropic/claude-opus-5',
    provider: 'anthropic',
    routeSource: 'vercel',
    calls: 1,
    upstreamCostMicroUsd: 7_000_000,
    billedCostMicroUsd: 9_000_000,
  })

  const customer = await t.run(async ctx =>
    ctx.db.insert('users', {
      email: 'customer@example.com',
      name: 'Customer',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    }),
  )
  await expect(read('monthly', customer)).rejects.toThrow('internal_admin_required')
})

test('an operator pages to older windows and back to the current one', async () => {
  const t = harness()
  const ids = await seedOperator(t)
  const declaredWindow = await t.query(inferenceMargin, {
    internalKey: INTERNAL_KEY,
    actorId: ids.actorId,
    granularity: 'daily',
    now: WEDNESDAY,
  })
  const previousDay = Date.parse(declaredWindow.window.start) - 24 * 60 * 60 * 1000
  await seedGeneration(t, ids, {
    createdAt: previousDay,
    tier: 'frontier',
    upstreamCostMicroUsd: 7_000_000,
    billedCostMicroUsd: 9_000_000,
  })
  await seedGeneration(t, ids, {
    createdAt: WEDNESDAY,
    tier: 'frontier',
    upstreamCostMicroUsd: 2_000_000,
    billedCostMicroUsd: 5_000_000,
  })
  await foldHistory(t)
  const read = (through?: number) =>
    t.query(inferenceMargin, {
      internalKey: INTERNAL_KEY,
      actorId: ids.actorId,
      granularity: 'daily',
      now: WEDNESDAY,
      ...(through === undefined ? {} : { through }),
    })

  const current = await read()
  expect(current.window.end).toBe('2026-09-16')
  expect(current.periods.map(p => p.period)).toEqual(['2026-09-16'])
  expect(current.newerThrough).toBeUndefined()

  // The older window ends the day before the current one starts.
  const older = await read(current.olderThrough)
  expect(Date.parse(older.window.end) + 24 * 60 * 60 * 1000).toBe(Date.parse(current.window.start))
  expect(Date.parse(older.window.end) - Date.parse(older.window.start)).toBe(
    Date.parse(current.window.end) - Date.parse(current.window.start),
  )
  expect(older.periods.map(p => [p.period, p.upstreamCostMicroUsd])).toEqual([
    [new Date(previousDay).toISOString().slice(0, 10), 7_000_000],
  ])
  expect(older.totals.upstreamCostMicroUsd).toBe(7_000_000)

  // Newer from there reaches today again, and a future anchor is today.
  const newer = await read(older.newerThrough)
  expect(newer.window).toEqual(current.window)
  expect((await read(WEDNESDAY + 90 * 24 * 60 * 60 * 1000)).window).toEqual(current.window)
})

test('margin folds keep configured and Vercel route sources separate and promote legacy Vercel rows', async () => {
  const t = harness()
  const ids = await seedOperator(t)
  await seedGeneration(t, ids, {
    createdAt: WEDNESDAY,
    tier: 'frontier',
    model: 'openai/gpt-5.6-sol',
    provider: 'openai',
    routeSource: 'vercel',
    upstreamCostMicroUsd: 1_000_000,
    billedCostMicroUsd: 2_000_000,
  })
  await seedGeneration(t, ids, {
    createdAt: WEDNESDAY,
    tier: 'frontier',
    model: 'openai/gpt-5.6-sol',
    provider: 'openai',
    routeSource: 'configured_upstream',
    billedCostMicroUsd: 3_000_000,
  })
  await t.run(async ctx => {
    await ctx.db.insert('inferenceMarginRollups', {
      granularity: 'monthly',
      periodKey: '2026-09',
      tier: 'frontier',
      model: 'openai/gpt-5.6-sol',
      provider: 'openai',
      calls: 1,
      upstreamCostMicroUsd: 500_000,
      billedCostMicroUsd: 700_000,
      updatedAt: 1,
    })
  })
  await foldHistory(t)
  const read = await t.query(inferenceMargin, {
    internalKey: INTERNAL_KEY,
    actorId: ids.actorId,
    granularity: 'monthly',
    now: WEDNESDAY,
  })
  expect(read.models).toEqual([
    {
      tier: 'frontier',
      model: 'openai/gpt-5.6-sol',
      provider: 'openai',
      routeSource: 'vercel',
      calls: 2,
      upstreamCostMicroUsd: 1_500_000,
      billedCostMicroUsd: 2_700_000,
    },
    {
      tier: 'frontier',
      model: 'openai/gpt-5.6-sol',
      provider: 'openai',
      routeSource: 'configured_upstream',
      calls: 1,
      upstreamCostMicroUsd: 0,
      billedCostMicroUsd: 3_000_000,
    },
  ])
})

async function foldHistory(t: Harness): Promise<void> {
  const generations = await t.run(async ctx => ctx.db.query('gatewayGenerations').collect())
  await t.mutation(fold, { internalKey: INTERNAL_KEY })
  // Real scheduled continuations drain a bounded input. Batch size is private.
  for (let attempt = 0; attempt <= generations.length; attempt++) {
    await Bun.sleep(1)
    await t.finishInProgressScheduledFunctions()
    const remaining = await t.run(async ctx =>
      (await ctx.db.query('gatewayGenerations').collect()).filter(
        row => row.status === 'settled' && row.marginRolledUpAt === undefined,
      ),
    )
    if (remaining.length === 0) {
      await Bun.sleep(1)
      await t.finishInProgressScheduledFunctions()
      return
    }
  }
  throw new Error('Inference margin folding made no progress through its finite backlog')
}
