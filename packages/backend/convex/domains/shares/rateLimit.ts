import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { consumeRateLimit, shareEmailRateLimitKey } from '../shared/rateLimits'

export const DEFAULT_SHARE_EMAIL_DAILY_LIMIT = 50
export const SHARE_EMAIL_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000

export function shareEmailDailyLimit(): number {
  const raw = process.env.DUET_SHARE_EMAIL_DAILY_LIMIT
  if (raw === undefined || raw.trim() === '') return DEFAULT_SHARE_EMAIL_DAILY_LIMIT
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SHARE_EMAIL_DAILY_LIMIT
}

export async function consumeShareEmailRateLimit(
  ctx: MutationCtx,
  userId: Id<'users'>,
  now: number,
): Promise<void> {
  const result = await consumeRateLimit(ctx, {
    key: shareEmailRateLimitKey(userId),
    limit: shareEmailDailyLimit(),
    windowMs: SHARE_EMAIL_RATE_LIMIT_WINDOW_MS,
    now,
  })
  if (!result.ok) {
    throw new Error(
      `Share email daily rate limit exceeded; retry after ${result.retryAfterSeconds} seconds`,
    )
  }
}
