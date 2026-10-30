import { afterEach, beforeEach, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import type { BillingMode, GenerationModality } from '@repo/contract'

import type { MutationCtx } from '../../_generated/server'
import schema from '../../schema'
import { gatewayPreflightImpl } from './preflight'

const INTERNAL_KEY = 'workspace-selection-test'
const HASHED_KEY = 'a'.repeat(64)
let previousInternalKey: string | undefined
beforeEach(() => {
  previousInternalKey = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = INTERNAL_KEY
})
afterEach(() => {
  if (previousInternalKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = previousInternalKey
})

function newTest() {
  return convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
}

function preflight(ctx: MutationCtx, workspaceSlug?: string) {
  return gatewayPreflightImpl(ctx, {
    internalKey: INTERNAL_KEY,
    hashedKey: HASHED_KEY,
    workspaceSlug,
    requestKind: 'catalog',
    modality: 'text',
    now: 1000,
  })
}

async function fixture(ctx: MutationCtx) {
  const userId = await ctx.db.insert('users', {
    email: 'model-workspace@example.test',
    createdAt: 1,
    updatedAt: 1,
    memberDirectoryRevision: 0,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
  })
  const first = await ctx.db.insert('workspaces', {
    slug: 'first',
    name: 'First',
    status: 'active',
    billingUserId: userId,
    createdAt: 1,
    onboardedAt: 1,
  })
  const second = await ctx.db.insert('workspaces', {
    slug: 'second',
    name: 'Second',
    status: 'active',
    billingUserId: userId,
    createdAt: 1,
    onboardedAt: 1,
  })
  for (const workspaceId of [first, second]) {
    await ctx.db.insert('workspaceMembers', { userId, workspaceId, role: 'editor' })
  }
  await ctx.db.insert('apiKeys', {
    kind: 'user',
    userId,
    hashedKey: HASHED_KEY,
    prefix: 'duet_sk_fixture',
  })
  return { first, second, userId }
}

async function fundedFixture(ctx: MutationCtx) {
  const result = await fixture(ctx)
  await ctx.db.patch(result.userId, {
    paidCreditBalanceMicroUsd: 10_000_000,
    billing: { trialExpiresAt: 10_000 },
  })
  const membership = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_workspace_and_user', q =>
      q.eq('workspaceId', result.first).eq('userId', result.userId),
    )
    .unique()
  await ctx.db.patch(membership!._id, { role: 'owner' })
  return result
}

function generationPreflight(
  ctx: MutationCtx,
  modality: GenerationModality = 'text',
  billingMode: BillingMode = 'post_response',
) {
  return gatewayPreflightImpl(
    ctx,
    {
      internalKey: INTERNAL_KEY,
      hashedKey: HASHED_KEY,
      workspaceSlug: 'first',
      requestKind: 'generation',
      modality,
      model: 'upstream/new-model',
      billingMode,
      estimateMicroUsd: 2_000_000,
      now: 1000,
    },
    { entries: [] },
  )
}

test('uncatalogued text creates a chargeable generation without a tier or an upfront hold', async () => {
  await newTest().run(async ctx => {
    const { first, userId } = await fundedFixture(ctx)
    const result = await generationPreflight(ctx)
    expect(result).toMatchObject({ proceed: true, workspaceId: first, userId })
    if (!result.proceed || !('generationId' in result)) throw new Error('Generation was refused')
    expect(await ctx.db.get(result.generationId!)).toMatchObject({
      workspaceId: first,
      userId,
      model: 'upstream/new-model',
      modality: 'text',
      billingMode: 'post_response',
      chargeToWorkspace: true,
      status: 'forwarding',
    })
    expect((await ctx.db.get(result.generationId!))?.tier).toBeUndefined()
    expect(await ctx.db.query('creditTransactions').collect()).toEqual([])
    expect((await ctx.db.get(userId))?.paidCreditBalanceMicroUsd).toBe(10_000_000)
  })
})

test('uncatalogued native media uses the existing credit hold', async () => {
  for (const modality of ['image', 'video'] as const) {
    await newTest().run(async ctx => {
      const { first, userId } = await fundedFixture(ctx)
      const result = await generationPreflight(ctx, modality, 'reservation')
      expect(result).toMatchObject({ proceed: true, workspaceId: first, userId })
      if (!result.proceed || !('generationId' in result)) throw new Error('Generation was refused')
      expect(await ctx.db.get(result.generationId!)).toMatchObject({
        model: 'upstream/new-model',
        modality,
        billingMode: 'reservation',
        chargeToWorkspace: true,
        reservationId: result.reservationId,
      })
      expect(await ctx.db.query('creditTransactions').collect()).toMatchObject([
        {
          workspaceId: first,
          amountMicroUsd: -2_000_000,
          type: 'reservation',
          reference: result.reservationId,
          metadata: { status: 'held', estimateMicroUsd: 2_000_000 },
        },
      ])
      expect((await ctx.db.get(userId))?.paidCreditBalanceMicroUsd).toBe(8_000_000)
    })
  }
})

test('uncatalogued requests still enforce credit and spending caps without creating a generation', async () => {
  await newTest().run(async ctx => {
    const { first, userId } = await fundedFixture(ctx)
    await ctx.db.patch(first, { billing: { maxMonthlySpendMicroUsd: 1_000_000 } })
    expect(await generationPreflight(ctx)).toMatchObject({
      proceed: false,
      block: { status: 402, body: { code: 'monthly_cap', tier: 'workspace' } },
    })
    await ctx.db.patch(first, { billing: {} })
    await ctx.db.patch(userId, { paidCreditBalanceMicroUsd: 1_500_000 })
    expect(await generationPreflight(ctx, 'image', 'reservation')).toMatchObject({
      proceed: false,
      block: { status: 402, body: { code: 'insufficient_credits' } },
    })
    expect(await ctx.db.query('gatewayGenerations').collect()).toEqual([])
    expect(await ctx.db.query('creditTransactions').collect()).toEqual([])
    expect((await ctx.db.get(userId))?.paidCreditBalanceMicroUsd).toBe(1_500_000)
  })
})

test('one user key explicitly selects either live workspace', async () => {
  await newTest().run(async ctx => {
    const { first, second, userId } = await fixture(ctx)
    for (const [workspaceSlug, workspaceId] of [
      ['first', first],
      ['second', second],
    ] as const) {
      expect(await preflight(ctx, workspaceSlug)).toEqual({
        proceed: true,
        workspaceId,
        workspaceSlug,
        userId,
      })
    }
  })
})

test('model gateway refuses an incomplete workspace after scope resolution', async () => {
  await newTest().run(async ctx => {
    const { first } = await fixture(ctx)
    await ctx.db.patch(first, { onboardedAt: undefined })

    expect(await preflight(ctx, 'first')).toEqual({
      proceed: false,
      block: {
        status: 409,
        body: {
          error: 'onboarding_required',
          code: 'onboarding_required',
          onboardingUrl: '/w/first/onboarding',
        },
      },
    })
    expect(await ctx.db.query('gatewayGenerations').collect()).toEqual([])
  })
})

test('bound VM credentials cannot redirect billing with a conflicting selector', async () => {
  await newTest().run(async ctx => {
    const { first, userId } = await fixture(ctx)
    const key = await ctx.db.query('apiKeys').unique()
    await ctx.db.delete(key!._id)
    await ctx.db.insert('apiKeys', {
      kind: 'system_vm',
      userId,
      hashedKey: HASHED_KEY,
      prefix: 'duet_sk_fixture',
      scopes: ['ws:first:services'],
      workspaceIds: [first],
    })
    expect(await preflight(ctx, 'second')).toMatchObject({
      proceed: false,
      block: { status: 403, body: { code: 'workspace_mismatch' } },
    })
    expect(await preflight(ctx)).toMatchObject({ proceed: true, workspaceId: first })
    expect(await preflight(ctx, 'first')).toMatchObject({ proceed: true, workspaceId: first })
  })
})

test('human selection requires current spending membership and never falls back to another workspace', async () => {
  await newTest().run(async ctx => {
    const { first, second, userId } = await fixture(ctx)
    const membership = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q => q.eq('workspaceId', second).eq('userId', userId))
      .unique()
    await ctx.db.patch(membership!._id, { role: 'viewer' })
    expect(await preflight(ctx, 'second')).toMatchObject({
      proceed: false,
      block: { status: 403, body: { code: 'insufficient_scope', scope: 'ws:second:services' } },
    })
    await ctx.db.delete(membership!._id)
    expect(await preflight(ctx, 'second')).toMatchObject({
      proceed: false,
      block: { status: 403, body: { code: 'insufficient_scope' } },
    })
    expect(await preflight(ctx)).toMatchObject({
      proceed: false,
      block: { status: 403, body: { code: 'workspace_ambiguous' } },
    })
    expect(await preflight(ctx, 'missing')).toMatchObject({
      proceed: false,
      block: { status: 403, body: { code: 'insufficient_scope', scope: 'ws:missing:services' } },
    })
    expect(await ctx.db.query('gatewayGenerations').collect()).toEqual([])
    expect(await ctx.db.query('rateLimits').collect()).toEqual([])
    expect((await ctx.db.get(first))?.billingUserId).toBe(userId)
    expect((await ctx.db.get(userId))?.paidCreditBalanceMicroUsd).toBe(0)
    await ctx.db.insert('workspaceMembers', { workspaceId: second, userId, role: 'editor' })
    expect(await preflight(ctx, 'second')).toMatchObject({ proceed: true, workspaceId: second })
  })
})
