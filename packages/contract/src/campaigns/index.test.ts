import { describe, expect, test } from 'bun:test'

import { AD_CLICK_PARAMS, CampaignLeadRequestSchema, normalizeAttributionSignals } from './index'

describe('campaign attribution signals', () => {
  test('keeps the shared allowlist and drops blank, non-string, and unknown values', () => {
    expect(AD_CLICK_PARAMS).toEqual(['gclid', 'gbraid', 'wbraid', 'rdt_cid', 'fbclid', 'oppref'])
    expect(
      normalizeAttributionSignals({
        utm_source: ' newsletter ',
        fbclid: ' meta-click ',
        oppref: ' openai-click ',
        referrer: ' ',
        ip: 42,
        secret: 'drop-me',
      }),
    ).toEqual({
      utm_source: 'newsletter',
      fbclid: 'meta-click',
      oppref: 'openai-click',
    })
  })
})

describe('campaign action contracts', () => {
  test('accepts generic bounded email data while rejecting non-JSON values', () => {
    expect(
      CampaignLeadRequestSchema.safeParse({
        data: {
          email: 'owner@example.com',
          source: 'blog',
          futureCampaignField: { cohort: 3 },
        },
        signals: { utm_source: 'newsletter' },
      }).success,
    ).toBe(true)
    expect(
      CampaignLeadRequestSchema.safeParse({
        data: { email: 'owner@example.com', invalid: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false)
  })
})
