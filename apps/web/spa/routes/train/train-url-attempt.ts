export interface PendingUrlAttempt {
  url: string
  request?: AbortController
}

export function countActiveUrlAttempts<T extends { status: 'pending' | 'failed' }>(
  attempts: ReadonlyArray<T>,
): number {
  return attempts.filter(attempt => attempt.status === 'pending').length
}

export function dismissUrlAttempt<T extends PendingUrlAttempt>(
  attempts: T[],
  url: string,
  dismissed: WeakSet<AbortController>,
): T[] {
  for (const attempt of attempts) {
    if (attempt.url !== url || attempt.request === undefined) continue
    dismissed.add(attempt.request)
    attempt.request.abort(new DOMException('Website import dismissed', 'AbortError'))
  }
  return attempts.filter(attempt => attempt.url !== url)
}
