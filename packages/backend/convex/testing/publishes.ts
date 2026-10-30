import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { updateCanonicalUserIdentity } from '../domains/users/directoryRefresh'
import { cleanDisplayName } from '../domains/users/identity'

export const rawPublishesForTest = query({
  args: { internalKey: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await ctx.db.query('publishes').collect()
  },
})

// Exercises the viewer owner-label fallback: clears (or sets) a creator's display
// name so resolveForEdge must fall back to a deterministic non-email label.
export const setUserNameForTest = mutation({
  args: {
    internalKey: v.string(),
    userId: v.id('users'),
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const user = await ctx.db.get(args.userId)
    if (user === null) throw new Error('User not found')
    await updateCanonicalUserIdentity(ctx, {
      user,
      email: user.email,
      name: cleanDisplayName(args.name),
      now: Date.now(),
      patch: {
        firstName: cleanDisplayName(args.firstName),
        lastName: cleanDisplayName(args.lastName),
      },
    })
    return { ok: true as const }
  },
})

// Repoints a publish's creator so the missing-creator resolve branch can be
// exercised against a deleted user id.
export const setPublishCreatorForTest = mutation({
  args: {
    internalKey: v.string(),
    publishId: v.id('publishes'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.patch(args.publishId, { createdByUserId: args.userId })
    return { ok: true as const }
  },
})

export const deleteUserForTest = mutation({
  args: { internalKey: v.string(), userId: v.id('users') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    await ctx.db.delete(args.userId)
    return { ok: true as const }
  },
})
