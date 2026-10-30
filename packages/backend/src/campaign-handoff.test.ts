import { afterEach, beforeEach, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { convexTest } from 'convex-test'
import {
  componentsGeneric,
  queryGeneric,
  type FunctionReference,
  type GenericMutationCtx,
} from 'convex/server'

import type { DataModel, Id } from '../convex/_generated/dataModel'
import { campaigns } from '../convex/domains/campaigns/config'
import { resolveCampaignHandoffAttribution } from '../convex/domains/campaigns/handoff'
import { bootstrapUser } from '../convex/domains/invitations/model'
import { mintHashedToken } from '../convex/domains/shared/hashedToken'
import schema from '../convex/schema'

const savedEnv = { key: process.env.POSTHOG_API_KEY, host: process.env.POSTHOG_HOST }
const fixtures: Array<ReturnType<typeof convexTest>> = []
const fixtureCampaign = { enabled: true, attributionWindowMs: 20_000 }
beforeEach(() => {
  Object.assign(campaigns, { 'handoff-fixture': fixtureCampaign, 'handoff-later': fixtureCampaign })
  process.env.POSTHOG_API_KEY = 'handoff-fixture-key'
  process.env.POSTHOG_HOST = 'https://posthog-fixture.test'
})
afterEach(async () => {
  for (const t of fixtures.splice(0)) {
    await t.run(async ctx => {
      for (const scheduled of await ctx.db.system.query('_scheduled_functions').collect())
        if (scheduled.state.kind === 'pending') await ctx.scheduler.cancel(scheduled._id)
    })
    await t.finishInProgressScheduledFunctions()
  }
  Reflect.deleteProperty(campaigns, 'handoff-fixture')
  Reflect.deleteProperty(campaigns, 'handoff-later')
  if (savedEnv.key === undefined) delete process.env.POSTHOG_API_KEY
  else process.env.POSTHOG_API_KEY = savedEnv.key
  if (savedEnv.host === undefined) delete process.env.POSTHOG_HOST
  else process.env.POSTHOG_HOST = savedEnv.host
})
const jobs = componentsGeneric().actionRetrier!.fixture!.jobs! as FunctionReference<'query'>
async function signupEvents(ctx: GenericMutationCtx<DataModel>) {
  const rows = (await ctx.runQuery(jobs, {})) as Array<{
    functionArgs: { events?: Array<Record<string, unknown>> }
  }>
  return rows
    .flatMap(row => row.functionArgs.events ?? [])
    .filter(event => event.name === 'user.signed_up')
}
async function fixture() {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  fixtures.push(t)
  const directory = dirname(
    fileURLToPath(import.meta.resolve('@convex-dev/action-retrier/package.json')),
  )
  const component = `${directory}/src/component`
  const { default: componentSchema } = await import(`${component}/schema.ts`)
  t.registerComponent('actionRetrier', componentSchema, {
    './_generated/api.ts': () => import(`${component}/_generated/api.js`),
    './public.ts': () => import(`${component}/public.ts`),
    './run.ts': () => import(`${component}/run.ts`),
    './fixture.ts': async () => ({
      jobs: queryGeneric({ args: {}, handler: ctx => ctx.db.query('runs').collect() }),
    }),
  })
  return t
}

test('a handoff resolves only a live signup attribution row', async () => {
  const t = await fixture()

  await t.run(async ctx => {
    const attributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug: 'handoff-fixture',
      action: 'signup',
      signals: {},
      createdAt: 1_000,
      expiresAt: 20_000,
    })
    const scanAttributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug: 'handoff-fixture',
      action: 'scan',
      signals: {},
      createdAt: 1_000,
      expiresAt: 20_000,
    })

    const resolved = await resolveCampaignHandoffAttribution(ctx, attributionId, 10_000)
    expect(resolved?._id).toBe(attributionId)
    // The row's fixed expiry is authoritative: at expiry the handoff dies.
    expect(await resolveCampaignHandoffAttribution(ctx, attributionId, 20_000)).toBeNull()
    // Only signup-action journeys are claimable.
    expect(await resolveCampaignHandoffAttribution(ctx, scanAttributionId, 10_000)).toBeNull()
    // Garbage and non-attribution IDs resolve to nothing rather than throwing.
    expect(await resolveCampaignHandoffAttribution(ctx, 'not-an-id', 10_000)).toBeNull()
  })
})

test('existing membership bootstrap binds acquisition and emits signup before returning', async () => {
  const t = await fixture()

  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'existing@example.com',
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'existing',
      name: 'Existing',
      status: 'active',
      billingUserId: userId,
      createdAt: 1_000,
    })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
    const attributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug: 'handoff-fixture',
      action: 'signup',
      signals: {},
      createdAt: 1_000,
      expiresAt: 20_000,
    })
    const acquisition = attributionId

    expect(
      await bootstrapUser(
        ctx,
        userId,
        { acquisition },
        {
          now: 10_000,
        },
      ),
    ).toEqual({ workspaceId, invited: false })
    expect(await ctx.db.get(userId)).toEqual(
      expect.objectContaining({
        acquisitionAttributionId: attributionId,
        signupProcessedAt: 10_000,
      }),
    )
    expect(await signupEvents(ctx)).toEqual([
      expect.objectContaining({
        id: `signup:${userId}`,
        name: 'user.signed_up',
        userId,
        attributionId,
      }),
    ])
  })
})

test('invite bootstrap finalizes acquisition before returning the invited workspace', async () => {
  const inviteToken = 'invite-token'
  const t = await fixture()

  await t.run(async ctx => {
    const ownerId = await insertUser(ctx, 'owner@example.com')
    const inviteeId = await insertUser(ctx, 'invitee@example.com')
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'invited',
      name: 'Invited',
      status: 'active',
      billingUserId: ownerId,
      createdAt: 1_000,
    })
    await ctx.db.insert('workspaceMembers', {
      workspaceId,
      userId: ownerId,
      role: 'owner',
    })
    await ctx.db.insert('workspaceInvites', {
      workspaceId,
      email: 'invitee@example.com',
      role: 'editor',
      ...(await mintHashedToken(inviteToken, 10)),
      activeKey: `${workspaceId}:invitee@example.com`,
      inviterUserId: ownerId,
      expiresAt: Date.now() + 60_000,
      createdAt: 1_000,
    })
    const attributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug: 'handoff-fixture',
      action: 'signup',
      signals: {},
      createdAt: 1_000,
      expiresAt: 20_000,
    })
    const acquisition = attributionId

    expect(
      await bootstrapUser(
        ctx,
        inviteeId,
        { invite: inviteToken, acquisition },
        {
          now: 10_000,
        },
      ),
    ).toEqual({ workspaceId, invited: true })
    expect(await ctx.db.get(inviteeId)).toEqual(
      expect.objectContaining({
        acquisitionAttributionId: attributionId,
        signupProcessedAt: 10_000,
      }),
    )
    expect(await signupEvents(ctx)).toEqual([
      expect.objectContaining({
        id: `signup:${inviteeId}`,
        name: 'user.signed_up',
        userId: inviteeId,
        attributionId,
      }),
    ])
  })
})

test('invite failure rolls back signup, acquisition claim, and emitted event work', async () => {
  const t = await fixture()
  let userId: Id<'users'> | undefined
  let attributionId: Id<'campaignAttributions'> | undefined
  let acquisition = ''

  await t.run(async ctx => {
    userId = await insertUser(ctx, 'failed-invite@example.com')
    attributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug: 'handoff-fixture',
      action: 'signup',
      signals: {},
      createdAt: 1_000,
      expiresAt: 20_000,
    })
    acquisition = attributionId
  })
  if (userId === undefined || attributionId === undefined) throw new Error('Fixture setup failed')
  const failedUserId = userId
  const failedAttributionId = attributionId

  await expect(
    t.run(async ctx => {
      await bootstrapUser(
        ctx,
        failedUserId,
        { invite: 'invalid-invite', acquisition },
        {
          now: 10_000,
        },
      )
    }),
  ).rejects.toThrow('Invite could not be accepted')

  await t.run(async ctx => {
    expect(await ctx.db.get(failedUserId)).not.toHaveProperty('signupProcessedAt')
    expect(await ctx.db.get(failedUserId)).not.toHaveProperty('acquisitionAttributionId')
    expect(await ctx.db.get(failedAttributionId)).not.toHaveProperty('acquiredByUserId')
    expect(await signupEvents(ctx)).toEqual([])
  })
})

test('one attribution handoff cannot become acquisition for two users', async () => {
  const t = await fixture()

  await t.run(async ctx => {
    const firstUserId = await insertUser(ctx, 'first@example.com')
    const secondUserId = await insertUser(ctx, 'second@example.com')
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'shared',
      name: 'Shared',
      status: 'active',
      billingUserId: firstUserId,
      createdAt: 1_000,
    })
    await ctx.db.insert('workspaceMembers', {
      workspaceId,
      userId: firstUserId,
      role: 'owner',
    })
    await ctx.db.insert('workspaceMembers', {
      workspaceId,
      userId: secondUserId,
      role: 'viewer',
    })
    const attributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug: 'handoff-fixture',
      action: 'signup',
      signals: {},
      createdAt: 1_000,
      expiresAt: 20_000,
    })
    const acquisition = attributionId
    const options = {
      now: 10_000,
    }

    await bootstrapUser(ctx, firstUserId, { acquisition }, options)
    await bootstrapUser(ctx, secondUserId, { acquisition }, options)

    expect(await ctx.db.get(firstUserId)).toEqual(
      expect.objectContaining({ acquisitionAttributionId: attributionId }),
    )
    expect(await ctx.db.get(secondUserId)).not.toHaveProperty('acquisitionAttributionId')
    expect(await ctx.db.get(secondUserId)).toEqual(
      expect.objectContaining({ signupProcessedAt: 10_000 }),
    )
    expect(await ctx.db.get(attributionId)).toEqual(
      expect.objectContaining({ acquiredByUserId: firstUserId }),
    )
  })
})

test('the first later valid handoff fills missing acquisition without replaying signup', async () => {
  const t = await fixture()

  await t.run(async ctx => {
    const userId = await insertUser(ctx, 'later-attribution@example.com')
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'later-attribution',
      name: 'Later Attribution',
      status: 'active',
      billingUserId: userId,
      createdAt: 1_000,
    })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
    const attributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug: 'handoff-fixture',
      action: 'signup',
      signals: {},
      createdAt: 1_000,
      expiresAt: 20_000,
    })
    const acquisition = attributionId
    const options = {
      now: 10_000,
    }

    await bootstrapUser(ctx, userId, {}, options)
    await bootstrapUser(ctx, userId, { acquisition }, options)

    expect(await ctx.db.get(userId)).toEqual(
      expect.objectContaining({
        acquisitionAttributionId: attributionId,
        signupProcessedAt: 10_000,
      }),
    )
    expect(await signupEvents(ctx)).toEqual([
      expect.objectContaining({ id: `signup:${userId}`, name: 'user.signed_up', userId }),
    ])
  })
})

test('a later valid handoff cannot replace or claim beyond existing acquisition', async () => {
  const t = await fixture()

  await t.run(async ctx => {
    const userId = await insertUser(ctx, 'immutable@example.com')
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'immutable',
      name: 'Immutable',
      status: 'active',
      billingUserId: userId,
      createdAt: 1_000,
    })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
    const firstAttributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug: 'handoff-fixture',
      action: 'signup',
      signals: {},
      createdAt: 1_000,
      expiresAt: 20_000,
    })
    const laterAttributionId = await ctx.db.insert('campaignAttributions', {
      campaignSlug: 'handoff-later',
      action: 'signup',
      signals: {},
      createdAt: 2_000,
      expiresAt: 20_000,
    })
    const options = {
      now: 10_000,
    }

    await bootstrapUser(ctx, userId, { acquisition: firstAttributionId }, options)
    await bootstrapUser(ctx, userId, { acquisition: laterAttributionId }, options)

    expect(await ctx.db.get(userId)).toEqual(
      expect.objectContaining({ acquisitionAttributionId: firstAttributionId }),
    )
    expect(await ctx.db.get(laterAttributionId)).not.toHaveProperty('acquiredByUserId')
  })
})

test('invalid acquisition is ignored while signup remains exactly once', async () => {
  const t = await fixture()

  await t.run(async ctx => {
    const userId = await insertUser(ctx, 'invalid-acquisition@example.com')
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'invalid-acquisition',
      name: 'Invalid Acquisition',
      status: 'active',
      billingUserId: userId,
      createdAt: 1_000,
    })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
    const options = {
      now: 10_000,
    }

    await bootstrapUser(ctx, userId, { acquisition: 'v1.tampered.signature' }, options)
    await bootstrapUser(ctx, userId, { acquisition: 'v1.tampered.signature' }, options)

    const user = await ctx.db.get(userId)
    expect(user).toEqual(expect.objectContaining({ signupProcessedAt: 10_000 }))
    expect(user).not.toHaveProperty('acquisitionAttributionId')
    expect(await signupEvents(ctx)).toEqual([
      expect.objectContaining({
        id: `signup:${userId}`,
        name: 'user.signed_up',
        userId,
      }),
    ])
  })
})

async function insertUser(ctx: GenericMutationCtx<DataModel>, email: string) {
  return await ctx.db.insert('users', {
    email,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
    memberDirectoryRevision: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  })
}
