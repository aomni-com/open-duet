import {
  MIRROR_FOLDER_ID,
  encodeActorContext,
  normalizeDrivePath,
  type DriveFileEvent,
} from '@repo/contract'

import { mirrorMachineForShortDeviceId, readMirrorDevices, readMounts } from '../sync/mount-store'
import type { FetchLike } from '../sync/syncthing-client'

// Sole owner of the Syncthing→Duet event translation (spec file-attribution
// slice 18). Long-polls the loopback `GET /rest/events/disk` subscription
// (pre-filtered to LocalChangeDetected + RemoteChangeDetected) and translates
// every REMOTE-originated change — a share peer's or mirror device's write
// landing on the drive — into a DriveFileEvent emitted through the slice-04
// pipeline: one recorder, one seq, no fanotify guesswork (semantic events win).
//
// Firewalls this module carries:
// - L14: the Syncthing API never leaves loopback — this consumer and the scan
//   nudge are its only VM-side clients; the public vocabulary is Duet's.
// - L15: the `since` cursor is process-local consumption state ONLY. It resets
//   on every gateway or Syncthing restart; an ID discontinuity is counted as a
//   gap (accepted loss, never fabricated events) — the durable public cursor
//   stays the Convex per-workspace seq.
// - L17: remote-originated CHANGES are real activity (a workspace edited
//   only from a Mac must not hit the 7-day GC); LocalChangeDetected (scan
//   noise for local writes — attributed elsewhere) and idle polls tick nothing.
//
// Translation choices (slice-file "record the choice"; builder-confirmed on a
// real VM against syncthing v1.27.2 — research/syncthing-events-probe.md):
// - action mapping: modified→write, deleted→delete. Verified: disk events
//   know only modified|deleted — NEW files also arrive as 'modified', and no
//   rename action exists (a remote rename lands as a deleted+modified pair,
//   honestly reported as delete+write). added→create is kept as a defensive
//   mapping in case a future pin grows the action vocabulary.
// - directories: structural adds/deletes carry folder kind; a directory-only
//   metadata modification has no precise content event and only ticks activity.
//   Symlinks are namespace files.
// - actor: modifiedBy (Syncthing's short device ID) resolves device-first —
//   a mirror-device binding (slice 20 seam) wins with `mirror:<machineId>`;
//   otherwise a share-mount folder yields `sync:<shareId>`; otherwise the
//   write lands as `system` and the unknown-device counter ticks (MAP Q1).
// - unknown folder: no drive prefix to map the path into → skipped + counted
//   (pre-slice-19 every configured folder is a mount-store share mount).

export const SYNCTHING_EVENTS_LONG_POLL_S = 60
export const SYNCTHING_EVENTS_BACKOFF_MS = 5_000

export interface SyncthingDiskEvent {
  id: number
  type: string
  time?: string
  data?: Record<string, unknown>
}

/**
 * Snapshot of the sync registry the translator resolves against. Folders come
 * from the mount-store (the one authoritative path→share registry, L11);
 * Mirror identities resolve from registered Syncthing peers. An unknown peer
 * remains a system write rather than guessing a user.
 */
export interface SyncthingRegistrySnapshot {
  folders: Map<string, { pathPrefix: string; shareId: string | null }>
  mirrorDeviceMachine(modifiedBy: string): string | null
}

export function mountStoreRegistry(stateDir: string): () => Promise<SyncthingRegistrySnapshot> {
  return async () => {
    const [mounts, mirrorDevices] = await Promise.all([
      readMounts(stateDir),
      readMirrorDevices(stateDir),
    ])
    return {
      // The Syncthing folder id for a share mount IS the mount id
      // (routes/sync.ts removes folders by mount id on unmount); the whole-drive
      // mirror folder (MIRROR_FOLDER_ID) is rooted at the drive, so its path
      // prefix is '' and its writes carry no shareId — a mirror device resolves
      // via mirrorDeviceMachine below, and an unregistered device on it falls
      // back to `system` (Q1).
      folders: new Map<string, { pathPrefix: string; shareId: string | null }>([
        ...mounts.map(
          mount => [mount.id, { pathPrefix: mount.path, shareId: mount.shareId }] as const,
        ),
        [MIRROR_FOLDER_ID, { pathPrefix: '', shareId: null }],
      ]),
      // Slice-19 seam filled: resolve the SHORT device ID (modifiedBy) to the
      // sync machine document id via the mount-store device registry.
      mirrorDeviceMachine: (modifiedBy: string) =>
        mirrorMachineForShortDeviceId(mirrorDevices, modifiedBy),
    }
  }
}

/**
 * The only kinds Syncthing disk events can honestly produce (no rename
 * action; 'create' only if a future pin adds an 'added' action).
 */
export type TranslatedFileEvent = Extract<DriveFileEvent, { kind: 'create' | 'write' | 'delete' }>

export type DiskEventTranslation =
  | { outcome: 'event'; event: TranslatedFileEvent; unknownDevice: boolean }
  // A remote change that emits no DriveFileEvent but still ticks activity.
  | { outcome: 'activity-only'; reason: 'directory' }
  | {
      outcome: 'skip'
      reason: 'not-remote-change' | 'malformed' | 'unknown-folder' | 'invalid-path'
    }

export function translateDiskEvent(
  raw: SyncthingDiskEvent,
  registry: SyncthingRegistrySnapshot,
  fallbackAt: number,
): DiskEventTranslation {
  if (raw.type !== 'RemoteChangeDetected') return { outcome: 'skip', reason: 'not-remote-change' }
  const data = raw.data
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof data.folder !== 'string' ||
    typeof data.path !== 'string' ||
    typeof data.action !== 'string'
  ) {
    return { outcome: 'skip', reason: 'malformed' }
  }
  const kind = ACTION_TO_KIND[data.action]
  if (kind === undefined) return { outcome: 'skip', reason: 'malformed' }
  const folder = registry.folders.get(data.folder)
  if (folder === undefined) return { outcome: 'skip', reason: 'unknown-folder' }
  if (data.type === 'dir' && kind === 'write') {
    return { outcome: 'activity-only', reason: 'directory' }
  }
  const normalized = normalizeDrivePath(
    folder.pathPrefix === '' ? data.path : `${folder.pathPrefix}/${data.path}`,
  )
  if (!normalized.ok) return { outcome: 'skip', reason: 'invalid-path' }
  const modifiedBy = typeof data.modifiedBy === 'string' ? data.modifiedBy : ''
  const machineId = modifiedBy === '' ? null : registry.mirrorDeviceMachine(modifiedBy)
  let actor: string
  let unknownDevice = false
  try {
    if (machineId !== null) {
      actor = encodeActorContext({ kind: 'mirror', deviceId: machineId })
    } else if (folder.shareId !== null) {
      actor = encodeActorContext({ kind: 'sync', shareId: folder.shareId })
    } else {
      actor = encodeActorContext({ kind: 'system' })
      unknownDevice = true
    }
  } catch {
    // A registry id that fails the actor grammar is a config bug, not an
    // event to invent an identity for.
    return { outcome: 'skip', reason: 'malformed' }
  }
  const parsedAt = raw.time === undefined ? Number.NaN : Date.parse(raw.time)
  const at = Number.isFinite(parsedAt) ? Math.floor(parsedAt) : fallbackAt
  return {
    outcome: 'event',
    unknownDevice,
    event:
      kind === 'write'
        ? { kind, path: normalized.relativePath, actor, at }
        : {
            kind,
            entryKind: data.type === 'dir' ? 'folder' : 'file',
            path: normalized.relativePath,
            actor,
            at,
          },
  }
}

const ACTION_TO_KIND: Record<string, 'create' | 'write' | 'delete' | undefined> = {
  added: 'create',
  modified: 'write',
  deleted: 'delete',
}

export interface SyncthingEventConsumerOptions {
  /** The loopback connection seam — syncthingConnection() from the one client. */
  connection(): Promise<{ base: string; headers: Record<string, string> }>
  fetch: FetchLike
  emit(event: DriveFileEvent): void
  resolveRegistry(): Promise<SyncthingRegistrySnapshot>
  now(): number
  longPollS?: number
  backoffMs?: number
  sleep?(ms: number): Promise<void>
  log?(fields: Record<string, unknown>): void
}

export interface SyncthingEventConsumerStats {
  translated: number
  /** Subscription-id discontinuities: buffered events we never saw (L15 loss). */
  gaps: number
  /** Cursor re-inits after a poll failure (Syncthing restart resets its ids). */
  resets: number
  pollErrors: number
  unknownDeviceWrites: number
  skipped: number
}

export interface SyncthingEventConsumer {
  start(): void
  stop(): void
  stats(): SyncthingEventConsumerStats
}

export function createSyncthingEventConsumer(
  options: SyncthingEventConsumerOptions,
): SyncthingEventConsumer {
  const longPollS = options.longPollS ?? SYNCTHING_EVENTS_LONG_POLL_S
  const backoffMs = options.backoffMs ?? SYNCTHING_EVENTS_BACKOFF_MS
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref?.()))
  const totals: SyncthingEventConsumerStats = {
    translated: 0,
    gaps: 0,
    resets: 0,
    pollErrors: 0,
    unknownDeviceWrites: 0,
    skipped: 0,
  }
  let started = false
  let stopped = false
  // Process-local consumption cursor (L15) — null means "learn the current
  // head before polling" so a (re)start never replays Syncthing's buffer.
  let lastId: number | null = null

  function start(): void {
    if (started) return
    started = true
    void loop()
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const { base, headers } = await options.connection()
        if (lastId === null) {
          const head = await poll(`${base}/rest/events/disk?limit=1&timeout=1`, headers)
          lastId = head.length === 0 ? 0 : head[head.length - 1]!.id
          continue
        }
        const events = await poll(
          `${base}/rest/events/disk?since=${lastId}&timeout=${longPollS}`,
          headers,
        )
        if (stopped) return
        if (events.length === 0) continue
        const registry = await options.resolveRegistry()
        for (const raw of events) {
          if (typeof raw.id === 'number') {
            if (raw.id !== lastId + 1) {
              totals.gaps += 1
              options.log?.({ operation: 'events_gap', expected: lastId + 1, got: raw.id })
            }
            lastId = raw.id
          }
          handle(raw, registry)
        }
      } catch (error) {
        if (stopped) return
        totals.pollErrors += 1
        if (lastId !== null) {
          // A Syncthing restart resets subscription ids; keeping the old
          // cursor would stall the poll forever. Re-learn the head — anything
          // that happened across the restart is accepted, counted loss.
          totals.resets += 1
          lastId = null
        }
        options.log?.({
          operation: 'events_poll_error',
          error: error instanceof Error ? error.message : String(error),
        })
        await sleep(backoffMs)
      }
    }
  }

  async function poll(url: string, headers: Record<string, string>): Promise<SyncthingDiskEvent[]> {
    const response = await options.fetch(url, { headers })
    if (!response.ok) throw new Error(`Syncthing events poll failed with HTTP ${response.status}`)
    const body = (await response.json()) as unknown
    return Array.isArray(body) ? (body as SyncthingDiskEvent[]) : []
  }

  function handle(raw: SyncthingDiskEvent, registry: SyncthingRegistrySnapshot): void {
    const translation = translateDiskEvent(raw, registry, options.now())
    switch (translation.outcome) {
      case 'event':
        totals.translated += 1
        if (translation.unknownDevice) {
          totals.unknownDeviceWrites += 1
          options.log?.({ operation: 'unknown_device_write', path: translation.event.path })
        }
        options.emit(translation.event)
        return
      case 'activity-only':
        return
      case 'skip':
        if (translation.reason !== 'not-remote-change') {
          totals.skipped += 1
          options.log?.({ operation: 'event_skipped', reason: translation.reason, id: raw.id })
        }
        return
    }
  }

  return {
    start,
    stop(): void {
      stopped = true
    },
    stats(): SyncthingEventConsumerStats {
      return { ...totals }
    },
  }
}
