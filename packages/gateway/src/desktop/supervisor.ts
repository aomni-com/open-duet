import {
  BROWSER_STACK_RETENTION_MS,
  DESKTOP_BROWSER_UNIT,
  DESKTOP_TARGET_UNIT,
  type DesktopPhase,
} from '@repo/contract'

import type { SystemCommandRunner } from '../system-command'
import type { BrowserMetricsReap } from './browser-metrics'

export const DESKTOP_REAP_GRACE_MS = 90_000
export const DESKTOP_TICK_MS = 5_000

/**
 * Ceiling on the gap between unattended start attempts for a target that keeps
 * failing.
 *
 * A desktop start is expensive — it pulls in Xvfb and a full Chrome — and its
 * commonest failure is not transient: on a workspace whose root disk is full,
 * Chrome cannot create its profile socket and fails every single time. Because
 * a live agent runner asks for the desktop on every tick, an unconditional
 * retry there is an infinite loop at tick cadence, which is exactly what pinned
 * 36 production VMs at ~0.115 vCPU against a 0.031 idle floor and consumed
 * about a third of the fleet's CPU pool.
 *
 * Backing off rather than latching off keeps the recovery automatic: the disk
 * gets freed and the next attempt succeeds, with no restart and no operator.
 */
export const DESKTOP_START_BACKOFF_MAX_MS = 15 * 60_000

const TARGET = DESKTOP_TARGET_UNIT

/**
 * Quiet systemd's own restart loop after a failed start.
 *
 * `duet-desktop-browser.service` is `Restart=always` with a one-second gap and
 * no start limit, so a Chrome that cannot start is relaunched every second for
 * as long as the unit is merely failing — one production VM reached
 * NRestarts=33990, and each attempt leaked another metrics file. A deliberate
 * stop is what ends that: systemd does not restart a unit it was told to stop.
 *
 * Fixing this in the unit file would be more direct, but the unit only reaches
 * a VM through an image rebuild, whereas this reaches every VM on the next
 * gateway release. `stop` on this unit is already in the shipped sudoers, so
 * nothing new has to be granted.
 */
export const DESKTOP_STOP_BROWSER_ARGV = ['sudo', '-n', 'systemctl', 'stop', DESKTOP_BROWSER_UNIT]

export interface DesktopLifecycle {
  ensureStarted(): Promise<DesktopPhase>
  phase(): DesktopPhase
  viewerAttached(): () => void
  viewerCount(): number
}

export interface DesktopSupervisor extends DesktopLifecycle {
  tick(): Promise<void>
  runMaintenance<T>(work: () => Promise<T>): Promise<T>
}

export function createDesktopSupervisor(options: {
  runCommand: SystemCommandRunner
  /**
   * Bound Chrome's leaked per-launch metrics files before a start. Injected
   * rather than called directly so the supervisor keeps one IO seam, and
   * omitted by callers that do not own a profile directory.
   */
  reapBrowserMetrics?: () => Promise<BrowserMetricsReap>
  /**
   * Remove an orphaned X display lock before a start, returning whether one was
   * there. Injected for the same reason as the reap: one IO seam.
   */
  clearStaleDisplayLock?: () => Promise<boolean>
  hasLiveAgentRunners: () => boolean
  lastBrowserActivityAt?: () => number | undefined
  isStartBlocked?: () => boolean
  now?: () => number
  log?: (fields: Record<string, unknown>) => void
}): DesktopSupervisor {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => undefined)
  let currentPhase: DesktopPhase = 'stopped'
  let viewers = 0
  let lastRequestedAt = Number.NEGATIVE_INFINITY
  let operation = Promise.resolve<unknown>(undefined)
  let startInFlight: Promise<DesktopPhase> | undefined
  let consecutiveStartFailures = 0
  let nextUnattendedStartAt = Number.NEGATIVE_INFINITY
  let browserStoppedWhileTargetDown = false

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = operation.then(work, work)
    operation = next.catch(() => undefined)
    return next
  }

  /** Exponential from one tick to the ceiling: 5s, 10s, 20s … 15m. */
  function backoffAfter(failures: number): number {
    return Math.min(DESKTOP_START_BACKOFF_MAX_MS, DESKTOP_TICK_MS * 2 ** (failures - 1))
  }

  async function start(): Promise<DesktopPhase> {
    if (currentPhase === 'ready') return currentPhase
    currentPhase = 'starting'
    try {
      // Ahead of the start it unblocks: on a workspace the leak has already
      // filled, Chrome cannot create its profile socket until this frees space,
      // so this is what makes a gateway release self-healing. A reap that
      // cannot run is not a reason to skip the start.
      const reaped = await options.reapBrowserMetrics?.().catch(() => undefined)
      if (reaped !== undefined && reaped.deleted > 0) {
        log({ operation: 'reap_browser_metrics', ...reaped })
      }
      // An orphaned display lock refuses every start until it is removed, so it
      // has to go before the attempt rather than after the failure.
      if ((await options.clearStaleDisplayLock?.().catch(() => false)) === true) {
        log({ operation: 'clear_stale_display_lock', status: 'cleared' })
      }
      const result = await options.runCommand(['sudo', '-n', 'systemctl', 'start', TARGET])
      if (result.exitCode !== 0)
        throw new Error(`desktop target start failed with exit code ${result.exitCode}`)
      currentPhase = 'ready'
      consecutiveStartFailures = 0
      nextUnattendedStartAt = Number.NEGATIVE_INFINITY
      log({ operation: 'start', status: 'ready' })
      return currentPhase
    } catch (error) {
      currentPhase = 'stopped'
      consecutiveStartFailures += 1
      const backoffMs = backoffAfter(consecutiveStartFailures)
      nextUnattendedStartAt = now() + backoffMs
      // Backing off our own retries is only half of it: systemd would go on
      // relaunching the browser unit every second in the gap. Stopping it is
      // what makes the backoff an actual pause.
      await options.runCommand(DESKTOP_STOP_BROWSER_ARGV).catch(() => undefined)
      log({
        operation: 'start',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        consecutiveFailures: consecutiveStartFailures,
        backoffMs,
      })
      throw error
    }
  }

  return {
    ensureStarted(): Promise<DesktopPhase> {
      lastRequestedAt = now()
      if (startInFlight !== undefined) return startInFlight
      if (options.isStartBlocked?.() === true) {
        return Promise.reject(new Error('desktop start blocked for maintenance'))
      }
      if (currentPhase === 'ready') return Promise.resolve(currentPhase)
      currentPhase = 'starting'
      startInFlight = serialize(start).finally(() => {
        startInFlight = undefined
      })
      return startInFlight
    },
    phase(): DesktopPhase {
      return currentPhase
    },
    viewerAttached(): () => void {
      viewers += 1
      let attached = true
      return () => {
        if (!attached) return
        attached = false
        viewers = Math.max(0, viewers - 1)
      }
    },
    viewerCount(): number {
      return viewers
    },
    runMaintenance<T>(work: () => Promise<T>): Promise<T> {
      return serialize(work)
    },
    tick(): Promise<void> {
      return serialize(async () => {
        const activeResult = await options.runCommand([
          'sudo',
          '-n',
          'systemctl',
          'is-active',
          TARGET,
        ])
        currentPhase = activeResult.exitCode === 0 ? 'ready' : 'stopped'

        // Chrome must not outlive the target. duet-desktop.target only `Wants`
        // the browser unit, so systemd starts Chrome even when KasmVNC failed;
        // Chrome cannot then reach its display, dies, and `Restart=always`
        // relaunches it every second — leaking a 4 MiB metrics file each time.
        // That is the engine behind the 2026-08-27 pool exhaustion, and making
        // the dependency `Requires` would need an image rebuild.
        //
        // Latched on the down-transition rather than run every tick: the fix is
        // a state reconciliation, and re-issuing it on a schedule would spend
        // twelve needless sudo calls a minute on every idle workspace.
        if (currentPhase === 'ready') {
          browserStoppedWhileTargetDown = false
        } else if (!browserStoppedWhileTargetDown) {
          browserStoppedWhileTargetDown = true
          await options.runCommand(DESKTOP_STOP_BROWSER_ARGV).catch(() => undefined)
        }

        if (options.hasLiveAgentRunners()) {
          // Unattended: a live runner wants a desktop on every tick, so this is
          // the branch that must respect the backoff. An explicit
          // `ensureStarted()` — someone actually asking — still attempts once.
          if (currentPhase !== 'ready' && now() >= nextUnattendedStartAt) {
            await start().catch(() => undefined)
          }
          return
        }
        const browserActivityAt = options.lastBrowserActivityAt?.()
        if (
          currentPhase !== 'ready' ||
          viewers > 0 ||
          now() - lastRequestedAt <= DESKTOP_REAP_GRACE_MS ||
          (browserActivityAt !== undefined &&
            now() - browserActivityAt <= BROWSER_STACK_RETENTION_MS)
        ) {
          return
        }

        const result = await options.runCommand(['sudo', '-n', 'systemctl', 'stop', TARGET])
        if (result.exitCode !== 0) {
          log({ operation: 'stop', status: 'failed', exitCode: result.exitCode })
          return
        }
        currentPhase = 'stopped'
        log({ operation: 'stop', status: 'stopped' })
      })
    },
  }
}
