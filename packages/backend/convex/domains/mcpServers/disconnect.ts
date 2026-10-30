import { v } from 'convex/values'

import type { Doc, Id } from '../../_generated/dataModel'
import { mutation, type MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { credentialForServer } from './credentials'
import { deleteMcpServerRow, mcpServerByName, patchMcpServerState } from './model'

/**
 * Removal, in the order that IS the design.
 *
 * Three mutations rather than one, because two network calls happen between
 * them and neither may be made from inside a transaction:
 *
 * 1. `beginMcpServerDisconnect` marks the row `disconnecting` and hands out the
 *    credential, the registration and where to discover the authorization
 *    server. — `apps/api` attempts RFC 7009 revocation.
 * 2. `dropMcpServerCredential` deletes the credential **unconditionally**,
 *    whatever revocation answered, and says whether the registration it pointed
 *    at is now unreferenced. — `apps/api` attempts the RFC 7592 delete.
 * 3. `finishMcpServerDisconnect` records what happened to the registration and
 *    removes the server.
 *
 * The order matters more than the round trips cost. The credential is deleted
 * BEFORE the registration is asked about, so a disconnect that dies halfway has
 * already forgotten the token — Duet never keeps a credential it has been told
 * to forget — and a row left in `disconnecting` is simply retried by the next
 * DELETE, since every step re-reads.
 *
 * ## What none of this can clean up
 *
 * Recorded here rather than shown to a human: D13 says Duet does not
 * editorialize about third parties.
 *
 * - An authorization server that does DCR but not RFC 7592 (no
 *   `registration_client_uri` in its response). Its "Duet" client is permanent.
 * - A registration whose DELETE fails for good — client already gone,
 *   registration access token expired, endpoint 404. The row is kept so a later
 *   disconnect retries, but nothing guarantees it will ever succeed.
 * - Tokens at an authorization server with no `revocation_endpoint`. They live
 *   until it expires them.
 * - A statically pasted token. There is no discovered revocation endpoint and a
 *   PAT is the user's to revoke at its source, so nothing is attempted.
 */

const disconnectArgs = {
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
}

export const beginMcpServerDisconnect = mutation({
  args: { ...disconnectArgs, name: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const server = await mcpServerByName(ctx, args.workspaceId, args.name)
    // Not an error: removal is idempotent, and a caller repeating a DELETE is
    // asking for an end state that already holds.
    if (server === null) return null
    // Not decoration: `projectMcpServersForSession` launches only `ready`
    // servers, so this write is what keeps a turn from picking up a server
    // whose token is about to be revoked out from under it.
    await patchMcpServerState(ctx, server._id, 'disconnecting', args.now ?? Date.now())
    const credential = await credentialForServer(ctx, server._id)
    const registration =
      credential?.registrationId === undefined ? null : await ctx.db.get(credential.registrationId)
    return {
      server: { id: server._id, name: server.name, authKind: server.authKind },
      // The one read in this domain that hands out a refresh token outside the
      // lease. It is safe only because the row is on its way out: the caller
      // may present it exactly once, to revoke it.
      credential:
        credential === null
          ? null
          : {
              kind: credential.kind,
              accessToken: credential.accessToken,
              refreshToken: credential.refreshToken,
              // Where to fetch the RAW metadata document that names the
              // revocation endpoint. Recorded at mint, so a disconnect never
              // has to reach the MCP server itself — which may well be the
              // reason the user is disconnecting it.
              authorizationServer: credential.authorizationServer,
            },
      registration: registration === null ? null : registrationForDisconnect(registration),
    }
  },
})

/**
 * Step 3 and step 4's question, in one transaction.
 *
 * The credential goes whether or not revocation succeeded. Whether the
 * registration is now unreferenced is an index read over
 * `mcpServerCredentials.by_registration` taken AFTER the delete — never a
 * stored refcount, which drifts the first time a delete loses a race.
 */
export const dropMcpServerCredential = mutation({
  args: { ...disconnectArgs, serverId: v.id('mcpServers') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const server = await ctx.db.get(args.serverId)
    if (server === null || server.workspaceId !== args.workspaceId) {
      return { deleted: false, registration: 'none' as const }
    }
    const credential = await credentialForServer(ctx, args.serverId)
    if (credential === null) return { deleted: false, registration: 'none' as const }
    const registrationId = credential.registrationId
    await ctx.db.delete(credential._id)
    if (registrationId === undefined) return { deleted: true, registration: 'none' as const }
    const remaining = await ctx.db
      .query('mcpServerCredentials')
      .withIndex('by_registration', q => q.eq('registrationId', registrationId))
      .first()
    return {
      deleted: true,
      registration: remaining === null ? ('orphaned' as const) : ('shared' as const),
    }
  },
})

export const finishMcpServerDisconnect = mutation({
  args: {
    ...disconnectArgs,
    name: v.string(),
    registrationId: v.optional(v.id('mcpClientRegistrations')),
    /** `skipped` covers both "still in use" and "no way to ask". */
    registrationDelete: v.union(v.literal('deleted'), v.literal('failed'), v.literal('skipped')),
    reason: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const now = args.now ?? Date.now()
    if (args.registrationId !== undefined) {
      const registration = await ctx.db.get(args.registrationId)
      if (registration !== null && registration.workspaceId === args.workspaceId) {
        if (args.registrationDelete === 'deleted') {
          // The client is gone from the third party, so the row that names it
          // would be a pointer to nothing. Deleted even if a connect adopted it
          // in the meantime: the next one registers deliberately.
          await ctx.db.delete(args.registrationId)
        } else if (args.registrationDelete === 'failed') {
          // Kept, and deliberately NOT tombstoned. A live row is what makes a
          // later connect reuse this registration instead of minting a second
          // orphan, and what gives a later disconnect something to retry.
          await ctx.db.patch(args.registrationId, {
            deleteFailedAt: now,
            deleteFailedReason: (args.reason ?? 'unknown').slice(0, 200),
          })
        }
      }
    }
    const server = await mcpServerByName(ctx, args.workspaceId, args.name)
    if (server === null) return { name: args.name, removed: false }
    await deleteMcpServerRow(ctx, args.workspaceId, server)
    return { name: server.name, removed: true }
  },
})

/**
 * Nothing outlives the workspace that owns it.
 *
 * A workspace delete is a status patch, not a cascade, so without this every
 * token and every client registration the workspace ever obtained would sit in
 * Convex forever with no surface left that could ever disconnect them — D18's
 * orphan problem at its largest scale, and a live third-party token nobody can
 * reach.
 *
 * It is a row reap and nothing more. Revocation and the RFC 7592 delete are
 * network calls that only `apps/api` can make, and a mutation cannot make them
 * — so a deleted workspace's grants are attempted-nothing, deleted-locally. The
 * honest reading is that this trades a *reachable* orphan for an *unreachable*
 * one, and keeping the rows instead would leave both.
 *
 * The server rows themselves stay: the workspace is soft-deleted and every
 * other workspace-scoped table survives with it. Only what holds a third-party
 * secret is reaped.
 */
export async function reapMcpCredentialsForWorkspace(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
): Promise<void> {
  const credentials = await ctx.db
    .query('mcpServerCredentials')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .collect()
  for (const credential of credentials) await ctx.db.delete(credential._id)
  const registrations = await ctx.db
    .query('mcpClientRegistrations')
    .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
    .collect()
  for (const registration of registrations) await ctx.db.delete(registration._id)
}

/**
 * Everything the RFC 7592 delete needs, and nothing else.
 *
 * The registration access token IS a credential, which is why it never leaves
 * through `publicRegistration`; it leaves here because this call is the one
 * that spends it.
 */
function registrationForDisconnect(registration: Doc<'mcpClientRegistrations'>) {
  return {
    id: registration._id,
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
    tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
    registrationClientUri: registration.registrationClientUri,
    registrationAccessToken: registration.registrationAccessToken,
  }
}
