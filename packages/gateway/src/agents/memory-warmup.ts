import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

import { MEMORY_CLI_CONTRACT, type GatewayAnchor } from '@repo/contract'

import { settledDuetCli, spawnDuetCli, type DuetCliRunner } from '../duet-cli'
import { MANAGED_CLI_ENV } from '../duet-cli'
import { agentMemoryDbPath } from './agent-context'

/**
 * A fresh store is a full PGlite bootstrap plus every migration — measured at
 * 6–11s of CPU on a workspace VM. The cap only has to catch a wedged CLI, and a
 * build killed early leaves the agent paying on its first turn instead, so
 * it is generous.
 */
const MEMORY_WARMUP_TIMEOUT_MS = 2 * 60 * 1_000

export type MemoryWarmupOutcome = 'warmed' | 'superseded' | 'failed'

export interface MemoryWarmupResult {
  /** The drive root's store — the default agent's — is `root`; every other key is an anchor id. */
  key: string
  outcome: MemoryWarmupOutcome
}

export interface MemoryWarmupRailOptions {
  stateDir: string
  /** The drive root's own memory database — the default agent's store. */
  memoryDbPath: string
  /**
   * Building a store is a CPU burst on the same small VM a live turn runs on,
   * so a pass waits while any runner is active and tries again next cycle.
   */
  busy: () => boolean
  runner?: DuetCliRunner
  log?: (fields: Record<string, unknown>) => void
}

export interface MemoryWarmupRail {
  /**
   * Build every memory database that does not exist yet — the drive root's
   * first, then one per active agent anchor — one at a time. A target already
   * tried in this process is skipped whatever the result: a store that cannot
   * be built is the runner's problem to report on the first turn, not a
   * reason to burn CPU every sync cycle.
   */
  warm(anchors: readonly GatewayAnchor[]): Promise<MemoryWarmupResult[]>
}

interface WarmupTarget {
  key: string
  dbPath: string
}

/**
 * Builds memory databases ahead of the first turn that would otherwise pay
 * for them.
 *
 * A runner that finds no store creates and migrates one on its first turn:
 * 11–14s of hydrate against a ~2s norm, for a named agent and for a new
 * workspace's default agent alike. Agents are created long before they are
 * first spoken to, and a workspace boots before its owner has finished
 * signing up, so the anchor reconcile that registers one is the moment to
 * build its store in the background instead.
 *
 * The CLI builds into a scratch path beside the real one and the finished
 * directory is renamed into place only if nothing else got there first, so a
 * runner that spawns mid-build never opens a half-migrated store and a build
 * that loses the race is discarded rather than clobbering real memories.
 */
export function createMemoryWarmupRail(options: MemoryWarmupRailOptions): MemoryWarmupRail {
  const runner = settledDuetCli(options.runner ?? spawnDuetCli)
  const log = options.log ?? (() => undefined)
  const attempted = new Set<string>()
  let pass: Promise<MemoryWarmupResult[]> | null = null
  // A turn can run for minutes and the reconcile ticks every few seconds; one
  // line per wait says the same thing as one per tick.
  let deferralLogged = false

  return {
    warm(anchors) {
      if (pass !== null) return pass
      const targets = pending(anchors)
      if (targets.length === 0) return Promise.resolve([])
      pass = runPass(targets).finally(() => {
        pass = null
      })
      return pass
    },
  }

  function pending(anchors: readonly GatewayAnchor[]): WarmupTarget[] {
    const targets: WarmupTarget[] = [{ key: 'root', dbPath: options.memoryDbPath }]
    for (const anchor of anchors) {
      if (anchor.agentId === undefined || anchor.state !== 'active') continue
      try {
        targets.push({ key: anchor.id, dbPath: agentMemoryDbPath(options.stateDir, anchor.id) })
      } catch {
        // An anchor id that cannot be a path segment has no store to build.
      }
    }
    return targets.filter(target => !attempted.has(target.key) && !existsSync(target.dbPath))
  }

  async function runPass(targets: WarmupTarget[]): Promise<MemoryWarmupResult[]> {
    const results: MemoryWarmupResult[] = []
    for (const target of targets) {
      // Re-checked per store, not per pass: a turn that starts while one
      // build runs should not queue behind a workspace full of them.
      if (options.busy()) {
        if (!deferralLogged) {
          log({ operation: 'agent_memory_warmup', status: 'deferred', reason: 'runners_active' })
          deferralLogged = true
        }
        break
      }
      deferralLogged = false
      attempted.add(target.key)
      results.push({ key: target.key, outcome: await warmOne(target) })
    }
    return results
  }

  async function warmOne(target: WarmupTarget): Promise<MemoryWarmupOutcome> {
    const scratchPath = `${target.dbPath}.warm-${randomUUID().slice(0, 8)}`
    const startedAt = Date.now()
    try {
      // The same mode the session spawn gives an agent's state directory.
      mkdirSync(dirname(target.dbPath), { recursive: true, mode: 0o700 })
      const result = await runner(MEMORY_CLI_CONTRACT.open.argv({ dbPath: scratchPath }), {
        env: { ...MANAGED_CLI_ENV },
        timeoutMs: MEMORY_WARMUP_TIMEOUT_MS,
      })
      if (result.exitCode !== MEMORY_CLI_CONTRACT.exitCodes.ok || !existsSync(scratchPath)) {
        return failed(target, {
          exitCode: result.exitCode,
          ...(result.timedOut === true ? { timedOut: true } : {}),
          error: (result.stderr.trim() || result.stdout.trim()).slice(0, 500),
        })
      }
      if (existsSync(target.dbPath)) return superseded(target)
      try {
        renameSync(scratchPath, target.dbPath)
      } catch {
        // The runner created the real store between the check and the rename.
        return superseded(target)
      }
      log({
        operation: 'agent_memory_warmup',
        status: 'warmed',
        target: target.key,
        durationMs: Date.now() - startedAt,
      })
      return 'warmed'
    } catch (error) {
      // A filesystem refusal (a read-only state dir, a full disk) is this
      // store's failure to report, not a rejection nobody awaits.
      return failed(target, { error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (existsSync(scratchPath)) rmSync(scratchPath, { recursive: true, force: true })
    }
  }

  function failed(target: WarmupTarget, fields: Record<string, unknown>): MemoryWarmupOutcome {
    log({ operation: 'agent_memory_warmup', status: 'failed', target: target.key, ...fields })
    return 'failed'
  }

  function superseded(target: WarmupTarget): MemoryWarmupOutcome {
    log({ operation: 'agent_memory_warmup', status: 'superseded', target: target.key })
    return 'superseded'
  }
}
