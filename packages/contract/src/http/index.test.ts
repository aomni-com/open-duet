import { describe, expect, test } from 'bun:test'

import { ApiRateLimitErrorSchema, duplexFor, requestBody } from './index'

describe('streaming fetch request init', () => {
  test('forwards bodies only for methods that may carry them', () => {
    expect(requestBody(new Request('https://example.test'))).toBeUndefined()
    expect(duplexFor(new Request('https://example.test'))).toEqual({})

    const post = new Request('https://example.test', { method: 'POST', body: 'payload' })
    expect(requestBody(post)).toBe(post.body)
    expect(duplexFor(post)).toEqual({ duplex: 'half' })
  })
})

describe('authenticated API rate-limit contract', () => {
  test('validates the public refusal body', () => {
    expect(ApiRateLimitErrorSchema.parse({ error: 'rate_limited', retryAfterSeconds: 17 })).toEqual(
      {
        error: 'rate_limited',
        retryAfterSeconds: 17,
      },
    )
    expect(
      ApiRateLimitErrorSchema.safeParse({ error: 'rate_limited', retryAfterSeconds: 0 }).success,
    ).toBe(false)
  })
})
