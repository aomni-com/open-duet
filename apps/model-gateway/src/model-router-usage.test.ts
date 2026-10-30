import { describe, expect, test } from 'bun:test'

import { usageFromModelRouterJson, usageFromModelRouterSse } from './model-router-usage'

describe('model router usage extraction', () => {
  test('normalizes OpenAI usage', () => {
    expect(
      usageFromModelRouterJson('/v1/chat/completions', {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      }),
    ).toEqual({
      source: 'provider',
      usage: { uncachedInputTokens: 70, cachedInputTokens: 30, outputTokens: 20 },
    })
  })

  test('finds late streamed usage and nested Responses usage', () => {
    expect(
      usageFromModelRouterSse(
        '/v1/responses',
        'data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":2}}}\n\ndata: [DONE]\n\n',
      ),
    ).toEqual({
      source: 'provider',
      usage: { uncachedInputTokens: 8, cachedInputTokens: 0, outputTokens: 2 },
    })
    expect(
      usageFromModelRouterSse(
        '/v1/messages',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
      ),
    ).toEqual({
      source: 'provider',
      usage: { uncachedInputTokens: 12, cachedInputTokens: 3, outputTokens: 4 },
      cacheCreationInputTokens: 2,
    })
    expect(
      usageFromModelRouterJson('/v1/responses', {
        usage: { input_tokens: 9, output_tokens: 2 },
      }).usage,
    ).toEqual({ uncachedInputTokens: 9, cachedInputTokens: 0, outputTokens: 2 })
  })

  test('rejects unusable provider counts and preserves Anthropic cache semantics', () => {
    expect(
      usageFromModelRouterJson('/v1/messages', {
        usage: { input_tokens: -1, output_tokens: 2 },
      }),
    ).toEqual({ source: 'missing' })
    expect(
      usageFromModelRouterJson('/v1/messages', {
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      }).usage,
    ).toEqual({ uncachedInputTokens: 14, cachedInputTokens: 3, outputTokens: 2 })
    expect(
      usageFromModelRouterJson('/v1/chat/completions', {
        usage: {
          prompt_tokens: 2,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      }),
    ).toEqual({ source: 'missing' })
  })
})
