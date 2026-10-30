import { ConvexError, v } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import { mutation, type MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'

/**
 * The in-flight half of a consent round trip: one row per press of Connect.
 *
 * Everything durable a callback needs is written here BEFORE the human leaves
 * for the third party, because the response comes back to an unauthenticated
 * endpoint with nothing but `code`, `state` and `iss` on it. In particular the
 * expected issuer is recorded from validated authorization-server metadata at
 * this moment — RFC 9207 is a comparison against what discovery said *then*, and
 * asking the authorization server again at callback time would let a server that
 * has been swapped underneath us answer for its own identity.
 *
 * The state itself is never stored, only its hash. The plaintext rides in the
 * OAuth `state` parameter, which lands in the authorization server's logs and in
 * the browser's history — the same reason `oauthAuthorizationCodes` stores
 * `hashedCode`.
 */

const MAX_PENDING_PER_SERVER = 8

export const startMcpOAuthAuthorization = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    serverId: v.id('mcpServers'),
    hashedState: v.string(),
    codeVerifier: v.string(),
    authorizationServer: v.string(),
    expectedIssuer: v.string(),
    resource: v.optional(v.string()),
    redirectTo: v.string(),
    expiresAt: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const server = await ctx.db.get(args.serverId)
    if (server === null || server.workspaceId !== args.workspaceId) {
      throw new ConvexError({ error: 'server_not_found' })
    }
    // The sweep is scoped to this server rather than the table: two members
    // pressing Connect on the same server legitimately hold two live rows, and
    // a table-wide scan would take a read dependency on every workspace's
    // in-flight consent, turning unrelated connects into write conflicts.
    const pending = await pendingForServer(ctx, args.serverId)
    const now = args.now ?? Date.now()
    for (const row of pending) {
      if (row.expiresAt <= now) await ctx.db.delete(row._id)
    }
    // A ceiling, so a caller that never completes a flow cannot grow the row
    // set without bound inside one TTL. The oldest live attempt is the one a
    // human has already walked away from.
    const live = pending
      .filter(row => row.expiresAt > now)
      .sort((a, b) => a.expiresAt - b.expiresAt)
    for (const row of live.slice(0, Math.max(0, live.length - (MAX_PENDING_PER_SERVER - 1)))) {
      await ctx.db.delete(row._id)
    }

    await ctx.db.insert('mcpOAuthAuthorizations', {
      serverId: args.serverId,
      workspaceId: args.workspaceId,
      hashedState: args.hashedState,
      codeVerifier: args.codeVerifier,
      authorizationServer: args.authorizationServer,
      expectedIssuer: args.expectedIssuer,
      resource: args.resource,
      redirectTo: args.redirectTo,
      expiresAt: args.expiresAt,
    })
    return { started: true }
  },
})

/**
 * Redeem a pending authorization exactly once.
 *
 * The delete is in the same transaction as the read, which is what makes a
 * replayed callback — the same `state` presented twice, from the browser's
 * history or from anyone who watched the redirect — find nothing the second
 * time. Expiry answers the same way as absence: a caller learns only that this
 * state is not redeemable, never which of the reasons applies.
 */
export const claimMcpOAuthAuthorization = mutation({
  args: {
    internalKey: v.string(),
    hashedState: v.string(),
    serverId: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const pending = await ctx.db
      .query('mcpOAuthAuthorizations')
      .withIndex('by_hashed_state', q => q.eq('hashedState', args.hashedState))
      .unique()
    if (pending === null) return null
    const now = args.now ?? Date.now()
    if (pending.expiresAt <= now) {
      await ctx.db.delete(pending._id)
      return null
    }
    // The state descriptor names the server it was minted for. They can only
    // disagree if a signed descriptor was paired with someone else's state, so
    // the row is left alone rather than consumed on a stranger's behalf.
    if (pending.serverId !== args.serverId) return null
    const server = await ctx.db.get(pending.serverId)
    await ctx.db.delete(pending._id)
    // The server was removed while its owner was away at the consent page.
    // There is nowhere to put the tokens, so the flow ends here.
    if (server === null) return null
    return {
      serverId: pending.serverId,
      workspaceId: pending.workspaceId,
      server: { name: server.name, url: server.url },
      codeVerifier: pending.codeVerifier,
      authorizationServer: pending.authorizationServer,
      expectedIssuer: pending.expectedIssuer,
      resource: pending.resource,
      redirectTo: pending.redirectTo,
    }
  },
})

/**
 * Removal takes the in-flight authorizations with it, the same way it takes the
 * credential: a row whose server is gone can only ever be claimed into nothing.
 */
export async function deleteAuthorizationsForServer(
  ctx: MutationCtx,
  serverId: Id<'mcpServers'>,
): Promise<void> {
  for (const row of await pendingForServer(ctx, serverId)) await ctx.db.delete(row._id)
}

async function pendingForServer(ctx: MutationCtx, serverId: Id<'mcpServers'>) {
  return await ctx.db
    .query('mcpOAuthAuthorizations')
    .withIndex('by_server', q => q.eq('serverId', serverId))
    .collect()
}
