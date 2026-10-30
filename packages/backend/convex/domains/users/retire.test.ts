import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import type { MutationCtx } from '../../_generated/server'
import schema from '../../schema'
import { retireUserIdentity } from './retire'

const fixture = () => convexTest(schema, { '../../_generated/api.ts': async () => ({}) })

async function user(ctx: MutationCtx, email: string) {
  return await ctx.db.insert('users', {
    email,
    createdAt: 1,
    updatedAt: 1,
    paidCreditBalanceMicroUsd: 20,
    monthlyCreditBalanceMicroUsd: 30,
    memberDirectoryRevision: 0,
    billing: { stripeCustomerId: 'retained-external-customer' },
  })
}

test('identity retirement preserves surviving workspace principals and revokes personal credentials', async () => {
  await fixture().run(async ctx => {
    const userId = await user(ctx, 'departing@example.test')
    const remainingUserId = await user(ctx, 'remaining@example.test')
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'survives',
      name: 'Survives',
      createdByUserId: userId,
      billingUserId: remainingUserId,
      createdAt: 1,
      status: 'active',
    })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId: remainingUserId, role: 'owner' })
    await ctx.db.insert('apiKeys', { userId, hashedKey: 'user', prefix: 'user', kind: 'user' })
    for (const kind of ['browser_session', 'impersonation', 'system_vm', 'app'] as const) {
      await ctx.db.insert('apiKeys', {
        userId,
        hashedKey: kind,
        prefix: kind,
        kind,
        scopes: [],
        workspaceIds: [workspaceId],
        workspaceId,
      })
    }
    await retireUserIdentity(ctx, { userId, now: 100 })
    for (const key of await ctx.db.query('apiKeys').take(10)) {
      expect(key.revokedAt).toBe(key.kind === 'system_vm' || key.kind === 'app' ? undefined : 100)
    }
    expect(await ctx.db.get(workspaceId)).toMatchObject({
      status: 'active',
      createdByUserId: userId,
    })
    expect(await ctx.db.get(userId)).toMatchObject({
      email: `retired-${userId}@duet-test.invalid`,
      paidCreditBalanceMicroUsd: 20,
      monthlyCreditBalanceMicroUsd: 30,
    })
    expect((await ctx.db.get(userId))?.billing).toBeUndefined()
  })
})

test('identity retirement fences outstanding OAuth authorization and refresh families', async () => {
  const t = fixture()
  await t.run(async ctx => {
    const userId = await user(ctx, 'oauth@example.test')
    const otherUserId = await user(ctx, 'other@example.test')
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'oauth',
      name: 'OAuth',
      billingUserId: otherUserId,
      status: 'active',
      createdAt: 1,
    })
    const requestId = await ctx.db.insert('oauthAuthorizationRequests', {
      userId,
      workspaceId,
      clientId: 'client',
      clientName: 'Client',
      redirectUri: 'https://client.test/callback',
      capabilities: ['files:read'],
      resource: 'https://mcp.test',
      codeChallenge: 'challenge',
      status: 'approved',
      expiresAt: 1000,
      createdAt: 1,
    })
    const codeId = await ctx.db.insert('oauthAuthorizationCodes', {
      userId,
      workspaceId,
      requestId,
      hashedCode: 'code',
      scopes: ['ws:oauth:files:read'],
      clientId: 'client',
      redirectUri: 'https://client.test/callback',
      resource: 'https://mcp.test',
      challenge: 'challenge',
      expiresAt: 1000,
    })
    const grantId = await ctx.db.insert('oauthGrants', {
      userId,
      workspaceId,
      clientId: 'client',
      clientName: 'Client',
      redirectHost: 'client.test',
      capabilities: ['files:read'],
      scopes: ['ws:oauth:files:read'],
      audience: 'https://mcp.test',
      workspaceSlug: 'oauth',
      workspaceName: 'OAuth',
      generation: 1,
      createdAt: 1,
    })
    const accessKeyId = await ctx.db.insert('apiKeys', {
      userId,
      kind: 'oauth',
      hashedKey: 'oauth-access',
      prefix: 'oauth',
      scopes: ['ws:oauth:files:read'],
      workspaceIds: [workspaceId],
      oauthGrantId: grantId,
      audience: 'https://mcp.test',
      expiresAt: 1000,
    })
    const tokenId = await ctx.db.insert('oauthRefreshTokens', {
      hashedToken: 'refresh',
      grantId,
      accessKeyId,
      generation: 1,
      expiresAt: 1000,
    })
    const unrelatedGrantId = await ctx.db.insert('oauthGrants', {
      userId: otherUserId,
      workspaceId,
      clientId: 'client',
      clientName: 'Client',
      redirectHost: 'client.test',
      capabilities: ['files:read'],
      scopes: ['ws:oauth:files:read'],
      audience: 'https://mcp.test',
      workspaceSlug: 'oauth',
      workspaceName: 'OAuth',
      generation: 1,
      createdAt: 1,
    })
    await retireUserIdentity(ctx, { userId, now: 100 })
    expect(await ctx.db.get(requestId)).toMatchObject({ status: 'denied', expiresAt: 1000 })
    expect(await ctx.db.get(codeId)).toMatchObject({ consumedAt: 100 })
    expect(await ctx.db.get(grantId)).toMatchObject({ revokedAt: 100 })
    expect(await ctx.db.get(accessKeyId)).toMatchObject({ revokedAt: 100 })
    // Refresh tokens keep their durable grant link; the canonical family fence
    // is the revoked grant checked by every refresh and access authentication.
    expect(await ctx.db.get(tokenId)).toMatchObject({ grantId })
    expect((await ctx.db.get(unrelatedGrantId))?.revokedAt).toBeUndefined()
  })
})

test('identity retirement marks pending sign-in, device approval, and sync machine state', async () => {
  const t = fixture()
  await t.run(async ctx => {
    const userId = await user(ctx, 'pending@example.test')
    const deviceId = await ctx.db.insert('deviceCodes', {
      code: 'device-code',
      userCode: 'device-user-code',
      userId,
      status: 'approved',
      expiresAt: 1000,
      intervalSeconds: 5,
    })
    const signInId = await ctx.db.insert('authSignInRequests', {
      requestId: 'request',
      email: 'pending@example.test',
      attemptsRemaining: 3,
      expiresAt: 1000,
      createdAt: 1,
    })
    const machineId = await ctx.db.insert('syncMachines', {
      userId,
      name: 'Laptop',
      syncthingDeviceId: 'device',
      createdAt: 1,
      lastUsedAt: 1,
    })
    await retireUserIdentity(ctx, { userId, now: 100 })
    expect((await ctx.db.get(deviceId))?.status).toBe('denied')
    expect((await ctx.db.get(signInId))?.consumedAt).toBe(100)
    expect(await ctx.db.get(machineId)).toMatchObject({ userId, removedAt: 100 })
  })
})
