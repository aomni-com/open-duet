import { describe, expect, test } from 'bun:test'

import { retryConvexContention } from './convex-contention'

describe('retryConvexContention', () => {
  test('does not retry errors outside Convex optimistic contention', async () => {
    const expected = new Error('route failed')
    let attempts = 0
    const delays: number[] = []

    await expect(
      retryConvexContention(
        async () => {
          attempts += 1
          throw expected
        },
        { random: () => 0.5, sleep: async delay => void delays.push(delay) },
      ),
    ).rejects.toBe(expected)

    expect(attempts).toBe(1)
    expect(delays).toEqual([])
  })

  test('retries only transient Convex optimistic contention with full-jitter backoff', async () => {
    let attempts = 0
    const delays: number[] = []

    const result = await retryConvexContention(
      async () => {
        attempts += 1
        if (attempts < 3) throw contentionError(attempts)
        return 'authenticated'
      },
      { random: () => 0.5, sleep: async delay => void delays.push(delay) },
    )

    expect(result).toBe('authenticated')
    expect(attempts).toBe(3)
    expect(delays).toHaveLength(2)
    expect(delays[0]).toBeGreaterThan(0)
    expect(delays[1]).toBe(delays[0]! * 2)
  })

  test('a fallback turns exhausted contention into a value instead of a throw', async () => {
    let attempts = 0
    const delays: number[] = []
    const seen: Error[] = []

    const result = await retryConvexContention(
      async (): Promise<string> => {
        attempts += 1
        throw contentionError(attempts)
      },
      {
        random: () => 0.5,
        sleep: async delay => void delays.push(delay),
        fallback: error => {
          seen.push(error)
          return 'served without the tick'
        },
      },
    )

    expect(result).toBe('served without the tick')
    expect(attempts).toBeGreaterThan(1)
    expect(delays).toHaveLength(attempts - 1)
    expect(delays[0]).toBeGreaterThan(0)
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBe(delays[index - 1]! * 2)
    }
    expect(seen.map(error => error.message)).toEqual([
      `OptimisticConcurrencyControlFailure: attempt ${attempts}`,
    ])
  })

  test('a fallback is never consulted for errors outside contention', async () => {
    const expected = new Error('route failed')

    await expect(
      retryConvexContention(
        async (): Promise<string> => {
          throw expected
        },
        {
          random: () => 0.5,
          sleep: async () => {},
          fallback: () => 'must not be used',
        },
      ),
    ).rejects.toBe(expected)
  })

  test('stops after bounded contended attempts and rethrows the last failure', async () => {
    let attempts = 0
    const delays: number[] = []
    let lastError: Error | undefined
    let thrown: unknown

    try {
      await retryConvexContention(
        async () => {
          attempts += 1
          lastError = contentionError(attempts)
          throw lastError
        },
        { random: () => 0.5, sleep: async delay => void delays.push(delay) },
      )
    } catch (error) {
      thrown = error
    }

    expect(attempts).toBeGreaterThan(1)
    expect(delays).toHaveLength(attempts - 1)
    expect(delays[0]).toBeGreaterThan(0)
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBe(delays[index - 1]! * 2)
    }
    expect(thrown).toBe(lastError)
  })
})

function contentionError(attempt: number): Error {
  return new Error(`OptimisticConcurrencyControlFailure: attempt ${attempt}`)
}
