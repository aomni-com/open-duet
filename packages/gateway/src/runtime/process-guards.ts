// A type alias, not an interface: the logger takes `Record<string, unknown>`,
// which an interface (no index signature) cannot satisfy.
export type ProcessGuardEvent = {
  operation: 'unhandled_rejection' | 'uncaught_exception'
  error: string
  stack?: string
}

/**
 * Keep the one gateway process up through a stray asynchronous failure.
 *
 * Bun's default for an unhandled rejection or an uncaught throw is exit(1).
 * The gateway hosts every rail of a workspace in that one process — sync,
 * apps, sessions, files, desktop — so the default turns a bug in any of them
 * into an outage of all of them, and a deterministic one into a systemd
 * crash loop (start-limit, then nothing). Each rail already contains its own
 * failures; this is the backstop for the one that did not, and it is loud:
 * every event lands in the gateway log with its stack.
 */
export function installProcessGuards(log: (event: ProcessGuardEvent) => void): void {
  process.on('unhandledRejection', reason => {
    log({ operation: 'unhandled_rejection', ...describe(reason) })
  })
  process.on('uncaughtException', error => {
    log({ operation: 'uncaught_exception', ...describe(error) })
  })
}

function describe(error: unknown): Pick<ProcessGuardEvent, 'error' | 'stack'> {
  return error instanceof Error
    ? { error: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) }
    : { error: String(error) }
}
