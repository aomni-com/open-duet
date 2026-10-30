import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { cleanDisplayName, normalizeEmail } from '../domains/users/identity'

export const rawStateForTest = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const [clients, requests, codes, grants, refreshTokens, apiKeys] = await Promise.all([
      ctx.db.query('oauthClients').collect(),
      ctx.db.query('oauthAuthorizationRequests').collect(),
      ctx.db.query('oauthAuthorizationCodes').collect(),
      ctx.db.query('oauthGrants').collect(),
      ctx.db.query('oauthRefreshTokens').collect(),
      ctx.db.query('apiKeys').collect(),
    ])
    return { clients, requests, codes, grants, refreshTokens, apiKeys }
  },
})

export const createUserWithoutWorkspaceForTest = mutation({
  args: { internalKey: v.string(), email: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const now = Date.now()
    const email = normalizeEmail(args.email)
    const name = cleanDisplayName(args.name)
    return await ctx.db.insert('users', {
      email,
      name,
      memberDirectoryRevision: 0,
      createdAt: now,
      updatedAt: now,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
    })
  },
})
