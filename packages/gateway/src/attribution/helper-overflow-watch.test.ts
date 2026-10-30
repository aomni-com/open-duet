import { expect, test } from 'bun:test'

import { createHelperOverflowWatch } from './helper-overflow-watch'

test('detects overflow increases again after a helper restart resets its cumulative counter', () => {
  let losses = 0
  const watch = createHelperOverflowWatch(() => {
    losses += 1
  })

  watch.observe(10)
  watch.reset()
  watch.observe(1)

  expect(losses).toBe(2)
})
