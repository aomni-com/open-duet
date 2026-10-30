/**
 * Gateway-managed supervisor for the privileged fanotify helper (slice 10).
 *
 * The helper (`helper-main.ts`) is NOT its own systemd unit and has NO durable
 * event spool (David's simplification, MAP L7 accepted-loss): it lives and dies
 * with the gateway. This supervisor spawns it as `sudo -n bun <helperPath>
 * <driveDir> <gatewayPid>` holding a LIVE stdin pipe for its whole life (the
 * helper treats stdin EOF as shutdown — slice-09 deviation #4), awaits the
 * `ready` handshake, forwards parsed `HelperEvent`s, restarts it with bounded
 * backoff on any unexpected exit, and kills it on `stop()` so a gateway
 * shutdown never leaks an orphaned root process.
 *
 * Firewall: helper-down time is just uncaptured OS events (counted via
 * `helperRestarts`), never a file-service failure — the gateway keeps serving
 * files regardless. A protocol-version mismatch at `ready` fails LOUDLY (a
 * self-update always ships a matched helper, so a mismatch is a real bug) and
 * does not restart-loop a helper that will only mismatch again.
 *
 * No resolver/policy logic lives here — turning `unit` cgroup leaves into
 * actors is slice 11, which wires this supervisor into the gateway runtime.
 */
import {
  HELPER_PROTOCOL_VERSION,
  encodeHelperCommand,
  parseHelperLine,
  type HelperEvent,
} from './helper-protocol'

/** A spawned helper child, as the supervisor uses it. Injectable for tests. */
export type HelperCommandResult = { status: 'sent' } | { status: 'helper_down'; error: string }

export interface HelperChild {
  /** Raw stdout bytes — one NDJSON `HelperEvent` frame per line. */
  readonly stdout: AsyncIterable<Uint8Array>
  /** Attempts one command write; a dead child is reported, never thrown to the caller. */
  sendCommand(frame: string): Promise<HelperCommandResult>
  /** Terminates the child. SIGTERM lets the helper shut down cleanly. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
  /** Resolves when the child has exited, for any reason. */
  readonly exited: Promise<void>
}

/** Spawns one helper child from a full argv (`['sudo','-n','bun',...]`). */
export type SpawnHelper = (argv: readonly string[]) => HelperChild

export interface HelperSupervisorOptions {
  /** Absolute path to the bundled `helper.js` in the running release. */
  helperPath: string
  /** Absolute drive directory the helper watches. */
  driveDir: string
  /** Child spawner (production default wraps `Bun.spawn`). */
  spawn: SpawnHelper
  /** Called for every forwarded `fs`/`stats` frame (never `ready`). */
  onEvent: (event: HelperEvent) => void
  /** Called whenever the helper transitions to down (crash/restart), not on `stop()`. */
  onDown?: () => void
  /** Called after every successful handshake, before filesystem events are forwarded. */
  onReady?: () => void | Promise<void>
  /** Gateway pid passed to the helper so it drops its own events; defaults to process.pid. */
  gatewayPid?: number
  /**
   * Absolute bun binary to exec under sudo. Defaults to `process.execPath` (the
   * bun already running the gateway) — sudo resets PATH to its secure_path, so a
   * bare `bun` would not resolve; the absolute path is what production needs.
   */
  bunPath?: string
  /** Bounded exponential backoff between restarts. */
  backoff?: { baseMs: number; maxMs: number }
  /** Injectable timer (tests). */
  delay?: (ms: number) => Promise<void>
  /** Structured log sink; defaults to console.warn/error via a JSON line. */
  log?: (fields: Record<string, unknown>) => void
}

export interface HelperSupervisorStats {
  /** Number of unexpected helper exits that triggered a restart. */
  helperRestarts: number
  /** Number of stdout lines that failed to parse as a HelperEvent. */
  malformedFrames: number
  /** True while a child is up and past its `ready` handshake. */
  running: boolean
}

export interface HelperSupervisor {
  /** Spawns the helper and resolves once it emits a protocol-matched `ready`. */
  start(): Promise<void>
  /** Starts the helper and keeps its Syncthing excluded pid current. */
  startWithSyncthingPidRefresh(): Promise<void>
  /** Turns semantic-event emission on/off in the helper (held across restarts). */
  suppress(on: boolean): void
  /**
   * Sets the helper's excluded-pid set — non-session pids dropped like
   * gateway-pid (the Syncthing daemon; L9 "semantic events win"). Whole-set
   * replacement, held across restarts and re-applied to every fresh child.
   */
  excludePids(pids: readonly number[]): void
  /** Stops restarting and kills the running child; resolves once it is gone. */
  stop(): Promise<void>
  stats(): HelperSupervisorStats
}

const DEFAULT_BACKOFF = { baseMs: 250, maxMs: 5_000 }
const SYNCTHING_UNIT = 'duet-syncthing.service'
const SYNCTHING_PID_REFRESH_MS = 30_000

export function createHelperSupervisor(options: HelperSupervisorOptions): HelperSupervisor {
  const gatewayPid = options.gatewayPid ?? process.pid
  const backoff = options.backoff ?? DEFAULT_BACKOFF
  const delay = options.delay ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const log =
    options.log ?? (fields => console.warn(JSON.stringify({ component: 'helper', ...fields })))
  const bunPath = options.bunPath ?? process.execPath
  const argv = ['sudo', '-n', bunPath, options.helperPath, options.driveDir, String(gatewayPid)]

  let stopped = false
  /** Set when a helper is unusable no matter how often we respawn (proto mismatch). */
  let fatal: Error | null = null
  let child: HelperChild | null = null
  let suppressed = false
  let excludedPids: number[] = []
  let helperRestarts = 0
  let malformedFrames = 0
  let running = false
  let loop: Promise<void> | null = null
  let syncthingPidRefreshStarted = false

  let readyResolve: (() => void) | null = null
  let readyReject: ((error: Error) => void) | null = null
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  // Swallow unhandled-rejection noise if start()'s promise is never awaited to
  // completion (e.g. stop() before ready) — callers that await it still see it.
  readyPromise.catch(() => undefined)

  function settleReadyOk(): void {
    readyResolve?.()
    readyResolve = null
    readyReject = null
  }
  function settleReadyErr(error: Error): void {
    readyReject?.(error)
    readyResolve = null
    readyReject = null
  }

  async function sendCommand(current: HelperChild, frame: string): Promise<boolean> {
    let result: HelperCommandResult
    try {
      result = await current.sendCommand(frame)
    } catch (error) {
      // Defend the gateway even if an injected/alternate child violates the
      // HelperChild contract. Production's adapter reports this as helper_down.
      result = { status: 'helper_down', error: errorMessage(error) }
    }
    if (result.status === 'sent') return true

    log({ event: 'helper_write_failed', error: result.error })
    if (child !== current || stopped) return false
    running = false
    child = null
    try {
      current.kill('SIGKILL')
    } catch {
      // The child is already down; supervision will restart it from runLoop.
    }
    return false
  }

  function sendToCurrent(frame: string): void {
    const current = child
    if (current === null) return
    void sendCommand(current, frame).catch(() => undefined)
  }

  function setExcludedPids(pids: readonly number[]): void {
    excludedPids = [...pids]
    sendToCurrent(encodeHelperCommand({ t: 'exclude-pids', pids: excludedPids }))
  }

  async function runOnce(): Promise<void> {
    const current = options.spawn(argv)
    child = current
    let sawReady = false
    let pending = ''
    const decoder = new TextDecoder()
    try {
      for await (const chunk of current.stdout) {
        pending += decoder.decode(chunk, { stream: true })
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim()
          pending = pending.slice(newline + 1)
          if (line === '') continue
          const event = parseHelperLine(line)
          if (event === null) {
            malformedFrames += 1
            continue
          }
          if (event.t === 'ready') {
            if (event.protocol !== HELPER_PROTOCOL_VERSION) {
              fatal = new Error(
                `helper protocol mismatch: helper speaks v${event.protocol}, gateway expects v${HELPER_PROTOCOL_VERSION}`,
              )
              log({ event: 'protocol_mismatch', helperProtocol: event.protocol })
              current.kill('SIGKILL')
              return
            }
            running = true
            // Re-apply the desired suppression + excluded-pid state to every
            // fresh child (the helper starts with an empty set each spawn).
            if (
              suppressed &&
              !(await sendCommand(current, encodeHelperCommand({ t: 'suppress', on: true })))
            ) {
              return
            }
            if (excludedPids.length > 0) {
              if (
                !(await sendCommand(
                  current,
                  encodeHelperCommand({ t: 'exclude-pids', pids: excludedPids }),
                ))
              ) {
                return
              }
            }
            await options.onReady?.()
            sawReady = true
            settleReadyOk()
            continue
          }
          options.onEvent(event)
        }
      }
    } finally {
      running = false
      child = null
      await current.exited.catch(() => undefined)
    }
    if (!sawReady && !stopped && fatal === null) {
      // Exited before a handshake — a startup crash; the run loop backs off.
      log({ event: 'helper_exit_before_ready' })
    }
  }

  async function runLoop(): Promise<void> {
    let attempt = 0
    while (!stopped && fatal === null) {
      try {
        await runOnce()
      } catch (error) {
        // A spawn or stdout-iteration failure is just another way for the
        // helper to be down — degrade to a restart, never crash the gateway.
        running = false
        child = null
        log({ event: 'helper_run_error', error: String(error) })
      }
      if (stopped || fatal !== null) break
      options.onDown?.()
      helperRestarts += 1
      const waitMs = Math.min(backoff.maxMs, backoff.baseMs * 2 ** attempt)
      attempt += 1
      log({ event: 'helper_restart', helperRestarts, backoffMs: waitMs })
      await delay(waitMs)
    }
    if (fatal !== null) {
      options.onDown?.()
      settleReadyErr(fatal)
    }
  }

  return {
    start(): Promise<void> {
      if (loop === null) loop = runLoop()
      return readyPromise
    },
    startWithSyncthingPidRefresh(): Promise<void> {
      if (!syncthingPidRefreshStarted) {
        syncthingPidRefreshStarted = true
        void (async () => {
          while (!stopped) {
            try {
              const pid = await discoverSyncthingPid(options.spawn)
              setExcludedPids(pid === null ? [] : [pid])
            } catch (error) {
              log({ event: 'syncthing_pid_refresh_failed', error: errorMessage(error) })
            }
            await delay(SYNCTHING_PID_REFRESH_MS)
          }
        })().catch(error => {
          log({ event: 'syncthing_pid_refresh_failed', error: errorMessage(error) })
        })
      }
      if (loop === null) loop = runLoop()
      return readyPromise
    },
    suppress(on: boolean): void {
      suppressed = on
      // Only reaches a child that is up; the desired state is re-sent on ready.
      sendToCurrent(encodeHelperCommand({ t: 'suppress', on }))
    },
    excludePids(pids: readonly number[]): void {
      // Only reaches a child that is up; the desired set is re-sent on ready.
      setExcludedPids(pids)
    },
    async stop(): Promise<void> {
      stopped = true
      settleReadyErr(new Error('helper supervisor stopped before ready'))
      // SIGTERM lets the helper answer pending perm events and flush final
      // stats; the loop only resolves once the child's `exited` settles, so
      // awaiting it is the no-orphan guarantee.
      child?.kill('SIGTERM')
      await loop?.catch(() => undefined)
    },
    stats(): HelperSupervisorStats {
      return { helperRestarts, malformedFrames, running }
    },
  }
}

/** The Syncthing daemon's systemd MainPID, or null while it is absent or inactive. */
async function discoverSyncthingPid(spawn: SpawnHelper): Promise<number | null> {
  const proc = spawn(['systemctl', 'show', SYNCTHING_UNIT, '--property=MainPID', '--value'])
  const decoder = new TextDecoder()
  let output = ''
  for await (const chunk of proc.stdout) output += decoder.decode(chunk, { stream: true })
  output += decoder.decode()
  await proc.exited
  const value = output.trim()
  if (value === '0') return null
  if (!/^\d+$/.test(value)) throw new Error(`invalid Syncthing MainPID: ${JSON.stringify(value)}`)
  const pid = Number(value)
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`invalid Syncthing MainPID: ${JSON.stringify(value)}`)
  }
  return pid
}

/**
 * Production spawner: `Bun.spawn` with a piped stdin held open for the child's
 * whole life (never `.end()` — EOF is the helper's shutdown signal) and a piped
 * stdout the supervisor drains line by line. stderr is inherited so helper
 * diagnostics land in the gateway journal.
 */
export function spawnHelperProcess(argv: readonly string[]): HelperChild {
  const proc = Bun.spawn(argv as string[], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  return {
    stdout: proc.stdout,
    async sendCommand(frame: string): Promise<HelperCommandResult> {
      try {
        proc.stdin.write(frame)
        await proc.stdin.flush()
        return { status: 'sent' }
      } catch (error) {
        return { status: 'helper_down', error: errorMessage(error) }
      }
    },
    kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
      proc.kill(signal)
    },
    exited: proc.exited.then(() => undefined),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
