import { parseScope, WhoamiResponseSchema, type WorkspaceSummary } from '@repo/contract'

import { CliError, EXIT_CODES } from '../exit-codes.js'
import type { ApiClient } from '../http.js'
import {
  defaultMirrorDir,
  writeStatusSnapshot,
  workspaceSyncKey,
  type SyncStatusSnapshot,
  type WorkspaceSyncState,
  type WorkspaceSyncStatus,
} from './daemon-status.js'
import { isSyncMachineActive } from './machine.js'
import {
  isAdmissionRefusal,
  type MirrorSnapshot,
  type StartWorkspaceMirror,
  type WorkspaceMirrorHandle,
} from './mirror.js'

// One instance per live writable workspace. Workspace retirement and membership
// determine the running set; account machine removal stops all its mirrors.

export interface DaemonSession {
  api: Pick<ApiClient, 'request'>
  apiOrigin: string
  machineId: string
  startMirror: StartWorkspaceMirror
}

export interface DaemonOptions {
  /** Reuse a session until login, origin or machine changes; replacement stops its mirrors. */
  session: DaemonSession | (() => Promise<DaemonSession | null>)
  /** User home (`~`); files and engine state are scoped to the durable workspace. */
  home: string
  writeSnapshot?: (snapshot: SyncStatusSnapshot) => Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (fields: Record<string, unknown>) => void
  reconcileIntervalMs?: number
  pollIntervalMs?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
}

interface Managed {
  slug: string
  syncKey: string
  serverStatus: string
  state: WorkspaceSyncState
  handle: WorkspaceMirrorHandle | null
  localDir: string
  snapshot: MirrorSnapshot | null
  note: string | undefined
  missingRemote: boolean
  backoffMs: number
  nextAttemptAt: number
  starting: boolean
}

export interface Daemon {
  /** One reconcile pass: diff server workspaces against the running set. */
  reconcileOnce(): Promise<void>
  /** Sample every running mirror once for the status snapshot. */
  pollOnce(): Promise<void>
  /** Publish the current snapshot. */
  publish(): Promise<void>
  /** Point-in-time snapshot (also what `publish` writes). */
  snapshot(): SyncStatusSnapshot
  /** Run reconcile+poll loops until `signal` aborts, then stop every mirror. */
  run(signal: AbortSignal): Promise<void>
  /** Stop every running mirror (idempotent). */
  stopAll(): Promise<void>
}

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_BASE_BACKOFF_MS = 5_000
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000

export function createDaemon(options: DaemonOptions): Daemon {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms).unref?.()))
  const log = options.log ?? (() => {})
  const writeSnapshot =
    options.writeSnapshot ?? (snapshot => writeStatusSnapshot(options.home, snapshot))
  const reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS

  const managed = new Map<string, Managed>()
  let currentSession: DaemonSession | null = null

  function ensure(
    workspace: Pick<WorkspaceSummary, 'id' | 'slug' | 'status'>,
    apiOrigin: string,
  ): Managed {
    let entry = managed.get(workspace.id)
    if (entry === undefined) {
      const syncKey = workspaceSyncKey(apiOrigin, workspace.id)
      entry = {
        slug: workspace.slug,
        syncKey,
        serverStatus: workspace.status,
        state: 'starting',
        handle: null,
        localDir: defaultMirrorDir(options.home, syncKey),
        snapshot: null,
        note: undefined,
        missingRemote: false,
        backoffMs: baseBackoffMs,
        nextAttemptAt: 0,
        starting: false,
      }
      managed.set(workspace.id, entry)
    }
    entry.slug = workspace.slug
    entry.serverStatus = workspace.status
    return entry
  }

  async function stopMirror(entry: Managed): Promise<void> {
    const handle = entry.handle
    entry.handle = null
    if (handle === null) return
    try {
      await handle.stop()
    } catch (error) {
      log({ operation: 'mirror_stop_failed', slug: entry.slug, error: message(error) })
    }
  }

  async function attemptStart(entry: Managed, startMirror: StartWorkspaceMirror): Promise<void> {
    if (entry.starting || entry.handle !== null || now() < entry.nextAttemptAt) return
    entry.starting = true
    entry.state = 'starting'
    try {
      entry.handle = await startMirror({
        slug: entry.slug,
        syncKey: entry.syncKey,
        localDir: entry.localDir,
        log,
      })
      entry.backoffMs = baseBackoffMs
      entry.nextAttemptAt = 0
      entry.note = undefined
      log({ operation: 'mirror_started', slug: entry.slug })
    } catch (error) {
      entry.handle = null
      entry.state = 'error'
      entry.note = message(error)
      entry.nextAttemptAt = now() + entry.backoffMs
      entry.backoffMs = Math.min(entry.backoffMs * 2, maxBackoffMs)
      log({
        operation: 'mirror_start_failed',
        slug: entry.slug,
        error: entry.note,
        retryInMs: entry.nextAttemptAt - now(),
      })
    } finally {
      entry.starting = false
    }
  }

  async function reconcileOnce(): Promise<void> {
    const session =
      typeof options.session === 'function' ? await options.session() : options.session
    if (session !== currentSession) {
      await stopAll()
      managed.clear()
      currentSession = session
    }
    if (session === null) {
      log({ operation: 'machine_missing', message: 'Run duet sync install first.' })
      return
    }
    let active = false
    try {
      active = await isSyncMachineActive(session.api, session.machineId)
    } catch (error) {
      if (error instanceof CliError && error.exitCode === EXIT_CODES.auth) {
        await stopAll()
        for (const entry of managed.values()) {
          entry.state = 'error'
          entry.snapshot = null
          entry.note = message(error)
        }
      }
      throw error
    }
    if (!active) {
      await stopAll()
      for (const entry of managed.values()) {
        entry.state = 'error'
        entry.snapshot = null
        entry.note = 'Sync disabled for this Mac. Run duet sync install to enable it again.'
      }
      log({ operation: 'machine_disabled', machineId: session.machineId })
      return
    }
    const workspaces = await whoamiWorkspaces(session.api)
    const seen = new Set(workspaces.map(workspace => workspace.id))

    // Drop mirrors for workspaces the credential no longer reaches (membership
    // lost or workspace deleted): stop cleanly, forget them (the mirror-devices
    // detach already happened server-side).
    for (const [id, entry] of managed) {
      if (!seen.has(id)) {
        await stopMirror(entry)
        // Safe to delete the just-yielded key mid-iteration (single reconcile at
        // a time; the map is not mutated concurrently).
        managed.delete(id)
        log({ operation: 'mirror_dropped', slug: entry.slug })
      }
    }

    for (const workspace of workspaces) {
      if (workspace.status === 'retired') {
        // Surfaced, never mirrored, never un-retired (Q3). If it was running,
        // stop it; the slow retry is simply the next reconcile seeing the server
        // flip it back to `active`.
        const entry = ensure(workspace, session.apiOrigin)
        await stopMirror(entry)
        entry.state = 'retired'
        entry.snapshot = null
        entry.note = undefined
        entry.missingRemote = false
        // Clear any leftover start backoff so an un-retire (server → active)
        // resumes promptly rather than waiting out a stale error window.
        entry.backoffMs = baseBackoffMs
        entry.nextAttemptAt = 0
        continue
      }
      if (workspace.status !== 'active') {
        // provisioning / unhealthy / anything transient: don't mirror yet, don't
        // surface a scary row — it will appear once the server reports `active`.
        continue
      }
      const entry = ensure(workspace, session.apiOrigin)
      if (entry.handle !== null && entry.handle.slug !== workspace.slug) await stopMirror(entry)
      await attemptStart(entry, session.startMirror)
    }
  }

  async function pollOnce(): Promise<void> {
    await Promise.all(
      [...managed.values()].map(async entry => {
        if (entry.handle === null) return
        try {
          const snapshot = await entry.handle.poll()
          entry.snapshot = snapshot
          entry.state = snapshot.converged ? 'up-to-date' : 'syncing'
          entry.missingRemote = snapshot.reposMissingRemote.length > 0
          entry.note = noteFor(snapshot)
        } catch (error) {
          // The supervisor restarts Syncthing and the bridge re-mints on their
          // own; a transient poll error is surfaced, not torn down.
          if (isAdmissionRefusal(error)) {
            await stopMirror(entry)
            entry.snapshot = null
            entry.nextAttemptAt = now() + entry.backoffMs
          }
          entry.state = 'error'
          entry.note = message(error)
          log({ operation: 'mirror_poll_failed', slug: entry.slug, error: entry.note })
        }
      }),
    )
  }

  function snapshot(): SyncStatusSnapshot {
    const workspaces: WorkspaceSyncStatus[] = [...managed.values()].map(entry => ({
      slug: entry.slug,
      state: entry.state,
      localDir: entry.localDir,
      connected: entry.snapshot?.connected ?? false,
      needBytes: entry.snapshot?.needBytes ?? 0,
      remoteCompletion: entry.snapshot?.remoteCompletion ?? 0,
      conflicts: entry.snapshot?.conflicts ?? 0,
      ...(entry.missingRemote ? { missingRemote: true } : {}),
      ...(entry.note !== undefined && entry.note.length > 0 ? { note: entry.note } : {}),
    }))
    return { version: 1, updatedAt: now(), daemonPid: process.pid, workspaces }
  }

  async function publish(): Promise<void> {
    try {
      await writeSnapshot(snapshot())
    } catch (error) {
      log({ operation: 'snapshot_write_failed', error: message(error) })
    }
  }

  async function stopAll(): Promise<void> {
    for (const entry of managed.values()) await stopMirror(entry)
  }

  async function run(signal: AbortSignal): Promise<void> {
    const aborted = (): boolean => signal.aborted
    while (!aborted()) {
      try {
        await reconcileOnce()
      } catch (error) {
        // Not logged in yet, offline, API hiccup: back off, don't crash — launchd
        // must not see a thrashing process before login completes.
        log({ operation: 'reconcile_failed', error: message(error) })
      }
      const reconcileDeadline = now() + reconcileIntervalMs
      while (!aborted() && now() < reconcileDeadline) {
        await pollOnce()
        await publish()
        await sleep(pollIntervalMs)
      }
    }
    await stopAll()
    await publish()
  }

  return { reconcileOnce, pollOnce, publish, snapshot, run, stopAll }
}

function noteFor(snapshot: MirrorSnapshot): string | undefined {
  if (snapshot.reposMissingRemote.length > 0) {
    const first = snapshot.reposMissingRemote[0]
    const where = first === '.' ? 'this repo' : `repo ${first}`
    return `${where} has no git remote — add one so history reaches your Mac`
  }
  return undefined
}

async function whoamiWorkspaces(
  api: Pick<ApiClient, 'request'>,
): Promise<Array<Pick<WorkspaceSummary, 'id' | 'slug' | 'status'>>> {
  const response = await api.request('/whoami')
  const body = WhoamiResponseSchema.parse(await response.json())
  const writable = new Set(
    body.scopes.flatMap(scope => {
      const parsed = parseScope(scope)
      return parsed?.capability === 'files:write' ? [parsed.workspaceSlug] : []
    }),
  )
  return body.workspaces
    .filter(workspace => writable.has(workspace.slug))
    .map(workspace => ({ id: workspace.id, slug: workspace.slug, status: workspace.status }))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
