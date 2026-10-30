import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { AgentRpcCommandAcceptedEventSchema } from '@repo/contract'
import type { ModelSelectionId } from '@repo/contract'

import { DUET_CLI_BINARY, MANAGED_CLI_ENV } from '../duet-cli'
import { redactText } from '../redaction'
import { DEVELOPER_SYSTEM_PROMPT } from './developer-system-prompt'
import { RUNNER_OWNER_ENV, RUNNER_RPC_FLAG } from './orphan-sweep'
import type { AgentRunnerCommand, AgentRunnerEvent, AgentRunnerStartedEvent } from './protocol'
import { prepareRoutingConfig } from './routing-config'

export type AgentRunnerEventListener = (event: AgentRunnerEvent) => void

/** Commands the runner acknowledges by request id. */
type CorrelatedCommandType = Extract<AgentRunnerCommand, { requestId: string }>['type']

/**
 * The runner took a command on stdin and never acknowledged it. A live
 * process that does not read its RPC is not slow: the event loop that
 * would have acked is the same one everything else it does needs, so
 * nothing it is doing can finish either.
 */
export class RunnerUnresponsiveError extends Error {
  constructor(readonly commandType: CorrelatedCommandType) {
    super(`Timeout waiting for command_accepted (${commandType})`)
    this.name = 'RunnerUnresponsiveError'
  }
}

export interface AgentRunner {
  start(): Promise<void>
  send(command: AgentRunnerCommand): Promise<void>
  waitForTurnStarted(timeoutMs?: number): Promise<AgentRunnerStartedEvent>
  onEvent(listener: AgentRunnerEventListener): () => void
  /**
   * Fires when the runner's stdout closes — the one signal a dead process
   * cannot fail to send and a live one cannot send. The process handle's own
   * exit report is diagnostics, never the verdict: see `start`.
   */
  onExit(listener: (code: number | null) => void): () => void
  isAlive(): boolean
  getPid(): number | null
  getStderr(): string
  kill(): void
}

export interface ProcessRunnerOptions {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  onOutputLimit?: (event: RunnerOutputLimitEvent) => void
  onProcessHandleExit?: (event: RunnerProcessHandleExitEvent) => void
  /** The OS edge, injectable so a test can drive a process handle by hand. */
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
}

export interface RunnerOutputLimitEvent {
  stream: 'stdout' | 'stderr'
  action: 'turn_terminated' | 'older_output_truncated'
  maxBytes: number
}

/**
 * What the process handle said, the moment it said it. `stdoutOpen: true` is
 * the case worth a log line: the runtime called the process dead while its
 * pipe was still open, which is a runtime defect and must not be silent.
 */
export interface RunnerProcessHandleExitEvent {
  code: number | null
  signal: string | null
  error?: string
  stdoutOpen: boolean
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface AgentRunnerFactoryArgs {
  sessionId: string
  cwd?: string
  tier: ModelSelectionId
  memoryDbPath: string
  systemPromptFiles: readonly string[]
  env?: Record<string, string>
  onOutputLimit?: (event: RunnerOutputLimitEvent) => void
  onProcessHandleExit?: (event: RunnerProcessHandleExitEvent) => void
}

export type AgentRunnerFactory = (args: AgentRunnerFactoryArgs) => AgentRunner

// Cold memory-store startup can exceed ordinary acknowledgement latency.
// Its readiness deadline is separate from command acceptance so startup does
// not consume the shorter per-command wait.
export const DEFAULT_TURN_STARTED_TIMEOUT_MS = 300_000
const DEFAULT_COMMAND_ACCEPTED_TIMEOUT_MS = 30_000
const DEFAULT_KILL_ESCALATION_MS = 5_000
export const RUNNER_STDOUT_RECORD_MAX_BYTES = 50 * 1024 * 1024
export const RUNNER_STDERR_MAX_BYTES = 64 * 1024
const STDERR_TRUNCATION_MARKER = '[earlier runner stderr truncated]\n'

export class ProcessAgentRunner extends EventEmitter implements AgentRunner {
  private child: ChildProcess | null = null
  private stdoutFragment = ''
  private stdoutFragmentBytes = 0
  private stderrTail = ''
  private stdoutLimitExceeded = false
  private stderrLimitExceeded = false
  private exited = false
  private stdoutClosed = false
  private handleExit: { code: number | null; signal: string | null } | null = null
  private pgid: number | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pendingCommands = new Map<
    string,
    {
      commandType: CorrelatedCommandType
      resolve: () => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  constructor(private readonly options: ProcessRunnerOptions) {
    super()
  }

  async start(): Promise<void> {
    if (this.child !== null) throw new Error('Runner already started')
    this.child = (this.options.spawn ?? spawn)(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        ...this.options.env,
        ...MANAGED_CLI_ENV,
        [RUNNER_OWNER_ENV]: String(process.pid),
      },
    })
    this.pgid = this.child.pid ?? null
    this.child.stdin?.on('error', () => undefined)
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', chunk => {
      if (this.stdoutLimitExceeded) return
      const text = String(chunk)
      this.stdoutFragment += text
      this.stdoutFragmentBytes += Buffer.byteLength(text)
      if (text.includes('\n')) this.processStdoutLines()
      if (this.stdoutFragmentBytes > RUNNER_STDOUT_RECORD_MAX_BYTES) {
        this.exceedStdoutLimit('fragment')
      }
    })
    this.child.stderr?.on('data', chunk => {
      this.appendStderr(chunk.toString())
    })
    /* A runner is dead when its stdout closes, and only then.

       The kernel closes a dead process's pipes and never closes a live one's,
       so the pipe is the one fact no runtime layer can misreport. The handle's
       `exit`/`error` is not that fact: Bun's exit bookkeeping can report an
       `error` for a process `wait4` just called alive, and a runner declared
       dead that way went on streaming and finished its turn after the gateway
       had already ended it. What the handle says is kept for the log and for
       `waitForTurnStarted`'s error text, nothing else.

       The only handle report acted on directly is a spawn that never produced
       a process (no pid): there is no pipe to wait for. */
    const stdout = this.child.stdout
    if (stdout == null) this.stdoutClosed = true
    else {
      const onStdoutClosed = () => {
        this.stdoutClosed = true
        this.finish()
      }
      stdout.once('end', onStdoutClosed)
      stdout.once('close', onStdoutClosed)
    }
    this.child.on('error', error => {
      const message = error instanceof Error ? error.message : String(error)
      this.appendStderr(`${message}\n`)
      this.options.onProcessHandleExit?.({
        code: null,
        signal: null,
        error: message,
        stdoutOpen: !this.stdoutClosed,
      })
      if (this.stdoutClosed || this.child?.pid === undefined) this.finish()
    })
    this.child.on('exit', (code, signal) => {
      this.handleExit = { code, signal }
      this.appendStderr(`[runner process exit code=${code} signal=${signal}]\n`)
      this.options.onProcessHandleExit?.({ code, signal, stdoutOpen: !this.stdoutClosed })
      if (this.stdoutClosed) this.finish()
    })
  }

  /** The runner is over: settle every waiter once, whichever signal arrived last. */
  private finish(): void {
    if (this.exited) return
    this.exited = true
    if (this.killTimer !== null) clearTimeout(this.killTimer)
    this.rejectPendingCommands('Runner exited before command acceptance')
    this.emit('exit', this.handleExit?.code ?? null)
  }

  async send(command: AgentRunnerCommand): Promise<void> {
    const stdin = this.child?.stdin
    if (stdin == null || this.exited) throw new Error('Runner not alive')
    const correlated = correlatedCommand(command)
    const accepted =
      correlated === null
        ? null
        : this.waitForCommandAcceptance(correlated.requestId, correlated.commandType)
    try {
      await new Promise<void>((resolve, reject) => {
        stdin.write(`${JSON.stringify(command)}\n`, error => {
          if (error == null) resolve()
          else reject(error)
        })
      })
      await accepted
    } catch (error) {
      if (correlated !== null) this.rejectPendingCommand(correlated.requestId, error)
      throw error
    }
  }

  waitForTurnStarted(
    timeoutMs = DEFAULT_TURN_STARTED_TIMEOUT_MS,
  ): Promise<AgentRunnerStartedEvent> {
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new Error(`Runner exited before turn_started. Stderr: ${this.stderrTail}`))
        return
      }
      const cleanup = () => {
        clearTimeout(timer)
        unsubscribe()
        this.off('exit', onExit)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timeout waiting for turn_started. Stderr: ${this.stderrTail}`))
      }, timeoutMs)
      const unsubscribe = this.onEvent(event => {
        if (event.type === 'turn_started') {
          cleanup()
          resolve(event)
        }
      })
      const onExit = () => {
        cleanup()
        reject(new Error(`Runner exited before turn_started. Stderr: ${this.stderrTail}`))
      }
      this.on('exit', onExit)
    })
  }

  onEvent(listener: AgentRunnerEventListener): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.on('exit', listener)
    return () => this.off('exit', listener)
  }

  isAlive(): boolean {
    return this.child !== null && !this.exited
  }

  getPid(): number | null {
    return this.pgid
  }

  getStderr(): string {
    return redactText(this.stderrTail)
  }

  kill(): void {
    this.rejectPendingCommands('Runner killed before command acceptance')
    const pgid = this.pgid
    if (pgid !== null) {
      try {
        process.kill(-pgid, 'SIGTERM')
      } catch {
        // Already gone.
      }
      this.killTimer = setTimeout(() => {
        try {
          process.kill(-pgid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }, DEFAULT_KILL_ESCALATION_MS)
      this.killTimer.unref()
    } else {
      this.child?.kill()
    }
    this.child = null
  }

  private processStdoutLines(): void {
    const lines = this.stdoutFragment.split('\n')
    this.stdoutFragment = lines.pop() ?? ''
    this.stdoutFragmentBytes = Buffer.byteLength(this.stdoutFragment)
    for (const line of lines) {
      if (Buffer.byteLength(line) > RUNNER_STDOUT_RECORD_MAX_BYTES) {
        this.exceedStdoutLimit('record')
        return
      }
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const value: unknown = JSON.parse(trimmed)
        const accepted = AgentRpcCommandAcceptedEventSchema.safeParse(value)
        if (accepted.success) {
          this.acceptPendingCommand(accepted.data.requestId, accepted.data.commandType)
          continue
        }
        if (
          typeof value === 'object' &&
          value !== null &&
          (value as { type?: unknown }).type === 'command_accepted'
        ) {
          this.appendStderr(`[invalid command_accepted] ${trimmed}\n`)
          continue
        }
        this.emit('event', value as AgentRunnerEvent)
      } catch {
        this.appendStderr(`[invalid ndjson] ${trimmed}\n`)
      }
    }
  }

  private exceedStdoutLimit(kind: 'fragment' | 'record'): void {
    if (this.stdoutLimitExceeded) return
    this.stdoutLimitExceeded = true
    this.stdoutFragment = ''
    this.stdoutFragmentBytes = 0
    this.appendStderr(`[runner stdout exceeded its NDJSON ${kind} limit; turn terminated]\n`)
    this.options.onOutputLimit?.({
      stream: 'stdout',
      action: 'turn_terminated',
      maxBytes: RUNNER_STDOUT_RECORD_MAX_BYTES,
    })
    this.kill()
  }

  private appendStderr(value: string): void {
    const combined = this.stderrTail + redactText(value)
    if (Buffer.byteLength(combined) <= RUNNER_STDERR_MAX_BYTES) {
      this.stderrTail = combined
      return
    }
    if (!this.stderrLimitExceeded) {
      this.stderrLimitExceeded = true
      this.options.onOutputLimit?.({
        stream: 'stderr',
        action: 'older_output_truncated',
        maxBytes: RUNNER_STDERR_MAX_BYTES,
      })
    }
    const tailBytes = RUNNER_STDERR_MAX_BYTES - Buffer.byteLength(STDERR_TRUNCATION_MARKER)
    this.stderrTail = STDERR_TRUNCATION_MARKER + utf8Tail(combined, tailBytes)
  }

  private waitForCommandAcceptance(
    requestId: string,
    commandType: CorrelatedCommandType,
  ): Promise<void> {
    if (requestId.trim().length === 0) throw new Error('Runner command request id is required')
    if (this.pendingCommands.has(requestId))
      throw new Error('Runner command request id is in flight')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(requestId)
        reject(new RunnerUnresponsiveError(commandType))
      }, DEFAULT_COMMAND_ACCEPTED_TIMEOUT_MS)
      timer.unref()
      this.pendingCommands.set(requestId, { commandType, resolve, reject, timer })
    })
  }

  private acceptPendingCommand(requestId: string, commandType: CorrelatedCommandType): void {
    const pending = this.pendingCommands.get(requestId)
    if (pending === undefined) return
    if (pending.commandType !== commandType) {
      this.rejectPendingCommand(requestId, new Error('Runner command acceptance type mismatch'))
      return
    }
    clearTimeout(pending.timer)
    this.pendingCommands.delete(requestId)
    pending.resolve()
  }

  private rejectPendingCommand(requestId: string, error: unknown): void {
    const pending = this.pendingCommands.get(requestId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingCommands.delete(requestId)
    pending.reject(error instanceof Error ? error : new Error(String(error)))
  }

  private rejectPendingCommands(message: string): void {
    for (const requestId of this.pendingCommands.keys()) {
      this.rejectPendingCommand(requestId, new Error(message))
    }
  }
}

function utf8Tail(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value)
  if (encoded.byteLength <= maxBytes) return value
  let start = encoded.byteLength - maxBytes
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1
  return encoded.subarray(start).toString('utf8')
}

function correlatedCommand(command: AgentRunnerCommand): {
  requestId: string
  commandType: CorrelatedCommandType
} | null {
  switch (command.type) {
    case 'prompt':
    case 'answer':
    case 'wake':
      return { requestId: command.requestId, commandType: command.type }
    case 'start':
    case 'interrupt':
      return null
  }
}

export function defaultRunnerFactory(args: AgentRunnerFactoryArgs, driveDir: string): AgentRunner {
  const cwd = resolveAgentCwd(driveDir, args.cwd)
  // Absolute-only: the runner joins a relative name onto its cwd, which would
  // silently resolve a state-dir file to a non-existent path inside the drive
  // and drop the layer without a word.
  if (args.systemPromptFiles.some(file => !isAbsolute(file))) {
    throw new Error('Invalid agent system prompt path')
  }
  prepareRoutingConfig(cwd)
  return new ProcessAgentRunner({
    command: DUET_CLI_BINARY,
    args: [
      RUNNER_RPC_FLAG,
      '--session',
      args.sessionId,
      '--workdir',
      cwd,
      '--db',
      args.memoryDbPath,
      '--model',
      args.tier,
      '--system-prompt',
      DEVELOPER_SYSTEM_PROMPT,
      // Repeatable by design: the runner renders one `<system_prompt_file>`
      // block per flag, in order, so an onboarding session gets the author's
      // instructions followed by the product's completion contract.
      ...args.systemPromptFiles.flatMap(file => ['--system-prompt-file', file]),
    ],
    cwd,
    // The session's own database, so a tool call reaches the rows the runner
    // does: a bare `duet memory add --db` in a shell defaults to the drive
    // root's, filing one agent's note under another's memory. Session-named
    // rather than echoing the gateway's inherited `DUET_MEMORY_DB_PATH`, which
    // points at that root database. Owned here: a caller cannot redirect it.
    env: {
      ...args.env,
      DUET_SESSION_ID: args.sessionId,
      DUET_SESSION_MEMORY_DB: args.memoryDbPath,
    },
    onOutputLimit: args.onOutputLimit,
    onProcessHandleExit: args.onProcessHandleExit,
  })
}

export function resolveAgentCwd(driveDir: string, cwd?: string): string {
  const resolved = resolveAgentPath(driveDir, cwd)
  if (!isDirectory(resolved)) throw new Error('Invalid agent cwd')
  return resolved
}

export function resolveAgentPath(driveDir: string, cwd?: string): string {
  const root = resolve(driveDir)
  if (cwd === undefined || cwd.length === 0 || cwd === '/') return root
  if (isAbsolute(cwd)) throw new Error('Invalid agent cwd')
  const resolved = resolve(root, cwd)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
    throw new Error('Invalid agent cwd')
  // A symlink inside the drive can stay under root lexically while pointing
  // outside it, so containment must also hold for the real filesystem target.
  // Best-effort: the drive is writable while sessions run, so spawn's own
  // failure remains the backstop for changes made after this check.
  const realRoot = realpathDeepestExisting(root)
  const real = realpathDeepestExisting(resolved)
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`))
    throw new Error('Invalid agent cwd')
  return resolved
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function realpathDeepestExisting(path: string): string {
  const missingTail: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync(current), ...missingTail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missingTail.unshift(basename(current))
      current = parent
    }
  }
}
