import { afterEach, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'

import { InternalAdminCleanupPreviewSchema } from '@repo/contract'

import schema from '../../schema'

const priorKey = process.env.DUET_API_INTERNAL_KEY
const fixtures: ReturnType<typeof convexTest>[] = []
afterEach(async () => {
  for (const t of fixtures.splice(0)) {
    await t.run(async ctx => {
      for (const row of await ctx.db.system.query('_scheduled_functions').collect())
        if (row.state.kind === 'pending') await ctx.scheduler.cancel(row._id)
    })
    await t.finishInProgressScheduledFunctions()
  }
  if (priorKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = priorKey
})
const query = (name: string) =>
  makeFunctionReference<'query'>(`domains/internalAdmin/cleanup:${name}`)
const mutation = (name: string) =>
  makeFunctionReference<'mutation'>(`domains/internalAdmin/cleanup:${name}`)
async function fixture() {
  process.env.DUET_API_INTERNAL_KEY = 'cleanup-test'
  const t = convexTest(schema, {
    '../../_generated/api.ts': async () => ({}),
    '../../domains/internalAdmin/cleanup.ts': () => import('./cleanup'),
  })
  fixtures.push(t)
  const seed = await t.run(async ctx => {
    const fields = {
      createdAt: 1,
      updatedAt: 1,
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
    }
    const actorId = await ctx.db.insert('users', { ...fields, email: 'operator@duet.so' })
    const userId = await ctx.db.insert('users', { ...fields, email: 'testperson@gmail.com' })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'sole',
      name: 'Sole workspace',
      billingUserId: userId,
      createdByUserId: userId,
      status: 'active',
      createdAt: 1,
    })
    const membershipId = await ctx.db.insert('workspaceMembers', {
      workspaceId,
      userId,
      role: 'owner',
    })
    return { actorId, userId, workspaceId, membershipId }
  })
  return {
    t,
    ...seed,
    access: { actorId: seed.actorId, internalKey: 'cleanup-test' },
    provenance: {
      actorId: seed.actorId,
      internalKey: 'cleanup-test',
      reason: 'Remove test account',
      requestId: 'cleanup-test-request',
      now: 10,
    },
  }
}

test('normalized email preview exposes the sole workspace and immutable membership without writing', async () => {
  const { t, access, userId, workspaceId, membershipId } = await fixture()
  const preview = await t.query(query('previewUserCleanup'), {
    ...access,
    identifier: 'Test.Person+alias@googlemail.com',
  })
  expect(InternalAdminCleanupPreviewSchema.omit({ auditId: true }).parse(preview)).toMatchObject({
    user: { userId, email: 'testperson@gmail.com' },
    canStart: true,
    workspaces: [
      {
        workspaceId,
        classification: 'sole_member_delete',
        memberCount: 1,
        targetMembershipId: membershipId,
        targetMembershipGenerationId: membershipId,
      },
    ],
  })
  expect(await t.run(ctx => ctx.db.query('internalAdminCleanupOperations').collect())).toEqual([])
  expect(await t.run(ctx => ctx.db.get(membershipId))).not.toBeNull()
})

test('self delete is rejected before an operation row is created', async () => {
  const { t, access, actorId } = await fixture()
  await expect(
    t.mutation(mutation('startUserCleanup'), {
      ...access,
      userId: actorId,
      requestId: 'self-delete-request',
      reason: 'Remove myself',
      now: 10,
    }),
  ).rejects.toThrow()
  expect(await t.run(ctx => ctx.db.query('internalAdminCleanupOperations').collect())).toEqual([])
})

test('invalid provenance is rejected before cleanup state is written', async () => {
  const { t, provenance, userId } = await fixture()
  await expect(
    t.mutation(mutation('startUserCleanup'), {
      ...provenance,
      reason: 'x',
      requestId: 'short',
      userId,
    }),
  ).rejects.toThrow()
  expect(await t.run(ctx => ctx.db.query('internalAdminCleanupOperations').collect())).toEqual([])
})

test('billing blocker is durable and retry re-evaluates the same target', async () => {
  const { t, provenance, userId } = await fixture()
  await t.run(async ctx => {
    const editor = await ctx.db.insert('users', {
      email: 'editor@example.test',
      createdAt: 1,
      updatedAt: 1,
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'blocked',
      name: 'Blocked',
      billingUserId: userId,
      status: 'active',
      createdAt: 1,
    })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId, role: 'owner' })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId: editor, role: 'editor' })
  })
  const started = (await t.mutation(mutation('startUserCleanup'), { ...provenance, userId })) as {
    status: string
    operationId: string
    resources: Array<{ status: string }>
  }
  expect(started.status).toBe('blocked')
  expect(started.resources.some(resource => resource.status === 'blocked')).toBe(true)
  const retried = (await t.mutation(mutation('retryCleanup'), {
    ...provenance,
    requestId: 'cleanup-retry-request',
    reason: 'Retry blocked cleanup',
    operationId: started.operationId,
  })) as { status: string }
  expect(retried.status).toBe('blocked')
  expect(await t.run(ctx => ctx.db.query('internalAdminCleanupOperations').collect())).toHaveLength(
    1,
  )
})
