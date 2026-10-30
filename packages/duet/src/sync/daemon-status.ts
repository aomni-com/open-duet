import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// The per-workspace status the daemon publishes and `duet sync status` reads
// (spec file-attribution slice 22). The daemon owns the live Syncthing APIs (one
// per workspace, all loopback — L14); a separate `sync status` invocation cannot
// reach them, so the daemon writes a snapshot file and the command formats it.
// This is a status CACHE, never a durable cursor (L15): the authoritative state
// is always Syncthing's, sampled here for display.

export type WorkspaceSyncState =
  | 'starting' // handed to the mirror; first convergence not yet observed
  | 'up-to-date' // connected, folder idle, remote reports us complete
  | 'syncing' // a transfer is in flight
  | 'retired' // idle-retired on the server; surfaced, not mirrored (Q3)
  | 'error' // start/poll failed; retried on backoff

export interface WorkspaceSyncStatus {
  slug: string
  state: WorkspaceSyncState
  /** Local mirror directory, or null for a workspace not currently mirrored. */
  localDir: string | null
  connected: boolean
  needBytes: number
  remoteCompletion: number
  conflicts: number
  /** A repo with no git remote (history has no path to the Mac — G1 nag). */
  missingRemote?: boolean
  /** Short human note: an error, a nag, or slice-17 "agent editing …" sugar. */
  note?: string
}

export interface SyncStatusSnapshot {
  version: 1
  updatedAt: number
  daemonPid: number
  workspaces: WorkspaceSyncStatus[]
}

export function syncRoot(home: string): string {
  return join(home, '.duet', 'sync')
}

/** Files and engine state share the identity of a workspace, independent of its name or login. */
export function workspaceSyncKey(apiOrigin: string, workspaceId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([new URL(apiOrigin).href, workspaceId]))
    .digest('hex')
}

export function defaultMirrorDir(home: string, syncKey: string): string {
  return join(home, 'duet', syncKey)
}

export function statusFilePath(home: string): string {
  return join(syncRoot(home), 'status.json')
}

/** Read the daemon's last-published snapshot, or null when none exists. */
export async function readStatusSnapshot(home: string): Promise<SyncStatusSnapshot | null> {
  let text: string
  try {
    text = await readFile(statusFilePath(home), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as SyncStatusSnapshot
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) return null
    return parsed
  } catch {
    return null
  }
}

/** Atomically publish a snapshot (temp + rename so a concurrent read never tears). */
export async function writeStatusSnapshot(
  home: string,
  snapshot: SyncStatusSnapshot,
): Promise<void> {
  const path = statusFilePath(home)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

const STATE_LABELS: Record<WorkspaceSyncState, string> = {
  starting: 'starting',
  'up-to-date': 'up to date',
  syncing: 'syncing',
  retired: 'retired',
  error: 'error',
}

/**
 * Render the snapshot as aligned one-line-per-workspace human output. Pure so it
 * is unit-tested; the command layer only decides json-vs-human and staleness.
 */
export function formatStatusHuman(snapshot: SyncStatusSnapshot): string {
  if (snapshot.workspaces.length === 0) {
    return 'No workspaces are being mirrored yet.\n'
  }
  const rows = [...snapshot.workspaces].sort((a, b) => a.slug.localeCompare(b.slug))
  const slugWidth = Math.max(...rows.map(row => row.slug.length))
  const labelWidth = Math.max(...rows.map(row => STATE_LABELS[row.state].length))
  const lines = rows.map(row => {
    const slug = row.slug.padEnd(slugWidth)
    const label = formatStateLabel(row).padEnd(labelWidth + 5)
    const where = row.state === 'retired' ? '— not mirrored' : (row.localDir ?? '')
    const tail = row.note !== undefined && row.note.length > 0 ? `   (${row.note})` : ''
    return `${slug}  ${label}  ${where}${tail}`.trimEnd()
  })
  return `${lines.join('\n')}\n`
}

function formatStateLabel(row: WorkspaceSyncStatus): string {
  if (row.state === 'syncing') {
    return `syncing ${Math.min(99, Math.max(0, Math.round(row.remoteCompletion)))}%`
  }
  if (row.state === 'error') return 'error'
  if (row.conflicts > 0 && row.state === 'up-to-date') {
    return row.conflicts === 1 ? '1 conflict' : `${row.conflicts} conflicts`
  }
  return STATE_LABELS[row.state]
}
import { createHash } from 'node:crypto'
