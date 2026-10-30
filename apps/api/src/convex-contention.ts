const MAX_CONTENTION_ATTEMPTS = 8
const BASE_CONTENTION_DELAY_MS = 10

interface RetryConvexContentionOptions<T> {
  random?: () => number
  sleep?: (delayMs: number) => Promise<void>
  /**
   * Answer to give when contention outlasts every retry, for callers whose
   * write is best-effort (a usage tick, a stamp) and must never fail the
   * request it rides on. Consulted only for contention: any other error still
   * throws, because it means something is wrong, not merely busy.
   */
  fallback?: (error: Error) => T
}

export async function retryConvexContention<T>(
  operation: () => Promise<T>,
  options: RetryConvexContentionOptions<T> = {},
): Promise<T> {
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)))
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isConvexContention(error)) throw error
      if (attempt + 1 >= MAX_CONTENTION_ATTEMPTS) {
        if (options.fallback !== undefined) return options.fallback(error)
        throw error
      }
      const ceiling = BASE_CONTENTION_DELAY_MS * 2 ** attempt
      await sleep(random() * ceiling)
    }
  }
}

function isConvexContention(error: unknown): error is Error {
  return error instanceof Error && error.message.includes('OptimisticConcurrencyControlFailure')
}
