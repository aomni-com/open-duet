import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import type { GenericMutationCtx } from 'convex/server'

import { defaultTierFor, raiseTier, type SubscriptionPlanId } from '@repo/contract'

import type { DataModel, Id } from '../convex/_generated/dataModel'
import {
  applyPaidSubscriptionInvoiceWithDb,
  applySubscriptionLifecycleWithDb,
} from '../convex/domains/credits/subscriptions'
import { workspaceDefaultTierProjection } from '../convex/domains/workspaces/tierPolicy'
import { raiseStoredTiersToPlanDefault } from '../convex/domains/workspaces/tierSweep'
import schema from '../convex/schema'

const CUSTOMER_ID = 'cus_tier_sweep'
const T0 = 1_900_000_000_000
const MONTH_MS = 30 * 24 * 60 * 60 * 1_000

test('a plan change raises a lower session to its configured default', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

  await t.run(async ctx => {
    const userId = await insertSubscriber(ctx, 'starter')
    const workspaceId = await insertWorkspace(ctx, userId)
    const sessionId = await insertSession(ctx, workspaceId, userId, 'balanced')

    const result = await applySubscriptionLifecycleWithDb(
      ctx,
      lifecycle({ plan: 'max' }),
      T0 + 1000,
    )
    expect(result).toEqual({ applied: true })
    expect((await ctx.db.get(userId))?.billing?.subscription?.plan).toBe('max')

    const session = await ctx.db.get(sessionId)
    expect(session?.lastModelId).toBe(
      raiseTier('balanced', defaultTierFor({ subscriber: true, plan: 'max' })),
    )
  })
})

test('a plan downgrade preserves Standard, Max, and unset selections', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

  await t.run(async ctx => {
    const userId = await insertSubscriber(ctx, 'max')
    const workspaceId = await insertWorkspace(ctx, userId)
    const balancedSession = await insertSession(ctx, workspaceId, userId, 'balanced')
    const frontierSession = await insertSession(ctx, workspaceId, userId, 'frontier')
    const unsetSession = await insertSession(ctx, workspaceId, userId, undefined)

    await applySubscriptionLifecycleWithDb(
      ctx,
      lifecycle({ plan: 'pro', priceId: 'price_pro' }),
      T0 + 1000,
    )

    expect((await ctx.db.get(balancedSession))?.lastModelId).toBe('balanced')
    expect((await ctx.db.get(frontierSession))?.lastModelId).toBe(
      raiseTier('balanced', defaultTierFor({ subscriber: true, plan: 'max' })),
    )
    expect((await ctx.db.get(unsetSession))?.lastModelId).toBeUndefined()
  })
})

test('a switch to starter preserves a stored higher selection', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

  await t.run(async ctx => {
    const userId = await insertSubscriber(ctx, 'pro')
    const workspaceId = await insertWorkspace(ctx, userId)
    const balancedSession = await insertSession(ctx, workspaceId, userId, 'balanced')

    await applySubscriptionLifecycleWithDb(
      ctx,
      lifecycle({ plan: 'starter', priceId: 'price_starter' }),
      T0 + 1000,
    )

    expect((await ctx.db.get(balancedSession))?.lastModelId).toBe('balanced')
  })
})

test('a stored workspace default rides the same only-raise rule; unset stays unset', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

  await t.run(async ctx => {
    const userId = await insertSubscriber(ctx, 'starter')
    const lowWorkspace = await insertWorkspace(ctx, userId)
    await ctx.db.patch(lowWorkspace, { defaultModelId: 'balanced' })
    const unsetWorkspace = await insertWorkspace(ctx, userId)

    await applySubscriptionLifecycleWithDb(ctx, lifecycle({ plan: 'max' }), T0 + 1000)

    expect((await ctx.db.get(lowWorkspace))?.defaultModelId).toBe(
      raiseTier('balanced', defaultTierFor({ subscriber: true, plan: 'max' })),
    )
    expect((await ctx.db.get(unsetWorkspace))?.defaultModelId).toBeUndefined()
  })
})

test('a first paid invoice raises trial-era sessions to the plan default', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

  await t.run(async ctx => {
    const userId = await insertSubscriber(ctx, null)
    const workspaceId = await insertWorkspace(ctx, userId)
    const sessionId = await insertSession(ctx, workspaceId, userId, 'balanced')

    await applyPaidSubscriptionInvoiceWithDb(
      ctx,
      paidInvoice({ plan: 'max', priceId: 'price_max' }),
      T0 + 1000,
      async () => {},
    )

    expect((await ctx.db.get(sessionId))?.lastModelId).toBe(
      raiseTier('balanced', defaultTierFor({ subscriber: true, plan: 'max' })),
    )
  })
})

test('the Standard floor raises Economy selections while preserving explicit higher choices', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const userId = await insertSubscriber(ctx, 'starter')
    const workspaceId = await insertWorkspace(ctx, userId)
    await ctx.db.patch(workspaceId, { defaultModelId: 'economy' })
    const economy = await insertSession(ctx, workspaceId, userId, 'economy')
    const higher = await insertSession(ctx, workspaceId, userId, 'frontier')
    await raiseStoredTiersToPlanDefault(ctx, userId, 'balanced')
    expect((await ctx.db.get(workspaceId))?.defaultModelId).toBe('balanced')
    expect((await ctx.db.get(economy))?.lastModelId).toBe('balanced')
    expect((await ctx.db.get(higher))?.lastModelId).toBe('frontier')
  })
})

function paidInvoice(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'invoice_paid' as const,
    eventId: 'evt_invoice_1',
    eventCreatedAt: T0 + 1000,
    invoiceId: 'in_1',
    invoiceCreatedAt: T0 + 1000,
    customerId: CUSTOMER_ID,
    subscriptionId: 'sub_1',
    priceId: 'price_pro',
    plan: 'pro' as const,
    periodStart: T0,
    periodEnd: T0 + MONTH_MS,
    billingReason: 'subscription_create' as const,
    ...overrides,
  }
}

function lifecycle(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'subscription_lifecycle' as const,
    eventId: 'evt_lifecycle_1',
    eventCreatedAt: T0 + 1000,
    customerId: CUSTOMER_ID,
    subscriptionId: 'sub_1',
    priceId: 'price_pro',
    plan: 'pro' as const,
    status: 'active' as const,
    currentPeriodStart: T0,
    currentPeriodEnd: T0 + MONTH_MS,
    cancelAtPeriodEnd: false,
    ...overrides,
  }
}

async function insertSubscriber(
  ctx: GenericMutationCtx<DataModel>,
  plan: SubscriptionPlanId | null,
): Promise<Id<'users'>> {
  return await ctx.db.insert('users', {
    email: 'tier-sweep@example.com',
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    memberDirectoryRevision: 0,
    billing: {
      stripeCustomerId: CUSTOMER_ID,
      ...(plan === null
        ? {}
        : {
            monthlyCreditExpiresAt: T0 + MONTH_MS,
            subscription: {
              stripeSubscriptionId: 'sub_1',
              stripePriceId: `price_${plan}`,
              plan,
              status: 'active' as const,
              currentPeriodStart: T0 - MONTH_MS,
              currentPeriodEnd: T0 + MONTH_MS,
              cancelAtPeriodEnd: false,
              latestLifecycleEventCreatedAt: T0,
              latestLifecycleEventId: 'evt_prior',
            },
          }),
    },
    createdAt: T0,
    updatedAt: T0,
  })
}

async function insertWorkspace(
  ctx: GenericMutationCtx<DataModel>,
  userId: Id<'users'>,
): Promise<Id<'workspaces'>> {
  return await ctx.db.insert('workspaces', {
    slug: 'tier-sweep',
    name: 'Tier sweep',
    status: 'active',
    billingUserId: userId,
    createdAt: T0,
  })
}

async function insertSession(
  ctx: GenericMutationCtx<DataModel>,
  workspaceId: Id<'workspaces'>,
  userId: Id<'users'>,
  lastModelId: string | undefined,
): Promise<Id<'agentSessions'>> {
  return await ctx.db.insert('agentSessions', {
    workspaceId,
    userId,
    audienceKind: 'workspace',
    turnStatus: 'complete',
    bucket: 'done',
    prompt: '',
    title: 'Fixture',
    titleOrigin: 'excerpt',
    titleStatus: 'complete',
    searchText: '',
    archiveState: 'active',
    visible: true,
    ...(lastModelId === undefined ? {} : { lastModelId }),
    lastEventSeq: 0,
    lastRunnerInputSeq: 0,
    runnerInputPending: false,
    lastDeliveredInputSeq: 0,
    createdAt: T0,
    updatedAt: T0,
  })
}

test('plan changes preserve and project explicit workspace and session aliases', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const userId = await insertSubscriber(ctx, 'starter')
    const workspaceId = await insertWorkspace(ctx, userId)
    await ctx.db.patch(workspaceId, { defaultModelId: 'openai-frontier' })
    const sessionId = await insertSession(ctx, workspaceId, userId, 'anthropic-max')
    await applySubscriptionLifecycleWithDb(ctx, lifecycle({ plan: 'max' }), T0 + 1000)
    expect((await ctx.db.get(sessionId))?.lastModelId).toBe('anthropic-max')
    const workspace = (await ctx.db.get(workspaceId))!
    const user = (await ctx.db.get(userId))!
    expect(workspace.defaultModelId).toBe('openai-frontier')
    expect(workspaceDefaultTierProjection(workspace, user, T0 + 1000)).toEqual({
      configured: 'openai-frontier',
      effective: 'openai-frontier',
    })
  })
})
