import { getAuthUserId } from '@convex-dev/auth/server'
import { v } from 'convex/values'

import { internalQuery, query } from '../../_generated/server'
import { walletOf } from '../credits/wallet'

export const resendContact = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId)
    if (user === null || user.ephemeralExpiresAt !== undefined) return null
    return { email: user.email, firstName: user.firstName, lastName: user.lastName }
  },
})

// Session-gated identity probe. Projected — never the raw user row: the
// session surface may see its own identity and balance (the public billing
// overview already exposes them) but not Stripe internals.
export const current = query({
  args: {},
  handler: async ctx => {
    const userId = await getAuthUserId(ctx)
    if (userId === null) throw new Error('Unauthenticated')
    const user = await ctx.db.get(userId)
    if (user === null) throw new Error('Unauthenticated')
    const sourceBilling = user.billing
    const billing =
      sourceBilling === undefined
        ? {}
        : {
            autoTopupEnabled: sourceBilling.autoTopupEnabled,
            autoTopupThresholdMicroUsd: sourceBilling.autoTopupThresholdMicroUsd,
            autoTopupAmountMicroUsd: sourceBilling.autoTopupAmountMicroUsd,
            maxMonthlySpendMicroUsd: sourceBilling.maxMonthlySpendMicroUsd,
            monthlySpendMicroUsd: sourceBilling.monthlySpendMicroUsd,
            monthlySpendPeriodKey: sourceBilling.monthlySpendPeriodKey,
            paymentMethodReadyAt: sourceBilling.paymentMethodReadyAt,
            lastTopupError: sourceBilling.lastTopupError,
            consecutiveTopupFailures: sourceBilling.consecutiveTopupFailures,
            firstPaidAt: sourceBilling.firstPaidAt,
            trialExpiresAt: sourceBilling.trialExpiresAt,
          }
    return {
      _id: user._id,
      email: user.email,
      name: user.name,
      paidCreditBalanceMicroUsd: walletOf(user).paidMicroUsd,
      monthlyCreditBalanceMicroUsd: walletOf(user).monthlyMicroUsd,
      billing,
    }
  },
})
