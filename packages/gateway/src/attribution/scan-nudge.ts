import { parseActorContext, type DriveFileEvent } from '@repo/contract'

import { readMounts, syncMountsForDrivePath } from '../sync/mount-store'
import type { FetchLike } from '../sync/syncthing-client'

// Sole owner of the outbound Duet→Syncthing direction (spec file-attribution
// slice 18): subscribes to the pipeline's onEvent tap and turns foreign
// mutations (API-path, agent, terminal, system) into debounced, path-batched
// `POST /rest/db/scan?folder=&sub=` calls so mirrors see a change in
// sub-seconds instead of waiting out Syncthing's watcher debounce.
//
// - LOOP GUARD (test-pinned): `sync:*` / `mirror:*` actors never nudge —
//   Syncthing already knows what it wrote itself; nudging it back would spin
//   translate→nudge→scan forever.
// - Best-effort acceleration only: a failed scan is counted and dropped —
//   never hot-retried, never surfaced to the pipeline. Syncthing's own
//   low-delay watcher (slice-19 folder config) is the correctness baseline,
//   so a dead nudge degrades latency, not fidelity.
// - The scan endpoint is synchronous on the Syncthing side (blocks until the
//   scan completes) — calls are fired from a serialized async chain, never
//   from the pipeline's emit path.

export const DEFAULT_SCAN_NUDGE_DEBOUNCE_MS = 250
// Above this many changed paths in one folder a targeted scan stops paying
// for itself — scan the folder root once instead.
export const SCAN_NUDGE_MAX_SUBS_PER_SCAN = 32

export interface ScanTarget {
  folderId: string
  /** Path relative to the folder root; '' = the folder root itself. */
  sub: string
}

/** Drive-relative changed paths → the Syncthing folders that contain them. */
export type ScanTargetResolver = (paths: string[]) => Promise<ScanTarget[]>

/**
 * Default resolver over the mount-store registry (paths outside any synced
 * mount resolve to nothing — there is no folder to scan). When slice 19 adds
 * the whole-drive mirror folder this is the one seam that learns about it.
 */
export function mountStoreScanTargets(stateDir: string): ScanTargetResolver {
  return async paths => {
    const mounts = await readMounts(stateDir)
    const targets: ScanTarget[] = []
    for (const path of paths) {
      for (const match of syncMountsForDrivePath(mounts, path)) {
        targets.push({ folderId: match.mount.id, sub: match.sub })
      }
    }
    return targets
  }
}

export interface ScanNudgeOptions {
  /** The loopback connection seam — syncthingConnection() from the one client. */
  connection(): Promise<{ base: string; headers: Record<string, string> }>
  fetch: FetchLike
  resolveTargets: ScanTargetResolver
  debounceMs?: number
  timers?: {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
  log?(fields: Record<string, unknown>): void
}

export interface ScanNudgeStats {
  scans: number
  failures: number
  loopGuardSkips: number
  rawPathsObserved: number
  latestPaths: string[]
}

export interface ScanNudge {
  /** Pipeline tap listener — wire via pipeline.onEvent(scanNudge.onEvent). */
  onEvent(event: DriveFileEvent): void
  /** Await the in-flight flush chain (tests and drains). */
  settle(): Promise<void>
  stats(): ScanNudgeStats
  stop(): void
}

const defaultTimers = {
  setTimeout(callback: () => void, ms: number): unknown {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0])
  },
}

export function createScanNudge(options: ScanNudgeOptions): ScanNudge {
  const debounceMs = options.debounceMs ?? DEFAULT_SCAN_NUDGE_DEBOUNCE_MS
  const timers = options.timers ?? defaultTimers
  const totals: ScanNudgeStats = {
    scans: 0,
    failures: 0,
    loopGuardSkips: 0,
    rawPathsObserved: 0,
    latestPaths: [],
  }
  const pending = new Set<string>()
  let timer: unknown = null
  let inflight: Promise<void> = Promise.resolve()
  let stopped = false

  function onEvent(event: DriveFileEvent): void {
    if (stopped) return
    if (
      event.kind !== 'write' &&
      event.kind !== 'create' &&
      event.kind !== 'delete' &&
      event.kind !== 'rename'
    ) {
      return
    }
    const actor = parseActorContext(event.actor)
    if (actor !== null && (actor.kind === 'sync' || actor.kind === 'mirror')) {
      totals.loopGuardSkips += 1
      return
    }
    for (const path of event.kind === 'rename' ? [event.fromPath, event.path] : [event.path]) {
      totals.rawPathsObserved += 1
      totals.latestPaths.push(path)
      if (totals.latestPaths.length > 32) totals.latestPaths.shift()
    }
    pending.add(event.path)
    if (event.kind === 'rename') pending.add(event.fromPath)
    if (timer === null) {
      timer = timers.setTimeout(() => {
        timer = null
        inflight = inflight.then(flushPending)
      }, debounceMs)
    }
  }

  async function flushPending(): Promise<void> {
    const paths = [...pending]
    pending.clear()
    if (paths.length === 0) return
    let targets: ScanTarget[]
    let base: string
    let headers: Record<string, string>
    try {
      targets = await options.resolveTargets(paths)
      ;({ base, headers } = await options.connection())
    } catch (error) {
      totals.failures += 1
      options.log?.({
        operation: 'scan_nudge_failed',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const subsByFolder = new Map<string, Set<string>>()
    for (const target of targets) {
      const subs = subsByFolder.get(target.folderId) ?? new Set<string>()
      subs.add(target.sub)
      subsByFolder.set(target.folderId, subs)
    }
    for (const [folderId, subs] of subsByFolder) {
      const params = new URLSearchParams({ folder: folderId })
      // A sub of '' (the folder root changed) or too many subs → whole-folder
      // scan; otherwise scan exactly the changed paths (sub is repeatable).
      if (!subs.has('') && subs.size <= SCAN_NUDGE_MAX_SUBS_PER_SCAN) {
        for (const sub of subs) params.append('sub', sub)
      }
      try {
        const response = await options.fetch(`${base}/rest/db/scan?${params.toString()}`, {
          method: 'POST',
          headers,
        })
        if (response.ok) {
          totals.scans += 1
        } else {
          totals.failures += 1
          options.log?.({ operation: 'scan_nudge_failed', folderId, status: response.status })
        }
      } catch (error) {
        totals.failures += 1
        options.log?.({
          operation: 'scan_nudge_failed',
          folderId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  return {
    onEvent,
    async settle(): Promise<void> {
      await inflight
    },
    stats(): ScanNudgeStats {
      return { ...totals, latestPaths: [...totals.latestPaths] }
    },
    stop(): void {
      stopped = true
      if (timer !== null) {
        timers.clearTimeout(timer)
        timer = null
      }
    },
  }
}
