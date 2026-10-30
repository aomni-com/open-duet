import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import {
  consumeRateLimit,
  modelGatewayRateLimitKey,
  type ModelGatewayRateLimitEndpoint,
} from '../shared/rateLimits'

export type WorkspaceRateLimitEndpoint = ModelGatewayRateLimitEndpoint

// Default: 600 requests per workspace per endpoint per 60-second fixed window.
export const DEFAULT_WORKSPACE_RATE_LIMIT = 600
export const DEFAULT_WORKSPACE_RATE_LIMIT_WINDOW_MS = 60_000

export function workspaceRateLimitConfig(endpoint: WorkspaceRateLimitEndpoint): {
  limit: number
  windowMs: number
} {
  const fallbackLimit = positiveIntegerFromEnv(
    'DUET_MODEL_GATEWAY_WORKSPACE_RATE_LIMIT',
    DEFAULT_WORKSPACE_RATE_LIMIT,
  )
  const endpointLimit = positiveIntegerFromEnv(
    endpoint === 'catalog'
      ? 'DUET_MODEL_GATEWAY_WORKSPACE_CATALOG_RATE_LIMIT'
      : 'DUET_MODEL_GATEWAY_WORKSPACE_GENERATION_RATE_LIMIT',
    fallbackLimit,
  )
  return {
    limit: endpointLimit,
    windowMs: positiveIntegerFromEnv(
      'DUET_MODEL_GATEWAY_WORKSPACE_RATE_LIMIT_WINDOW_MS',
      DEFAULT_WORKSPACE_RATE_LIMIT_WINDOW_MS,
    ),
  }
}

export async function consumeWorkspaceRateLimitWithDb(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<'workspaces'>
    endpoint: WorkspaceRateLimitEndpoint
    limit: number
    windowMs: number
    now: number
  },
): Promise<
  { ok: true; remaining: number; resetAt: number } | { ok: false; retryAfterSeconds: number }
> {
  return await consumeRateLimit(ctx, {
    key: modelGatewayRateLimitKey(args.workspaceId, args.endpoint),
    limit: args.limit,
    windowMs: args.windowMs,
    now: args.now,
  })
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}
