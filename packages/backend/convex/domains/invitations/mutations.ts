import { v } from 'convex/values'

import { internalMutation, mutation } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import {
  acceptIncomingInvite,
  bootstrapUser,
  createInviteForActor,
  revokeInviteForActor,
} from './model'

const inviteRole = v.union(v.literal('editor'), v.literal('viewer'))
const bootstrapTokens = v.object({
  invite: v.optional(v.string()),
  acquisition: v.optional(v.string()),
})

/**
 * Internal because a browser holds a Convex auth token, so anything public here
 * is callable straight from the console — and this is the mutation that mints a
 * workspace, a trial grant, and a VM. The only way in is
 * `domains/signupAbuse/actions:signUp`, which verifies first.
 *
 * The caller supplies `userId` rather than this reading `ctx.auth`: the action
 * has already resolved the authenticated identity, and an internal mutation
 * that re-derives it would give the same question two owners.
 */
export const bootstrap = internalMutation({
  args: {
    userId: v.id('users'),
    tokens: v.optional(bootstrapTokens),
    workspaceName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await bootstrapUser(
      ctx,
      args.userId,
      args.tokens ?? {},
      args.workspaceName === undefined ? {} : { workspaceName: args.workspaceName },
    )
    const workspace = await ctx.db.get(result.workspaceId)
    if (workspace === null) throw new Error('Bootstrap workspace missing')
    return { ...result, workspaceSlug: workspace.slug }
  },
})

export const createFromApi = internalMutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    email: v.string(),
    role: inviteRole,
    token: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await createInviteForActor(ctx, args)
  },
})

export const revokeFromApi = mutation({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    inviteId: v.id('workspaceInvites'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await revokeInviteForActor(ctx, args.inviteId, args.actorId, args.now)
  },
})

export const acceptIncomingFromApi = mutation({
  args: { internalKey: v.string(), actorId: v.id('users'), inviteId: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await acceptIncomingInvite(ctx, args.actorId, args.inviteId)
  },
})
