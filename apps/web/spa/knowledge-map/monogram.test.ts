import { expect, test } from 'bun:test'

import { monogram } from './monogram'

test('monograms identify both single-word and multi-word names', () => {
  expect(monogram('Research')).toBe('RH')
  expect(monogram('Reviewer')).toBe('RR')
  expect(monogram('Customer readiness')).toBe('CR')
  expect(monogram('archive-browser')).toBe('AB')
})
