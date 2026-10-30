import { describe, expect, test } from 'bun:test'

import { nextReleaseVersion } from './next-public-version'

describe('nextReleaseVersion', () => {
  test('advances npm by one patch when the checked-out version is behind', () => {
    expect(nextReleaseVersion('1.0.1', '1.0.3')).toBe('1.0.4')
  })

  test('keeps an intentional higher local release version', () => {
    expect(nextReleaseVersion('2.0.0', '1.0.4')).toBe('2.0.0')
  })
})
