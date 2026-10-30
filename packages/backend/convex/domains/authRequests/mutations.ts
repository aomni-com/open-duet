import { v } from 'convex/values'

import { assertSingleWorkspaceScopes } from '@repo/contract'

import { internalMutation } from '../../_generated/server'
import { grantableScopesForWorkspaceRole } from '../apiKeys/model'
import { issueUserKey } from '../apiKeys/userKeys'
import { createOrLinkUserForAuth } from '../users/model'
import { isLiveWorkspace } from '../workspaces/authorization'
import {
  bindCodeToSignInRequest,
  chargeFailedAttempt,
  consumeSignInRequest,
  createSignInRequest,
} from './model'

/** Reachable only from `actions:start`, which is where the internal-key gate is. */
export const create = internalMutation({
  args: {
    email: v.string(),
    clientName: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<{ requestId: string; expiresIn: number }> =>
    await createSignInRequest(ctx, args),
})

/**
 * Called from `auth.ts`'s send callback — the one moment a minted code is
 * visible to Duet — and never with the code itself.
 */
export const bindCode = internalMutation({
  args: { email: v.string(), codeHash: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<{ bound: boolean; clientName?: string }> =>
    await bindCodeToSignInRequest(ctx, args),
})

/** One guess spent. Reachable only from `actions:verify`. */
export const spendAttempt = internalMutation({
  args: { requestId: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<{ attemptsRemaining: number }> =>
    await chargeFailedAttempt(ctx, args),
})

/**
 * Write the name the caller asserted onto a brand-new account.
 *
 * The account merge stays `createOrLinkUserForAuth`'s — this only hands it the
 * name Convex Auth threw away (`signIn.js:62` forwards no `name`, which is why
 * every magic-link signup in production today is nameless).
 *
 * **A stored name is never overwritten.** `profileFieldsToKeep` does not protect
 * one: it keeps a name the provider *supplied*, so supplying one wins. The
 * wire schema says `name` is new-account-only, and this is where that is true
 * rather than merely documented — `verify` also refuses to call this on the
 * bind branch, so a returning human is guarded twice over.
 */
export const applySignInName = internalMutation({
  args: { userId: v.id('users'), email: v.string(), name: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const user = await ctx.db.get(args.userId)
    if (user === null) throw new Error('Sign-in identity not found')
    if (user.name !== undefined) return
    await createOrLinkUserForAuth(ctx, {
      existingUserId: args.userId,
      type: 'email',
      profile: { email: args.email, name: args.name, emailVerified: true },
    })
  },
})

/**
 * Mint the credential the sign-in was for, and close the request.
 *
 * The selected workspace is a navigation/default target in the response;
 * the issued key still identifies the person across all current memberships.
 *
 * Consuming the record last means a failure anywhere above leaves it pending,
 * so the human can try again — the request record is cheap; the code is not.
 */
export const issueSignInKey = internalMutation({
  args: {
    requestId: v.string(),
    userId: v.id('users'),
    workspaceId: v.id('workspaces'),
    keyName: v.string(),
    now: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    accessToken: string
    prefix: string
    scopes: string[]
    workspace: { slug: string; name: string }
  }> => {
    const workspace = await ctx.db.get(args.workspaceId)
    if (workspace === null || !isLiveWorkspace(workspace.status)) {
      throw new Error('Sign-in workspace is not live')
    }
    const membership = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', args.workspaceId).eq('userId', args.userId),
      )
      .unique()
    if (membership === null) throw new Error('Sign-in identity is not a member of that workspace')

    const scopes = grantableScopesForWorkspaceRole(workspace.slug, membership.role)
    assertSingleWorkspaceScopes(scopes)
    const issued = await issueUserKey(ctx, {
      actorId: args.userId,
      name: args.keyName,
      now: args.now,
    })
    await consumeSignInRequest(ctx, { requestId: args.requestId, now: args.now })
    return {
      accessToken: issued.key,
      prefix: issued.record.prefix,
      scopes,
      workspace: { slug: workspace.slug, name: workspace.name },
    }
  },
})
