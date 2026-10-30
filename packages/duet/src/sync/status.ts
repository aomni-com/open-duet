import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { completion, connections, folderStatus, type SyncthingApi } from './syncthing-api.js'

/** Syncthing's conflict-copy naming convention (`name.sync-conflict-<ts>-<id>.ext`). */
export function isConflictPath(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return base.includes('.sync-conflict-')
}

export interface ConvergenceState {
  connected: boolean
  localState: string
  localNeedBytes: number
  localNeedItems: number
  globalItems: number
  remoteCompletion: number
  remoteNeedBytes: number
  converged: boolean
}

/**
 * Read a point-in-time convergence snapshot: the VM peer is connected, the
 * local folder is idle with nothing needed, and the VM reports us 100% complete.
 * Convergence needs BOTH directions quiet — a local-only check would call "done"
 * mid-upload.
 *
 * The `globalItems > 0` gate closes a real startup race: immediately after the
 * connection opens but BEFORE the remote index arrives, the folder is idle,
 * nothing is "needed", and completion reads 100% — a false convergence. A
 * mirror always mirrors a non-empty drive, so requiring the index (globalItems)
 * to have landed is the honest signal that a first clone actually happened.
 */
export async function readConvergence(
  st: SyncthingApi,
  input: { folderId: string; vmDeviceId: string },
): Promise<ConvergenceState> {
  const [status, remote, conns] = await Promise.all([
    folderStatus(st, input.folderId),
    completion(st, input.folderId, input.vmDeviceId),
    connections(st),
  ])
  const connected = conns.connections?.[input.vmDeviceId]?.connected === true
  const localState = status.state ?? 'unknown'
  const localNeedBytes = status.needBytes ?? 0
  const localNeedItems = status.needItems ?? 0
  const globalItems = status.globalTotalItems ?? status.globalFiles ?? 0
  const remoteCompletion = remote.completion ?? 0
  const remoteNeedBytes = remote.needBytes ?? 0
  const converged =
    connected &&
    globalItems > 0 &&
    localState === 'idle' &&
    localNeedBytes === 0 &&
    localNeedItems === 0 &&
    remoteNeedBytes === 0 &&
    remoteCompletion >= 100
  return {
    connected,
    localState,
    localNeedBytes,
    localNeedItems,
    globalItems,
    remoteCompletion,
    remoteNeedBytes,
    converged,
  }
}

export interface WaitForConvergenceOptions {
  folderId: string
  vmDeviceId: string
  timeoutMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onSnapshot?: (state: ConvergenceState) => void
}

export async function waitForConvergence(
  st: SyncthingApi,
  options: WaitForConvergenceOptions,
): Promise<ConvergenceState> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const pollMs = options.pollMs ?? 1_000
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms).unref?.()))
  const deadline = now() + timeoutMs
  let last: ConvergenceState | null = null
  while (now() < deadline) {
    last = await readConvergence(st, options)
    options.onSnapshot?.(last)
    if (last.converged) return last
    await sleep(pollMs)
  }
  if (last === null) last = await readConvergence(st, options)
  return last
}

/**
 * List `.sync-conflict-*` files under the mirror dir (Syncthing's convention;
 * we surface, never resolve — Q6). Skips Syncthing's own internals.
 */
export async function listConflicts(dir: string): Promise<string[]> {
  const found: string[] = []
  await walk(dir, dir, found)
  found.sort()
  return found
}

const SKIP_DIRS = new Set(['.stfolder', '.stversions', '.git', 'node_modules'])

async function walk(root: string, current: string, found: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = (await readdir(current, { withFileTypes: true })) as Dirent[]
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(current, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(root, full, found)
    } else if (isConflictPath(entry.name)) {
      found.push(relative(root, full))
    }
  }
}
