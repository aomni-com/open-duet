import { mkdir, readFile, readlink, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { readBootState, writeBootState, type BootState } from './boot-health'
import {
  DEFAULT_CURRENT_RELEASE_LINK,
  DEFAULT_PREVIOUS_RELEASE_LINK,
  DEFAULT_RELEASES_DIR,
  ensureBootableCurrent,
  inspectRelease,
  type FetchLike,
} from './runtime-release'

const DEFAULT_STATE_DIR = '/home/exedev/.duet'
const ADOPTION_STATE_FILE = 'runtime-release-adoption.json'
const MAX_PRE_PROBATION_FAILURES = 3

type BootstrapEnv = Record<string, string | undefined>

export interface RuntimeBootstrapDependencies {
  fetch?: FetchLike
  bootId?: () => Promise<string>
  log?: (fields: Record<string, unknown>) => void
}

interface AdoptionState {
  bootId: string
  version: string
}

export async function runRuntimeBootstrap(
  env: BootstrapEnv = process.env,
  dependencies: RuntimeBootstrapDependencies = {},
): Promise<number> {
  const stateDir = env.DUET_STATE_DIR ?? DEFAULT_STATE_DIR
  const releasesDir = env.DUET_RELEASES_DIR ?? DEFAULT_RELEASES_DIR
  const currentReleaseLink = env.DUET_CURRENT_RELEASE_LINK ?? DEFAULT_CURRENT_RELEASE_LINK
  const previousReleaseLink = env.DUET_PREVIOUS_RELEASE_LINK ?? DEFAULT_PREVIOUS_RELEASE_LINK
  const log = dependencies.log ?? (fields => console.info(JSON.stringify(fields)))

  try {
    const bootId = await (dependencies.bootId ?? readBootId)()
    const token = await readOptionalText(join(stateDir, 'vm-token'))
    let bootState = await readBootState(stateDir)
    const currentVersion = await inspectReleaseLink(currentReleaseLink)
    if (currentVersion !== null) {
      bootState = nextAttemptState(bootState, currentVersion)
      await writeBootState(stateDir, bootState)
    }
    const adoptionState = await readJson<AdoptionState>(join(stateDir, ADOPTION_STATE_FILE))
    const result = await ensureBootableCurrent({
      releasesDir,
      currentReleaseLink,
      previousReleaseLink,
      apiUrl: env.DUET_API_URL,
      token,
      fetch: dependencies.fetch ?? fetch,
      extraHeaders: parseExtraHeaders(env.DUET_GATEWAY_EXTRA_HEADERS_JSON),
      quarantinedVersion: bootState?.quarantinedVersion,
      adoptedVersionThisBoot: adoptionState?.bootId === bootId ? adoptionState.version : undefined,
      recordAdopted: async version => {
        await writeJsonAtomic(join(stateDir, ADOPTION_STATE_FILE), { bootId, version })
      },
    })
    if (result.status !== 'retryable_failure' && bootState?.attemptedVersion !== result.version) {
      bootState = changeAttempt(bootState, result.version)
      await writeBootState(stateDir, bootState)
    }
    log({ operation: 'runtime_release_bootstrap', ...result })
    return result.status === 'retryable_failure' ? 1 : 0
  } catch (error) {
    log({
      operation: 'runtime_release_bootstrap',
      status: 'retryable_failure',
      error: error instanceof Error ? error.message : String(error),
    })
    return 1
  }
}

function nextAttemptState(state: BootState | null, currentVersion: string): BootState {
  if (state === null) return { attemptedVersion: currentVersion, consecutiveFailures: 0 }
  if (state.attemptedVersion !== currentVersion) return changeAttempt(state, currentVersion)
  if (state.healthyVersion === currentVersion) return state

  const consecutiveFailures = state.consecutiveFailures + 1
  return {
    ...state,
    consecutiveFailures,
    ...(consecutiveFailures >= MAX_PRE_PROBATION_FAILURES
      ? { quarantinedVersion: currentVersion }
      : {}),
  }
}

function changeAttempt(state: BootState | null, version: string): BootState {
  if (state === null) return { attemptedVersion: version, consecutiveFailures: 0 }
  const { healthyAt, healthyVersion, ...persisted } = state
  return {
    ...persisted,
    attemptedVersion: version,
    // consecutiveFailures counts boots of the CURRENT attemptedVersion — the
    // 3-strike buffer before quarantine. Moving to a different version (adopt or
    // rollback) starts that version fresh; inheriting the old count would leave
    // a rolled-back release one slow boot away from being quarantined too,
    // defeating the rollback.
    consecutiveFailures: 0,
    previousVersion: state.attemptedVersion,
    ...(healthyVersion === version ? { healthyVersion, healthyAt } : {}),
  }
}

async function inspectReleaseLink(link: string): Promise<string | null> {
  try {
    const target = await readlink(link)
    const releaseDir = isAbsolute(target) ? target : resolve(dirname(link), target)
    const inspection = await inspectRelease(releaseDir)
    return inspection.ok ? inspection.version : null
  } catch {
    return null
  }
}

async function readBootId(): Promise<string> {
  return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, 'utf8')).trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

function parseExtraHeaders(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim().length === 0) return {}
  const parsed = JSON.parse(raw) as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const partial = `${path}.partial-${process.pid}`
  await writeFile(partial, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await rename(partial, path)
}

if (import.meta.main) process.exit(await runRuntimeBootstrap())
