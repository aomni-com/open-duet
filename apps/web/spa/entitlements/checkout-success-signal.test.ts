import { afterEach, expect, test } from 'bun:test'

import {
  CHECKOUT_CELEBRATION_GRACE_MS,
  CHECKOUT_SUCCESS_STORAGE_KEY,
  clearCheckoutSuccess,
  publishCheckoutSuccess,
  subscribeToCheckoutSuccess,
} from './checkout-success-signal'

const PAYER = 'user_ana'
const subscriptions: Array<() => void> = []
afterEach(() => {
  for (const stop of subscriptions.splice(0)) stop()
})

function memoryStorage() {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  }
}

/** Collects everything one tab is told, from whichever path tells it. */
function watch(deps: {
  now: number
  userId?: string
  storage: ReturnType<typeof memoryStorage>
  channel?: FakeTarget
  window?: FakeTarget
}) {
  const heard: number[] = []
  const stop = subscribeToCheckoutSuccess(at => heard.push(at), {
    now: () => deps.now,
    userId: deps.userId ?? PAYER,
    storage: deps.storage,
    channel: deps.channel,
    window: deps.window,
  })
  subscriptions.push(stop)
  return { heard, stop }
}

test('a checkout success published in the return tab is heard in the workspace tab', () => {
  const storage = memoryStorage()
  publishCheckoutSuccess({ now: 1_000, userId: PAYER, storage })

  expect(watch({ now: 1_000 + 30_000, storage }).heard).toEqual([1_000])
})

test('a success older than the grace window no longer suppresses anything', () => {
  const storage = memoryStorage()
  publishCheckoutSuccess({ now: 1_000, userId: PAYER, storage })

  expect(watch({ now: 1_000 + CHECKOUT_CELEBRATION_GRACE_MS + 1, storage }).heard).toEqual([])
})

test("one person's payment never answers for the next person on the browser", () => {
  const storage = memoryStorage()
  publishCheckoutSuccess({ now: 1_000, userId: PAYER, storage })

  expect(watch({ now: 1_500, storage }).heard).toEqual([1_000])
  expect(watch({ now: 1_500, userId: 'user_ben', storage }).heard).toEqual([])
})

test('a redeemed success stops answering for a balance that was spent back down', () => {
  const storage = memoryStorage()
  publishCheckoutSuccess({ now: 1_000, userId: PAYER, storage })

  clearCheckoutSuccess({ storage })

  expect(watch({ now: 1_500, storage }).heard).toEqual([])
})

test('a corrupt or backdated record never opens the grace window', () => {
  for (const value of [
    'not json',
    `{"at":"soon","userId":"${PAYER}"}`,
    `{"userId":"${PAYER}"}`,
    // A clock that jumped backwards must not read as an unbounded grace.
    `{"at":9000,"userId":"${PAYER}"}`,
  ]) {
    const storage = memoryStorage()
    storage.setItem(CHECKOUT_SUCCESS_STORAGE_KEY, value)
    expect(watch({ now: 2_000, storage }).heard).toEqual([])
  }
})

test('a tab wakes for a broadcast from the return tab and for its storage write', () => {
  const channel = new FakeTarget()
  const win = new FakeTarget()
  const storage = memoryStorage()
  const { heard, stop } = watch({ now: 5_000, storage, channel, window: win })

  for (const raw of ['null', '42', '"checkout"', '[]']) {
    channel.emit('message', { data: raw })
    win.emit('storage', { key: CHECKOUT_SUCCESS_STORAGE_KEY, newValue: raw })
  }
  expect(heard).toEqual([])

  channel.emit('message', { data: `{"at":4000,"userId":"${PAYER}"}` })
  win.emit('storage', {
    key: CHECKOUT_SUCCESS_STORAGE_KEY,
    newValue: `{"at":4500,"userId":"${PAYER}"}`,
  })
  win.emit('storage', { key: 'unrelated', newValue: `{"at":4900,"userId":"${PAYER}"}` })

  expect(heard).toEqual([4_000, 4_500])

  stop()
  channel.emit('message', { data: `{"at":4999,"userId":"${PAYER}"}` })
  expect(heard).toEqual([4_000, 4_500])
})

test('the tab that publishes the success hears it too, with no round trip', () => {
  const storage = memoryStorage()
  const { heard, stop } = watch({ now: 7_000, storage })

  publishCheckoutSuccess({ now: 7_000, userId: PAYER, storage })
  expect(heard).toEqual([7_000])

  stop()
  publishCheckoutSuccess({ now: 7_000, userId: PAYER, storage })
  expect(heard).toEqual([7_000])
})

test("a publishing tab does not shout down another tab's signed-in reader", () => {
  const storage = memoryStorage()
  const { heard } = watch({ now: 7_000, userId: 'user_ben', storage })

  publishCheckoutSuccess({ now: 7_000, userId: PAYER, storage })

  expect(heard).toEqual([])
})

class FakeTarget {
  private readonly listeners = new Map<string, Set<EventListener>>()
  addEventListener(type: string, listener: EventListener) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event)
  }
}
