import { z } from 'zod'

export const VERCEL_AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh'
export const VERCEL_AI_GATEWAY_REFERER = 'https://app.duet.so'
export const VERCEL_AI_GATEWAY_TITLE = 'Duet'

export const RUNNERS_CGROUP = '/sys/fs/cgroup/runners'
export const X_DUET_GATEWAY_HEADER = 'x-duet-gateway'
export const X_DUET_GATEWAY_CODE_HEADER = 'x-duet-gateway-code'
export const X_DUET_TIER_HEADER = 'x-duet-tier'
export const X_DUET_WORKSPACE_HEADER = 'x-duet-workspace'

// Data-plane lifecycle refusals are shared by API routes and their public
// schemas. They stay distinct from account-level subscription errors and from
// `not_found`, because callers can retry provisioning/unhealthy states while
// an archived workspace needs explicit recommissioning.
export const WORKSPACE_PAUSED_ERROR = 'workspace_paused' as const
export const WORKSPACE_PROVISIONING_ERROR = 'workspace_provisioning' as const
export const WORKSPACE_UNHEALTHY_ERROR = 'workspace_unhealthy' as const
export const WORKSPACE_ARCHIVED_ERROR = 'workspace_archived' as const
export const WorkspaceGatewayRefusalErrorSchema = z.enum([
  WORKSPACE_PAUSED_ERROR,
  WORKSPACE_PROVISIONING_ERROR,
  WORKSPACE_UNHEALTHY_ERROR,
  WORKSPACE_ARCHIVED_ERROR,
])

export const BLOCKED_UPSTREAM_PATHS = new Set(['/v1/credits', '/v1/generation'])

export const STRIPPED_UPSTREAM_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  X_DUET_TIER_HEADER,
  X_DUET_WORKSPACE_HEADER,
  'connection',
  'content-length',
  'host',
  'transfer-encoding',
])

export const SERVICE_PROXY_STRIPPED_REQUEST_HEADERS = new Set([
  ...STRIPPED_UPSTREAM_REQUEST_HEADERS,
  'xi-api-key',
])

export const STRIPPED_UPSTREAM_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
])

export const RECONCILE_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000] as const

export const GATEWAY_GENERATION_MODALITIES = ['text', 'image', 'video', 'audio'] as const
export const GATEWAY_BILLING_MODES = ['post_response', 'reservation'] as const
export const GATEWAY_REQUEST_KINDS = ['catalog', 'generation'] as const

export const GenerationModalitySchema = z.enum(GATEWAY_GENERATION_MODALITIES)
export type GenerationModality = z.infer<typeof GenerationModalitySchema>

export const BillingModeSchema = z.enum(GATEWAY_BILLING_MODES)
export type BillingMode = z.infer<typeof BillingModeSchema>

export const RequestKindSchema = z.enum(GATEWAY_REQUEST_KINDS)
export type RequestKind = z.infer<typeof RequestKindSchema>

export const GatewayBlockSchema = z.union([
  z.object({
    status: z.literal(401),
    body: z.object({
      error: z.literal('unauthorized'),
      code: z.enum(['missing_api_key', 'invalid_api_key', 'expired_api_key']),
    }),
  }),
  z.object({
    status: z.literal(402),
    body: z.object({
      error: z.literal('insufficient_credits'),
      code: z.literal('insufficient_credits'),
      tier: z.literal('account'),
      balanceMicroUsd: z.number(),
      autoTopupScheduled: z.boolean(),
      billingUrl: z.string(),
    }),
  }),
  z.object({
    status: z.literal(402),
    body: z.object({
      error: z.literal('monthly_cap'),
      code: z.literal('monthly_cap'),
      tier: z.enum(['account', 'workspace']),
      balanceMicroUsd: z.number(),
      autoTopupScheduled: z.boolean(),
      billingUrl: z.string(),
    }),
  }),
  z.object({
    status: z.literal(402),
    body: z.object({
      error: z.literal('subscription_required'),
      code: z.literal('subscription_required'),
      billingUrl: z.string(),
    }),
  }),
  z.object({
    status: z.literal(402),
    body: z.object({
      // Workspace servicing is paused; account entitlement uses subscription_required.
      error: z.literal('subscription_inactive'),
      code: z.literal('subscription_inactive'),
      billingUrl: z.string(),
    }),
  }),
  z.object({
    status: z.literal(402),
    body: z.object({
      error: z.literal('payment_required'),
      code: z.literal('payment_required'),
      billingUrl: z.string(),
    }),
  }),
  z.object({
    status: z.literal(403),
    body: z.object({
      error: z.literal('model_not_allowed'),
      code: z.literal('model_not_allowed'),
    }),
  }),
  z.object({
    status: z.literal(409),
    body: z.object({
      error: z.literal('onboarding_required'),
      code: z.literal('onboarding_required'),
      onboardingUrl: z.string(),
    }),
  }),
  z.object({
    status: z.literal(403),
    body: z.object({
      error: z.literal('tier_not_allowed'),
      code: z.literal('tier_not_allowed'),
    }),
  }),
  z.object({
    status: z.literal(403),
    body: z.object({
      error: z.string(),
      code: z.literal('endpoint_not_available'),
    }),
  }),
  z.object({
    status: z.literal(403),
    body: z.object({
      error: z.literal('insufficient_scope'),
      code: z.literal('insufficient_scope'),
      scope: z.string(),
    }),
  }),
  z.object({
    status: z.literal(403),
    body: z.object({
      error: z.string(),
      code: z.enum(['workspace_ambiguous', 'workspace_mismatch']),
    }),
  }),
  z.object({
    status: z.literal(404),
    body: z.object({
      error: z.string(),
      code: z.literal('service_not_found'),
    }),
  }),
  z.object({
    status: z.literal(503),
    body: z.object({
      error: z.string(),
      code: z.literal('service_unavailable'),
    }),
  }),
  z.object({
    status: z.literal(429),
    body: z.object({
      error: z.literal('rate_limited'),
      code: z.literal('rate_limited'),
      retryAfterSeconds: z.number(),
    }),
  }),
])
export type GatewayBlock = z.infer<typeof GatewayBlockSchema>

/**
 * The 402s a caller can hit by asking a workspace to spend. What unites them is
 * that a person can resolve each one — which is what separates them from a
 * transport failure and earns them named copy instead of "something went
 * wrong". It is NOT that each is resolved by paying: `authorizeSpend` reaches a
 * cap check only after the balance check has passed, so a `monthly_cap` caller
 * has credits and is stopped by a limit. Copy that reads this list as "the
 * out-of-money errors" bills someone to leave them just as blocked.
 *
 * `billingUrl` is deliberately not parsed: it is for program callers with no
 * browser to route, while an in-app surface owns its own route to billing.
 */
export const SPEND_REFUSAL_CODES = [
  'insufficient_credits',
  'monthly_cap',
  'subscription_required',
  'subscription_inactive',
  'payment_required',
] as const

/**
 * `tier` is only meaningful for `monthly_cap`, and it is not decoration: an
 * account cap and a workspace cap are different limits with different owners,
 * and only the account's has a control on the billing page.
 */
export const SpendRefusalSchema = z.object({
  code: z.enum(SPEND_REFUSAL_CODES),
  tier: z.enum(['account', 'workspace']).optional(),
})
export type SpendRefusal = z.infer<typeof SpendRefusalSchema>

export function applyGatewayBlockMarker(headers: Headers, block: GatewayBlock): void {
  headers.set(X_DUET_GATEWAY_HEADER, 'block')
  headers.set(X_DUET_GATEWAY_CODE_HEADER, block.body.code)
}

export function gatewayBlockResponse(block: GatewayBlock): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=UTF-8' })
  applyGatewayBlockMarker(headers, block)
  return new Response(JSON.stringify(block.body), { status: block.status, headers })
}

const GatewayPreflightProceedSchema = z.object({
  proceed: z.literal(true),
  generationId: z.string().optional(),
  reservationId: z.string().optional(),
})

const GatewayPreflightBlockSchema = z.object({
  proceed: z.literal(false),
  block: GatewayBlockSchema,
})
export type GatewayPreflightBlock = z.infer<typeof GatewayPreflightBlockSchema>

export const GatewayPreflightResultSchema = z.union([
  GatewayPreflightProceedSchema,
  GatewayPreflightBlockSchema,
])
export type GatewayPreflightResult = z.infer<typeof GatewayPreflightResultSchema>
