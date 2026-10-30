import type { GatewayBlock, GatewayPreflightBlock } from '@repo/contract'

import { duetAppHref } from '../../config'

export function blocked(block: GatewayBlock): GatewayPreflightBlock {
  return { proceed: false as const, block }
}

export function unauthorizedBlock(
  code: 'missing_api_key' | 'invalid_api_key' | 'expired_api_key',
): GatewayBlock {
  return { status: 401, body: { error: 'unauthorized', code } }
}

export function insufficientScopeBlock(scope: string): GatewayBlock {
  return { status: 403, body: { error: 'insufficient_scope', code: 'insufficient_scope', scope } }
}

export function preflightBlock(
  reason: 'subscription_required' | 'insufficient_credits' | 'monthly_cap' | undefined,
  tier: 'account' | 'workspace' | undefined,
  balanceMicroUsd: number,
): GatewayBlock {
  const code = reason ?? 'insufficient_credits'
  if (code === 'subscription_required') {
    return {
      status: 402,
      body: {
        error: 'subscription_required',
        code: 'subscription_required',
        billingUrl: billingUrl(),
      },
    }
  }
  if (code === 'monthly_cap') {
    return {
      status: 402,
      body: {
        error: 'monthly_cap',
        code: 'monthly_cap',
        tier: tier ?? 'account',
        balanceMicroUsd,
        autoTopupScheduled: false,
        billingUrl: billingUrl(),
      },
    }
  }
  return {
    status: 402,
    body: {
      error: 'insufficient_credits',
      code: 'insufficient_credits',
      tier: 'account',
      balanceMicroUsd,
      autoTopupScheduled: false,
      billingUrl: billingUrl(),
    },
  }
}

export function paymentBlock(code: 'subscription_inactive' | 'payment_required'): GatewayBlock {
  if (code === 'subscription_inactive') {
    return {
      status: 402,
      body: {
        error: 'subscription_inactive',
        code: 'subscription_inactive',
        billingUrl: billingUrl(),
      },
    }
  }
  return {
    status: 402,
    body: { error: 'payment_required', code: 'payment_required', billingUrl: billingUrl() },
  }
}

export function modelNotAllowedBlock(): GatewayBlock {
  return {
    status: 403,
    body: { error: 'model_not_allowed', code: 'model_not_allowed' },
  }
}

export function rateLimitBlock(retryAfterSeconds: number): GatewayBlock {
  return {
    status: 429,
    body: { error: 'rate_limited', code: 'rate_limited', retryAfterSeconds },
  }
}

function billingUrl(): string {
  return duetAppHref('/settings/billing')
}
