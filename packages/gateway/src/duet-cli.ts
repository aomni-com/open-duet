import { MEMORY_CLI_CONTRACT } from '@repo/contract'

import { RUNNING_RUNTIME } from './runtime/paths'

export const DUET_CLI_BINARY = RUNNING_RUNTIME.duet
export const MANAGED_CLI_ENV = {
  DUET_NO_AUTO_UPGRADE: '1',
  ...(RUNNING_RUNTIME.version === undefined
    ? {}
    : { PATH: `${RUNNING_RUNTIME.directory}:${process.env.PATH ?? ''}` }),
} as const

export interface DuetCliResult {
  exitCode: number
  stdout: string
  stderr: string
  /** The command outlived its cap and was killed; `exitCode` is its signal. */
  timedOut?: boolean
  /** Stdout crossed the caller's byte ceiling and the child was killed. */
  outputTooLarge?: boolean
}

/**
 * How long any one agent-CLI invocation may take before the gateway gives up.
 *
 * Every call here is something a person is waiting on — a memory being saved,
 * a skill picker opening — so the cap is set by human patience rather than by
 * how long the command could conceivably need. A stalled invocation is a
 * failure to report, not a request to hold open: without a cap a single wedged
 * child keeps its HTTP request alive forever and leaves the process behind.
 */
export const DUET_CLI_TIMEOUT_MS = 10_000

export interface SpawnDuetCliOptions {
  timeoutMs?: number
  /** Optional hard ceiling applied while stdout is streaming, before buffering it. */
  maxStdoutBytes?: number
  /** Optional hard ceiling applied while stderr is streaming, before buffering it. */
  maxStderrBytes?: number
  /** Overridable so the seam's own timeout can be tested without the agent CLI. */
  binary?: string
  /**
   * Extra environment for this call, layered over the gateway's own. Commands
   * that reach a model need credentials the gateway holds in memory rather than
   * in its process environment.
   */
  env?: Record<string, string>
}

/**
 * One invocation of the agent CLI. `spawnDuetCli` is the production instance;
 * the parameter exists so every caller — a route, a maintenance rail — can be
 * driven in tests without the binary.
 */
export type DuetCliRunner = (
  argv: string[],
  options?: SpawnDuetCliOptions,
) => Promise<DuetCliResult>

/**
 * A runner that answers however the spawn ends.
 *
 * `Bun.spawn` throws where the binary is missing, and every caller of this
 * seam wants that as one more CLI result — a route has a response to write,
 * a rail has a queue of targets behind the failed one — never as an
 * exception. `unavailable` is the code the CLI itself exits with for a store
 * it cannot reach, so a missing CLI reads the same way downstream.
 */
export function settledDuetCli(runner: DuetCliRunner): DuetCliRunner {
  return async (argv, options) => {
    try {
      return await runner(argv, options)
    } catch (error) {
      return {
        exitCode: MEMORY_CLI_CONTRACT.exitCodes.unavailable,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

/**
 * Run the agent CLI once and collect everything it said.
 *
 * The child is killed when the cap expires, which is the half that matters:
 * abandoning the promise would return the request but leave a wedged process
 * holding its file handles for the life of the VM.
 */
export async function spawnDuetCli(
  argv: string[],
  options: SpawnDuetCliOptions = {},
): Promise<DuetCliResult> {
  const proc = Bun.spawn([options.binary ?? DUET_CLI_BINARY, ...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env, ...MANAGED_CLI_ENV },
  })

  let timedOut = false
  let outputTooLarge = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, options.timeoutMs ?? DUET_CLI_TIMEOUT_MS)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedText(proc.stdout, options.maxStdoutBytes, () => {
        outputTooLarge = true
        proc.kill()
      }),
      readBoundedText(proc.stderr, options.maxStderrBytes, () => {
        outputTooLarge = true
        proc.kill()
      }),
      proc.exited,
    ])
    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      ...(outputTooLarge ? { outputTooLarge: true } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number | undefined,
  onExceeded: () => void,
): Promise<string> {
  if (maxBytes === undefined) return await new Response(stream).text()
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const read = await reader.read()
      if (read.done) return text + decoder.decode()
      const remaining = maxBytes - bytes
      if (read.value.byteLength > remaining) {
        if (remaining > 0)
          text += decoder.decode(read.value.subarray(0, remaining), { stream: true })
        onExceeded()
        await reader.cancel()
        // Do not flush an incomplete code point split by the byte ceiling: its
        // replacement character could make the returned UTF-8 text exceed the
        // very byte limit this reader promises.
        return text
      }
      bytes += read.value.byteLength
      text += decoder.decode(read.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}
