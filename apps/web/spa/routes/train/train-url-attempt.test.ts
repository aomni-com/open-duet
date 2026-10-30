import { expect, test } from 'bun:test'

import { countActiveUrlAttempts, dismissUrlAttempt } from './train-url-attempt'

test('dismissing a pending website source aborts its request and removes only that attempt', () => {
  const request = new AbortController()
  const dismissed = new WeakSet<AbortController>()
  const remaining = dismissUrlAttempt(
    [
      { url: 'https://example.com/dismissed', request },
      { url: 'https://example.com/kept', request: new AbortController() },
    ],
    'https://example.com/dismissed',
    dismissed,
  )

  expect(request.signal.aborted).toBe(true)
  expect(dismissed.has(request)).toBe(true)
  expect(remaining.map(attempt => attempt.url)).toEqual(['https://example.com/kept'])
})

test('only pending website sources reserve a URL slot', () => {
  expect(
    countActiveUrlAttempts([
      { url: 'https://example.com/pending', status: 'pending' },
      { url: 'https://example.com/failed', status: 'failed' },
    ]),
  ).toBe(1)
})
