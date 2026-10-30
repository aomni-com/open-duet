import { describe, expect, test } from 'bun:test'

import {
  OnboardingRecommendationsRequestSchema,
  OnboardingRecommendationsResponseSchema,
} from './index'

function recommendation(agentName: string) {
  return { agentName, reason: 'You asked for faster content — this agent drafts it for you.' }
}

describe('onboarding recommendations wire contract', () => {
  test('transports exactly four recommendations or none, never a partial list', () => {
    const four = ['scribe', 'seo-scout', 'inbox-zero', 'bookkeeper'].map(recommendation)

    expect(
      OnboardingRecommendationsResponseSchema.safeParse({ recommendations: four }).success,
    ).toBe(true)
    expect(OnboardingRecommendationsResponseSchema.safeParse({ recommendations: [] }).success).toBe(
      true,
    )
    expect(
      OnboardingRecommendationsResponseSchema.safeParse({
        recommendations: four.slice(0, 3),
      }).success,
    ).toBe(false)
    expect(
      OnboardingRecommendationsResponseSchema.safeParse({
        recommendations: [...four, recommendation('extra-agent')],
      }).success,
    ).toBe(false)
  })

  test('request accepts a trimmed purpose and refuses one beyond the clamp', () => {
    const parsed = OnboardingRecommendationsRequestSchema.parse({
      purpose: '  Grow my bakery with weekly content.  ',
      tagHints: ['marketing'],
    })
    expect(parsed.purpose).toBe('Grow my bakery with weekly content.')

    expect(
      OnboardingRecommendationsRequestSchema.safeParse({ purpose: 'x'.repeat(1001) }).success,
    ).toBe(false)
    expect(
      OnboardingRecommendationsRequestSchema.safeParse({
        purpose: 'Grow my bakery.',
        tagHints: ['not-a-real-tag'],
      }).success,
    ).toBe(false)
  })
})
