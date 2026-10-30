import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import schema from './schema'

test('strict human-key storage refuses stale grant and credential machine fields', async () => {
  await convexTest(schema, { './_generated/api.ts': async () => ({}) }).run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'strict-identity@example.test',
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'strict-identity',
      name: 'Strict identity',
      status: 'active',
      createdAt: 1,
      billingUserId: userId,
    })
    for (const legacy of [
      { scopes: [] },
      { workspaceIds: [] },
      { workspaceId },
      { syncthingDeviceId: 'retired-peer' },
      { audience: 'https://mcp.duet.so/' },
      { rotatedAt: 1 },
    ]) {
      await expect(
        ctx.db.insert('apiKeys', {
          kind: 'user',
          userId,
          hashedKey: 'unchanged-identity-hash',
          prefix: 'duet_sk_identity',
          ...legacy,
        }),
      ).rejects.toThrow()
    }
    expect(await ctx.db.query('apiKeys').collect()).toEqual([])
  })
})

test('strict device approval storage refuses retired grants and machine metadata', async () => {
  await convexTest(schema, { './_generated/api.ts': async () => ({}) }).run(async ctx => {
    for (const legacy of [
      { scopes: [] },
      { capabilities: [] },
      { workspaceIds: [] },
      { deviceName: '' },
    ]) {
      await expect(
        ctx.db.insert('deviceCodes', {
          code: 'identity-login',
          userCode: 'IDENTITY',
          status: 'pending',
          expiresAt: 1_000_000,
          intervalSeconds: 5,
          ...legacy,
        }),
      ).rejects.toThrow()
    }
    expect(await ctx.db.query('deviceCodes').collect()).toEqual([])
  })
})
