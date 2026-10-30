import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'

import schema from './schema'

test('strict observations reject retired arguments without changing the workspace and write one runtime identity', async () => {
  const key = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'runtime-observation-fixture'
  try {
    const t = convexTest(schema, {
      './_generated/api.ts': async () => ({}),
      './domains/workspaces/vmSync.ts': () => import('./domains/workspaces/vmSync'),
    })
    const workspaceId = await t.run(async ctx => {
      const billingUserId = await ctx.db.insert('users', {
        email: 'observation@example.test',
        memberDirectoryRevision: 0,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      return await ctx.db.insert('workspaces', {
        slug: 'runtime-observation',
        name: 'Runtime observation',
        status: 'active',
        servicingStatus: 'paused',
        billingUserId,
        createdAt: 1,
        vmTokenHash: 'fixture-token',
        imageRef: 'original-image',
      })
    })
    const before = await t.run(ctx => ctx.db.get(workspaceId))
    await expect(
      t.mutation(
        makeFunctionReference<'mutation'>('domains/workspaces/vmSync:persistVmSyncObservation'),
        {
          internalKey: 'runtime-observation-fixture',
          vmTokenHash: 'fixture-token',
          now: 2,
          observation: {
            needsModelCredentials: false,
            versions: {
              gateway: '0.0.0+transition',
              agent: 'old-agent',
              duetfs: 'old-duetfs',
              image: 'original-image',
            },
          },
        },
      ),
    ).rejects.toThrow()
    expect(await t.run(ctx => ctx.db.get(workspaceId))).toEqual(before)
    await t.mutation(
      makeFunctionReference<'mutation'>('domains/workspaces/vmSync:persistVmSyncObservation'),
      {
        internalKey: 'runtime-observation-fixture',
        vmTokenHash: 'fixture-token',
        now: 2,
        observation: {
          needsModelCredentials: false,
          versions: {
            runtime: '0.0.0+transition',
            image: 'original-image',
          },
        },
      },
    )
    const row = await t.run(ctx => ctx.db.get(workspaceId))
    expect(row).toMatchObject({
      runtimeVersion: '0.0.0+transition',
      imageVersion: 'original-image',
      imageRef: 'original-image',
    })
    expect(row).not.toHaveProperty('gatewayVersion')
    expect(row).not.toHaveProperty('agentVersion')
    expect(row).not.toHaveProperty('duetfsVersion')
    for (const field of ['gatewayVersion', 'agentVersion', 'duetfsVersion']) {
      const retired = { imageVersion: 'original-image', [field]: 'retired-component' }
      await expect(t.run(ctx => ctx.db.patch(workspaceId, retired))).rejects.toThrow()
      expect(await t.run(ctx => ctx.db.get(workspaceId))).toEqual(row)
    }
  } finally {
    if (key === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = key
  }
})
