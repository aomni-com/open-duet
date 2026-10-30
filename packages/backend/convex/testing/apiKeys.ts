import { v } from 'convex/values'

import {
  AUTHENTICATED_API_RATE_LIMIT,
  OAuthGrantStorageMetadataSchema,
  assertSingleWorkspaceScopes,
  parseScope,
} from '@repo/contract'

import { mutation, query } from '../_generated/server'
import { AUTHENTICATED_API_RATE_LIMIT_SHARDS } from '../domains/apiKeys/apiRateLimit'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { insertApiKey } from '../domains/apiKeys/storage'
import { rateLimitShardCount } from '../domains/shared/rateLimits'

export const rawApiKeysForTest = query({
  args: {
    internalKey: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.query('apiKeys').collect()
  },
})

// Callers supply already-hashed material so raw credentials never cross this seam.
export const insertOAuthApiKeyForTest = mutation({
  args: {
    internalKey: v.string(),
    userId: v.id('users'),
    workspaceId: v.id('workspaces'),
    hashedKey: v.string(),
    prefix: v.string(),
    scopes: v.array(v.string()),
    audience: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    assertSingleWorkspaceScopes(args.scopes)
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null) throw new Error('Workspace not found')
    const grantMetadata = OAuthGrantStorageMetadataSchema.parse({
      clientId: 'fixture-client',
      clientName: 'Fixture client',
      redirectHost: 'fixture.example',
      capabilities: args.scopes.map(scope => {
        const parsed = parseScope(scope)
        if (parsed === null) throw new Error('Invalid workspace scope')
        return parsed.capability
      }),
      scopes: args.scopes,
      audience: args.audience,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.name,
    })
    const oauthGrantId = await ctx.db.insert('oauthGrants', {
      userId: args.userId,
      workspaceId: args.workspaceId,
      ...grantMetadata,
      generation: 1,
      createdAt: args.expiresAt - 60_000,
    })
    await ctx.db.patch(oauthGrantId, { paginationId: oauthGrantId })
    return await insertApiKey(ctx, {
      kind: 'oauth',
      userId: args.userId,
      hashedKey: args.hashedKey,
      prefix: args.prefix,
      scopes: args.scopes,
      workspaceIds: [args.workspaceId],
      oauthGrantId,
      audience: args.audience,
      expiresAt: args.expiresAt,
    })
  },
})

/**
 * What a principal has spent, not what one document says.
 *
 * A budget large enough to divide lives across several shard rows, so a
 * fixture or assertion naming the bare key describes one shard of a browser
 * session's window and calls it the whole thing. Passing `limit` makes these
 * helpers speak in budgets — the unit every caller actually means — and keeps
 * the shard layout an implementation detail of `consumeRateLimit`.
 */
function rateLimitShardKeys(key: string, limit: number | undefined): string[] {
  if (key.startsWith('api:')) {
    return Array.from(
      { length: AUTHENTICATED_API_RATE_LIMIT_SHARDS },
      (_, shard) => `${key}#api:${shard}`,
    )
  }
  const shards = limit === undefined ? 1 : rateLimitShardCount(limit)
  return Array.from({ length: shards }, (_, shard) => (shard === 0 ? key : `${key}#${shard}`))
}

function legacyApiRateLimitKeys(key: string): string[] {
  return key.startsWith('api:')
    ? Array.from({ length: rateLimitShardCount(AUTHENTICATED_API_RATE_LIMIT) }, (_, shard) =>
        shard === 0 ? key : `${key}#${shard}`,
      )
    : []
}

export const rateLimitForKeyForTest = query({
  args: {
    internalKey: v.string(),
    key: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const rows = (
      await Promise.all(
        [...rateLimitShardKeys(args.key, args.limit), ...legacyApiRateLimitKeys(args.key)].map(
          async key =>
            await ctx.db
              .query('rateLimits')
              .withIndex('by_key', q => q.eq('key', key))
              .unique(),
        ),
      )
    ).filter(row => row !== null)
    if (rows.length === 0) return null
    const windowStart = Math.max(...rows.map(row => row.windowStart))
    const current = rows.filter(row => row.windowStart === windowStart)
    return {
      count: current.reduce((total, row) => total + row.count, 0),
      windowStart,
      updatedAt: Math.max(...current.map(row => row.updatedAt)),
    }
  },
})

export const setRateLimitForTest = mutation({
  args: {
    internalKey: v.string(),
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
    updatedAt: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    // Reset the entire fixture budget, including compatibility state from a
    // previous layout; otherwise it can still consume the new window's allowance.
    for (const key of legacyApiRateLimitKeys(args.key)) {
      const row = await ctx.db
        .query('rateLimits')
        .withIndex('by_key', q => q.eq('key', key))
        .unique()
      if (row !== null) await ctx.db.delete(row._id)
    }
    // Spread as evenly as the shards allow: a fixture that piles a whole
    // budget onto one row describes a principal no amount of real traffic can
    // produce, and the refusal it then provokes is an artefact of the fixture.
    const keys = rateLimitShardKeys(args.key, args.limit)
    for (const [shard, key] of keys.entries()) {
      const count =
        Math.floor(args.count / keys.length) + (shard < args.count % keys.length ? 1 : 0)
      const existing = await ctx.db
        .query('rateLimits')
        .withIndex('by_key', q => q.eq('key', key))
        .unique()
      const state = { windowStart: args.windowStart, count, updatedAt: args.updatedAt }
      if (existing === null) {
        await ctx.db.insert('rateLimits', { key, ...state })
        continue
      }
      await ctx.db.patch(existing._id, state)
    }
  },
})

export const expireDeviceCodeForTest = mutation({
  args: {
    internalKey: v.string(),
    deviceCode: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const code = await ctx.db
      .query('deviceCodes')
      .withIndex('by_code', q => q.eq('code', args.deviceCode))
      .unique()
    if (code === null) throw new Error('Device code not found')
    await ctx.db.patch(code._id, { expiresAt: args.now - 1 })
  },
})

// Moves a browser session's rotation marker back in time, so a test can
// present the old cookie from past the handoff window without waiting it out.
export const ageBrowserSessionRotationForTest = mutation({
  args: {
    internalKey: v.string(),
    keyPrefix: v.string(),
    rotatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const key = await ctx.db
      .query('apiKeys')
      .withIndex('by_prefix', q => q.eq('prefix', args.keyPrefix))
      .unique()
    if (key === null || key.kind !== 'browser_session') throw new Error('Browser session not found')
    await ctx.db.patch(key._id, { rotatedAt: args.rotatedAt })
  },
})

export const replaceApiKeyScopesForTest = mutation({
  args: {
    internalKey: v.string(),
    keyPrefix: v.string(),
    scopes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const key = await ctx.db
      .query('apiKeys')
      .withIndex('by_prefix', q => q.eq('prefix', args.keyPrefix))
      .unique()
    if (key === null) throw new Error('API key not found')
    await ctx.db.patch(key._id, { scopes: args.scopes })
  },
})

export const replaceApiKeyAppIdForTest = mutation({
  args: {
    internalKey: v.string(),
    keyPrefix: v.string(),
    appId: v.id('apps'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const key = await ctx.db
      .query('apiKeys')
      .withIndex('by_prefix', q => q.eq('prefix', args.keyPrefix))
      .unique()
    if (key === null) throw new Error('API key not found')
    await ctx.db.patch(key._id, { appId: args.appId })
  },
})
