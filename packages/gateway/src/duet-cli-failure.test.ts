import { describe, expect, test } from 'bun:test'

import { classifyDuetCliFailure } from './duet-cli-failure'

describe('Duet CLI failure classifier', () => {
  test('classifies exit 75 as a lock timeout', () => {
    expect(classifyDuetCliFailure(75, '  memory database locked  ')).toEqual({
      kind: 'lock_timeout',
      status: 503,
      message: 'memory database locked',
    })
  })

  test('keeps the stderr not-found fallback', () => {
    expect(classifyDuetCliFailure(1, 'unknown slug: handbook')).toEqual({
      kind: 'not_found',
      status: 404,
      message: 'unknown slug: handbook',
    })
  })

  test('classifies every other failure as a bad gateway', () => {
    expect(classifyDuetCliFailure(2, 'unexpected failure')).toEqual({
      kind: 'failed',
      status: 502,
      message: 'unexpected failure',
    })
  })
})
