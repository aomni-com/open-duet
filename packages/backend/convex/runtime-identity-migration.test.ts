import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

import { migrateWorkspaceRuntimeIdentityRow } from './migrations'
import schema from './schema'

test('runtime identity migration preserves VM provenance and removes obsolete component identities', async () => {
  // Replay the additive deployment's row grammar, then validate its output
  // against the strict schema. Only this historical input admits old columns.
  const beforeCutover = defineSchema({
    ...schema.tables,
    workspaces: defineTable({
      ...schema.tables.workspaces.validator.fields,
      gatewayVersion: v.optional(v.string()),
      agentVersion: v.optional(v.string()),
      duetfsVersion: v.optional(v.string()),
    }),
  })
  const modules = { './_generated/api.ts': async () => ({}) }
  const strictRows = convexTest(schema, modules)
  await convexTest(beforeCutover, modules).run(async ctx => {
    const billingUserId = await ctx.db.insert('users', {
      email: 'runtime@example.test',
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const id = await ctx.db.insert('workspaces', {
      slug: 'runtime-migration',
      name: 'Runtime migration',
      status: 'active',
      createdAt: 1,
      billingUserId,
      vmName: 'original-vm',
      imageRef: 'original-image',
      imageVersion: 'original-image',
      gatewayVersion: '0.0.0+transition',
      agentVersion: 'old-agent',
      duetfsVersion: 'old-duetfs',
    })
    const before = (await ctx.db.get(id))!
    await migrateWorkspaceRuntimeIdentityRow(ctx, before)
    const expected = { ...before, runtimeVersion: before.gatewayVersion }
    delete expected.gatewayVersion
    delete expected.agentVersion
    delete expected.duetfsVersion
    expect(await ctx.db.get(id)).toEqual(expected)
    await migrateWorkspaceRuntimeIdentityRow(ctx, (await ctx.db.get(id))!)
    expect(await ctx.db.get(id)).toEqual(expected)
    await ctx.db.patch(id, { runtimeVersion: '0.0.0+strict', gatewayVersion: '0.0.0+stale' })
    await migrateWorkspaceRuntimeIdentityRow(ctx, (await ctx.db.get(id))!)
    const migrated = (await ctx.db.get(id))!
    expect(migrated).toEqual({ ...expected, runtimeVersion: '0.0.0+strict' })
    const { _id, _creationTime, ...fields } = migrated
    await strictRows.run(async strict => {
      const accepted = await strict.db.insert('workspaces', fields)
      expect(await strict.db.get(accepted)).toMatchObject(fields)
    })
  })
})
