import { dirname, resolve } from 'node:path'

import { readBootState } from './boot-health'
import type { DesiredStateStore } from './desired-state'
import {
  applyRuntimeRelease,
  DEFAULT_CURRENT_RELEASE_LINK,
  DEFAULT_RELEASES_DIR,
} from './runtime-release'
import { createUpdateGate } from './update-gate'

export { DEFAULT_CURRENT_RELEASE_LINK, DEFAULT_RELEASES_DIR } from './runtime-release'

export const DEFAULT_RUNTIME_UPDATE_MAX_DEFER_MS = 24 * 60 * 60 * 1000
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface RuntimeUpdaterOptions {
  apiUrl?: string
  stateDir: string
  runningVersion: string
  desiredState: DesiredStateStore
  getVmToken: () => Promise<string | null>
  hasActiveRunners: () => boolean
  blockStartsIfIdle: () => (() => void) | null
  fetch: FetchLike
  extraHeaders?: Record<string, string>
  releasesDir?: string
  currentReleaseLink?: string
  previousReleaseLink?: string
  maxDeferMs?: number
  now?: () => number
  exit?: (code: number) => void
  log?: (fields: Record<string, unknown>) => void
}

export type RuntimeUpdateCheckResult =
  | { status: 'not_needed' }
  | { status: 'missing_config' }
  | { status: 'missing_token' }
  | { status: 'deferred'; version: string; deadlineMs: number }
  | { status: 'failed'; version: string; error: string }
  | { status: 'applied'; version: string }

export interface RuntimeUpdater {
  check(): Promise<RuntimeUpdateCheckResult>
}

export function createRuntimeUpdater(options: RuntimeUpdaterOptions): RuntimeUpdater {
  const releasesDir = options.releasesDir ?? DEFAULT_RELEASES_DIR
  const currentReleaseLink = options.currentReleaseLink ?? DEFAULT_CURRENT_RELEASE_LINK
  const previousReleaseLink =
    options.previousReleaseLink ?? resolve(dirname(currentReleaseLink), 'previous')
  const maxDeferMs = options.maxDeferMs ?? DEFAULT_RUNTIME_UPDATE_MAX_DEFER_MS
  const now = options.now ?? Date.now
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const updateGate = createUpdateGate({ maxDeferMs, now, forceAfterDeadline: false })
  let inFlight: Promise<RuntimeUpdateCheckResult> | null = null
  let lastLoggedDecision: string | null = null

  return {
    check(): Promise<RuntimeUpdateCheckResult> {
      if (inFlight !== null) return inFlight
      inFlight = runCheck()
        .then(result => {
          const decision = JSON.stringify(result)
          if (decision !== lastLoggedDecision) {
            lastLoggedDecision = decision
            options.log?.({ operation: 'runtime_update', ...result })
          }
          return result
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
  }

  async function runCheck(): Promise<RuntimeUpdateCheckResult> {
    const desired = options.desiredState.current()
    const desiredVersion = desired.paused ? undefined : desired.runtimeRelease?.version
    const gate = updateGate.check({
      desiredVersion,
      runningVersion: options.runningVersion,
      hasActiveRunners: options.hasActiveRunners(),
    })
    if (gate.status === 'not_needed') return { status: 'not_needed' }
    if (options.apiUrl === undefined) return { status: 'missing_config' }
    if (gate.status === 'deferred') {
      return { status: 'deferred', version: gate.version, deadlineMs: gate.deadlineMs }
    }

    const bootState = await readBootState(options.stateDir)
    if (bootState?.quarantinedVersion === gate.version) {
      return {
        status: 'failed',
        version: gate.version,
        error: `runtime release ${gate.version} is quarantined`,
      }
    }

    const token = await options.getVmToken()
    if (token === null) return { status: 'missing_token' }
    let unblockStarts: (() => void) | null = null
    function releaseAdmission(): void {
      const unblock = unblockStarts
      unblockStarts = null
      unblock?.()
    }
    try {
      const applied = await applyRuntimeRelease({
        apiUrl: options.apiUrl,
        token,
        desiredVersion: gate.version,
        descriptor: desired.runtimeRelease,
        activateIfCurrent: async activate => {
          unblockStarts = options.blockStartsIfIdle()
          if (unblockStarts === null) return false
          const activated = await options.desiredState.activateIfCurrent(gate.version, activate)
          if (!activated) releaseAdmission()
          return activated
        },
        fetch: options.fetch,
        extraHeaders: options.extraHeaders,
        releasesDir,
        currentReleaseLink,
        previousReleaseLink,
      })
      if (applied === null) return { status: 'not_needed' }
      exit(0)
      return { status: 'applied', version: gate.version }
    } catch (error) {
      releaseAdmission()
      return {
        status: 'failed',
        version: gate.version,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
