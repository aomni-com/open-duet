export type ModelRouterUsage = {
  usage?: {
    uncachedInputTokens: number
    cachedInputTokens: number
    outputTokens: number
  }
  cacheCreationInputTokens?: number
  source: 'provider' | 'missing'
}

type RecordLike = Record<string, unknown>

export function usageFromModelRouterJson(pathname: string, body: unknown): ModelRouterUsage {
  const record = asRecord(body)
  const usage =
    asRecord(record?.usage) ??
    (pathname === '/v1/responses' ? asRecord(asRecord(record?.response)?.usage) : null)
  const normalized = normalizeUsage(pathname, usage)
  if (normalized === undefined) return { source: 'missing' }
  return {
    source: 'provider',
    usage: normalized.usage,
    ...(normalized.cacheCreationInputTokens === undefined
      ? {}
      : { cacheCreationInputTokens: normalized.cacheCreationInputTokens }),
  }
}

export function usageFromModelRouterSse(pathname: string, text: string): ModelRouterUsage {
  let partial: Partial<ModelRouterUsage['usage']> = {}
  let cacheCreationInputTokens = 0
  let hasCacheCreation = false
  for (const frame of text.split(/\n\n+/)) {
    const data = frame
      .split(/\r?\n/)
      .find(line => line.startsWith('data:'))
      ?.slice(5)
      .trim()
    if (!data || data === '[DONE]') continue
    try {
      const record = JSON.parse(data) as unknown
      const usageRecord =
        asRecord(record)?.usage ??
        (pathname === '/v1/responses'
          ? asRecord(asRecord(record)?.response)?.usage
          : pathname === '/v1/messages'
            ? asRecord(asRecord(record)?.message)?.usage
            : null)
      const fragment = usageFragment(pathname, asRecord(usageRecord))
      if (fragment !== undefined) {
        partial = { ...partial, ...fragment.usage }
        if (fragment.cacheCreationInputTokens !== undefined) {
          cacheCreationInputTokens = fragment.cacheCreationInputTokens
          hasCacheCreation = true
        }
      }
    } catch {
      // Partial SSE frames are expected while the stream is being read.
    }
  }
  if (
    partial.uncachedInputTokens === undefined ||
    partial.cachedInputTokens === undefined ||
    partial.outputTokens === undefined
  )
    return { source: 'missing' }
  return {
    source: 'provider',
    usage: {
      uncachedInputTokens: partial.uncachedInputTokens,
      cachedInputTokens: partial.cachedInputTokens,
      outputTokens: partial.outputTokens,
    },
    ...(hasCacheCreation ? { cacheCreationInputTokens } : {}),
  }
}

function normalizeUsage(
  pathname: string,
  usage: RecordLike | null,
):
  | { usage: NonNullable<ModelRouterUsage['usage']>; cacheCreationInputTokens?: number }
  | undefined {
  if (!usage) return undefined
  const input =
    numberAt(usage, pathname === '/v1/messages' ? 'input_tokens' : 'prompt_tokens') ??
    numberAt(usage, 'input_tokens')
  const output =
    numberAt(usage, pathname === '/v1/messages' ? 'output_tokens' : 'completion_tokens') ??
    numberAt(usage, 'output_tokens')
  if (input === undefined || output === undefined) return undefined
  const details = asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details)
  const cached =
    pathname === '/v1/messages'
      ? (numberAt(usage, 'cache_read_input_tokens') ?? 0)
      : (numberAt(usage, 'cached_input_tokens') ?? numberAt(details, 'cached_tokens') ?? 0)
  const cacheCreation =
    pathname === '/v1/messages'
      ? (numberAt(usage, 'cache_creation_input_tokens') ?? 0)
      : (numberAt(usage, 'cache_creation_input_tokens') ??
        numberAt(details, 'cache_write_tokens') ??
        numberAt(details, 'cached_creation_tokens') ??
        0)
  const uncachedInputTokens =
    pathname === '/v1/messages' ? input + cacheCreation : input - cached + cacheCreation
  if (uncachedInputTokens < 0) return undefined
  return {
    usage: {
      uncachedInputTokens,
      cachedInputTokens: cached,
      outputTokens: output,
    },
    ...(cacheCreation > 0 ? { cacheCreationInputTokens: cacheCreation } : {}),
  }
}

function usageFragment(
  pathname: string,
  usage: RecordLike | null,
):
  | { usage: Partial<NonNullable<ModelRouterUsage['usage']>>; cacheCreationInputTokens?: number }
  | undefined {
  if (!usage) return undefined
  const input =
    numberAt(usage, pathname === '/v1/messages' ? 'input_tokens' : 'prompt_tokens') ??
    numberAt(usage, 'input_tokens')
  const output =
    numberAt(usage, pathname === '/v1/messages' ? 'output_tokens' : 'completion_tokens') ??
    numberAt(usage, 'output_tokens')
  const details = asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details)
  const cached =
    pathname === '/v1/messages'
      ? numberAt(usage, 'cache_read_input_tokens')
      : (numberAt(usage, 'cached_input_tokens') ?? numberAt(details, 'cached_tokens') ?? 0)
  const cacheCreation =
    pathname === '/v1/messages'
      ? numberAt(usage, 'cache_creation_input_tokens')
      : (numberAt(usage, 'cache_creation_input_tokens') ??
        numberAt(details, 'cache_write_tokens') ??
        numberAt(details, 'cached_creation_tokens'))
  if (
    input === undefined &&
    output === undefined &&
    cached === undefined &&
    cacheCreation === undefined
  )
    return undefined
  const uncachedInputTokens =
    pathname === '/v1/messages'
      ? input === undefined
        ? undefined
        : input + (cacheCreation ?? 0)
      : input === undefined
        ? undefined
        : input - (cached ?? 0) + (cacheCreation ?? 0)
  if (uncachedInputTokens !== undefined && uncachedInputTokens < 0) return undefined
  return {
    usage: {
      ...(uncachedInputTokens === undefined
        ? {}
        : { uncachedInputTokens }),
      ...(cached === undefined ? {} : { cachedInputTokens: cached }),
      ...(output === undefined ? {} : { outputTokens: output }),
    },
    ...(cacheCreation === undefined ? {} : { cacheCreationInputTokens: cacheCreation }),
  }
}

function asRecord(value: unknown): RecordLike | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : null
}

function numberAt(value: RecordLike | null, key: string): number | undefined {
  const number = value?.[key]
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : undefined
}
