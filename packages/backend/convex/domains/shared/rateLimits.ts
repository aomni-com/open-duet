import { isPreAuthRateLimitEndpoint } from '@repo/contract'

import type { MutationCtx } from '../../_generated/server'
import { consumeFixedWindow } from './fixedWindowRateLimit'

export type ModelGatewayRateLimitEndpoint = 'catalog' | 'generation' | 'services'

// The guard for both arguments the caller controls. The mutation takes the
// endpoint as a bare string rather than a closed `v.union`, so this is the only
// place a name outside the contract vocabulary can be turned away.
export function preAuthRateLimitKey(endpoint: string, identityHash: string): string {
  if (!isPreAuthRateLimitEndpoint(endpoint)) {
    throw new Error(`Unknown pre-auth rate-limit endpoint: ${endpoint}`)
  }
  if (!/^[a-f0-9]{64}$/.test(identityHash)) {
    throw new Error('Pre-auth rate-limit identity must be a SHA-256 hex digest')
  }
  return `preauth:${endpoint}:${identityHash}`
}

export function modelGatewayRateLimitKey(
  workspaceId: string,
  endpoint: ModelGatewayRateLimitEndpoint,
): string {
  return `mgw:${workspaceId}:${endpoint}`
}

export function browserSessionMintRateLimitKey(userId: string): string {
  return `bsmint:${userId}`
}

export function shareEmailRateLimitKey(userId: string): string {
  return `shareemail:${userId}`
}

/**
 * How a budget is split across counter documents.
 *
 * Convex serialises writers of a single document, so one counter row per
 * principal makes every concurrent request from that principal an OCC retry
 * (Convex error #1) — `apiKeys/api:recordCredentialUse` bumps this row on
 * every authenticated API request. Spreading a principal's window over several
 * rows means concurrent requests usually land on different documents.
 *
 * Each shard carries an equal slice of the budget and requests pick one at
 * random, so the ceiling is at most the budget — exact when the budget divides
 * evenly and traffic spreads evenly, conservative otherwise. The slice rounds
 * DOWN for that reason: most budgets here are operator-set at runtime (the
 * model gateway's per-workspace ceilings, the share-email daily cap) and do not
 * divide, and rounding up would hand back a ceiling above the number the
 * operator typed. Conservative is the right way round for a limiter: it is a
 * ceiling on abuse, not an allowance anyone is entitled to spend precisely.
 * A budget too small to divide stays whole — `MIN_SHARD_BUDGET` is the floor
 * below which the split would become the limit.
 */
const MAX_RATE_LIMIT_SHARDS = 8
const MIN_SHARD_BUDGET = 60

export function rateLimitShardCount(limit: number): number {
  return Math.max(1, Math.min(MAX_RATE_LIMIT_SHARDS, Math.floor(limit / MIN_SHARD_BUDGET)))
}

export async function consumeRateLimit(
  ctx: MutationCtx,
  args: { key: string; limit: number; windowMs: number; now: number },
) {
  const shards = rateLimitShardCount(args.limit)
  // Shard 0 keeps the bare key so an unsharded budget — and every row already
  // written before a budget grew — stays exactly where it was.
  const shard = shards === 1 ? 0 : Math.floor(Math.random() * shards)
  const key = shard === 0 ? args.key : `${args.key}#${shard}`
  return await consumeFixedWindow({
    limit: Math.floor(args.limit / shards),
    windowMs: args.windowMs,
    now: args.now,
    load: async () =>
      await ctx.db
        .query('rateLimits')
        .withIndex('by_key', q => q.eq('key', key))
        .unique(),
    insert: async state => {
      await ctx.db.insert('rateLimits', { key, ...state })
    },
    patch: async (row, state) => {
      await ctx.db.patch(row._id, state)
    },
  })
}
