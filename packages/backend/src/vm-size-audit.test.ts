import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import schema from '../convex/schema'

test('audit provenance accepts VM resize resource details', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'vm-size-audit@example.com',
      memberDirectoryRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'vm-size-audit',
      name: 'VM size audit',
      status: 'active',
      createdAt: 1,
      billingUserId: userId,
      createdByUserId: userId,
    })

    const auditId = await ctx.db.insert('auditEvents', {
      workspaceId,
      event: 'workspace.vm_size_resized',
      actorId: userId,
      provenance: {
        source: 'workspace_vm_size_sweep',
        vmName: 'duet-ws-test',
        cpu: 10,
        memory: '24GB',
      },
      at: 1,
      sortId: 'audit-1',
    })

    expect((await ctx.db.get(auditId))?.provenance).toEqual({
      source: 'workspace_vm_size_sweep',
      vmName: 'duet-ws-test',
      cpu: 10,
      memory: '24GB',
    })
  })
})
