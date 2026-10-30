import { expect, test } from 'bun:test'

import { resolveDrawableArt } from './map-glyphs'

test('falls back only for the icon URL that failed to draw', () => {
  expect(resolveDrawableArt('https://files.test/icon-v1.png', undefined)).toBe(
    'https://files.test/icon-v1.png',
  )
  expect(
    resolveDrawableArt('https://files.test/icon-v1.png', 'https://files.test/icon-v1.png'),
  ).toBe(undefined)
  expect(
    resolveDrawableArt('https://files.test/icon-v2.png', 'https://files.test/icon-v1.png'),
  ).toBe('https://files.test/icon-v2.png')
})
