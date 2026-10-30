import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { formatSyncConflictName, isPathInside, normalizeDrivePath } from '@repo/contract'

import { readMounts } from './mount-store'
import { assertSafeDirectory } from './mounts'
import type { FetchLike } from './syncthing-client'

// Receive-only local changes all carry localFlags, including the viewer files
// this product promises to preserve. The global record is the discriminator:
// creator-tracked paths have global.localFlags === 0, while viewer additions
// and Syncthing conflict copies have receive-only flags there too. Never use
// folder-wide /rest/db/revert here; it deletes both preserved categories.

const REPAIR_SETTLE_TIMEOUT_MS = 30_000
const REPAIR_SETTLE_POLL_MS = 100

export interface ReadModeIndexEvent {
  id: number
  type: string
  data?: Record<string, unknown>
}

export interface ReadModeEnforcementOptions {
  stateDir: string
  driveDir: string
  connection(): Promise<{ base: string; headers: Record<string, string> }>
  fetch: FetchLike
  longPollS?: number
  backoffMs?: number
  sleep?(ms: number): Promise<void>
  log?(fields: Record<string, unknown>): void
}

export interface ReadModeEnforcer {
  start(): void
  stop(): void
}

interface SyncthingFileState {
  deleted?: boolean
  localFlags?: number
  modifiedBy?: string
  type?: string
}

interface SyncthingFileInfo {
  global?: SyncthingFileState
  local?: SyncthingFileState
}

export function createReadModeEnforcer(options: ReadModeEnforcementOptions): ReadModeEnforcer {
  const longPollS = options.longPollS ?? 60
  const backoffMs = options.backoffMs ?? 5_000
  const sleep = options.sleep ?? (ms => Bun.sleep(ms))
  let started = false
  let stopped = false
  let lastId: number | null = null
  let swept = false

  return {
    start() {
      if (started) return
      started = true
      void loop()
    },
    stop() {
      stopped = true
    },
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const { base, headers } = await options.connection()
        if (lastId === null) {
          const response = await options.fetch(
            `${base}/rest/events?events=LocalIndexUpdated&limit=1&timeout=1`,
            { headers },
          )
          if (!response.ok)
            throw new Error(`Syncthing event poll failed with HTTP ${response.status}`)
          const head = (await response.json()) as unknown
          if (!Array.isArray(head)) throw new Error('Syncthing event poll returned invalid JSON')
          const latest = head.at(-1)
          lastId = isIndexEvent(latest) ? latest.id : 0
        }
        if (!swept) {
          await sweepOutstandingChanges(options, base, headers)
          swept = true
        }
        const response = await options.fetch(
          `${base}/rest/events?events=LocalIndexUpdated&since=${lastId}&timeout=${longPollS}`,
          { headers },
        )
        if (!response.ok)
          throw new Error(`Syncthing event poll failed with HTTP ${response.status}`)
        const events = (await response.json()) as unknown
        if (!Array.isArray(events)) throw new Error('Syncthing event poll returned invalid JSON')
        for (const raw of events) {
          if (!isIndexEvent(raw) || raw.id <= lastId) continue
          await enforceReadModeIndexUpdate(options, raw)
          lastId = raw.id
        }
        // Real Syncthing long-polls block here. Yield defensively for fake or
        // unexpectedly eager servers so stop signals and timers still run.
        await Bun.sleep(0)
      } catch (error) {
        if (stopped) return
        // Syncthing subscription IDs reset on restart. Relearn the head and
        // re-sweep durable receive-only changes before consuming new events.
        lastId = null
        swept = false
        options.log?.({
          operation: 'read_mode_enforcement_failed',
          error: error instanceof Error ? error.message : String(error),
        })
        await sleep(backoffMs)
      }
    }
  }
}

async function sweepOutstandingChanges(
  options: ReadModeEnforcementOptions,
  base: string,
  headers: Record<string, string>,
): Promise<void> {
  const mounts = await readMounts(options.stateDir)
  let firstFailure: unknown
  for (const mount of mounts) {
    if (mount.mode !== 'read' || mount.role !== 'recipient') continue
    try {
      await sweepMountChanges(options, base, headers, mount.id)
    } catch (error) {
      // One broken mount must not block read-mode repair of the others; the
      // sweep rethrows after the pass so the caller still retries.
      firstFailure ??= error
    }
  }
  if (firstFailure !== undefined) throw firstFailure
}

async function sweepMountChanges(
  options: ReadModeEnforcementOptions,
  base: string,
  headers: Record<string, string>,
  mountId: string,
): Promise<void> {
  {
    const filenames: string[] = []
    for (let page = 1; ; page += 1) {
      const params = new URLSearchParams({
        folder: mountId,
        page: String(page),
        perpage: '100',
      })
      const response = await options.fetch(`${base}/rest/db/localchanged?${params}`, { headers })
      if (!response.ok) {
        throw new Error(`Syncthing local-change list failed with HTTP ${response.status}`)
      }
      const body = (await response.json()) as { files?: unknown }
      if (!Array.isArray(body.files)) throw new Error('Syncthing local-change list was invalid')
      filenames.push(
        ...body.files.flatMap(file => {
          if (typeof file !== 'object' || file === null) return []
          const name = (file as Record<string, unknown>).name
          return typeof name === 'string' ? [name] : []
        }),
      )
      if (body.files.length < 100) break
    }
    await enforceReadModeIndexUpdate(options, {
      id: 0,
      type: 'LocalIndexUpdated',
      data: { folder: mountId, filenames },
    })
  }
}

export async function enforceReadModeIndexUpdate(
  options: ReadModeEnforcementOptions,
  event: ReadModeIndexEvent,
): Promise<void> {
  if (event.type !== 'LocalIndexUpdated') return
  const folderId = event.data?.folder
  const filenames = event.data?.filenames
  if (
    typeof folderId !== 'string' ||
    !Array.isArray(filenames) ||
    !filenames.every(filename => typeof filename === 'string')
  ) {
    return
  }
  const mount = (await readMounts(options.stateDir)).find(
    candidate =>
      candidate.id === folderId && candidate.mode === 'read' && candidate.role === 'recipient',
  )
  if (mount === undefined) return

  const { base, headers } = await options.connection()
  for (const filename of filenames) {
    const normalized = normalizeDrivePath(filename)
    if (!normalized.ok) continue
    const params = new URLSearchParams({ folder: folderId, file: normalized.relativePath })
    const response = await options.fetch(`${base}/rest/db/file?${params}`, { headers })
    if (response.status === 404) continue
    if (!response.ok) throw new Error(`Syncthing file lookup failed with HTTP ${response.status}`)
    const info = (await response.json()) as SyncthingFileInfo
    if (info.global?.localFlags !== 0) continue
    if (info.local?.localFlags === undefined || info.local.localFlags === 0) continue
    if (info.global.deleted === true && info.local.deleted === true) continue
    if (
      info.global.type === 'FILE_INFO_TYPE_DIRECTORY' &&
      info.local.type === 'FILE_INFO_TYPE_DIRECTORY' &&
      info.local.deleted !== true
    ) {
      // Preserve viewer additions inside a creator directory. Their own file
      // records are evaluated individually; the directory itself needs no repair.
      continue
    }

    const configuredMountRoot = join(options.driveDir, mount.path)
    if (!(await assertSafeDirectory(options.driveDir, configuredMountRoot))) continue
    const driveRoot = await realpath(options.driveDir)
    const mountRoot = await realpath(configuredMountRoot)
    // Re-check after resolution: the writable mount can be swapped between
    // the lstat-based assertion and realpath by a recipient process.
    if (!isPathInside(driveRoot, mountRoot)) continue
    const target = join(mountRoot, normalized.relativePath)
    const parent = await realpath(dirname(target)).catch(() => null)
    if (parent === null || !isPathInside(mountRoot, parent)) continue

    if (info.local.deleted === true) {
      // Once Syncthing has indexed a local deletion, scanning the still-missing
      // path is a no-op. Materialize then scan a placeholder, remove only that
      // placeholder, and scan again so the creator's global version is pulled.
      if (!(await createPlaceholderNoFollow(target))) continue
      await scanPath(options, base, headers, folderId, normalized.relativePath)
      await rm(target, { recursive: true, force: true })
    } else {
      // A targeted rescan restores the creator's version, but Syncthing does
      // not manufacture a conflict copy when the gateway removes the viewer
      // edit first. Preserve those bytes under Syncthing's conflict naming
      // convention before making the creator path absent.
      await preserveConflictCopy(target, info.global.modifiedBy)
    }
    await scanPath(options, base, headers, folderId, normalized.relativePath)
    // The scan itself emits more LocalIndexUpdated events. Do not consume those
    // until Syncthing has pulled the creator version, or each queued event starts
    // another repair and turns the tracked path into a placeholder/delete loop.
    await waitForCreatorVersion(options, base, headers, folderId, normalized.relativePath, target)
  }
}

async function waitForCreatorVersion(
  options: ReadModeEnforcementOptions,
  base: string,
  headers: Record<string, string>,
  folderId: string,
  path: string,
  target: string,
): Promise<void> {
  const deadline = Date.now() + REPAIR_SETTLE_TIMEOUT_MS
  let lastState = 'unobserved'
  for (;;) {
    const params = new URLSearchParams({ folder: folderId, file: path })
    const response = await options.fetch(`${base}/rest/db/file?${params}`, { headers })
    if (response.ok) {
      const info = (await response.json()) as SyncthingFileInfo
      const global = info.global
      const local = info.local
      lastState = JSON.stringify({
        globalDeleted: global?.deleted,
        globalFlags: global?.localFlags,
        globalType: global?.type,
        localDeleted: local?.deleted,
        localFlags: local?.localFlags,
        localType: local?.type,
      })
      if (
        global?.localFlags === 0 &&
        local?.localFlags === 0 &&
        local.deleted === global.deleted &&
        local.type === global.type &&
        (await targetMatchesCreatorState(target, global))
      ) {
        return
      }
    } else if (response.status !== 404) {
      throw new Error(`Syncthing repair lookup failed with HTTP ${response.status}`)
    } else {
      lastState = 'not-found'
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(`Syncthing creator-version repair timed out; last=${lastState}`)
    }
    await Bun.sleep(Math.min(REPAIR_SETTLE_POLL_MS, remainingMs))
  }
}

async function targetMatchesCreatorState(
  target: string,
  global: SyncthingFileState,
): Promise<boolean> {
  const targetState = await lstat(target).catch(error => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return null
    }
    throw error
  })
  if (global.deleted === true) return targetState === null
  if (targetState === null) return false
  if (global.type === 'FILE_INFO_TYPE_DIRECTORY') return targetState.isDirectory()
  if (global.type === 'FILE_INFO_TYPE_SYMLINK') return targetState.isSymbolicLink()
  return targetState.isFile()
}

async function preserveConflictCopy(path: string, modifiedBy?: string): Promise<void> {
  const at = new Date()
  for (let suffix = 0; ; suffix += 1) {
    const candidate = formatSyncConflictName(path, at, modifiedBy ?? 'CREATOR', suffix)
    if (await pathExists(candidate)) continue
    await rename(path, candidate)
    return
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

async function createPlaceholderNoFollow(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EEXIST'
    ) {
      return false
    }
    throw error
  }
  await handle.close()
  return true
}

async function scanPath(
  options: ReadModeEnforcementOptions,
  base: string,
  headers: Record<string, string>,
  folderId: string,
  path: string,
): Promise<void> {
  const params = new URLSearchParams({ folder: folderId, sub: path })
  const response = await options.fetch(`${base}/rest/db/scan?${params}`, {
    method: 'POST',
    headers,
  })
  if (!response.ok) throw new Error(`Syncthing targeted scan failed with HTTP ${response.status}`)
}

function isIndexEvent(value: unknown): value is ReadModeIndexEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'number' &&
    typeof (value as Record<string, unknown>).type === 'string'
  )
}
