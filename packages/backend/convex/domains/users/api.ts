import { v } from 'convex/values'

import { mutation, query } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { writeAuditEvent } from '../audit/model'
import { updateCanonicalUserIdentity } from './directoryRefresh'
import { cleanDisplayName } from './identity'

export const profile = query({
  args: { internalKey: v.string(), actorId: v.id('users') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const user = await ctx.db.get(args.actorId)
    if (user === null) throw new Error('User not found')
    return {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
    }
  },
})

export const updateProfile = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const user = await ctx.db.get(args.actorId)
    if (user === null) throw new Error('User not found')
    const firstName = cleanDisplayName(args.firstName)
    const lastName = cleanDisplayName(args.lastName)
    const name = cleanDisplayName([firstName, lastName].filter(Boolean).join(' ') || undefined)
    await updateCanonicalUserIdentity(ctx, {
      user,
      email: user.email,
      name,
      now: args.now,
      patch: { firstName, lastName },
    })
    const memberships = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_user_and_workspace', q => q.eq('userId', args.actorId))
      .take(100)
    for (const membership of memberships) {
      await writeAuditEvent(ctx, {
        workspaceId: membership.workspaceId,
        event: 'user.profile_updated',
        actorId: args.actorId,
        provenance: { name },
        at: args.now,
      })
    }
    return { id: user._id, email: user.email, firstName, lastName, name }
  },
})
