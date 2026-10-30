import { spawn } from 'node:child_process'

import { TRAIN_CLI_CONTRACT, redactImportMemoryText } from '@repo/contract'

import { DUET_CLI_BINARY, MANAGED_CLI_ENV } from '../duet-cli'
import type { TrainRunner, TrainRunnerInput } from './pipeline'

export const MAX_TRAIN_COMMAND_OUTPUT_BYTES = 12 * 1024 * 1024
export const DEFAULT_TRAIN_COMMAND_TIMEOUT_MS = 6 * 60 * 60 * 1000

export const runDuetTrain: TrainRunner = async input => {
  const trained = await runCommand(
    TRAIN_CLI_CONTRACT.argv({
      sourceDir: input.stagingDir,
      slug: input.slug,
      storeDir: input.storeDir,
    }),
    input,
  )
  if (trained.exitCode !== 0) {
    const detail = trained.stderr.trim() || trained.stdout.trim() || 'no output'
    throw new Error(`duet train failed (exit ${trained.exitCode}): ${detail}`)
  }
  return { record: null, stdout: trained.stdout, stderr: trained.stderr }
}

async function runCommand(
  argv: string[],
  input: TrainRunnerInput,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = spawn(DUET_CLI_BINARY, argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...input.env, ...MANAGED_CLI_ENV },
  })
  if (child.pid !== undefined) input.onChildPid?.(child.pid)
  const stopOnOversize = (work: Promise<string>) =>
    work.catch(error => {
      child.kill('SIGKILL')
      throw error
    })
  const stdoutPromise = stopOnOversize(readStream(child.stdout))
  const stderrPromise = stopOnOversize(readStream(child.stderr))
  const outputFailurePromise = Promise.all([stdoutPromise, stderrPromise]).then(
    () => new Promise<never>(() => undefined),
  )
  const exitPromise = new Promise<number>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', code => resolveExit(code ?? 1))
  })
  const timeoutMs = input.commandTimeoutMs ?? DEFAULT_TRAIN_COMMAND_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`duet train command exceeded ${timeoutMs}ms`))
    }, timeoutMs)
  })
  let exitCode: number
  try {
    exitCode = await Promise.race([exitPromise, timeoutPromise, outputFailurePromise])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const [rawStdout, rawStderr] = await Promise.all([stdoutPromise, stderrPromise])
  return {
    stdout: redactImportMemoryText(rawStdout).text,
    stderr: redactImportMemoryText(rawStderr).text,
    exitCode,
  }
}

async function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return ''
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.byteLength
    if (bytes > MAX_TRAIN_COMMAND_OUTPUT_BYTES) {
      throw new Error(`duet train command output exceeded ${MAX_TRAIN_COMMAND_OUTPUT_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
