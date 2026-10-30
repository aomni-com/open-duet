import { v } from 'convex/values'

import { mutation, query } from '../_generated/server'
import { requireApiInternalKey } from '../domains/apiKeys/model'
import { retireUserIdentity } from '../domains/users/retire'

const SYNTHETIC_EMAIL_MARKER = 'staging-e2e-'

export const userByEmailForTest = query({
  args: { internalKey: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    assertStagingE2ESyntheticEmail(args.email)
    return await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', args.email.trim().toLowerCase()))
      .unique()
  },
})

/** Bind a pre-created test-clock customer before subscription Checkout.
 * The email guard confines this seam to disposable staging-E2E identities.
 */
export const bindStripeTestCustomerForTest = mutation({
  args: {
    internalKey: v.string(),
    email: v.string(),
    stripeCustomerId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const email = assertStagingE2ESyntheticEmail(args.email)
    if (!args.stripeCustomerId.startsWith('cus_')) throw new Error('Invalid Stripe customer id')
    const user = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', email))
      .unique()
    if (user === null) throw new Error('Synthetic staging E2E user not found')
    if (
      user.billing?.stripeCustomerId !== undefined &&
      user.billing.stripeCustomerId !== args.stripeCustomerId
    ) {
      throw new Error('Synthetic staging E2E user already has another Stripe customer')
    }
    await ctx.db.patch(user._id, {
      billing: { ...user.billing, stripeCustomerId: args.stripeCustomerId },
    })
    return { userId: user._id }
  },
})

export const orphanedResourcesByRunIdForTest = query({
  args: {
    internalKey: v.string(),
    runId: v.string(),
    emails: v.array(v.string()),
    workspaceNames: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    if (!args.runId.startsWith(SYNTHETIC_EMAIL_MARKER))
      throw new Error('Invalid staging E2E run id')
    if (args.emails.length > 10) throw new Error('Too many staging E2E identities')
    if (args.workspaceNames.length > 10) throw new Error('Too many staging E2E workspace names')
    const emails = [...new Set(args.emails.map(assertStagingE2ESyntheticEmail))]
    const workspaceNames = [...new Set(args.workspaceNames)]
    if (workspaceNames.some(name => !name.includes(args.runId))) {
      throw new Error('Workspace name is not tagged by this run')
    }
    const users = (
      await Promise.all(
        emails.map(email =>
          ctx.db
            .query('users')
            .withIndex('by_email', q => q.eq('email', email))
            .unique(),
        ),
      )
    ).filter(user => user !== null)
    // Cleanup names must match exactly; the remaining search index has relevance
    // semantics, so this test-only sweep filters the compound index.
    const workspaceBuckets = await Promise.all(
      workspaceNames.map(name =>
        ctx.db
          .query('workspaces')
          .withIndex('by_slug_status')
          .filter(q => q.eq(q.field('name'), name))
          .take(11),
      ),
    )
    if (workspaceBuckets.some(bucket => bucket.length > 10)) {
      throw new Error('Staging E2E workspace name is not unique enough to sweep')
    }
    const workspaces = [...new Map(workspaceBuckets.flat().map(row => [row._id, row])).values()]
    const inviteBuckets = await Promise.all(
      workspaces.map(workspace =>
        ctx.db
          .query('workspaceInvites')
          .withIndex('by_workspace_createdAt', q => q.eq('workspaceId', workspace._id))
          .take(1_001),
      ),
    )
    if (inviteBuckets.some(bucket => bucket.length > 1_000)) {
      throw new Error('Staging E2E workspace has too many invites')
    }
    const emailSet = new Set(emails)
    return {
      users: users.map(user => ({ id: user._id, label: user.email })),
      workspaces: workspaces
        .filter(workspace => workspace.status !== 'deleted')
        .map(workspace => ({ id: workspace._id, label: workspace.name })),
      invites: inviteBuckets
        .flat()
        .filter(invite => invite.activeKey !== undefined && emailSet.has(invite.email))
        .map(invite => ({ id: invite._id, label: invite.email })),
    }
  },
})

export const expireInviteForTest = mutation({
  args: {
    internalKey: v.string(),
    inviteId: v.id('workspaceInvites'),
    expectedEmail: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const expectedEmail = assertStagingE2ESyntheticEmail(args.expectedEmail)
    const invite = await ctx.db.get(args.inviteId)
    if (invite === null || invite.email !== expectedEmail) {
      throw new Error('Invite fixture identity mismatch')
    }
    if (invite.revokedAt !== undefined) {
      throw new Error('Revoked staging E2E invites cannot be expired')
    }
    await ctx.db.patch(invite._id, { expiresAt: args.now - 1 })
    return { expiresAt: args.now - 1 }
  },
})

export const revokeApiKeyByHashForTest = mutation({
  args: {
    internalKey: v.string(),
    hashedKey: v.string(),
    expectedPrefix: v.string(),
    expectedOwnerEmail: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const key = await ctx.db
      .query('apiKeys')
      .withIndex('by_hashedKey', q => q.eq('hashedKey', args.hashedKey))
      .unique()
    if (key === null) return { revoked: true as const }
    const owner = await ctx.db.get(key.userId)
    if (owner === null) throw new Error('API key owner not found')
    if (
      key.prefix !== args.expectedPrefix ||
      owner.email !== args.expectedOwnerEmail.trim().toLowerCase()
    ) {
      throw new Error('API key cleanup identity mismatch')
    }
    if (key.kind !== 'impersonation') {
      assertStagingE2ESyntheticEmail(owner.email)
    }
    await ctx.db.patch(key._id, { revokedAt: key.revokedAt ?? args.now ?? Date.now() })
    return { revoked: true as const }
  },
})

export const oauthRunResourcesForTest = query({
  args: {
    internalKey: v.string(),
    email: v.string(),
    clientIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const email = assertStagingE2ESyntheticEmail(args.email)
    if (args.clientIds.length > 5) throw new Error('Too many staging E2E OAuth clients')
    const user = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', email))
      .unique()
    const clients = (
      await Promise.all(
        [...new Set(args.clientIds)].map(clientId =>
          ctx.db
            .query('oauthClients')
            .withIndex('by_clientId', q => q.eq('clientId', clientId))
            .unique(),
        ),
      )
    ).filter(client => client !== null)
    const grants =
      user === null
        ? []
        : await ctx.db
            .query('oauthGrants')
            .withIndex('by_userId', q => q.eq('userId', user._id))
            .take(101)
    if (grants.length > 100) throw new Error('Synthetic staging user has too many OAuth grants')
    const refreshTokens = (
      await Promise.all(
        grants.map(grant =>
          ctx.db
            .query('oauthRefreshTokens')
            .withIndex('by_grantId', q => q.eq('grantId', grant._id))
            .take(101),
        ),
      )
    ).flat()
    if (refreshTokens.length > 100) throw new Error('Staging OAuth run has too many refresh rows')
    const keys = (
      await Promise.all(
        grants.map(grant =>
          ctx.db
            .query('apiKeys')
            .withIndex('by_oauthGrantId', q => q.eq('oauthGrantId', grant._id))
            .take(101),
        ),
      )
    ).flat()
    if (keys.length > 100) throw new Error('Staging OAuth run has too many access keys')
    const clientIdSet = new Set(args.clientIds)
    const requestRows = await ctx.db.query('oauthAuthorizationRequests').take(10_001)
    if (requestRows.length > 10_000) throw new Error('Too many OAuth authorization requests')
    const requests = requestRows.filter(
      request => clientIdSet.has(request.clientId) || request.userId === user?._id,
    )
    const requestIds = new Set(requests.map(request => request._id))
    const codeRows = await ctx.db.query('oauthAuthorizationCodes').take(10_001)
    if (codeRows.length > 10_000) throw new Error('Too many OAuth authorization codes')
    const codes = codeRows.filter(
      code => requestIds.has(code.requestId) || code.userId === user?._id,
    )
    return {
      clientIds: clients.map(client => client.clientId),
      requestIds: requests.map(request => request._id),
      codeIds: codes.map(code => code._id),
      grants: grants.map(grant => ({ id: grant._id, clientId: grant.clientId })),
      keyIds: keys.map(key => key._id),
      refreshTokenIds: refreshTokens.map(token => token._id),
    }
  },
})

/**
 * Hard-delete only the OAuth graph owned by one disposable staging identity
 * and the exact DCR client ids its run recorded. Product revocation
 * remains the user-facing behavior; this seam exists solely so live
 * acceptance leaves no hashed credential or cached client residue.
 */
export const cleanupOauthRunForTest = mutation({
  args: {
    internalKey: v.string(),
    email: v.string(),
    clientIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const email = assertStagingE2ESyntheticEmail(args.email)
    if (args.clientIds.length > 5) throw new Error('Too many staging E2E OAuth clients')
    const user = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', email))
      .unique()
    if (user === null) return { cleaned: true as const }

    const grants = await ctx.db
      .query('oauthGrants')
      .withIndex('by_userId', q => q.eq('userId', user._id))
      .take(101)
    if (grants.length > 100) throw new Error('Synthetic staging user has too many OAuth grants')
    for (const grant of grants) {
      const refreshTokens = await ctx.db
        .query('oauthRefreshTokens')
        .withIndex('by_grantId', q => q.eq('grantId', grant._id))
        .take(101)
      if (refreshTokens.length > 100)
        throw new Error('Staging OAuth grant has too many refresh rows')
      for (const token of refreshTokens) await ctx.db.delete(token._id)
      const keys = await ctx.db
        .query('apiKeys')
        .withIndex('by_oauthGrantId', q => q.eq('oauthGrantId', grant._id))
        .take(101)
      if (keys.length > 100) throw new Error('Staging OAuth grant has too many access keys')
      for (const key of keys) await ctx.db.delete(key._id)
    }

    const clientIdSet = new Set(args.clientIds)
    const requestRows = await ctx.db.query('oauthAuthorizationRequests').take(10_001)
    if (requestRows.length > 10_000) throw new Error('Too many OAuth authorization requests')
    const requests = requestRows.filter(
      request => clientIdSet.has(request.clientId) || request.userId === user._id,
    )
    const requestIds = new Set(requests.map(request => request._id))
    const codeRows = await ctx.db.query('oauthAuthorizationCodes').take(10_001)
    if (codeRows.length > 10_000) throw new Error('Too many OAuth authorization codes')
    const codes = codeRows.filter(
      code => requestIds.has(code.requestId) || code.userId === user._id,
    )
    for (const code of codes) await ctx.db.delete(code._id)
    for (const grant of grants) await ctx.db.delete(grant._id)
    for (const request of requests) await ctx.db.delete(request._id)
    for (const clientId of clientIdSet) {
      const client = await ctx.db
        .query('oauthClients')
        .withIndex('by_clientId', q => q.eq('clientId', clientId))
        .unique()
      if (client !== null) await ctx.db.delete(client._id)
    }
    return { cleaned: true as const }
  },
})

/**
 * Retire a unique staging-E2E identity after its workspaces have been deleted.
 * Keeping the user row preserves audit actor references; credentials and the
 * run-tagged address are removed so the synthetic identity cannot be reused or
 * found by an orphan sweep.
 */
export const retireUserByEmailForTest = mutation({
  args: { internalKey: v.string(), email: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const email = args.email.trim().toLowerCase()
    assertStagingE2ESyntheticEmail(email)
    const user = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', email))
      .unique()
    if (user === null) return { retired: true as const }
    // The erasure itself has one owner, shared with the ephemeral-identity
    // expiry sweep; this wrapper only contributes the synthetic-email guard.
    await retireUserIdentity(ctx, { userId: user._id, now: args.now ?? Date.now() })
    return { retired: true as const }
  },
})

function assertStagingE2ESyntheticEmail(email: string): string {
  const canonical = email.trim().toLowerCase()
  const isRunMailbox =
    canonical.endsWith('@agentmail.to') && canonical.includes(SYNTHETIC_EMAIL_MARKER)
  const isRunAdmin =
    canonical.startsWith(SYNTHETIC_EMAIL_MARKER) && canonical.endsWith('-admin@duet.so')
  if (!isRunMailbox && !isRunAdmin) {
    throw new Error('Only staging E2E synthetic identities are allowed')
  }
  return canonical
}
