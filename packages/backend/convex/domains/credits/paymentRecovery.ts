import type { Doc } from '../../_generated/dataModel'
import { AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD } from './subscriptions'

/**
 * Keep only the bounded failure window after recovery. Stripe has second precision,
 * so a recovery clears existing errors in that second; subsequent attempts still count.
 */
export function resetTopupFailureBilling(billing: Doc<'users'>['billing'], at: number) {
  if (at <= (billing?.paymentRecoveredAt ?? -1)) return billing ?? {}
  const failures = (
    billing?.topupFailureAts ??
    Array.from(
      {
        length: Math.min(
          billing?.consecutiveTopupFailures ?? 0,
          AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD,
        ),
      },
      () => billing?.lastTopupError?.at ?? 0,
    )
  ).filter(time => Math.floor(time / 1000) > Math.floor(at / 1000))
  return {
    ...billing,
    paymentRecoveredAt: at,
    topupFailureAts: failures,
    consecutiveTopupFailures: failures.length,
    lastTopupError:
      Math.floor((billing?.lastTopupError?.at ?? -1) / 1000) > Math.floor(at / 1000)
        ? billing?.lastTopupError
        : undefined,
  }
}
