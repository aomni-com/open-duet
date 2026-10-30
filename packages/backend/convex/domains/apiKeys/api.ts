import type { GenericMutationCtx } from 'convex/server'
import { v } from 'convex/values'

import { assertSingleWorkspaceScopes } from '@repo/contract'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { mutation, query } from '../../_generated/server'
import { bootstrapUser } from '../invitations/model'
import { consumeRateLimit, preAuthRateLimitKey } from '../shared/rateLimits'
import { resolveEphemeralExpiry } from '../users/ephemeralModel'
import { createOrLinkUserForAuth } from '../users/model'
import { isLiveWorkspace } from '../workspaces/authorization'
import {
  recordCredentialUse as recordCredentialUseFor,
  resolveCredential as resolveCredentialAuth,
} from './authenticate'
import { effectiveDeviceCodeStatus } from './deviceApproval'
import {
  grantableScopesForWorkspaceRole,
  generateApiKey,
  hashSecret,
  keyPrefix,
  liveWorkspaceBySlug,
  requireApiInternalKey,
  workspaceIdsForScopes,
  writeAuditForWorkspaceIds,
} from './model'
import { insertApiKey } from './storage'
import { issueUserKey } from './userKeys'

type MutationCtx = GenericMutationCtx<DataModel>

const IMPERSONATION_MAX_TTL_SECONDS = 24 * 60 * 60

// The API authenticates a request with these two calls issued together: the
// query answers who the caller is, the mutation spends their budget. See
// ./authenticate.ts for why they are not one transaction.
export const resolveCredential = query({
  args: {
    internalKey: v.string(),
    hashedKey: v.string(),
    keyPrefix: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await resolveCredentialAuth(ctx, args)
  },
})

export const recordCredentialUse = mutation({
  args: {
    internalKey: v.string(),
    hashedKey: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await recordCredentialUseFor(ctx, args)
  },
})

export const mintImpersonationKey = mutation({
  args: {
    internalKey: v.string(),
    email: v.string(),
    workspaceSlug: v.optional(v.string()),
    ttlSeconds: v.number(),
    now: v.number(),
    createIfMissing: v.optional(v.boolean()),
    name: v.optional(v.string()),
    // Explicit, never inferred: `true` buys the 6h default, a timestamp names
    // the deletion moment (capped at 24h). Only valid while creating the user
    // — an existing identity can never be made disposable retroactively.
    ephemeral: v.optional(v.union(v.literal(true), v.number())),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const email = args.email.trim().toLowerCase()
    // Resolve (and thereby validate/cap) the expiry before touching anything,
    // so a past timestamp rejects with no side effects.
    const ephemeralExpiresAt =
      args.ephemeral === undefined ? undefined : resolveEphemeralExpiry(args.ephemeral, args.now)
    let user = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', email))
      .unique()
    let created = false
    if (user === null) {
      if (args.createIfMissing !== true) throw new Error('User not found')
      const createdUserId = await createOrLinkUserForAuth(ctx, {
        existingUserId: null,
        type: 'email',
        profile: { email, name: args.name, emailVerified: true },
      })
      user = await ctx.db
        .query('users')
        .withIndex('by_email', q => q.eq('email', email))
        .unique()
      if (user === null) throw new Error('Failed to create impersonation user')
      // Before bootstrap, deliberately: workspace birth derives the workspace's
      // `ephemeral` mark (→ the VM's tag) from the owner's expiry, for the
      // bootstrap workspace and every one the user creates later alike.
      if (ephemeralExpiresAt !== undefined) {
        await ctx.db.patch(user._id, { ephemeralExpiresAt })
      }
      await bootstrapUser(
        ctx,
        createdUserId as Id<'users'>,
        {},
        {
          requiresOnboarding: false,
        },
      )
      created = true
    } else if (ephemeralExpiresAt !== undefined && user.ephemeralExpiresAt === undefined) {
      // Disposability is a property of how an identity was born, never a
      // retrofit: a second caller must not be able to schedule the deletion of
      // a user (and their workspaces) it did not create. Re-login against an
      // already-ephemeral user is fine and keeps the ORIGINAL expiry — expiry
      // extension would let a chain of re-logins outlive the 24h cap.
      throw new Error('Cannot mark an existing user ephemeral')
    }

    const target = await resolveImpersonationWorkspace(ctx, user._id, args.workspaceSlug)
    const scopes = grantableScopesForWorkspaceRole(target.workspace.slug, target.membership.role)
    assertSingleWorkspaceScopes(scopes)
    const workspaceIds = await workspaceIdsForScopes(ctx, scopes)

    const key = generateApiKey()
    const hashedKey = await hashSecret(key)
    const prefix = keyPrefix(key)
    const ttlSeconds = Math.floor(args.ttlSeconds)
    if (ttlSeconds <= 0) throw new Error('Invalid impersonation TTL')
    const expiresAt = args.now + Math.min(ttlSeconds, IMPERSONATION_MAX_TTL_SECONDS) * 1000
    await insertApiKey(ctx, {
      kind: 'impersonation',
      userId: user._id,
      hashedKey,
      prefix,
      scopes,
      workspaceIds,
      expiresAt,
    })
    await writeAuditForWorkspaceIds(ctx, {
      workspaceIds,
      event: 'api_key.impersonation_issued',
      actorId: user._id,
      provenance: {
        actor: 'programmatic-login',
        targetEmail: email,
        prefix,
        scopes,
        expiresAt,
      },
      at: args.now,
    })
    return {
      token: key,
      prefix,
      expiresAt,
      userId: user._id,
      workspaceSlug: target.workspace.slug,
      created,
    }
  },
})

export const pollDeviceCode = mutation({
  args: {
    internalKey: v.string(),
    deviceCode: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const code = await ctx.db
      .query('deviceCodes')
      .withIndex('by_code', q => q.eq('code', args.deviceCode))
      .unique()
    if (code === null) {
      return { status: 'pending' as const, interval: 5 }
    }
    const status = effectiveDeviceCodeStatus(code, args.now)
    if (status === 'expired') {
      if (code.status !== 'expired') await ctx.db.patch(code._id, { status: 'expired' })
      return { status: 'expired' as const }
    }
    if (status === 'denied') return { status: 'denied' as const }
    if (status === 'consumed') return { status: 'consumed' as const }
    if (
      code.lastPolledAt !== undefined &&
      args.now - code.lastPolledAt < code.intervalSeconds * 1000
    ) {
      const interval = code.intervalSeconds + 5
      await ctx.db.patch(code._id, { intervalSeconds: interval })
      return { status: 'slow_down' as const, interval }
    }
    if (status === 'pending') {
      await ctx.db.patch(code._id, { lastPolledAt: args.now })
      return { status: 'pending' as const, interval: code.intervalSeconds }
    }
    if (code.userId === undefined) throw new Error('Approved device code missing user')

    const issued = await issueUserKey(ctx, {
      actorId: code.userId,
      name: code.clientName ?? 'Duet CLI',
      now: args.now,
    })
    await ctx.db.patch(code._id, { status: 'consumed', lastPolledAt: args.now })
    return { status: 'approved' as const, key: issued.key, prefix: issued.record.prefix }
  },
})

async function resolveImpersonationWorkspace(
  ctx: MutationCtx,
  userId: Id<'users'>,
  workspaceSlug: string | undefined,
): Promise<{ workspace: Doc<'workspaces'>; membership: Doc<'workspaceMembers'> }> {
  if (workspaceSlug !== undefined) {
    const workspace = await liveWorkspaceBySlug(ctx, workspaceSlug)
    if (workspace === null) throw new Error('Workspace not found')
    const membership = await ctx.db
      .query('workspaceMembers')
      .withIndex('by_workspace_and_user', q =>
        q.eq('workspaceId', workspace._id).eq('userId', userId),
      )
      .unique()
    if (membership === null) throw new Error('Workspace membership not found')
    return { workspace, membership }
  }

  const memberships = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_user_and_workspace', q => q.eq('userId', userId))
    // Programmatic login only needs one target workspace; 100 exceeds the expected membership count.
    .take(100)
  for (const membership of memberships.sort((a, b) => a._creationTime - b._creationTime)) {
    const workspace = await ctx.db.get(membership.workspaceId)
    if (workspace !== null && isLiveWorkspace(workspace.status)) return { workspace, membership }
  }
  throw new Error('User has no workspace')
}

export const consumePreAuthRateLimit = mutation({
  args: {
    internalKey: v.string(),
    identityHash: v.string(),
    // Deliberately not a closed `v.union`: the endpoint vocabulary is owned by
    // `@repo/contract`, and duplicating it as a validator makes every addition a
    // runtime rejection that type-checks. `preAuthRateLimitKey` is the guard.
    endpoint: v.string(),
    limit: v.number(),
    windowMs: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await consumeRateLimit(ctx, {
      key: preAuthRateLimitKey(args.endpoint, args.identityHash),
      limit: args.limit,
      windowMs: args.windowMs,
      now: args.now,
    })
  },
})
