import type { GenericMutationCtx } from 'convex/server'
import { v } from 'convex/values'

import { ApiKeyNameStorageSchema, BROWSER_SESSION_TTL_MS } from '@repo/contract'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { mutation } from '../../_generated/server'
import { duetAppHref } from '../../config'
import { browserSessionMintRateLimitKey, consumeRateLimit } from '../shared/rateLimits'
import { requireCurrentUserId } from '../workspaces/authorization'
import {
  DEVICE_CODE_EXPIRES_IN_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  generateApiKey,
  generateDeviceCode,
  generateUserCode,
  hashSecret,
  keyPrefix,
  liveWorkspaceMemberships,
  mintAppKeyForApp,
  mintVmModelKeyForWorkspace,
  requireApiInternalKey,
  revokeVmModelKeyForWorkspace,
  revokeAppKeysForApp,
  rotateAppKeyForApp,
  rotateVmModelKeyForWorkspace,
  writeAuditForWorkspaceIds,
} from './model'
import { insertApiKey } from './storage'

type MutationCtx = GenericMutationCtx<DataModel>

// The unit this bounds is a page load, not a mint. A browser arriving without
// a session cookie fans its requests out across lambdas that share no memory,
// and each of them needs a credential of its own: unlike a rotation there is
// no previous key to stamp, so the burst cannot be collapsed to one winner and
// every sibling mints. A budget narrower than one page load turns an ordinary
// cold start into failed requests. The number is also what decides how many
// counter documents the budget is spread over (`rateLimitShardCount`), and a
// burst this wide must not land on one hot row, so it is set several loads
// wide rather than exactly one.
export const BROWSER_SESSION_MINT_LIMIT = 240
// Exported so the rate-limit test bursts against the real bound and the real
// window rather than a copy of them that can drift out from under it.
export const BROWSER_SESSION_MINT_WINDOW_MS = 60 * 1000
const BROWSER_SESSION_PRUNE_LIMIT = 100
const BROWSER_SESSION_ROTATION_GRACE_MS = 60 * 1000
// How long after a rotation a request still presenting the previous key is a
// sibling of that rotation (hand back null, write nothing) rather than a browser
// that never received the replacement (rotate again). Must sit well inside the
// grace so a lost handoff recovers before the old credential dies.
export const BROWSER_SESSION_ROTATION_HANDOFF_MS = 10 * 1000

export const mintBrowserSession = mutation({
  args: {
    previousHashedKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actorId = await requireCurrentUserId(ctx)
    const now = Date.now()

    // Resolve the previous key before touching anything contended: a sibling
    // that bails here has read nothing another sibling writes except this
    // one row, so its retry is cheap and it never joins the write race.
    let previous: Extract<Doc<'apiKeys'>, { scopes: string[] }> | undefined
    const previousHashedKey = args.previousHashedKey
    if (previousHashedKey !== undefined) {
      const candidate = await ctx.db
        .query('apiKeys')
        .withIndex('by_hashedKey', q => q.eq('hashedKey', previousHashedKey))
        .unique()
      if (
        candidate !== null &&
        candidate.kind === 'browser_session' &&
        candidate.userId === actorId &&
        candidate.revokedAt === undefined &&
        (candidate.expiresAt === undefined || candidate.expiresAt > now)
      ) {
        previous = candidate
      }
    }
    if (
      previous?.rotatedAt !== undefined &&
      now - previous.rotatedAt < BROWSER_SESSION_ROTATION_HANDOFF_MS
    ) {
      return null
    }

    await consumeBrowserSessionMintRateLimit(ctx, actorId, now)
    await pruneBrowserSessions(ctx, actorId, now)

    const liveMemberships = await liveWorkspaceMemberships(ctx, actorId)
    const workspaceIds = liveMemberships.map(({ workspace }) => workspace._id)
    const token = generateApiKey()
    const prefix = keyPrefix(token)
    const expiresAt = now + BROWSER_SESSION_TTL_MS
    await insertApiKey(ctx, {
      kind: 'browser_session',
      userId: actorId,
      hashedKey: await hashSecret(token),
      prefix,
      scopes: [],
      workspaceIds,
      expiresAt,
      // Born used. The browser fires its page-load burst with this token the
      // instant it lands; an unstamped row would make every request in that
      // burst a lastUsedAt writer to one fresh document, and a sibling mint
      // reading this user's sessions (pruneBrowserSessions) loses to each of
      // them in turn (Convex error #1).
      lastUsedAt: now,
    })
    if (previous !== undefined) {
      const graceExpiresAt = now + BROWSER_SESSION_ROTATION_GRACE_MS
      await ctx.db.patch(previous._id, {
        expiresAt: Math.min(previous.expiresAt ?? graceExpiresAt, graceExpiresAt),
        rotatedAt: now,
      })
    }
    await writeAuditForWorkspaceIds(ctx, {
      workspaceIds,
      event:
        previous === undefined
          ? 'api_key.browser_session_issued'
          : 'api_key.browser_session_rotated',
      actorId,
      provenance: {
        prefix,
        expiresAt,
        ...(previous === undefined ? {} : { oldPrefixes: [previous.prefix] }),
      },
      at: now,
    })
    return { token, prefix, expiresAt }
  },
})

export const revokeBrowserSession = mutation({
  args: {
    hashedKey: v.string(),
  },
  handler: async (ctx, args) => {
    const actorId = await requireCurrentUserId(ctx)
    const key = await ctx.db
      .query('apiKeys')
      .withIndex('by_hashedKey', q => q.eq('hashedKey', args.hashedKey))
      .unique()
    if (key === null || key.kind !== 'browser_session' || key.userId !== actorId) {
      return { revoked: false as const }
    }
    if (key.revokedAt !== undefined) return { revoked: true as const, revokedAt: key.revokedAt }
    const revokedAt = Date.now()
    // Expiry collapses to the revocation instant so the row joins the lapsed
    // range housekeeping scans. `revokedAt` is still what the validator
    // reports, so the refusal stays `revoked` rather than becoming `expired`.
    await ctx.db.patch(key._id, { revokedAt, expiresAt: revokedAt })
    await writeAuditForWorkspaceIds(ctx, {
      workspaceIds: key.workspaceIds,
      event: 'api_key.browser_session_revoked',
      actorId,
      provenance: { prefix: key.prefix },
      at: revokedAt,
    })
    return { revoked: true as const, revokedAt }
  },
})

export const mintVmModelKey = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await mintVmModelKeyForWorkspace(ctx, { workspaceId: args.workspaceId, now: args.now })
  },
})

export const rotateVmModelKey = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await rotateVmModelKeyForWorkspace(ctx, { workspaceId: args.workspaceId, now: args.now })
  },
})

export const revokeVmModelKey = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await revokeVmModelKeyForWorkspace(ctx, { workspaceId: args.workspaceId, now: args.now })
  },
})

export const mintAppKey = mutation({
  args: { internalKey: v.string(), appId: v.id('apps'), now: v.number() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await mintAppKeyForApp(ctx, { appId: args.appId, now: args.now })
  },
})

export const rotateAppKey = mutation({
  args: { internalKey: v.string(), appId: v.id('apps'), now: v.number() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await rotateAppKeyForApp(ctx, { appId: args.appId, now: args.now })
  },
})

export const revokeAppKey = mutation({
  args: { internalKey: v.string(), appId: v.id('apps'), now: v.number() },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const app = await ctx.db.get(args.appId)
    if (app === null) return { revoked: 0, prefixes: [] }
    return await revokeAppKeysForApp(ctx, { app, now: args.now })
  },
})

export const createDeviceCode = mutation({
  args: { clientName: v.optional(v.string()), verificationUri: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now()
    const code = generateDeviceCode()
    const userCode = await uniqueUserCode(ctx)
    await ctx.db.insert('deviceCodes', {
      code,
      userCode,
      status: 'pending',
      ...(args.clientName === undefined
        ? {}
        : { clientName: ApiKeyNameStorageSchema.parse(args.clientName) }),
      expiresAt: now + DEVICE_CODE_EXPIRES_IN_SECONDS * 1000,
      intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
    })
    return {
      device_code: code,
      user_code: userCode,
      verification_uri: args.verificationUri ?? duetAppHref('/device'),
      expires_in: DEVICE_CODE_EXPIRES_IN_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    }
  },
})

async function consumeBrowserSessionMintRateLimit(
  ctx: MutationCtx,
  userId: Id<'users'>,
  now: number,
): Promise<void> {
  const result = await consumeRateLimit(ctx, {
    key: browserSessionMintRateLimitKey(userId),
    limit: BROWSER_SESSION_MINT_LIMIT,
    windowMs: BROWSER_SESSION_MINT_WINDOW_MS,
    now,
  })
  if (!result.ok) {
    throw new Error('Browser session mint rate limit exceeded')
  }
}

async function pruneBrowserSessions(
  ctx: MutationCtx,
  userId: Id<'users'>,
  now: number,
): Promise<void> {
  // Only what has already lapsed. Reading the user's whole browser-session
  // range would put every sibling of a cold-start burst in a read set the next
  // sibling's insert invalidates (Convex error #1); a live session is inserted
  // a full TTL ahead of `now` and so falls outside this range. Revocation
  // collapses expiry to the revocation instant, which is how a revoked session
  // still reaches this scan.
  const lapsed = await ctx.db
    .query('apiKeys')
    .withIndex('by_userId_kind_expiresAt', q =>
      q.eq('userId', userId).eq('kind', 'browser_session').lte('expiresAt', now),
    )
    .take(BROWSER_SESSION_PRUNE_LIMIT)
  for (const session of lapsed) {
    await ctx.db.delete(session._id)
  }
}

async function uniqueUserCode(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const userCode = generateUserCode()
    const existing = await ctx.db
      .query('deviceCodes')
      .withIndex('by_userCode', q => q.eq('userCode', userCode))
      .first()
    if (existing === null) return userCode
  }
  throw new Error('Could not allocate user code')
}
