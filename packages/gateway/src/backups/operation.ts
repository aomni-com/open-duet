/** Detach cancellation on settlement so long streams do not retain prior results. */
export function abortableBackupOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(signal.reason)
    signal.addEventListener('abort', cancelled, { once: true })
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancelled))
  })
}

export async function backupOperationDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('Backup operation timed out')), timeoutMs)
  const combined = AbortSignal.any([signal, deadline.signal])
  try {
    return await abortableBackupOperation(() => operation(combined), combined)
  } finally {
    clearTimeout(timer)
  }
}
