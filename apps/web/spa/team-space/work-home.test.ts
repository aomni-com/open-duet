import { expect, test } from 'bun:test'

import { workHomeView } from './work-home'

test('a submitted first message immediately becomes the pending conversation', () => {
  expect(workHomeView(true, 'Prepare a launch brief')).toBe('conversation')
  expect(workHomeView(true, undefined)).toBe('starter')
  expect(workHomeView(false, 'Prepare a launch brief')).toBe('access-denied')
})
