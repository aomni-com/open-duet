import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { consumeWorkspaceRateLimitWithDb } from '../modelGateway/rateLimit'

export const DEFAULT_FREE_SERVICE_RATE_LIMIT = 60
export const DEFAULT_PAID_SERVICE_RATE_LIMIT = 600
export const DEFAULT_SERVICE_RATE_LIMIT_WINDOW_MS = 60_000

export function serviceRateLimitConfig(paid: boolean): { limit: number; windowMs: number } {
  const freeLimit = positiveIntegerFromEnv(
    'DUET_SERVICE_PROXY_WORKSPACE_RATE_LIMIT',
    DEFAULT_FREE_SERVICE_RATE_LIMIT,
  )
  return {
    limit: paid
      ? positiveIntegerFromEnv(
          'DUET_SERVICE_PROXY_WORKSPACE_PAID_RATE_LIMIT',
          DEFAULT_PAID_SERVICE_RATE_LIMIT,
        )
      : freeLimit,
    windowMs: positiveIntegerFromEnv(
      'DUET_SERVICE_PROXY_WORKSPACE_RATE_LIMIT_WINDOW_MS',
      DEFAULT_SERVICE_RATE_LIMIT_WINDOW_MS,
    ),
  }
}

export async function consumeServiceRateLimitWithDb(
  ctx: MutationCtx,
  args: { workspaceId: Id<'workspaces'>; paid: boolean; now: number },
) {
  const config = serviceRateLimitConfig(args.paid)
  return await consumeWorkspaceRateLimitWithDb(ctx, {
    workspaceId: args.workspaceId,
    endpoint: 'services',
    limit: config.limit,
    windowMs: config.windowMs,
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
