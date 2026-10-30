import { z } from 'zod'

export const MODEL_ROUTER_PATHS = ['/v1/chat/completions', '/v1/messages', '/v1/responses'] as const

/** Headers that are controlled by the gateway transport and must not be saved. */
export const MODEL_ROUTER_RESERVED_HEADERS = new Set([
  'x-duet-tier',
  'x-duet-workspace',
  'x-duet-gateway',
  'x-duet-gateway-code',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const HEADER_NAME_RE = /^[a-z0-9!#$%&'*+.^_`|~-]+$/i

export const ModelRouterHeaderSchema = z.object({
  name: z.string().trim().min(1).max(128),
  value: z.string().max(4096),
})

export const ModelRouterRuleSchema = z.object({
  id: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  modelGlob: z.string().trim().min(1).max(200),
  baseUrl: z.string().url(),
  headers: z.array(ModelRouterHeaderSchema).max(32),
})

export const ModelRouterPolicySchema = z.object({
  version: z.literal(1),
  rules: z.array(ModelRouterRuleSchema).max(100),
  updatedAt: z.number().int().nonnegative(),
})

export type ModelRouterRule = z.infer<typeof ModelRouterRuleSchema>
export type ModelRouterPolicy = z.infer<typeof ModelRouterPolicySchema>

/**
 * Cross-field policy checks shared by the admin write path and gateway.
 * Keep these checks independent of Convex validators so API callers and tests
 * receive the same rejection semantics.
 */
export function validateModelRouterPolicy(policy: ModelRouterPolicy): string | null {
  const seen = new Set<string>()
  for (const rule of policy.rules) {
    let baseUrl: URL
    try {
      baseUrl = new URL(rule.baseUrl)
    } catch {
      return `invalid base URL: ${rule.baseUrl}`
    }
    if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
      return `invalid base URL protocol: ${rule.baseUrl}`
    }
    if (rule.modelGlob.includes('?') || rule.modelGlob.includes('['))
      return `invalid model glob: ${rule.modelGlob}`
    if (seen.has(rule.id)) return `duplicate rule id: ${rule.id}`
    seen.add(rule.id)
    const headerNames = new Set<string>()
    for (const header of rule.headers) {
      const name = header.name.toLowerCase()
      if (!HEADER_NAME_RE.test(header.name)) return `invalid header: ${header.name}`
      if (MODEL_ROUTER_RESERVED_HEADERS.has(name)) return `reserved header: ${header.name}`
      if (headerNames.has(name)) return `duplicate header: ${header.name}`
      headerNames.add(name)
    }
  }
  return null
}
