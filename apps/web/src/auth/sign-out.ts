const SIGN_OUT_ATTEMPT_TIMEOUT_MS = 5_000

export async function revokeProductBrowserSession(
  signal: AbortSignal,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const response = await fetcher('/api/duet/session', { method: 'DELETE', signal })
  await response.arrayBuffer()
}

export async function completeProductSignOut({
  revokeBrowserSession,
  resetAnalytics,
  clearAuth,
  navigate,
  timeoutMs = SIGN_OUT_ATTEMPT_TIMEOUT_MS,
}: {
  revokeBrowserSession: (signal: AbortSignal) => Promise<void>
  resetAnalytics: () => void
  clearAuth: () => Promise<void>
  navigate: () => void
  timeoutMs?: number
}): Promise<void> {
  await boundedAttempt(revokeBrowserSession, timeoutMs)
  resetAnalytics()
  await clearAuth()
  navigate()
}

async function boundedAttempt(
  operation: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<void>(resolve => {
        timeout = setTimeout(() => {
          controller.abort()
          resolve()
        }, timeoutMs)
      }),
    ])
  } catch {
    // Server cleanup is best-effort; local identity teardown must always finish.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
