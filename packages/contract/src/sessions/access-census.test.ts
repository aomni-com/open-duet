import { describe, expect, test } from 'bun:test'

import { PUBLIC_API_ENDPOINTS } from '../endpoints'
import { SESSION_ACCESS_CENSUS, SESSION_ACCESS_REGISTRY_IDS } from './access-census'

describe('session access census', () => {
  test('assigns every public session operation to exactly one access contract', () => {
    const publicIds = PUBLIC_API_ENDPOINTS.filter(
      endpoint =>
        endpoint.id.startsWith('sessions.') ||
        endpoint.id.startsWith('agents.defaultSession.') ||
        endpoint.id === 'agents.sessionOnboarded' ||
        endpoint.id === 'agents.onboardingSession',
    ).map(endpoint => endpoint.id)

    expect([...SESSION_ACCESS_REGISTRY_IDS].sort()).toEqual(publicIds.sort())
    expect(new Set(SESSION_ACCESS_REGISTRY_IDS).size).toBe(SESSION_ACCESS_REGISTRY_IDS.length)
  })

  test('records the denial and side-effect contract for every seam', () => {
    for (const row of SESSION_ACCESS_CENSUS) {
      expect(row.principalVerdict.length).toBeGreaterThan(0)
      expect(row.malformedId.length).toBeGreaterThan(0)
      expect(row.sideEffectOrder.length).toBeGreaterThan(0)
    }
  })
})
