import { expect, test } from 'bun:test'

import { APPS_STARTING_POLL_MS, appsPollInterval } from './query-options'

test('keeps checking while a locked agent is waiting for its onboarding app to appear', () => {
  expect(
    appsPollInterval(
      { items: [], nextCursor: null, meta: { capabilities: { register: false } } },
      true,
    ),
  ).toBe(APPS_STARTING_POLL_MS)
})
