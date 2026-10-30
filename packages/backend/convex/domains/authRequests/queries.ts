import { v } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import { internalQuery } from '../../_generated/server'
import { liveWorkspaceMemberships } from '../apiKeys/model'
import { normalizeEmail } from '../users/identity'
import type { WorkspaceRole } from '../workspaces/authorization'
import { loadPendingSignInRequest, type SignInRequest } from './model'

/**
 * One workspace the signing-in human already belongs to.
 *
 * A superset of `SignInWorkspaceChoice` (`@repo/contract`): the resolution rule
 * reads only `slug`, but whoever mints the key needs the id, and re-deriving it
 * from the slug afterwards would be a second lookup answering a question this
 * one already answered.
 */
export interface SignInMembership {
  workspaceId: Id<'workspaces'>
  slug: string
  name: string
  role: WorkspaceRole
}

/**
 * Everything `verify` must know *before* it redeems anything.
 *
 * The two halves travel together because the ordering depends on it:
 * `verifyCodeAndSignIn.js:69-75` deletes a correct code the moment it is looked
 * up, so a `workspace_ambiguous` refusal decided after redemption would hand the
 * caller a list they can no longer act on. The memberships therefore have to be
 * readable from the request's *email* — which is the whole reason the record
 * carries one.
 *
 * No account yet means no memberships, which the resolution rule already reads
 * as "create". Note that `start` has usually created the `users` row already
 * (the library's `createVerificationCode` upserts one), so account existence is
 * never the signal here; live membership is.
 */
export const pendingSignIn = internalQuery({
  args: { requestId: v.string(), now: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ request: SignInRequest; memberships: SignInMembership[] } | null> => {
    const request = await loadPendingSignInRequest(ctx, args)
    if (request === null) return null
    const user = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', normalizeEmail(request.email)))
      .unique()
    if (user === null) return { request, memberships: [] }
    const memberships = await liveWorkspaceMemberships(ctx, user._id)
    return {
      request,
      memberships: memberships.map(({ membership, workspace }) => ({
        workspaceId: workspace._id,
        slug: workspace.slug,
        name: workspace.name,
        role: membership.role,
      })),
    }
  },
})

/**
 * The address the redeemed code actually authenticated.
 *
 * `auth:signIn` hands back tokens and nothing else, so the caller names the
 * identity out of the token it just minted. `normalizeId` rather than
 * `v.id('users')` because that string is parsed input until this query says
 * otherwise.
 */
export const redeemedIdentity = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<{ email: string } | null> => {
    const userId = ctx.db.normalizeId('users', args.userId)
    if (userId === null) return null
    const user = await ctx.db.get(userId)
    return user === null ? null : { email: user.email }
  },
})
