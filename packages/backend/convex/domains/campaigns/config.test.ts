import { describe, expect, test } from 'bun:test'

import { campaigns, type CampaignDefinition } from './config'

// `defineCampaigns` tolerating an agent name this repo has never seen is not
// tested here: it is an identity function, so a `.not.toThrow()` on it can only
// fail if the compiler already did. The tolerance is observable one layer up,
// where an unknown name has to survive the trip to the installer —
// `starterAgents.test.ts` drives arbitrary names through the real derivation.
describe('campaign definitions', () => {
  test('every starter-agent list is on an enabled campaign, non-empty, and duplicate-free', () => {
    // Naming an agent here locks every installed copy of it, so a list must be
    // a deliberate, live roster: a dormant campaign carrying agents or a
    // duplicate entry is an authoring slip, not a configuration.
    for (const [slug, definition] of Object.entries(
      campaigns as Record<string, CampaignDefinition>,
    )) {
      if (definition.starterAgents === undefined) continue
      expect({ slug, enabled: definition.enabled }).toEqual({ slug, enabled: true })
      expect(definition.starterAgents.length).toBeGreaterThan(0)
      expect(new Set(definition.starterAgents).size).toBe(definition.starterAgents.length)
    }
  })
})
