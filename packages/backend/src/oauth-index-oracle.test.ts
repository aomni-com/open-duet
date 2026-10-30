import { expect, test } from 'bun:test'

import { convexTest } from 'convex-test'

import schema from '../convex/schema'

test('OAuth production lookups resolve by exact indexed hashes and family ownership', async () => {
  const t = convexTest(schema, {
    '../convex/_generated/api.ts': async () => ({}),
  })

  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'oauth-index-oracle@example.com',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'oauth-index-oracle',
      name: 'OAuth index oracle',
      status: 'active',
      createdAt: 1,
      billingUserId: userId,
    })
    const requestId = await ctx.db.insert('oauthAuthorizationRequests', {
      clientId: 'client',
      clientName: 'Client',
      redirectUri: 'http://127.0.0.1/callback',
      capabilities: ['files:read'],
      resource: 'https://mcp.duet.so/',
      codeChallenge: 'challenge',
      status: 'approved',
      expiresAt: 100,
      createdAt: 1,
      userId,
      workspaceId,
    })
    const grantId = await ctx.db.insert('oauthGrants', {
      userId,
      workspaceId,
      clientId: 'client',
      clientName: 'Client',
      redirectHost: 'client.example',
      capabilities: ['files:read'],
      scopes: ['ws:oauth-index-oracle:files:read'],
      audience: 'https://mcp.duet.so/',
      workspaceSlug: 'oauth-index-oracle',
      workspaceName: 'OAuth index oracle',
      generation: 1,
      createdAt: 3,
    })
    const keyId = await ctx.db.insert('apiKeys', {
      kind: 'oauth',
      userId,
      hashedKey: 'access-hash',
      prefix: 'duet_sk_index',
      scopes: ['ws:oauth-index-oracle:files:read'],
      workspaceIds: [workspaceId],
      oauthGrantId: grantId,
      audience: 'https://mcp.duet.so/',
      expiresAt: 100,
    })
    await Promise.all([
      ctx.db.insert('oauthAuthorizationCodes', {
        hashedCode: 'wanted-code-hash',
        requestId,
        userId,
        workspaceId,
        scopes: ['ws:oauth-index-oracle:files:read'],
        clientId: 'client',
        redirectUri: 'http://127.0.0.1/callback',
        resource: 'https://mcp.duet.so/',
        challenge: 'challenge',
        expiresAt: 100,
      }),
      ctx.db.insert('oauthRefreshTokens', {
        hashedToken: 'wanted-refresh-hash',
        grantId,
        accessKeyId: keyId,
        generation: 1,
        expiresAt: 100,
      }),
    ])

    const [code, refresh, head, grantKeys, userGrants] = await Promise.all([
      ctx.db
        .query('oauthAuthorizationCodes')
        .withIndex('by_hashedCode', q => q.eq('hashedCode', 'wanted-code-hash'))
        .unique(),
      ctx.db
        .query('oauthRefreshTokens')
        .withIndex('by_hashedToken', q => q.eq('hashedToken', 'wanted-refresh-hash'))
        .unique(),
      ctx.db
        .query('oauthRefreshTokens')
        .withIndex('by_grantId_supersededAt', q =>
          q.eq('grantId', grantId).eq('supersededAt', undefined),
        )
        .unique(),
      ctx.db
        .query('apiKeys')
        .withIndex('by_oauthGrantId', q => q.eq('oauthGrantId', grantId))
        .collect(),
      ctx.db
        .query('oauthGrants')
        .withIndex('by_userId', q => q.eq('userId', userId))
        .collect(),
    ])

    expect(code?.hashedCode).toBe('wanted-code-hash')
    expect(refresh?._id).toBe(head?._id)
    expect(grantKeys.map(key => key._id)).toEqual([keyId])
    expect(userGrants.map(grant => grant._id)).toEqual([grantId])
  })
})
