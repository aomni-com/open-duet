/**
 * NDJSON frames between the privileged fanotify helper (`helper-main.ts`) and
 * the gateway supervisor (slice 10). Pure codec: no I/O, no process state.
 *
 * The helper writes one `HelperEvent` per stdout line and reads one
 * `HelperCommand` per stdin line. `unit` is the raw cgroup leaf name (e.g.
 * `session-abc123`) — NOT an actor string; turning units into actors is
 * gateway policy (slice 11). Parsers return null for anything malformed so a
 * wedged or hostile peer can never crash the other side; the caller counts
 * the nulls (the supervisor's malformed-frame counter, slice 10).
 */

/**
 * Wire-protocol version carried in the helper's `ready` frame. The supervisor
 * (slice 10) compares it against its own compiled-in value and fails loudly on
 * mismatch — a self-updated gateway always ships a protocol-matched helper, so
 * a mismatch means the two bundles drifted and the helper must NOT be trusted.
 * Bump on any breaking change to `HelperEvent`/`HelperCommand`.
 *
 * v2 (slice 11): added the `exclude-pids` command — the gateway tells the helper
 * which non-session pids to drop like gateway-pid (the Syncthing daemon, whose
 * writes slice 18 attributes semantically; the L9 "semantic events win" rule).
 * v3: structural filesystem facts carry file/folder kind so the activity
 * namespace never guesses identity semantics from a path.
 */
export const HELPER_PROTOCOL_VERSION = 3

export type HelperFsKind = 'read' | 'write' | 'create' | 'delete' | 'rename'

const FS_KINDS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'create',
  'delete',
  'rename',
] satisfies HelperFsKind[])

interface HelperFsEventBase {
  t: 'fs'
  /** Drive-relative path; the rename destination for `rename`. */
  path: string
  /** Drive-relative rename source, when known and inside the drive. */
  fromPath?: string
  pid: number
  /** cgroup leaf name of the acting process, or null when unresolvable. */
  unit: string | null
  at: number
}

export type HelperFsEvent = HelperFsEventBase &
  (
    | { kind: 'read' | 'write'; fromPath?: never; entryKind?: never }
    | { kind: 'create' | 'delete'; entryKind: 'file' | 'folder'; fromPath?: never }
    | { kind: 'rename'; entryKind: 'file' | 'folder'; fromPath?: string }
  )

export interface HelperStatsEvent {
  t: 'stats'
  /** Cumulative FAN_Q_OVERFLOW count — silent event loss made visible (MAP L12). */
  overflow: number
  /** Cumulative pid→cgroup resolution failures (short-lived process lost, /proc gone). */
  cgroupMisses: number
  at: number
}

export interface HelperReadyEvent {
  t: 'ready'
  pid: number
  /** Wire-protocol version (see HELPER_PROTOCOL_VERSION); supervisor gates on it. */
  protocol: number
}

export type HelperEvent = HelperReadyEvent | HelperFsEvent | HelperStatsEvent

export type HelperCommand =
  | { t: 'suppress'; on: boolean }
  /**
   * Replaces the helper's excluded-pid set (dropped exactly like gateway-pid,
   * before any handle open — L9). The gateway pushes the current Syncthing
   * daemon pid(s); an empty list clears the set. Whole-set replacement, not a
   * delta, so a stale pid can never linger after the daemon restarts.
   */
  | { t: 'exclude-pids'; pids: number[] }
  | { t: 'shutdown' }

export function encodeHelperEvent(event: HelperEvent): string {
  return `${JSON.stringify(event)}\n`
}

export function encodeHelperCommand(command: HelperCommand): string {
  return `${JSON.stringify(command)}\n`
}

/** Parses one helper stdout line. Malformed → null (caller counts). */
export function parseHelperLine(line: string): HelperEvent | null {
  const value = parseJsonObject(line)
  if (value === null) return null
  switch (value['t']) {
    case 'ready': {
      const pid = value['pid']
      const protocol = value['protocol']
      return isPid(pid) && isCount(protocol) ? { t: 'ready', pid, protocol } : null
    }
    case 'fs': {
      const { kind, entryKind, path, fromPath, pid, unit, at } = value as Record<string, unknown>
      if (typeof kind !== 'string' || !FS_KINDS.has(kind)) return null
      const structural = kind === 'create' || kind === 'delete' || kind === 'rename'
      if (structural !== (entryKind === 'file' || entryKind === 'folder')) return null
      if (kind !== 'rename' && fromPath !== undefined) return null
      if (typeof path !== 'string' || path === '') return null
      if (fromPath !== undefined && (typeof fromPath !== 'string' || fromPath === '')) return null
      if (!isPid(pid) || !isFiniteNumber(at)) return null
      if (unit !== null && typeof unit !== 'string') return null
      return {
        t: 'fs',
        kind: kind as HelperFsKind,
        ...(structural ? { entryKind: entryKind as 'file' | 'folder' } : {}),
        path,
        ...(fromPath === undefined ? {} : { fromPath }),
        pid,
        unit,
        at,
      } as HelperFsEvent
    }
    case 'stats': {
      const { overflow, cgroupMisses, at } = value as Record<string, unknown>
      if (!isCount(overflow) || !isCount(cgroupMisses) || !isFiniteNumber(at)) return null
      return { t: 'stats', overflow, cgroupMisses, at }
    }
    default:
      return null
  }
}

/** Parses one helper stdin line. Malformed → null (helper ignores it). */
export function parseHelperCommand(line: string): HelperCommand | null {
  const value = parseJsonObject(line)
  if (value === null) return null
  switch (value['t']) {
    case 'suppress': {
      const on = value['on']
      return typeof on === 'boolean' ? { t: 'suppress', on } : null
    }
    case 'exclude-pids': {
      const pids = value['pids']
      if (!Array.isArray(pids) || !pids.every(isPid)) return null
      return { t: 'exclude-pids', pids: pids as number[] }
    }
    case 'shutdown':
      return { t: 'shutdown' }
    default:
      return null
  }
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
