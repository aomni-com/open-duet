import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import {
  chargeFailedAttempt,
  consumeSignInRequest,
  createSignInRequest,
  loadPendingSignInRequest,
  pendingRequestForEmail,
  type SignInRequest,
} from '../domains/authRequests/model'

export const rawRequests = query({
  args: { internalKey: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db
      .query('authSignInRequests')
      .withIndex('by_email', q => q.eq('email', args.email))
      .order('desc')
      .take(50)
  },
})

/**
 * How many codes `@convex-dev/auth` currently holds for an address.
 *
 * Reads the vendor's tables to prove the invariant this domain leans on — one
 * account, one live code, however many requests were started.
 */
export const liveVerificationCodeCount = query({
  args: { internalKey: v.string(), email: v.string() },
  handler: async (ctx, args): Promise<number> => {
    requireApiInternalKey(args.internalKey)
    const account = await ctx.db
      .query('authAccounts')
      .withIndex('providerAndAccountId', q =>
        q.eq('provider', 'email').eq('providerAccountId', args.email),
      )
      .unique()
    if (account === null) return 0
    const codes = await ctx.db
      .query('authVerificationCodes')
      .withIndex('accountId', q => q.eq('accountId', account._id))
      .take(50)
    return codes.length
  },
})

/**
 * Retire every code the library is holding, for every address.
 *
 * A fixture affordance with one cause: `DUET_TEST_AUTH_CODE` pins every minted
 * code to one constant, so two accounts with a live code each put two rows under
 * the same hash — and `verifyCodeAndSignIn.js` looks a code up with `.unique()`.
 * Redemption then throws for reasons that have nothing to do with the code the
 * caller supplied. Tests that only ever *start* a sign-in leave such a row
 * behind, so a test that redeems clears the ground first.
 */
export const discardVerificationCodesForTest = mutation({
  args: { internalKey: v.string() },
  handler: async (ctx, args): Promise<number> => {
    requireApiInternalKey(args.internalKey)
    const codes = await ctx.db.query('authVerificationCodes').take(200)
    for (const code of codes) await ctx.db.delete(code._id)
    return codes.length
  },
})

/** The stored profile, for assertions about what a sign-in did and did not write. */
export const userForTest = query({
  args: { internalKey: v.string(), email: v.string() },
  handler: async (ctx, args): Promise<{ email: string; name?: string } | null> => {
    requireApiInternalKey(args.internalKey)
    const user = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', args.email.trim().toLowerCase()))
      .unique()
    if (user === null) return null
    return { email: user.email, ...(user.name === undefined ? {} : { name: user.name }) }
  },
})

/** The vendor's session rows for an address, for assertions about how long a sign-in lasts. */
export const rawAuthSessionsForTest = query({
  args: { internalKey: v.string(), email: v.string() },
  handler: async (ctx, args): Promise<{ expirationTime: number }[]> => {
    requireApiInternalKey(args.internalKey)
    const user = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', args.email.trim().toLowerCase()))
      .unique()
    if (user === null) return []
    const sessions = await ctx.db
      .query('authSessions')
      .withIndex('userId', q => q.eq('userId', user._id))
      .take(50)
    return sessions.map(session => ({ expirationTime: session.expirationTime }))
  },
})

export const createForTest = mutation({
  args: {
    internalKey: v.string(),
    email: v.string(),
    clientName: v.optional(v.string()),
    name: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<{ requestId: string; expiresIn: number }> => {
    requireApiInternalKey(args.internalKey)
    return await createSignInRequest(ctx, args)
  },
})

export const loadPendingForTest = query({
  args: { internalKey: v.string(), requestId: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<SignInRequest | null> => {
    requireApiInternalKey(args.internalKey)
    return await loadPendingSignInRequest(ctx, args)
  },
})

export const pendingForEmailForTest = query({
  args: { internalKey: v.string(), email: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<SignInRequest | null> => {
    requireApiInternalKey(args.internalKey)
    return await pendingRequestForEmail(ctx, args)
  },
})

export const chargeFailedAttemptForTest = mutation({
  args: { internalKey: v.string(), requestId: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<{ attemptsRemaining: number }> => {
    requireApiInternalKey(args.internalKey)
    return await chargeFailedAttempt(ctx, args)
  },
})

export const consumeForTest = mutation({
  args: { internalKey: v.string(), requestId: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<void> => {
    requireApiInternalKey(args.internalKey)
    await consumeSignInRequest(ctx, args)
  },
})
