import {
  AUTHENTICATED_API_RATE_LIMIT,
  AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS,
  type ApiCredentialKind,
} from '@repo/contract'

import type { MutationCtx } from '../../_generated/server'
import { consumeRateLimit } from '../shared/rateLimits'

// API workers can admit a whole page-load burst together. Keep its counters
// wider than the low-volume rails without increasing the principal's budget.
export const AUTHENTICATED_API_RATE_LIMIT_SHARDS = 32

export function authenticatedApiRateLimitKey(args: {
  credentialKind: ApiCredentialKind
  credentialId: string
  userId: string
}): string | null {
  switch (args.credentialKind) {
    case 'browser_session':
    case 'impersonation':
      return `api:user:${args.userId}`
    case 'system_vm':
      return null
    case 'user':
    case 'oauth':
    case 'app':
      return `api:credential:${args.credentialId}`
  }
}

export async function consumeAuthenticatedApiRateLimit(
  ctx: MutationCtx,
  args: {
    credentialKind: ApiCredentialKind
    credentialId: string
    userId: string
    now: number
  },
) {
  const key = authenticatedApiRateLimitKey(args)
  if (key === null) return { ok: true as const }
  const shard = Math.floor(Math.random() * AUTHENTICATED_API_RATE_LIMIT_SHARDS)
  const windowStart =
    Math.floor(args.now / AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS) *
    AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS
  // The widened layout is now the only authenticated API counter. Each shard
  // carries an equal slice of the full principal budget.
  return await consumeRateLimit(ctx, {
    key: `${key}#api:${shard}`,
    limit: Math.floor(AUTHENTICATED_API_RATE_LIMIT / AUTHENTICATED_API_RATE_LIMIT_SHARDS),
    windowMs: AUTHENTICATED_API_RATE_LIMIT_WINDOW_MS,
    now: args.now,
  })
}
