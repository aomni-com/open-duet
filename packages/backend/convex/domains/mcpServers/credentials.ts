import { ConvexError, v } from 'convex/values'

import type { Doc, Id } from '../../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'

/**
 * The only owner of third-party MCP credentials.
 *
 * D12 puts these tokens in Convex in plain text — the deployment is the trust
 * boundary — which is exactly why they live in their own table rather than on
 * `mcpServers`: Convex queries return whole documents, so a token beside the
 * server's name would have to be hand-stripped by every list, health, and
 * projection read. Here it can only escape through the two functions below,
 * both gated by the API's internal key.
 */

/**
 * The identity two servers must agree on to share one client registration.
 *
 * Origin plus pathname, with no trailing slash, no query and no fragment. This
 * normalization IS D18's sharing rule: if it is wrong, two servers behind one
 * authorization server each mint their own registration and each add/remove
 * cycle litters a third party with orphaned "Duet" clients.
 */
export function normalizeAuthorizationServer(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConvexError({ error: 'invalid_authorization_server' })
  }
  if (url.protocol !== 'https:') throw new ConvexError({ error: 'invalid_authorization_server' })
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const credentialArgs = {
  internalKey: v.string(),
  workspaceId: v.id('workspaces'),
  serverId: v.id('mcpServers'),
}

/**
 * Write a credential under a compare-and-swap on `generation`.
 *
 * Generation, never token equality, is the rotation signal: an authorization
 * server that returns no new refresh token leaves the old value in place, so
 * "the value did not change" proves nothing about who wrote last. A caller that
 * read generation N may only write N+1, and a loser is told `stale` rather than
 * silently overwriting the winner's rotated token.
 */
export const storeMcpServerCredential = mutation({
  args: {
    ...credentialArgs,
    expectedGeneration: v.optional(v.number()),
    kind: v.union(v.literal('oauth'), v.literal('static')),
    accessToken: v.string(),
    tokenType: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    scope: v.optional(v.string()),
    accessExpiresAt: v.optional(v.number()),
    registrationId: v.optional(v.id('mcpClientRegistrations')),
    resource: v.optional(v.string()),
    authorizationServer: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const server = await ctx.db.get(args.serverId)
    if (server === null || server.workspaceId !== args.workspaceId) {
      throw new ConvexError({ error: 'server_not_found' })
    }
    const existing = await credentialForServer(ctx, args.serverId)
    const now = args.now ?? Date.now()
    const fields = {
      kind: args.kind,
      accessToken: args.accessToken,
      tokenType: args.tokenType ?? 'Bearer',
      refreshToken: args.refreshToken,
      scope: args.scope,
      accessExpiresAt: args.accessExpiresAt,
      registrationId: args.registrationId,
      resource: args.resource,
      authorizationServer:
        args.authorizationServer === undefined
          ? undefined
          : normalizeAuthorizationServer(args.authorizationServer),
    }
    if (existing === null) {
      if (args.expectedGeneration !== undefined) return { status: 'stale' as const, generation: 0 }
      await ctx.db.insert('mcpServerCredentials', {
        ...fields,
        serverId: args.serverId,
        workspaceId: args.workspaceId,
        generation: 1,
        createdAt: now,
        updatedAt: now,
      })
      return { status: 'stored' as const, generation: 1 }
    }
    if (args.expectedGeneration !== undefined && args.expectedGeneration !== existing.generation) {
      return { status: 'stale' as const, generation: existing.generation }
    }
    const generation = existing.generation + 1
    await ctx.db.patch(existing._id, {
      ...fields,
      generation,
      // A fresh token is what recovery looks like, so the terminal-failure
      // marks clear together with it rather than needing a second call.
      invalidAt: undefined,
      invalidReason: undefined,
      updatedAt: now,
    })
    return { status: 'stored' as const, generation }
  },
})

/**
 * The one read that returns a secret. The proxy calls it per request, which is
 * why nothing caches the answer anywhere else: a cached copy is a second owner
 * of the credential, and it would go stale against a rotation it cannot see.
 *
 * It is also step 0 of the refresh sequence, which is why it reports whether a
 * refresh token exists and when the current lease ends rather than returning
 * either. The refresh token itself is released by `claimMcpRefreshLease` alone,
 * in the same write that takes the lease — a read that handed it out would put
 * it in the hands of every concurrent lambda at once.
 */
export const readMcpServerCredential = query({
  args: credentialArgs,
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const credential = await credentialForServer(ctx, args.serverId)
    if (credential === null || credential.workspaceId !== args.workspaceId) return null
    return {
      generation: credential.generation,
      kind: credential.kind,
      accessToken: credential.accessToken,
      tokenType: credential.tokenType,
      accessExpiresAt: credential.accessExpiresAt,
      registrationId: credential.registrationId,
      authorizationServer: credential.authorizationServer,
      invalidAt: credential.invalidAt,
      hasRefreshToken: credential.refreshToken !== undefined,
      leaseUntil: credential.leaseUntil,
    }
  },
})

/**
 * Take the refresh lease and the refresh token in ONE transactional write.
 *
 * This mutation is the whole safety property of the refresh path. Rotation is
 * real — `specs/done/connected-providers` observed a new refresh token on every
 * live refresh it probed — so two lambdas presenting the same one means the
 * loser stores a token the authorization server has already retired and the
 * workspace silently loses its grant. Because the lease and the token leave
 * here together, the token is released to at most one caller per generation.
 *
 * Every branch re-reads inside the transaction, which is what makes the whole
 * thing idempotent: a caller that lost a race is told to use the winner's
 * token, and an optimistic-concurrency retry simply re-runs the handler and
 * takes whichever branch is now true.
 *
 * `skewMs` and `leaseMs` arrive from the caller rather than being declared
 * here: one bounds the fetch the caller is about to make and the other decides
 * how early "expired" starts, and both are the proxy's to choose. A second copy
 * in Convex would be a second answer to the same question.
 */
export const claimMcpRefreshLease = mutation({
  args: {
    ...credentialArgs,
    expectedGeneration: v.number(),
    owner: v.string(),
    skewMs: v.number(),
    leaseMs: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const credential = await requireCredential(ctx, args.workspaceId, args.serverId)
    if (credential === null) return { status: 'unavailable' as const }
    // Terminal. Only a connect clears it, so nothing here may spend another
    // refusal on a grant the authorization server has already condemned.
    if (credential.invalidAt !== undefined) return { status: 'invalid' as const }
    // Somebody rotated between the caller's read and this transaction. Theirs
    // is the live grant: use it, never fetch.
    if (credential.generation !== args.expectedGeneration) {
      return { status: 'refreshed' as const, credential: publicCredential(credential) }
    }
    // A raced winner already extended it, or it never needed extending.
    if (
      credential.accessExpiresAt !== undefined &&
      credential.accessExpiresAt - args.now > args.skewMs
    ) {
      return { status: 'refreshed' as const, credential: publicCredential(credential) }
    }
    if (credential.leaseUntil !== undefined && credential.leaseUntil > args.now) {
      return {
        status: 'busy' as const,
        leaseUntil: credential.leaseUntil,
        credential: publicCredential(credential),
      }
    }
    // Nothing to refresh with. The stored token is all there will ever be until
    // a human reconnects, so it goes out as-is and the upstream decides.
    if (credential.refreshToken === undefined) {
      return { status: 'unavailable' as const, credential: publicCredential(credential) }
    }
    await ctx.db.patch(credential._id, {
      leaseOwner: args.owner,
      leaseUntil: args.now + args.leaseMs,
    })
    const registration =
      credential.registrationId === undefined ? null : await ctx.db.get(credential.registrationId)
    return {
      status: 'claimed' as const,
      generation: credential.generation,
      refreshToken: credential.refreshToken,
      resource: credential.resource,
      authorizationServer: credential.authorizationServer,
      // Duet is a public client, so this is an identity and not a secret: the
      // client id, and nothing that authenticates it.
      registration: registration === null ? null : { clientId: registration.clientId },
    }
  },
})

/**
 * Store what the authorization server answered, iff nobody superseded it.
 *
 * Lease ownership governs who may FETCH; **generation** governs who may WRITE.
 * They are deliberately different rules: a lease can lapse under a slow but
 * perfectly healthy lambda, and discarding a rotated refresh token because a
 * clock ran out — while nothing has actually superseded it — would lose the
 * grant for exactly the reason the lease exists to prevent.
 */
export const commitMcpRefresh = mutation({
  args: {
    ...credentialArgs,
    owner: v.string(),
    expectedGeneration: v.number(),
    accessToken: v.string(),
    tokenType: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    scope: v.optional(v.string()),
    accessExpiresAt: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const credential = await requireCredential(ctx, args.workspaceId, args.serverId)
    if (credential === null) return { status: 'gone' as const }
    if (credential.generation !== args.expectedGeneration) {
      return { status: 'superseded' as const, credential: publicCredential(credential) }
    }
    await ctx.db.patch(credential._id, {
      accessToken: args.accessToken,
      tokenType: args.tokenType ?? credential.tokenType,
      // An authorization server that returns no new refresh token leaves the
      // old one live. Dropping it here would end the grant on the half of real
      // refreshes that do not rotate.
      refreshToken: args.refreshToken ?? credential.refreshToken,
      scope: args.scope ?? credential.scope,
      accessExpiresAt: args.accessExpiresAt,
      generation: credential.generation + 1,
      // A fresh token IS the recovery, so the terminal mark clears with it.
      invalidAt: undefined,
      invalidReason: undefined,
      ...releasedLease(credential, args.owner),
      updatedAt: args.now,
    })
    const committed = (await ctx.db.get(credential._id))!
    return { status: 'committed' as const, credential: publicCredential(committed) }
  },
})

/**
 * What a failed refresh does to the row, by what the authorization server said.
 *
 * `invalid_grant` is the only answer that is provably terminal about the token:
 * the refresh token is dead, and keeping it invites every other lambda to burn
 * another refusal on it. `invalid_client` says the same about the client
 * identity, which is a fact about the registration and is marked there too, so
 * the next connect registers deliberately instead of reusing a client this
 * authorization server has stopped honouring. Everything else — a 5xx, a
 * timeout, a refused connection — taught us nothing about the grant, so it
 * releases the lease and changes nothing else.
 */
export const failMcpRefresh = mutation({
  args: {
    ...credentialArgs,
    owner: v.string(),
    expectedGeneration: v.number(),
    outcome: v.union(
      v.literal('transient'),
      v.literal('invalid_grant'),
      v.literal('invalid_client'),
    ),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const credential = await requireCredential(ctx, args.workspaceId, args.serverId)
    if (credential === null) return { status: 'gone' as const }
    const released = releasedLease(credential, args.owner)
    // A refusal about a token the row no longer holds. Acting on it would
    // condemn the refresh that overtook this one — the opposite of the truth.
    if (credential.generation !== args.expectedGeneration) {
      await ctx.db.patch(credential._id, released)
      return { status: 'superseded' as const, credential: publicCredential(credential) }
    }
    if (args.outcome === 'transient') {
      await ctx.db.patch(credential._id, released)
      return { status: 'cleared' as const, credential: publicCredential(credential) }
    }
    await ctx.db.patch(credential._id, {
      refreshToken: undefined,
      // Bumped so anything still in flight against this generation is
      // superseded rather than able to resurrect the dead grant.
      generation: credential.generation + 1,
      invalidAt: args.now,
      invalidReason: args.outcome,
      ...released,
      updatedAt: args.now,
    })
    if (args.outcome === 'invalid_client' && credential.registrationId !== undefined) {
      await markRegistrationInvalid(ctx, credential.registrationId, args.outcome, args.now)
    }
    return { status: 'invalidated' as const, generation: credential.generation + 1 }
  },
})

export const getMcpClientRegistration = query({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    authorizationServer: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const registration = await registrationForAuthorizationServer(
      ctx,
      args.workspaceId,
      args.authorizationServer,
    )
    return registration === null ? null : publicRegistration(registration)
  },
})

/**
 * One registration per (workspace, authorization server), reused by every
 * server behind that authorization server.
 *
 * There is no refcount column: a stored count drifts the first time a delete
 * loses a race, and the truth is one index read away through
 * `mcpServerCredentials.by_registration`.
 */
export const storeMcpClientRegistration = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    authorizationServer: v.string(),
    clientId: v.string(),
    clientSecret: v.optional(v.string()),
    tokenEndpointAuthMethod: v.optional(v.string()),
    clientSecretExpiresAt: v.optional(v.number()),
    // RFC 7592. Without these two a registration can never be deleted from the
    // third party, which is why Duet issues the DCR POST itself instead of
    // using the SDK's `registerClient()` — it parses them away.
    registrationClientUri: v.optional(v.string()),
    registrationAccessToken: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const authorizationServer = normalizeAuthorizationServer(args.authorizationServer)
    const fields = {
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
      clientSecretExpiresAt: args.clientSecretExpiresAt,
      registrationClientUri: args.registrationClientUri,
      registrationAccessToken: args.registrationAccessToken,
    }
    const existing = await ctx.db
      .query('mcpClientRegistrations')
      .withIndex('by_workspace_and_as', q =>
        q.eq('workspaceId', args.workspaceId).eq('authorizationServer', authorizationServer),
      )
      .unique()
    // D18 is one registration per (workspace, authorization server), and this
    // re-query inside the transaction is what enforces it. A plain upsert
    // cannot: two connects racing the same authorization server would both
    // patch, the second silently replacing the first, and the loser would
    // never learn it had one to clean up — leaving exactly the orphaned
    // "Duet" client on the third party that D18 exists to prevent.
    if (existing !== null && existing.invalidAt === undefined) {
      return { status: 'exists' as const, registration: publicRegistration(existing) }
    }
    if (existing !== null) {
      // Re-registering after the authorization server rejected the old client
      // is a recovery, so the invalid mark and the failed-delete record clear
      // with the new identity rather than outliving it.
      await ctx.db.patch(existing._id, {
        ...fields,
        invalidAt: undefined,
        invalidReason: undefined,
        deleteFailedAt: undefined,
        deleteFailedReason: undefined,
      })
      return {
        status: 'adopted' as const,
        registration: publicRegistration((await ctx.db.get(existing._id))!),
      }
    }
    const registrationId = await ctx.db.insert('mcpClientRegistrations', {
      ...fields,
      workspaceId: args.workspaceId,
      authorizationServer,
      createdAt: args.now ?? Date.now(),
    })
    return {
      status: 'adopted' as const,
      registration: publicRegistration((await ctx.db.get(registrationId))!),
    }
  },
})

/**
 * Mark a registration the authorization server has stopped honoring.
 *
 * `registrationForAuthorizationServer` already refuses to reuse a marked row,
 * so this is what makes the next connect register deliberately once, under a
 * human's click — instead of letting the SDK's `auth()` re-register on every
 * `invalid_client`, which turns a flapping authorization server into a stream
 * of orphans. The row survives the mark: it still holds the RFC 7592
 * credentials that are the only way to delete the client upstream.
 */
export const invalidateMcpClientRegistration = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    registrationId: v.string(),
    reason: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const registrationId = ctx.db.normalizeId('mcpClientRegistrations', args.registrationId)
    if (registrationId === null) return { invalidated: false }
    const registration = await ctx.db.get(registrationId)
    if (registration === null || registration.workspaceId !== args.workspaceId) {
      return { invalidated: false }
    }
    await markRegistrationInvalid(ctx, registrationId, args.reason, args.now ?? Date.now())
    return { invalidated: true }
  },
})

/**
 * The one write that condemns a registration, shared by the connect flow's
 * `invalid_client` and the refresh path's. A second copy would be a second
 * answer to "what does a rejected client look like in the row".
 */
async function markRegistrationInvalid(
  ctx: MutationCtx,
  registrationId: Id<'mcpClientRegistrations'>,
  reason: string,
  now: number,
): Promise<void> {
  await ctx.db.patch(registrationId, { invalidAt: now, invalidReason: reason.slice(0, 200) })
}

/**
 * The credential row, refused if it belongs to another workspace.
 *
 * Every refresh mutation re-reads through this rather than trusting what the
 * caller observed: the decision each of them makes is only sound if it is made
 * against the row as it is inside the transaction.
 */
async function requireCredential(
  ctx: MutationCtx,
  workspaceId: Id<'workspaces'>,
  serverId: Id<'mcpServers'>,
): Promise<Doc<'mcpServerCredentials'> | null> {
  const server = await ctx.db.get(serverId)
  if (server === null || server.workspaceId !== workspaceId) {
    throw new ConvexError({ error: 'server_not_found' })
  }
  const credential = await credentialForServer(ctx, serverId)
  return credential === null || credential.workspaceId !== workspaceId ? null : credential
}

/**
 * Clear the lease only if this caller still holds it. A caller whose lease
 * lapsed may still have the only correct answer, but the lease it lost now
 * belongs to whoever took it next.
 */
function releasedLease(
  credential: Doc<'mcpServerCredentials'>,
  owner: string,
): { leaseOwner?: undefined; leaseUntil?: undefined } {
  return credential.leaseOwner === owner ? { leaseOwner: undefined, leaseUntil: undefined } : {}
}

/** The credential as a caller that may not hold the refresh token sees it. */
function publicCredential(credential: Doc<'mcpServerCredentials'>) {
  return {
    generation: credential.generation,
    kind: credential.kind,
    accessToken: credential.accessToken,
    tokenType: credential.tokenType,
    accessExpiresAt: credential.accessExpiresAt,
  }
}

export async function credentialForServer(
  ctx: QueryCtx,
  serverId: Id<'mcpServers'>,
): Promise<Doc<'mcpServerCredentials'> | null> {
  return await ctx.db
    .query('mcpServerCredentials')
    .withIndex('by_server', q => q.eq('serverId', serverId))
    .unique()
}

export async function registrationForAuthorizationServer(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  authorizationServer: string,
): Promise<Doc<'mcpClientRegistrations'> | null> {
  const registration = await ctx.db
    .query('mcpClientRegistrations')
    .withIndex('by_workspace_and_as', q =>
      q
        .eq('workspaceId', workspaceId)
        .eq('authorizationServer', normalizeAuthorizationServer(authorizationServer)),
    )
    .unique()
  // An invalidated registration is not a registration: the next connect must
  // register again rather than reuse a client the authorization server refuses.
  return registration === null || registration.invalidAt !== undefined ? null : registration
}

/**
 * Disconnect deletes the credential whether or not revocation succeeded — a
 * token Duet can no longer present is worse than useless in the row. The
 * registration it pointed at deliberately survives: it is shared, and removing
 * it upstream is a call that can fail.
 */
export async function deleteCredentialsForServer(
  ctx: MutationCtx,
  serverId: Id<'mcpServers'>,
): Promise<void> {
  const credential = await credentialForServer(ctx, serverId)
  if (credential !== null) await ctx.db.delete(credential._id)
}

/** Never the client secret or the RFC 7592 access token: both are credentials. */
function publicRegistration(registration: Doc<'mcpClientRegistrations'>) {
  return {
    id: registration._id,
    authorizationServer: registration.authorizationServer,
    clientId: registration.clientId,
    tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
    clientSecretExpiresAt: registration.clientSecretExpiresAt,
    hasClientSecret: registration.clientSecret !== undefined,
    createdAt: registration.createdAt,
  }
}
