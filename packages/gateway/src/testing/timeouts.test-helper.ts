import { afterEach, beforeEach, spyOn } from 'bun:test'

/** Keep real clock behavior, then cancel every timeout this suite created. */
export function cleanUpTestTimeouts(): void {
  const schedule = globalThis.setTimeout
  let timers: ReturnType<typeof setTimeout>[] = []
  let spy: ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>>
  beforeEach(() => {
    timers = []
    spy = spyOn(globalThis, 'setTimeout').mockImplementation(
      Object.assign(
        (...args: Parameters<typeof setTimeout>) => {
          const timer = schedule(...args)
          timers.push(timer)
          return timer
        },
        { __promisify__: schedule.__promisify__ },
      ) as typeof globalThis.setTimeout,
    )
  })
  afterEach(() => {
    for (const timer of timers) clearTimeout(timer)
    spy.mockRestore()
  })
}
