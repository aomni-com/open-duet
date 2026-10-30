import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MEMORY_CLI_CONTRACT, type GatewayAnchor } from '@repo/contract'

import { agentMemoryDbPath } from './agents/agent-context'
import { writeAtomicJson } from './atomic-json'
import { settledDuetCli, spawnDuetCli, type DuetCliResult, type DuetCliRunner } from './duet-cli'
import { MANAGED_CLI_ENV } from './duet-cli'

export const MEMORY_REFLECT_STATE_FILE = 'memory-reflect.json'

/**
 * How long a memory database goes between reflection passes.
 *
 * Reflection folds aged observations into durable rows; the agent CLI leaves
 * anything younger than a few days alone, so running it more often than daily
 * spends a model call to re-read the same rows and decide again to keep them.
 */
export const MEMORY_REFLECT_INTERVAL_MS = 24 * 60 * 60 * 1_000

/**
 * How often the rail looks for a database that has come due.
 *
 * The interval is daily but the check is hourly, because the gateway restarts
 * for every release: a rail that only counted from process start would hand a
 * frequently-updated VM a reflection pass that never fires. The persisted clock
 * plus a short tick means a restart resumes the schedule instead of resetting
 * it.
 */
export const MEMORY_REFLECT_TICK_MS = 60 * 60 * 1_000

/**
 * How long one database's pass may take before it is killed.
 *
 * Reflection is a batched model call over a whole store, so this is minutes,
 * not the seconds a person waits on a memory write. The cap exists so a wedged
 * child cannot hold the database's open-lock — and with it every memory write
 * that agent tries to make — for the life of the VM.
 */
const MEMORY_REFLECT_TIMEOUT_MS = 30 * 60 * 1_000

/**
 * How long the pass waits for the database's cross-process open-lock.
 *
 * A live turn writing observations holds the lock in bursts, so a pass that
 * gave up instantly would lose every time an agent happened to be working.
 * Waiting a minute clears an ordinary burst; anything longer is a session that
 * owns the database right now, and the honest answer is to leave it alone until
 * tomorrow's slot.
 */
const MEMORY_REFLECT_LOCK_WAIT_MS = 60_000

export type MemoryReflectOutcome = 'reflected' | 'failed' | 'no_database'

export interface MemoryReflectResult {
  /** The drive root reflects as `root`; every other target is an anchor id. */
  key: string
  outcome: MemoryReflectOutcome
}

export interface MemoryReflectRailOptions {
  stateDir: string
  /** The drive root's own memory database — the default agent's store. */
  memoryDbPath: string
  anchors: () => readonly GatewayAnchor[]
  /** Reflection is a model call, so a VM without credentials cannot run one. */
  modelEnv: () => Record<string, string> | null
  runner?: DuetCliRunner
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
  log?: (fields: Record<string, unknown>) => void
}

export interface MemoryReflectRail {
  /** Reflect every database whose interval has elapsed, one at a time. */
  reflectDue(): Promise<MemoryReflectResult[]>
  start(): void
  stop(): void
}

interface ReflectTarget {
  key: string
  dbPath: string
}

/** One `lastAttemptedAt` per database key, as the state file stores it. */
type ReflectState = Record<string, number>

export function createMemoryReflectRail(options: MemoryReflectRailOptions): MemoryReflectRail {
  const now = options.now ?? Date.now
  const runner = settledDuetCli(options.runner ?? spawnDuetCli)
  const setTimer = options.setTimer ?? startUnrefdInterval
  const clearTimer =
    options.clearTimer ?? (timer => clearInterval(timer as ReturnType<typeof setInterval>))
  const statePath = join(options.stateDir, MEMORY_REFLECT_STATE_FILE)
  let state = readState(statePath)
  let pass: Promise<MemoryReflectResult[]> | null = null
  let timer: unknown = null

  return {
    reflectDue,

    start() {
      if (timer !== null) return
      timer = setTimer(() => {
        void reflectDue().catch(error =>
          log('memory_reflect_pass', 'failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }, MEMORY_REFLECT_TICK_MS)
    },

    stop() {
      if (timer === null) return
      clearTimer(timer)
      timer = null
    },
  }

  /**
   * Every memory database in this workspace: the drive root's, then one per
   * agent.
   *
   * Agents do not share a store — an agent's memories live under its own anchor
   * — so a reflection pass is per database rather than per VM. An anchor with
   * no agent (an app, a publish) has no memory to fold.
   */
  function reflectTargets(): ReflectTarget[] {
    const targets: ReflectTarget[] = [{ key: 'root', dbPath: options.memoryDbPath }]
    for (const anchor of options.anchors()) {
      if (anchor.agentId === undefined) continue
      try {
        targets.push({ key: anchor.id, dbPath: agentMemoryDbPath(options.stateDir, anchor.id) })
      } catch {
        // An anchor id that cannot be a path segment was never given a state
        // directory to hold a database either.
      }
    }
    return targets
  }

  function reflectDue(): Promise<MemoryReflectResult[]> {
    // One pass at a time: a tick that lands while yesterday's batch is still
    // folding must not start a second CLI against the same database.
    if (pass !== null) return pass
    pass = runPass().finally(() => {
      pass = null
    })
    return pass
  }

  async function runPass(): Promise<MemoryReflectResult[]> {
    const targets = reflectTargets()
    const due = seedAndCollectDue(targets)
    if (due.length === 0) return []
    const env = options.modelEnv()
    if (env === null) {
      // Not a failure and not a skipped slot: with no credentials the pass
      // cannot reach a model at all, so nothing is stamped and the next tick
      // tries again.
      log('memory_reflect_pass', 'skipped', { reason: 'model_credentials_unavailable' })
      return []
    }
    const results: MemoryReflectResult[] = []
    for (const target of due) {
      // Stamped before the run, not after: a pass killed mid-fold (a release
      // restart, the timeout) has already spent its slot, and retrying it on
      // every boot would turn a crash loop into a billing loop.
      stamp(target.key, targets)
      results.push({ key: target.key, outcome: await reflectOne(target, env) })
    }
    return results
  }

  async function reflectOne(
    target: ReflectTarget,
    env: Record<string, string>,
  ): Promise<MemoryReflectOutcome> {
    // An agent whose sessions have never written a memory has no database yet.
    // Reflecting would create an empty one and charge a model call to find it
    // empty.
    if (!existsSync(target.dbPath)) {
      log('memory_reflect', 'no_database', { target: target.key })
      return 'no_database'
    }
    const result = await runCli(target, env)
    if (result.exitCode === MEMORY_CLI_CONTRACT.exitCodes.ok) {
      log('memory_reflect', 'reflected', { target: target.key })
      return 'reflected'
    }
    // Every failure — a held lock, a corrupt store, a model outage — waits for
    // the next daily slot rather than being retried within the hour. Reflection
    // only ever looks at rows that are days old, so a missed day costs nothing
    // and a retry storm costs a model call per hour per agent.
    log('memory_reflect', 'failed', {
      target: target.key,
      exitCode: result.exitCode,
      ...(result.timedOut === true ? { timedOut: true } : {}),
      error: (result.stderr.trim() || result.stdout.trim()).slice(0, 500),
    })
    return 'failed'
  }

  async function runCli(
    target: ReflectTarget,
    env: Record<string, string>,
  ): Promise<DuetCliResult> {
    const argv = MEMORY_CLI_CONTRACT.reflect.argv({
      dbPath: target.dbPath,
      waitMs: MEMORY_REFLECT_LOCK_WAIT_MS,
    })
    return await runner(argv, {
      // The rail-owned env travels for the reason the runner spawn carries
      // it: a CLI that upgrades itself on launch turns a per-agent nightly
      // pass into one `npm install -g` per agent per night, all against the
      // same global prefix.
      env: { ...env, ...MANAGED_CLI_ENV },
      timeoutMs: MEMORY_REFLECT_TIMEOUT_MS,
    })
  }

  /**
   * Give a newly seen database its first deadline and return the ones already
   * past theirs.
   *
   * A target is seeded rather than reflected on sight so that adding an agent —
   * or shipping this rail to a VM that has been running for months — does not
   * fire a model call the moment the gateway notices the store.
   */
  function seedAndCollectDue(targets: ReflectTarget[]): ReflectTarget[] {
    const at = now()
    const due: ReflectTarget[] = []
    for (const target of targets) {
      const last = state[target.key]
      // Anything that is not a timestamp — a hand-edited file, a shape from
      // some other version — reads as a database this rail has not seen, which
      // re-seeds it rather than needing a parser to reject it.
      if (typeof last !== 'number') stamp(target.key, targets)
      else if (at - last >= MEMORY_REFLECT_INTERVAL_MS) due.push(target)
    }
    return due
  }

  function stamp(key: string, targets: ReflectTarget[]): void {
    // Rebuilt from the live targets, so a deleted agent drops out of the file
    // here rather than accumulating a row apiece for the life of the workspace.
    const next: ReflectState = {}
    for (const target of targets) {
      const value = target.key === key ? now() : state[target.key]
      if (value !== undefined) next[target.key] = value
    }
    writeAtomicJson(statePath, next)
    state = next
  }

  function log(operation: string, status: string, fields: Record<string, unknown> = {}): void {
    options.log?.({ operation, status, ...fields })
  }
}

function readState(path: string): ReflectState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as ReflectState) : {}
  } catch {
    return {}
  }
}

function startUnrefdInterval(callback: () => void, delayMs: number): unknown {
  const interval = setInterval(callback, delayMs)
  // A maintenance tick is never a reason to keep the process alive.
  interval.unref?.()
  return interval
}
