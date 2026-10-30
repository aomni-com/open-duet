import { describe, expect, test } from 'bun:test'

import { FeedbackRequestSchema } from './index'

describe('feedback request wire schema', () => {
  test('bounds UTF-8 content bytes and source length', () => {
    expect(FeedbackRequestSchema.safeParse({ content: 'Useful feedback' }).success).toBe(true)
    expect(FeedbackRequestSchema.safeParse({ content: '' }).success).toBe(false)
    expect(FeedbackRequestSchema.safeParse({ content: 'é'.repeat(4097) }).success).toBe(false)
    expect(
      FeedbackRequestSchema.safeParse({ content: 'Useful feedback', source: 'x'.repeat(129) })
        .success,
    ).toBe(false)
  })
})
