import { VERCEL_AI_GATEWAY_BASE_URL } from '@repo/contract'

export interface AiGatewayGenerationInfo {
  upstreamCostUsd: number
  provider?: string
  usage?: NormalizedAiGatewayUsage
  cacheCreationInputTokens?: number
}

export interface NormalizedAiGatewayUsage {
  uncachedInputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export type AiGatewayGenerationInfoResult =
  | { ready: false }
  | { ready: true; info: AiGatewayGenerationInfo }

export async function fetchAiGatewayGenerationInfo(args: {
  apiKey: string
  generationId: string
  baseUrl?: string
}): Promise<AiGatewayGenerationInfoResult> {
  const url = new URL('/v1/generation', args.baseUrl ?? VERCEL_AI_GATEWAY_BASE_URL)
  url.searchParams.set('id', args.generationId)
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${args.apiKey}` },
  })

  if (response.status === 404 || response.status === 429 || response.status >= 500) {
    return { ready: false }
  }
  if (!response.ok) {
    throw new Error(`AI Gateway generation lookup failed: ${response.status}`)
  }

  const body = await response.json()
  const data = asRecord(asRecord(body)?.data)
  if (!data || typeof data.total_cost !== 'number' || !Number.isFinite(data.total_cost)) {
    return { ready: false }
  }
  const usage = normalizeAiGatewayUsage(data)
  const cacheCreationInputTokens = tokenCount(data.native_tokens_cache_creation)
  const provider =
    typeof data.provider_name === 'string'
      ? data.provider_name
      : typeof data.provider === 'string'
        ? data.provider
        : undefined
  return {
    ready: true,
    info: {
      upstreamCostUsd: data.total_cost,
      ...(provider === undefined ? {} : { provider }),
      ...usage,
      ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    },
  }
}

/**
 * The generation record's prompt count EXCLUDES cache reads and cache
 * writes — the three counts are disjoint (measured live 2026-07-30;
 * specs/done/virtual-model-tiers/PROBE.md probe (a)). Nothing is subtracted:
 * cache-creation tokens join the uncached leg and bill at the input rate
 * (their 1.25x upstream write premium sits inside the tier margin).
 */
function normalizeAiGatewayUsage(
  data: Record<string, unknown>,
): Pick<AiGatewayGenerationInfo, 'usage'> {
  const promptTokens = tokenCount(data.tokens_prompt) ?? tokenCount(data.native_tokens_prompt)
  const outputTokens =
    tokenCount(data.tokens_completion) ?? tokenCount(data.native_tokens_completion)
  // Absent means ZERO cache reads, not "usage unknown" — the same reading
  // `native_tokens_cache_creation` already gets below. Requiring it let one
  // missing optional field erase `usage` altogether, and a tiered generation
  // with no `usage` fails settlement as `missing token telemetry`
  // (`settlement.ts`), so every call from a provider that does not report the
  // field parks unbillable and retries forever. Prompt and completion stay
  // required: without them there genuinely is no usage to bill.
  const cachedInputTokens = tokenCount(data.native_tokens_cached) ?? 0
  if (promptTokens === undefined || outputTokens === undefined) {
    return {}
  }
  const cacheCreationInputTokens = tokenCount(data.native_tokens_cache_creation) ?? 0
  return {
    usage: {
      uncachedInputTokens: promptTokens + cacheCreationInputTokens,
      cachedInputTokens,
      outputTokens,
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
