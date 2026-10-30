import { describe, expect, test } from 'bun:test'

import { REFRESH_GRACE_MS, transitionRefreshFamily, type RefreshFamily } from './refresh'

const NOW = 1_000_000

describe('OAuth refresh-family transitions', () => {
  test('head rotation advances once while grace re-rotation preserves generation and deadlines', () => {
    const first = transitionRefreshFamily(family(), hash('refresh-2'), NOW)
    expect(first.outcome).toBe('rotated')
    if (first.outcome !== 'rotated') throw new Error('expected head rotation')
    expect(first.generation).toBe(3)
    expect(first.predecessorGraceUntil).toBe(NOW + REFRESH_GRACE_MS)

    const retry = transitionRefreshFamily(
      {
        ...family(),
        generation: first.generation,
        headHash: hash('refresh-3'),
        predecessorHash: hash('refresh-2'),
        predecessorGraceUntil: first.predecessorGraceUntil,
      },
      hash('refresh-2'),
      NOW + 1,
    )
    expect(retry).toEqual({
      outcome: 'graceRerotate',
      generation: 3,
      predecessorGraceUntil: NOW + REFRESH_GRACE_MS,
    })
  })

  test('a deeper ancestor or immediate predecessor after grace revokes the family', () => {
    expect(transitionRefreshFamily(family(), hash('refresh-ancestor'), NOW)).toEqual({
      outcome: 'familyRevoked',
      generation: 2,
    })
    expect(
      transitionRefreshFamily(
        { ...family(), predecessorGraceUntil: NOW - 1 },
        hash('refresh-1'),
        NOW,
      ),
    ).toEqual({
      outcome: 'familyRevoked',
      generation: 2,
    })
  })
})

function family(): RefreshFamily {
  return {
    generation: 2,
    headHash: hash('refresh-2'),
    predecessorHash: hash('refresh-1'),
    predecessorGraceUntil: NOW + 20_000,
  }
}

function hash(label: string): string {
  return `sha256:${label}`
}
