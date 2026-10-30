import { describe, expect, test } from 'bun:test'

import { convexTest, type TestConvexForDataModel } from 'convex-test'
import type { GenericMutationCtx } from 'convex/server'

import type { DataModel, Id } from '../convex/_generated/dataModel'
import {
  MEMBER_DIRECTORY_REFRESH_BATCH_SIZE,
  refreshMemberDirectoryBatch,
  updateCanonicalUserIdentity,
} from '../convex/domains/users/directoryRefresh'
import { MAX_DISPLAY_NAME_LENGTH, MAX_EMAIL_LENGTH } from '../convex/domains/users/identity'
import { writeMemberDirectoryEntry } from '../convex/domains/workspaces/memberDirectory'
import schema from '../convex/schema'

const PAGE_SIZE = MEMBER_DIRECTORY_REFRESH_BATCH_SIZE

type MutationCtx = GenericMutationCtx<DataModel>
const MODULES = {
  '../convex/_generated/api.ts': async () => ({}),
  '../convex/domains/users/directoryRefresh.ts': async () =>
    await import('../convex/domains/users/directoryRefresh'),
}

describe('member-directory profile propagation', () => {
  test('strict user storage rejects an uninitialized directory revision', async () => {
    const t = convexTest(schema, MODULES)
    await expect(
      t.run(
        async ctx =>
          await ctx.db.insert('users', {
            email: 'missing-revision@example.com',
            createdAt: 1,
            updatedAt: 1,
            paidCreditBalanceMicroUsd: 0,
            monthlyCreditBalanceMicroUsd: 0,
          } as never),
      ),
    ).rejects.toThrow('memberDirectoryRevision')
  })

  test('commits the canonical profile before a multi-page directory converges', async () => {
    const t = convexTest(schema, MODULES)
    const userId = await t.run(async ctx => await seedUserMemberships(ctx, PAGE_SIZE + 1))

    await t.run(async ctx => await changeIdentity(ctx, userId, 1, 'Newest Name'))
    const before = await t.run(async ctx => ({
      user: await ctx.db.get(userId),
      names: await directoryNames(ctx, userId),
    }))
    expect(before.user?.name).toBe('Newest Name')
    expect(new Set(before.names)).toEqual(new Set(['Original Name']))

    const first = await runCurrentBatch(t, userId)
    expect(first.status).toBe('pending')
    expect(
      (await t.run(async ctx => await directoryNames(ctx, userId))).filter(
        name => name === 'Newest Name',
      ),
    ).toHaveLength(PAGE_SIZE)

    expect((await runCurrentBatch(t, userId)).status).toBe('complete')
    await expectExactIdentity(t, userId, PAGE_SIZE + 1, 'Newest Name', 'person@example.com')
  })

  test('uses bounded pages at empty, full, and multiple-page boundaries', async () => {
    for (const [membershipCount, expectedBatches] of [
      [0, 1],
      [1, 1],
      [PAGE_SIZE, 1],
      [5 * PAGE_SIZE + 1, 6],
    ] as const) {
      const t = convexTest(schema, MODULES)
      const userId = await t.run(async ctx => await seedUserMemberships(ctx, membershipCount))
      await t.run(async ctx => await changeIdentity(ctx, userId, 1, `Bounded ${membershipCount}`))

      let batches = 0
      while (batches < expectedBatches) {
        batches += 1
        const result = await runCurrentBatch(t, userId)
        if (result.status === 'complete') break
        expect(result.status).toBe('pending')
      }
      expect(batches).toBe(expectedBatches)
      await expectExactIdentity(
        t,
        userId,
        membershipCount,
        `Bounded ${membershipCount}`,
        'person@example.com',
      )
    }
  })

  test('a newer profile revision resets the checkpoint and makes the older worker stale', async () => {
    const t = convexTest(schema, MODULES)
    const userId = await t.run(async ctx => await seedUserMemberships(ctx, PAGE_SIZE + 1))
    await t.run(async ctx => await changeIdentity(ctx, userId, 1, 'Intermediate Name'))
    const first = await runCurrentBatch(t, userId)
    if (first.status !== 'pending') throw new Error('first revision did not checkpoint')

    await t.run(async ctx => await changeIdentity(ctx, userId, 2, 'Final Name'))
    const stale = await t.run(
      async ctx =>
        await refreshMemberDirectoryBatch(ctx, {
          userId,
          revision: 1,
          afterMembershipId: first.afterMembershipId,
        }),
    )
    expect(stale).toEqual({ status: 'stale' })

    for (let batch = 0; batch < 2; batch += 1) {
      if ((await runCurrentBatch(t, userId)).status === 'complete') break
    }
    await expectExactIdentity(t, userId, PAGE_SIZE + 1, 'Final Name', 'person@example.com')
  })

  test('a failed page keeps its checkpoint and retries the whole page', async () => {
    const t = convexTest(schema, MODULES)
    const userId = await t.run(async ctx => await seedUserMemberships(ctx, PAGE_SIZE))
    await t.run(async ctx => await changeIdentity(ctx, userId, 1, 'Retry Name'))
    await t.run(
      async ctx => await ctx.db.patch(userId, { name: 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) }),
    )

    await expect(runCurrentBatch(t, userId)).rejects.toThrow(
      `Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    )
    const afterFailure = await t.run(async ctx => ({
      names: await directoryNames(ctx, userId),
      job: await ctx.db
        .query('memberDirectoryRefreshJobs')
        .withIndex('by_user', q => q.eq('userId', userId))
        .unique(),
    }))
    expect(new Set(afterFailure.names)).toEqual(new Set(['Original Name']))
    expect(afterFailure.job?.afterMembershipId).toBeUndefined()

    await t.run(async ctx => await ctx.db.patch(userId, { name: 'Retry Name' }))
    expect((await runCurrentBatch(t, userId)).status).toBe('complete')
    await expectExactIdentity(t, userId, PAGE_SIZE, 'Retry Name', 'person@example.com')
  })

  test('a dangling membership projection is repaired without starving later rows', async () => {
    const t = convexTest(schema, MODULES)
    const userId = await t.run(async ctx => await seedUserMemberships(ctx, PAGE_SIZE + 1))
    const deletedMembershipId = await t.run(async ctx => {
      const first = await ctx.db
        .query('workspaceMemberDirectory')
        .withIndex('by_user_and_membership', q => q.eq('userId', userId))
        .first()
      if (first === null) throw new Error('directory fixture missing')
      await ctx.db.delete(first.membershipId)
      return first.membershipId
    })
    await t.run(async ctx => await changeIdentity(ctx, userId, 1, 'Repaired Name'))

    expect((await runCurrentBatch(t, userId)).status).toBe('pending')
    expect((await runCurrentBatch(t, userId)).status).toBe('complete')
    await expectExactIdentity(t, userId, PAGE_SIZE, 'Repaired Name', 'person@example.com')
    expect(
      await t.run(
        async ctx =>
          await ctx.db
            .query('workspaceMemberDirectory')
            .withIndex('by_membership', q => q.eq('membershipId', deletedMembershipId))
            .unique(),
      ),
    ).toBeNull()
  })

  test('the maximum identity page stays within Convex transaction limits', async () => {
    const t = convexTest({ schema, modules: MODULES, transactionLimits: true })
    const userId = await t.run(async ctx => await seedUserMemberships(ctx, PAGE_SIZE))
    const name = '界'.repeat(MAX_DISPLAY_NAME_LENGTH)
    const email = `${'e'.repeat(MAX_EMAIL_LENGTH - '@example.com'.length)}@example.com`
    await t.run(async ctx => {
      const user = await ctx.db.get(userId)
      if (user === null) throw new Error('user fixture missing')
      await updateCanonicalUserIdentity(ctx, { user, email, name, now: 2 })
    })

    expect((await runCurrentBatch(t, userId)).status).toBe('complete')
    await expectExactIdentity(t, userId, PAGE_SIZE, name, email)
  })
})

async function seedUserMemberships(ctx: MutationCtx, count: number): Promise<Id<'users'>> {
  const userId = await ctx.db.insert('users', {
    email: 'person@example.com',
    name: 'Original Name',
    memberDirectoryRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
  })
  for (let index = 0; index < count; index += 1) {
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: `directory-${index}`,
      name: `Directory ${index}`,
      status: 'active',
      createdAt: 1,
      billingUserId: userId,
    })
    const membershipId = await ctx.db.insert('workspaceMembers', {
      workspaceId,
      userId,
      role: 'viewer',
    })
    const membership = await ctx.db.get(membershipId)
    if (membership === null) throw new Error('membership insert disappeared')
    await writeMemberDirectoryEntry(ctx, membership)
  }
  return userId
}

async function changeIdentity(
  ctx: MutationCtx,
  userId: Id<'users'>,
  revision: number,
  name: string,
): Promise<void> {
  const user = await ctx.db.get(userId)
  if (user === null) throw new Error('user fixture missing')
  const updated = await updateCanonicalUserIdentity(ctx, {
    user,
    email: user.email,
    name,
    now: revision + 1,
  })
  if (updated.revision !== revision) throw new Error('unexpected profile revision')
}

async function runCurrentBatch(t: TestConvexForDataModel<DataModel>, userId: Id<'users'>) {
  return await t.run(async ctx => {
    const job = await ctx.db
      .query('memberDirectoryRefreshJobs')
      .withIndex('by_user', q => q.eq('userId', userId))
      .unique()
    if (job === null) return { status: 'complete' as const }
    return await refreshMemberDirectoryBatch(ctx, {
      userId,
      revision: job.revision,
      afterMembershipId: job.afterMembershipId ?? null,
    })
  })
}

async function directoryNames(ctx: MutationCtx, userId: Id<'users'>): Promise<string[]> {
  return (
    await ctx.db
      .query('workspaceMemberDirectory')
      .withIndex('by_user_and_membership', q => q.eq('userId', userId))
      .collect()
  ).map(row => row.name ?? '')
}

async function expectExactIdentity(
  t: TestConvexForDataModel<DataModel>,
  userId: Id<'users'>,
  membershipCount: number,
  name: string,
  email: string,
): Promise<void> {
  const state = await t.run(async ctx => ({
    directory: await ctx.db
      .query('workspaceMemberDirectory')
      .withIndex('by_user_and_membership', q => q.eq('userId', userId))
      .collect(),
    job: await ctx.db
      .query('memberDirectoryRefreshJobs')
      .withIndex('by_user', q => q.eq('userId', userId))
      .unique(),
  }))
  expect(state.job).toBeNull()
  expect(state.directory).toHaveLength(membershipCount)
  expect(
    state.directory.map(row => ({ email: row.email, name: row.name, searchText: row.searchText })),
  ).toEqual(
    Array.from({ length: membershipCount }, () => ({
      email,
      name,
      searchText: `${name.normalize('NFKC').toLowerCase()}\n${email.normalize('NFKC').toLowerCase()}`,
    })),
  )
}
