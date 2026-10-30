import { MEMORY_CLI_CONTRACT } from '@repo/contract'

export type DuetCliFailureClassification =
  | { kind: 'lock_timeout'; status: 503; message: string }
  | { kind: 'not_found'; status: 404; message: string }
  | { kind: 'failed'; status: 502; message: string }

export function classifyDuetCliFailure(
  exitCode: number,
  stderr: string,
): DuetCliFailureClassification {
  const message = stderr.trim()
  if (exitCode === MEMORY_CLI_CONTRACT.exitCodes.lockTimeout) {
    return { kind: 'lock_timeout', status: 503, message }
  }
  const normalized = message.toLowerCase()
  if (normalized.includes('not found') || normalized.includes('unknown slug')) {
    return { kind: 'not_found', status: 404, message }
  }
  return { kind: 'failed', status: 502, message }
}
