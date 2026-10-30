import { describe, expect, test } from 'bun:test'
import { join, relative } from 'node:path'

import { convexTest } from 'convex-test'
import { ConvexError } from 'convex/values'

import { WORKSPACE_MEMBER_LIMIT } from '@repo/contract'

import { insertWorkspaceMember } from '../convex/domains/workspaces/memberDirectory'
import schema from '../convex/schema'

const MODULES = { '../convex/_generated/api.ts': async () => ({}) }
const BACKEND_ROOT = join(import.meta.dir, '..')

describe('workspace member admission capacity', () => {
  test('all deployable membership inserts stay behind the capacity owner', async () => {
    const insertOwners: string[] = []
    for await (const path of new Bun.Glob('convex/**/*.ts').scan({
      cwd: BACKEND_ROOT,
      absolute: true,
    })) {
      if (path.includes('/convex/_generated/') || path.endsWith('.test.ts')) continue
      const source = await Bun.file(path).text()
      if (/\.insert\(['"]workspaceMembers['"]/.test(source)) {
        insertOwners.push(relative(BACKEND_ROOT, path))
      }
    }
    expect(insertOwners).toEqual(['convex/domains/workspaces/memberDirectory.ts'])
  })

  test('admits the last allowed member and returns typed data for the next', async () => {
    const t = convexTest(schema, MODULES)
    const workspaceId = await t.run(async ctx => {
      const billingUserId = await insertUser(ctx, 'billing@example.test')
      return await ctx.db.insert('workspaces', {
        slug: 'bounded-members',
        name: 'Bounded Members',
        status: 'active',
        createdAt: 1,
        billingUserId,
      })
    })

    await t.run(async ctx => {
      for (let index = 0; index < WORKSPACE_MEMBER_LIMIT; index += 1) {
        const userId = await insertUser(ctx, `member-${index}@example.test`)
        await insertWorkspaceMember(ctx, { workspaceId, userId, role: 'viewer' })
      }
    })

    const stored = await t.run(
      async ctx =>
        await ctx.db
          .query('workspaceMembers')
          .withIndex('by_workspace_and_user', q => q.eq('workspaceId', workspaceId))
          .collect(),
    )
    expect(stored).toHaveLength(WORKSPACE_MEMBER_LIMIT)
    expect(stored.at(-1)?.role).toBe('viewer')

    const overflowUserId = await t.run(async ctx => await insertUser(ctx, 'overflow@example.test'))
    try {
      await t.run(
        async ctx =>
          await insertWorkspaceMember(ctx, {
            workspaceId,
            userId: overflowUserId,
            role: 'editor',
          }),
      )
      throw new Error('overflow admission unexpectedly succeeded')
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError)
      if (!(error instanceof ConvexError)) throw error
      expect(error.data).toEqual({
        error: 'workspace_member_limit_reached',
        limit: WORKSPACE_MEMBER_LIMIT,
      })
    }
  })
})

async function insertUser(
  ctx: Parameters<Parameters<ReturnType<typeof convexTest>['run']>[0]>[0],
  email: string,
) {
  return await ctx.db.insert('users', {
    email,
    memberDirectoryRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
  })
}
