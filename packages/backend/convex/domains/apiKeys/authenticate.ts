import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import { assertSingleWorkspaceScopes } from '@repo/contract'

import type { DataModel, Doc } from '../../_generated/dataModel'
import { apiKeyLastUsedWindowMs } from '../../config'
import { consumeAuthenticatedApiRateLimit } from './apiRateLimit'
import {
  authorizedApiKeyPayload,
  authorizedAppKeyPayload,
  authorizedBrowserSessionPayload,
  authorizedHumanPayload,
  authorizedSystemVmKeyPayload,
} from './model'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>

// Authentication is two Convex calls, not one. Resolving a credential reads a
// lot — key, grant, memberships, workspaces, onboarding state — and writes
// nothing, so it runs as a query: no transaction, no OCC. The two per-request
// writes (the lastUsedAt stamp, the rate-limit counter) live in
// `recordCredentialUse`, whose read set is one key row and one counter shard,
// so the write conflicts a parallel page load provokes are cheap to retry
// instead of re-running the whole resolution (Convex error #1).

type CredentialRefusal = 'unknown' | 'revoked' | 'expired'

export async function resolveCredential(
  ctx: QueryCtx,
  args: { hashedKey: string; keyPrefix: string; now: number },
) {
  const found = await findUsableKey(ctx, args)
  if (!found.ok) return found
  const { key } = found
  if (key.kind === 'oauth') {
    const grant = key.oauthGrantId === undefined ? null : await ctx.db.get(key.oauthGrantId)
    if (grant === null || grant.revokedAt !== undefined) {
      return { ok: false as const, reason: 'revoked' as const }
    }
  }
  // One session shape for the two credentials a person browses with. An
  // impersonated visit stands in for the user's own tab — same workspaces,
  // same scopes, same onboarding state — so it resolves through the browser
  // payload rather than the workspace-scoped API-key one. `workspaceSlug` at
  // mint time still says which workspace to open; it never narrows what the
  // session can see, because the minting secret could mint another token for
  // any of them anyway (SECURITY.md). Only the reported kind differs.
  if (key.kind === 'browser_session' || key.kind === 'impersonation') {
    return {
      ok: true as const,
      auth: {
        ...(await authorizedBrowserSessionPayload(ctx, key.userId)),
        credentialKind: key.kind,
      },
    }
  }
  if (key.kind === 'user') {
    return {
      ok: true as const,
      auth: {
        credentialKind: 'user' as const,
        credentialId: key._id,
        ...(await authorizedHumanPayload(ctx, key.userId)),
      },
    }
  }
  assertSingleWorkspaceScopes(key.scopes)
  if (key.kind === 'app') {
    const payload = await authorizedAppKeyPayload(ctx, key)
    if (payload === null) return { ok: false as const, reason: 'unknown' as const }
    return {
      ok: true as const,
      auth: { credentialKind: 'app' as const, credentialId: key._id, ...payload },
    }
  }
  if (key.kind === 'oauth') {
    return {
      ok: true as const,
      auth: {
        credentialKind: 'oauth' as const,
        credentialId: key._id,
        audience: key.audience,
        ...(await authorizedApiKeyPayload(ctx, key.userId, key.scopes, key.workspaceIds)),
      },
    }
  }
  return {
    ok: true as const,
    auth: {
      credentialKind: key.kind,
      // The credential document id names this key as a file-attribution
      // actor (api-key:<credentialId>, MAP L5). Browser sessions above
      // don't carry one — they attribute as web:<userId>.
      credentialId: key._id,
      ...(await authorizedSystemVmKeyPayload(ctx, key.userId, key.scopes, key.workspaceIds)),
    },
  }
}

// A credential that does not resolve writes nothing: unknown, revoked and
// expired keys neither spend budget nor move lastUsedAt, so a flood of dead
// tokens cannot heat any row.
export async function recordCredentialUse(
  ctx: MutationCtx,
  args: { hashedKey: string; now: number },
): Promise<{ ok: true } | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number }> {
  const found = await findUsableKey(ctx, args)
  if (!found.ok) return { ok: true }
  const { key } = found
  await stampCredentialUse(ctx, key, args.now)
  const rateLimit = await consumeAuthenticatedApiRateLimit(ctx, {
    credentialKind: key.kind,
    credentialId: key._id,
    userId: key.userId,
    now: args.now,
  })
  if (!rateLimit.ok) {
    return { ok: false, reason: 'rate_limited', retryAfterSeconds: rateLimit.retryAfterSeconds }
  }
  return { ok: true }
}

export async function stampCredentialUse(ctx: MutationCtx, key: Doc<'apiKeys'>, now: number) {
  // Every caller shares this throttle; an unthrottled gateway stamp would
  // invalidate ordinary API usage counters reading this same credential.
  if (key.lastUsedAt === undefined || now - key.lastUsedAt >= apiKeyLastUsedWindowMs()) {
    await ctx.db.patch(key._id, { lastUsedAt: now })
  }
}

async function findUsableKey(
  ctx: QueryCtx,
  args: { hashedKey: string; keyPrefix?: string; now: number },
): Promise<{ ok: true; key: Doc<'apiKeys'> } | { ok: false; reason: CredentialRefusal }> {
  const key = await ctx.db
    .query('apiKeys')
    .withIndex('by_hashedKey', q => q.eq('hashedKey', args.hashedKey))
    .unique()
  if (key === null || (args.keyPrefix !== undefined && key.prefix !== args.keyPrefix)) {
    return { ok: false, reason: 'unknown' }
  }
  if (key.revokedAt !== undefined) return { ok: false, reason: 'revoked' }
  if (key.expiresAt !== undefined && key.expiresAt <= args.now) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, key }
}
