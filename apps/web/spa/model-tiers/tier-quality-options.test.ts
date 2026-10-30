import { describe, expect, test } from 'bun:test'

import { MODEL_TIERS, PROVIDER_MODEL_ALIASES } from '@repo/contract'

import { buildTierQualityOptions, buildAdvancedQualityOptions } from './tier-quality-options'

describe('session quality options', () => {
  test('orders Max, Standard, and Economy and derives every score from contract model data', () => {
    const options = buildTierQualityOptions()

    expect(options.map(option => option.label)).toEqual(['Max', 'Standard', 'Economy'])
    for (const option of options) {
      expect(option.scores).toEqual({
        performance: MODEL_TIERS[option.id].scores.speed,
        intelligence: MODEL_TIERS[option.id].scores.intelligence,
        cost: MODEL_TIERS[option.id].scores.cost,
      })
    }
  })

  test('shows router descriptions without needing a credit balance', () => {
    const options = buildTierQualityOptions()
    for (const option of options) {
      expect(option.detail).toBe(MODEL_TIERS[option.id].description)
    }
    const localized = buildTierQualityOptions(
      label => label,
      label => label,
      tier => `Localized ${tier}`,
    )
    expect(localized.map(option => option.detail)).toEqual([
      'Localized frontier',
      'Localized balanced',
      'Localized economy',
    ])
  })
})

test('advanced choices disclose their backing model and localized comparison scores', () => {
  const options = buildAdvancedQualityOptions(label => `Localized ${label}`)
  expect(options.map(option => option.id)).toContain('anthropic-balanced')
  expect(options.map(({ id, label, detail, scores }) => ({ id, label, detail, scores }))).toEqual(
    Object.values(PROVIDER_MODEL_ALIASES).map(alias => ({
      id: alias.id,
      label: alias.label,
      detail: alias.modelLabel,
      scores: {
        performance: alias.scores.speed,
        intelligence: alias.scores.intelligence,
        cost: alias.scores.cost,
      },
    })),
  )
  expect(options[0]?.scoreLabels).toEqual({
    performance: 'Localized Performance',
    intelligence: 'Localized Intelligence',
    cost: 'Localized Cost',
  })
})
