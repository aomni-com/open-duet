import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import { unsettledCandidates } from '../convex/domains/modelGateway/settlement'
import schema from '../convex/schema'

test('settlement selection moves a failed oldest row behind later work', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'settlement-selection@example.com',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'settlement-selection',
      name: 'Settlement selection',
      status: 'active',
      createdAt: 1,
      billingUserId: userId,
    })
    const insert = async (status: 'charge_failed' | 'reconciling', updatedAt: number) =>
      await ctx.db.insert('gatewayGenerations', {
        workspaceId,
        userId,
        modality: 'text',
        model: 'fixture',
        billingMode: 'post_response',
        chargeToWorkspace: true,
        status,
        createdAt: updatedAt,
        updatedAt,
      })
    const poisonId = await insert('charge_failed', 1)
    const healthyId = await insert('charge_failed', 2)
    const reconcileId = await insert('reconciling', 3)

    expect((await unsettledCandidates(ctx, 1)).map(row => row._id)).toEqual([poisonId])
    await ctx.db.patch(poisonId, { updatedAt: 10 })
    expect((await unsettledCandidates(ctx, 1)).map(row => row._id)).toEqual([healthyId])
    await ctx.db.patch(healthyId, { updatedAt: 11 })
    expect((await unsettledCandidates(ctx, 1)).map(row => row._id)).toEqual([reconcileId])
  })
})
