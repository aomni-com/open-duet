import { describe, expect, test } from 'bun:test'

import { assertLedgerParity, defaultServiceCatalogVoiceFixturePath } from './service-catalog-staging.ts'

describe('service-catalog staging journey oracles', () => {
  test('resolves the default voice fixture from the repository source location', async () => {
    expect(await Bun.file(defaultServiceCatalogVoiceFixturePath()).exists()).toBe(true)
  })

  test('checks vendor cost plus the single standard margin with both rounding steps', () => {
    expect(() =>
      assertLedgerParity([
        { reference: 'service:elevenlabs:tts', vendorCostMicroUsd: 2240, amountMicroUsd: -2688 },
        { reference: 'service:firecrawl:crawl', vendorCostMicroUsd: 5000, amountMicroUsd: -6000 },
      ]),
    ).not.toThrow()
    expect(() =>
      assertLedgerParity([
        { reference: 'service:elevenlabs:tts', vendorCostMicroUsd: 2240, amountMicroUsd: -2687 },
      ]),
    ).toThrow('standard 20% margin')
    expect(() =>
      assertLedgerParity([
        { reference: 'service:elevenlabs:tts', vendorCostMicroUsd: 2240, amountMicroUsd: 2688 },
      ]),
    ).toThrow('standard 20% margin')
  })
})
