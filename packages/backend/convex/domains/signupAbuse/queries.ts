import { v } from 'convex/values'

import { internalQuery } from '../../_generated/server'
import { DOMAIN_SIGNUP_WINDOW_MS } from './policy'

/**
 * What the gate needs to know about the signing-up user before it decides.
 *
 * `alreadyOnboarded` is the "cold signup only" test: an existing member is
 * signing in, not signing up, and re-verifying them would mean a device that
 * legitimately hosts three accounts starts failing their logins. It mirrors the
 * early return in `bootstrapUser`, which hands back the existing membership
 * rather than creating anything.
 */
export const signupContext = internalQuery({
  args: { userId: v.id('users') },
  handler: async (
    ctx,
    args,
  ): Promise<{ email: string; alreadyOnboarded: boolean; domainSignupsLastDay: number }> => {
    const user = await ctx.db.get(args.userId)
    if (user === null) throw new Error('Unauthenticated')
    const membership = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_user_and_workspace', q => q.eq('userId', args.userId))
      .first()
    // Bounded by a day of signups, whatever the fleet's size: the creation
    // index is the one that scales with the window rather than with the table.
    const since = Date.now() - DOMAIN_SIGNUP_WINDOW_MS
    const domain = user.email.split('@')[1]?.toLowerCase()
    let domainSignupsLastDay = 0
    if (domain !== undefined) {
      for await (const other of ctx.db
        .query('users')
        .withIndex('by_creation_time', q => q.gte('_creationTime', since))) {
        if (other._id === user._id) continue
        if (other.email.split('@')[1]?.toLowerCase() === domain) domainSignupsLastDay += 1
      }
    }
    return { email: user.email, alreadyOnboarded: membership !== null, domainSignupsLastDay }
  },
})
