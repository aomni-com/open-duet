import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'

import schema from '../../schema'

test('fleet health counts live VMs beyond VM-less rows and tallies only reported builds', async () => {
  const previousKey = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'fleet-health-test'
  try {
    const t = convexTest(schema, {
      '../../_generated/api.ts': async () => ({}),
      '../../domains/internalAdmin/model.ts': () => import('./model'),
    })
    const actorId = await t.run(async ctx => {
      const owner = await ctx.db.insert('users', {
        email: 'operator@duet.so',
        name: 'Operator',
        createdAt: 1,
        updatedAt: 1,
        paidCreditBalanceMicroUsd: 0,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
      })
      for (let index = 0; index < 1001; index++) {
        await ctx.db.insert('workspaces', {
          slug: `empty-${index}`,
          name: 'Empty',
          status: 'active',
          billingUserId: owner,
          createdAt: 1,
        })
      }
      await ctx.db.insert('workspaces', {
        slug: 'live',
        name: 'Live',
        status: 'active',
        billingUserId: owner,
        createdAt: 2,
        vmName: 'live-vm',
        runtimeVersion: 'build-a',
        lastHeartbeatAt: 2,
      })
      await ctx.db.insert('workspaces', {
        slug: 'unreported',
        name: 'Unreported',
        status: 'active',
        billingUserId: owner,
        createdAt: 2,
        vmName: 'unreported-vm',
      })
      return owner
    })

    const result = await t.query(
      makeFunctionReference<'query'>('domains/internalAdmin/model:fleetHealth'),
      {
        internalKey: 'fleet-health-test',
        actorId,
        now: 3,
      },
    )
    expect(result).toMatchObject({
      activeCount: 2,
      truncated: false,
      versions: { runtime: [{ label: 'build-a', count: 1 }] },
      vms: [
        { slug: 'live', vmName: 'live-vm', runtimeVersion: 'build-a' },
        { slug: 'unreported', vmName: 'unreported-vm' },
      ],
    })
  } finally {
    if (previousKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previousKey
  }
})

test('unpause clears topup failures without changing balances or suspension and remains subject to reconciliation', async () => {
  const previousKey = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = 'unpause-test'
  try {
    const t = convexTest(schema, {
      '../../_generated/api.ts': async () => ({}),
      '../../domains/internalAdmin/model.ts': () => import('./model'),
    })
    const { actorId, workspaceId } = await t.run(async ctx => {
      const actorId = await ctx.db.insert('users', {
        email: 'operator@duet.so',
        createdAt: 1,
        updatedAt: 1,
        paidCreditBalanceMicroUsd: 20_000_000,
        monthlyCreditBalanceMicroUsd: 0,
        memberDirectoryRevision: 0,
        billing: {
          consecutiveTopupFailures: 3,
          lastTopupError: { code: 'card_declined', message: 'Declined', at: 1 },
        },
      })
      const workspaceId = await ctx.db.insert('workspaces', {
        slug: 'paused-workspace',
        name: 'Paused workspace',
        status: 'active',
        servicingStatus: 'paused',
        suspendedAt: 2,
        billingUserId: actorId,
        createdAt: 1,
      })
      return { actorId, workspaceId }
    })
    await t.mutation(
      makeFunctionReference<'mutation'>('domains/internalAdmin/model:mutateWorkspace'),
      {
        internalKey: 'unpause-test',
        actorId,
        workspaceId,
        operation: 'unpause',
        reason: 'Operator resumes service',
        requestId: 'unpause-request',
        now: 3,
      },
    )
    const resumed = await t.run(ctx => ctx.db.get(workspaceId))
    expect(resumed).toMatchObject({
      servicingStatus: 'active',
      servicingStatusChangedAt: 3,
      suspendedAt: 2,
    })
    expect(resumed?.servicingExemptAt).toBeUndefined()
    const payer = await t.run(ctx => ctx.db.get(actorId))
    expect(payer?.paidCreditBalanceMicroUsd).toBe(20_000_000)
    expect(payer?.billing?.consecutiveTopupFailures).toBe(0)
    expect(payer?.billing?.lastTopupError).toBeUndefined()
    expect(payer?.billing?.paymentMethodReadyAt).toBeUndefined()
    const audits = await t.run(ctx => ctx.db.query('adminAuditEvents').collect())
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'admin.workspace.unpause',
        reason: 'Operator resumes service',
        status: 'completed',
      }),
    )
    const { reconcileServicingStatus } = await import('../credits/subscriptions')
    await t.run(ctx => reconcileServicingStatus(ctx, actorId, 4))
    expect(await t.run(ctx => ctx.db.get(workspaceId))).toMatchObject({ servicingStatus: 'paused' })
  } finally {
    if (previousKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previousKey
  }
})
