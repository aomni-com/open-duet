import { afterEach, describe, expect, test } from 'bun:test'

import { fetchAiGatewayGenerationInfo } from '../convex/services/aiGateway'

const originalFetch = globalThis.fetch

// Semantics measured live on 2026-07-30 (PROBE.md, probe (a)): in the
// generation record, tokens_prompt EXCLUDES both cache reads and cache
// writes. A cache-read call reported tokens_prompt: 2 with
// native_tokens_cached: 11974; the write call reported tokens_prompt: 2 with
// native_tokens_cache_creation: 11974. The three counts are disjoint and
// additive — nothing is subtracted from anything.
describe('AI Gateway generation info', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('adds cache-creation tokens to uncached input and keeps cache reads separate', async () => {
    // Shaped like the live cache-write capture: a tiny fresh prompt plus a
    // large cache write. The write tokens bill at the input rate — before
    // this rule they rode free as metadata.
    globalThis.fetch = fixtureFetch({
      data: {
        total_cost: 0.029_979,
        provider_name: 'fixture-provider',
        tokens_prompt: 2,
        tokens_completion: 4,
        native_tokens_prompt: 2,
        native_tokens_completion: 4,
        native_tokens_cached: 0,
        native_tokens_cache_creation: 11_974,
      },
    })

    await expect(
      fetchAiGatewayGenerationInfo({
        apiKey: 'test-platform-key',
        generationId: 'cache-write-generation',
        baseUrl: 'https://ai-gateway.example.test',
      }),
    ).resolves.toEqual({
      ready: true,
      info: {
        upstreamCostUsd: 0.029_979,
        provider: 'fixture-provider',
        usage: {
          uncachedInputTokens: 11_976,
          cachedInputTokens: 0,
          outputTokens: 4,
        },
        cacheCreationInputTokens: 11_974,
      },
    })
  })

  test('treats an absent cache-read count as zero rather than dropping all usage', async () => {
    // A provider that reports no `native_tokens_cached` has reported NO cache
    // reads — it has not withdrawn its token counts. This replaces a test that
    // pinned the opposite with no stated reason: requiring the field made one
    // missing optional erase `usage`, and a tiered generation with no `usage`
    // fails settlement as `missing token telemetry`, so every such call parked
    // unbillable and retried forever.
    globalThis.fetch = fixtureFetch({
      data: {
        total_cost: 2.75,
        tokens_prompt: 41,
        tokens_completion: 17,
      },
    })

    await expect(
      fetchAiGatewayGenerationInfo({
        apiKey: 'test-platform-key',
        generationId: 'no-cache-fields-generation',
        baseUrl: 'https://ai-gateway.example.test',
      }),
    ).resolves.toEqual({
      ready: true,
      info: {
        upstreamCostUsd: 2.75,
        usage: {
          uncachedInputTokens: 41,
          cachedInputTokens: 0,
          outputTokens: 17,
        },
      },
    })
  })

  test('bills a cache-read generation from disjoint prompt and cached counts', async () => {
    // Shaped like the live cache-read capture. Under the old subtractive
    // reading this exact payload was treated as an error; it is the normal
    // steady state of every multi-turn session.
    globalThis.fetch = fixtureFetch({
      data: {
        total_cost: 0.002_438_8,
        tokens_prompt: 2,
        tokens_completion: 4,
        native_tokens_cached: 11_974,
        native_tokens_cache_creation: 0,
      },
    })

    await expect(
      fetchAiGatewayGenerationInfo({
        apiKey: 'test-platform-key',
        generationId: 'cache-read-generation',
        baseUrl: 'https://ai-gateway.example.test',
      }),
    ).resolves.toEqual({
      ready: true,
      info: {
        upstreamCostUsd: 0.002_438_8,
        usage: {
          uncachedInputTokens: 2,
          cachedInputTokens: 11_974,
          outputTokens: 4,
        },
        cacheCreationInputTokens: 0,
      },
    })
  })

  test('uses native token counts when aggregate gateway counts are absent', async () => {
    globalThis.fetch = fixtureFetch({
      data: {
        total_cost: 0.000_111,
        native_tokens_prompt: 7,
        native_tokens_completion: 11,
        native_tokens_cached: 0,
      },
    })

    await expect(
      fetchAiGatewayGenerationInfo({
        apiKey: 'test-platform-key',
        generationId: 'native-token-generation',
        baseUrl: 'https://ai-gateway.example.test',
      }),
    ).resolves.toEqual({
      ready: true,
      info: {
        upstreamCostUsd: 0.000_111,
        usage: {
          uncachedInputTokens: 7,
          cachedInputTokens: 0,
          outputTokens: 11,
        },
      },
    })
  })
})

function fixtureFetch(body: unknown): typeof fetch {
  return Object.assign(async () => Response.json(body), { preconnect() {} })
}
