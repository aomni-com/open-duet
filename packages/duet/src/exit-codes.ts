export const EXIT_CODES = {
  ok: 0,
  generic: 1,
  auth: 3,
  scope: 4,
  notFound: 5,
  network: 6,
  usage: 64,
} as const

export type ExitCodeName = keyof typeof EXIT_CODES

export class CliError extends Error {
  readonly exitCode: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    exitCode: number,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

export function usageError(message: string): CliError {
  return new CliError('usage', message, EXIT_CODES.usage)
}
