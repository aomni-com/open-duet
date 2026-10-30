import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const BOOT_STATE_FILE = 'runtime-boot-state.json'

export interface BootState {
  attemptedVersion: string
  consecutiveFailures: number
  previousVersion?: string
  quarantinedVersion?: string
  healthyVersion?: string
  healthyAt?: number
}

export interface BootHealth {
  recordSyncOk(): Promise<void>
  markerWritten(): boolean
  /** True once this process has verified that its running release is certified healthy. */
  certified(): boolean
}

export function createBootHealth(options: {
  stateDir: string
  now: () => number
  minUptimeMs?: number
  minSyncOks?: number
}): BootHealth {
  const startedAt = options.now()
  const minUptimeMs = options.minUptimeMs ?? 60_000
  const minSyncOks = options.minSyncOks ?? 3
  let syncOks = 0
  let runningVersion: string | undefined
  let wroteMarker = false
  let settled = false
  let queue = Promise.resolve()

  return {
    recordSyncOk(): Promise<void> {
      const result = queue.then(record)
      queue = result.catch(() => undefined)
      return result
    },
    markerWritten: () => wroteMarker,
    certified: () => settled,
  }

  async function record(): Promise<void> {
    if (settled) return
    syncOks += 1
    const state = await readBootState(options.stateDir)
    if (state === null) return
    runningVersion ??= state.attemptedVersion
    if (state.attemptedVersion !== runningVersion) return
    if (state.healthyVersion === runningVersion) {
      settled = true
      return
    }
    if (syncOks < minSyncOks || options.now() - startedAt < minUptimeMs) return

    await writeBootState(options.stateDir, {
      ...state,
      consecutiveFailures: 0,
      healthyVersion: runningVersion,
      healthyAt: options.now(),
    })
    wroteMarker = true
    settled = true
  }
}

export async function readBootState(stateDir: string): Promise<BootState | null> {
  try {
    const value = JSON.parse(await readFile(join(stateDir, BOOT_STATE_FILE), 'utf8')) as BootState
    if (
      typeof value.attemptedVersion !== 'string' ||
      value.attemptedVersion.length === 0 ||
      !Number.isInteger(value.consecutiveFailures) ||
      value.consecutiveFailures < 0
    ) {
      return null
    }
    return value
  } catch {
    return null
  }
}

export async function writeBootState(stateDir: string, state: BootState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, BOOT_STATE_FILE)
  const partial = `${path}.partial-${process.pid}`
  await writeFile(partial, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(partial, path)
}
