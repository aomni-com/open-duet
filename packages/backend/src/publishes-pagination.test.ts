import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import { listWorkspacePublishesPage } from '../convex/domains/publishes/model'
import schema from '../convex/schema'

const MODULES = { '../convex/_generated/api.ts': async () => ({}) }

test('publish pagination reaches rows beyond the former materialized-list ceiling', async () => {
  const t = convexTest(schema, MODULES)
  const { workspaceId, userId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'publish-pages@example.test',
      memberDirectoryRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'publish-pages',
      name: 'Publish pages',
      status: 'active',
      createdAt: 1,
      billingUserId: userId,
    })
    return { workspaceId, userId }
  })

  await t.run(async ctx => {
    for (let index = 0; index < 501; index += 1) {
      const slug = `surface-${String(index).padStart(3, '0')}`
      const anchorId = await ctx.db.insert('anchors', {
        workspaceId,
        path: `public/${slug}`,
        kind: 'publish',
        settings: { kind: 'folder' },
        state: 'active',
        markerNonce: `marker-${index}`,
        createdAt: index + 1,
        updatedAt: index + 1,
      })
      await ctx.db.insert('publishes', {
        workspaceId,
        anchorId,
        slug,
        kind: 'folder',
        createdByUserId: userId,
        createdAt: index + 1,
        updatedAt: index + 1,
      })
    }
  })

  const slugs: string[] = []
  let cursor: string | null = null
  do {
    const page = await t.run(
      async ctx =>
        await listWorkspacePublishesPage(ctx, workspaceId, {
          cursor,
          numItems: 100,
        }),
    )
    slugs.push(...page.page.map(row => row.slug))
    cursor = page.isDone ? null : page.continueCursor
  } while (cursor !== null)

  expect(slugs).toEqual(
    Array.from({ length: 501 }, (_, index) => `surface-${String(index).padStart(3, '0')}`),
  )
})
