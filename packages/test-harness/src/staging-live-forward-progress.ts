/**
 * Bound eventually-consistent staging waits by both time and forward progress.
 * The caller owns the domain meaning of progress; this helper only enforces that
 * an unchanged projection cannot consume the entire wall-clock timeout.
 */
export async function waitForForwardProgress<T>(args: {
  label: string
  load: () => Promise<T>
  isComplete: (state: T) => boolean
  hasProgress: (previous: T, current: T) => boolean
  maxConsecutiveUnchangedObservations: number
  timeoutMs: number
  pollMs: number
  summarize?: (state: T) => unknown
}): Promise<T> {
  const deadline = Date.now() + args.timeoutMs
  let previous: { state: T } | undefined
  let unchangedObservations = 0

  const timeoutError = () =>
    new Error(
      `Timed out waiting for ${args.label}; last=${JSON.stringify(
        previous === undefined ? undefined : (args.summarize?.(previous.state) ?? previous.state),
      )}`,
    )

  for (;;) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw timeoutError()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const current = await Promise.race([
      args.load(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(timeoutError()), remainingMs)
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout)
    })
    if (Date.now() >= deadline) throw timeoutError()
    if (args.isComplete(current)) return current

    if (previous !== undefined) {
      if (args.hasProgress(previous.state, current)) {
        unchangedObservations = 0
      } else {
        unchangedObservations += 1
        if (unchangedObservations >= args.maxConsecutiveUnchangedObservations) {
          throw new Error(
            `Stopped waiting for ${args.label} after ${unchangedObservations} unchanged observations; last=${JSON.stringify(args.summarize?.(current) ?? current)}`,
          )
        }
      }
    }

    previous = { state: current }
    await Bun.sleep(args.pollMs)
  }
}
