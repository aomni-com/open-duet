import { expect, test } from 'bun:test'

import { createCheckoutReturnRefresher } from './checkout-return-refresh'

test('focus and visibility share one refresh until the server round trip settles', async () => {
  let calls = 0
  let settle!: () => void
  const pending = new Promise<void>(resolve => {
    settle = resolve
  })
  const refresh = createCheckoutReturnRefresher(async () => {
    calls += 1
    await pending
  })

  const focused = refresh()
  const visible = refresh()
  expect(calls).toBe(1)
  expect(visible).toBe(focused)

  settle()
  await focused
  await refresh()
  expect(calls).toBe(2)
})

test('a failed refresh does not strand later returns behind the old request', async () => {
  let calls = 0
  const refresh = createCheckoutReturnRefresher(async () => {
    calls += 1
    if (calls === 1) throw new Error('offline')
  })

  await expect(refresh()).rejects.toThrow('offline')
  await refresh()
  expect(calls).toBe(2)
})
