import { makeFunctionReference, type FunctionReference } from 'convex/server'

import {
  AttributionTierIdSchema,
  ModelRouterPolicySchema,
  MODEL_ROUTER_PATHS,
  tierBillsAtFlatRate,
  type ModelRouterPolicy,
  type ModelRouterRule,
} from '@repo/contract'

/** The backend query that owns the singleton model-router policy. */
export const MODEL_ROUTER_POLICY_QUERY = 'domains/modelGateway/model:getModelRouterPolicy'

export interface ModelRouterQueryClient {
  query(ref: FunctionReference<'query'>, args: Record<string, unknown>): Promise<unknown>
}

export type ModelRouterRouteReason =
  | 'missing_tier'
  | 'invalid_tier'
  | 'tier_not_flat_rate'
  | 'unsupported_family'
  | 'unsupported_method'
  | 'unsupported_path'
  | 'family_path_mismatch'
  | 'no_match'

export type ModelRouterDecision =
  | {
      kind: 'configured'
      rule: ModelRouterRule
      family: 'openai' | 'anthropic'
    }
  | { kind: 'vercel'; reason: ModelRouterRouteReason }

/**
 * Fetch the policy once per request. An absent policy is deliberately an empty
 * policy: rollout and backend outages leave Vercel as the safe fallback.
 */
export async function fetchModelRouterPolicy(args: {
  convex?: ModelRouterQueryClient | null
  internalKey?: string
}): Promise<ModelRouterPolicy> {
  if (args.convex === null || args.convex === undefined || !args.internalKey) {
    return emptyModelRouterPolicy()
  }
  try {
    const result = await args.convex.query(
      makeFunctionReference(MODEL_ROUTER_POLICY_QUERY) as FunctionReference<'query'>,
      { internalKey: args.internalKey },
    )
    const parsed = ModelRouterPolicySchema.safeParse(result)
    return parsed.success ? parsed.data : emptyModelRouterPolicy()
  } catch {
    // A policy read is advisory. Never make a backend policy outage take down
    // the model gateway; Vercel remains the fallback owner.
    return emptyModelRouterPolicy()
  }
}

export function emptyModelRouterPolicy(): ModelRouterPolicy {
  return { version: 1, rules: [], updatedAt: 0 }
}

/**
 * Apply the frozen eligibility order. In particular, glob matching happens
 * only after a raw tier claim has passed the exact flat-rate closure check.
 */
export function classifyModelRouterRequest(args: {
  request: Request
  model: string
  policy: ModelRouterPolicy
}): ModelRouterDecision {
  const rawTier = args.request.headers.get('x-duet-tier')
  if (rawTier === null) return { kind: 'vercel', reason: 'missing_tier' }
  const parsedTier = AttributionTierIdSchema.safeParse(rawTier.trim())
  if (!parsedTier.success) return { kind: 'vercel', reason: 'invalid_tier' }
  if (!tierBillsAtFlatRate(parsedTier.data, args.model)) {
    return { kind: 'vercel', reason: 'tier_not_flat_rate' }
  }

  const family = modelFamily(args.model)
  if (family === undefined) return { kind: 'vercel', reason: 'unsupported_family' }
  if (args.request.method !== 'POST') return { kind: 'vercel', reason: 'unsupported_method' }
  const path = new URL(args.request.url).pathname
  if (!(MODEL_ROUTER_PATHS as readonly string[]).includes(path)) {
    return { kind: 'vercel', reason: 'unsupported_path' }
  }
  if (family === 'anthropic' ? path !== '/v1/messages' : path === '/v1/messages') {
    return { kind: 'vercel', reason: 'family_path_mismatch' }
  }

  for (const rule of args.policy.rules) {
    if (rule.enabled && globMatches(rule.modelGlob, args.model)) {
      return { kind: 'configured', rule, family }
    }
  }
  return { kind: 'vercel', reason: 'no_match' }
}

/** Construct a configured attempt with route headers only. */
export function configuredUpstreamRequest(args: {
  request: Request
  rule: ModelRouterRule
  body?: BodyInit | null
  family?: 'openai' | 'anthropic'
}): Request {
  const sourceUrl = new URL(args.request.url)
  const base = args.rule.baseUrl.replace(/\/+$/g, '')
  const target = `${base}${sourceUrl.pathname}${sourceUrl.search}`
  const headers = new Headers()
  for (const header of args.rule.headers) headers.set(header.name, header.value)
  let body = args.body === undefined ? args.request.body : args.body
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const model = (parsed as Record<string, unknown>).model
        if (
          args.family !== undefined &&
          typeof model === 'string' &&
          model.startsWith(`${args.family}/`)
        ) {
          body = JSON.stringify({ ...parsed, model: model.slice(model.indexOf('/') + 1) })
        }
      }
    } catch {
      // Preserve non-JSON bodies for provider-specific endpoints.
    }
  }
  return new Request(target, {
    method: 'POST',
    headers,
    body,
    // Required by undici when forwarding a live request stream.
    ...(args.body === undefined && args.request.body !== null ? { duplex: 'half' as const } : {}),
  })
}

/**
 * Add OpenAI's final stream usage event without copying any caller headers.
 * Non-streaming and Anthropic requests are returned byte-for-byte unchanged.
 */
export function addOpenAiStreamUsage(body: unknown, pathname: string): unknown {
  if (pathname !== '/v1/chat/completions' || body === null || typeof body !== 'object') return body
  const record = body as Record<string, unknown>
  if (record.stream !== true) return body
  const streamOptions =
    record.stream_options !== null && typeof record.stream_options === 'object'
      ? { ...(record.stream_options as Record<string, unknown>) }
      : {}
  streamOptions.include_usage = true
  return { ...record, stream_options: streamOptions }
}

export function modelFamily(model: string): 'openai' | 'anthropic' | undefined {
  if (model.startsWith('openai/')) return 'openai'
  if (model.startsWith('anthropic/')) return 'anthropic'
  return undefined
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern.includes('?') || pattern.includes('[')) return false
  const expression = pattern
    .split('*')
    .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${expression}$`).test(value)
}
