export type UpdateGateDecision =
  | { status: 'not_needed' }
  | { status: 'ready'; version: string }
  | { status: 'deferred'; version: string; deadlineMs: number }

export interface UpdateGateOptions {
  maxDeferMs: number
  now: () => number
  forceAfterDeadline: boolean
}

export interface UpdateGateInput {
  desiredVersion?: string
  runningVersion?: string
  hasActiveRunners: boolean
}

export interface UpdateGate {
  check(input: UpdateGateInput): UpdateGateDecision
}

export function createUpdateGate(options: UpdateGateOptions): UpdateGate {
  let armed: { version: string; deadlineMs: number } | null = null

  return {
    check(input: UpdateGateInput): UpdateGateDecision {
      if (
        input.desiredVersion === undefined ||
        input.runningVersion === undefined ||
        input.desiredVersion === input.runningVersion
      ) {
        armed = null
        return { status: 'not_needed' }
      }

      if (armed?.version !== input.desiredVersion) {
        armed = {
          version: input.desiredVersion,
          deadlineMs: options.now() + options.maxDeferMs,
        }
      }

      if (
        input.hasActiveRunners &&
        (!options.forceAfterDeadline || options.now() < armed.deadlineMs)
      ) {
        return {
          status: 'deferred',
          version: input.desiredVersion,
          deadlineMs: armed.deadlineMs,
        }
      }

      return { status: 'ready', version: input.desiredVersion }
    },
  }
}
