import { DUET_ANCHOR_MARKER_FILE } from '@repo/contract'

/**
 * Pure fanotify byte codec: Buffer in, typed events out.
 *
 * All kernel byte-format knowledge for the FID/name fanotify group lives here
 * so the privileged helper (slice 09) stays thin I/O. No FFI, no syscalls, no
 * process code — the caller reads the fanotify fd and resolves file handles
 * (`open_by_handle_at`); this module only decodes bytes and joins events.
 *
 * Struct layouts follow the Linux uapi header `include/uapi/linux/fanotify.h`
 * (kernel 6.12, the version the FID spike ran against — see
 * specs/done/file-attribution/research/fanotify-fid-spike.md) plus
 * `fs/notify/fanotify/fanotify_user.c` `copy_fid_info_to_user` for the
 * name/padding placement. Byte order is the VM's native little-endian (x64).
 */

/** Event and init mask bits from uapi fanotify.h. */
export const FAN = {
  ACCESS: 0x00000001n,
  MODIFY: 0x00000002n,
  ATTRIB: 0x00000004n,
  CLOSE_WRITE: 0x00000008n,
  CLOSE_NOWRITE: 0x00000010n,
  OPEN: 0x00000020n,
  MOVED_FROM: 0x00000040n,
  MOVED_TO: 0x00000080n,
  CREATE: 0x00000100n,
  DELETE: 0x00000200n,
  DELETE_SELF: 0x00000400n,
  MOVE_SELF: 0x00000800n,
  OPEN_EXEC: 0x00001000n,
  Q_OVERFLOW: 0x00004000n,
  EVENT_ON_CHILD: 0x08000000n,
  RENAME: 0x10000000n,
  ONDIR: 0x40000000n,
} as const

/** struct fanotify_event_metadata: u32 event_len; u8 vers; u8 reserved; u16 metadata_len; u64 mask; s32 fd; s32 pid. */
export const FANOTIFY_METADATA_VERSION = 3
const EVENT_METADATA_LEN = 24

/** struct fanotify_event_info_header: u8 info_type; u8 pad; u16 len — info_type at offset 0 (the spike's swapped read was a real bug). */
const INFO_HEADER_LEN = 4

/**
 * struct fanotify_event_info_fid: header(4) + __kernel_fsid_t(2×s32) +
 * struct file_handle header { u32 handle_bytes; s32 handle_type } + f_handle
 * bytes, then (for *_DFID_NAME types) the NUL-terminated name immediately
 * after the unpadded handle bytes, then zero padding to the 4-aligned len.
 */
const FID_RECORD_FIXED_LEN = 20
const FSID_OFFSET = 4
const HANDLE_BYTES_OFFSET = 12
const HANDLE_TYPE_OFFSET = 16

/** MAX_HANDLE_SZ from include/linux/exportfs.h — larger claims are hostile. */
const MAX_HANDLE_SZ = 128

/** Info-record types this codec understands (uapi FAN_EVENT_INFO_TYPE_*). */
export const FAN_EVENT_INFO_TYPE = {
  FID: 1,
  DFID_NAME: 2,
  DFID: 3,
  OLD_DFID_NAME: 10,
  NEW_DFID_NAME: 12,
} as const

export type FidRecordKind = 'fid' | 'dfid_name' | 'dfid' | 'old_dfid_name' | 'new_dfid_name'

const FID_RECORD_KINDS: Record<number, FidRecordKind> = {
  [FAN_EVENT_INFO_TYPE.FID]: 'fid',
  [FAN_EVENT_INFO_TYPE.DFID_NAME]: 'dfid_name',
  [FAN_EVENT_INFO_TYPE.DFID]: 'dfid',
  [FAN_EVENT_INFO_TYPE.OLD_DFID_NAME]: 'old_dfid_name',
  [FAN_EVENT_INFO_TYPE.NEW_DFID_NAME]: 'new_dfid_name',
}

const NAMED_RECORD_KINDS: ReadonlySet<FidRecordKind> = new Set([
  'dfid_name',
  'old_dfid_name',
  'new_dfid_name',
])

export interface FidRecord {
  kind: FidRecordKind
  infoType: number
  fsid: readonly [number, number]
  handleType: number
  /** Opaque f_handle bytes (copied out of the read buffer). */
  handle: Uint8Array
  /** Stable cache key: `${handleType}:${hex(handle)}`. */
  handleKey: string
  /** Untrusted dirent-name bytes (NUL-terminated on the wire); null for unnamed records. */
  name: Uint8Array | null
  /**
   * Absolute path of the handle's object, filled in by the caller after
   * `open_by_handle_at` resolution. Never set by the parser. For *_DFID_NAME
   * records this is the parent directory; the entry itself is
   * `objectPath + '/' + name`.
   */
  objectPath?: string
}

export interface RawFanEvent {
  mask: bigint
  pid: number
  records: FidRecord[]
  overflow: boolean
}

/**
 * Decode one read(2)'s worth of fanotify events. Never throws on hostile
 * bytes: a metadata header with the wrong version or inconsistent lengths
 * stops the walk (framing can no longer be trusted), a truncated trailing
 * event is dropped, and malformed info records are skipped record-by-record.
 */
export function parseFanotifyBuffer(buf: Buffer, len: number): RawFanEvent[] {
  const events: RawFanEvent[] = []
  const end = Math.min(Math.max(len, 0), buf.length)
  let pos = 0
  while (pos + EVENT_METADATA_LEN <= end) {
    const eventLen = buf.readUInt32LE(pos)
    const version = buf.readUInt8(pos + 4)
    const metadataLen = buf.readUInt16LE(pos + 6)
    if (version !== FANOTIFY_METADATA_VERSION) break
    if (eventLen < EVENT_METADATA_LEN || metadataLen < EVENT_METADATA_LEN) break
    if (metadataLen > eventLen || pos + eventLen > end) break
    const mask = buf.readBigUInt64LE(pos + 8)
    const pid = buf.readInt32LE(pos + 20)
    events.push({
      mask,
      pid,
      records: parseInfoRecords(buf, pos + metadataLen, pos + eventLen),
      overflow: (mask & FAN.Q_OVERFLOW) !== 0n,
    })
    pos += eventLen
  }
  return events
}

function parseInfoRecords(buf: Buffer, start: number, end: number): FidRecord[] {
  const records: FidRecord[] = []
  let off = start
  while (off + INFO_HEADER_LEN <= end) {
    const infoType = buf.readUInt8(off)
    const recordLen = buf.readUInt16LE(off + 2)
    if (recordLen < INFO_HEADER_LEN || off + recordLen > end) break
    const record = parseFidRecord(buf, off, recordLen, infoType)
    if (record !== null) records.push(record)
    off += recordLen
  }
  return records
}

function parseFidRecord(
  buf: Buffer,
  off: number,
  recordLen: number,
  infoType: number,
): FidRecord | null {
  const kind = FID_RECORD_KINDS[infoType]
  if (kind === undefined || recordLen < FID_RECORD_FIXED_LEN) return null
  const handleBytes = buf.readUInt32LE(off + HANDLE_BYTES_OFFSET)
  if (handleBytes > MAX_HANDLE_SZ || FID_RECORD_FIXED_LEN + handleBytes > recordLen) return null
  const handleStart = off + FID_RECORD_FIXED_LEN
  const handle = Uint8Array.from(buf.subarray(handleStart, handleStart + handleBytes))
  const handleType = buf.readInt32LE(off + HANDLE_TYPE_OFFSET)
  return {
    kind,
    infoType,
    fsid: [buf.readInt32LE(off + FSID_OFFSET), buf.readInt32LE(off + FSID_OFFSET + 4)],
    handleType,
    handle,
    handleKey: `${handleType}:${Buffer.from(handle).toString('hex')}`,
    name: NAMED_RECORD_KINDS.has(kind)
      ? parseRecordName(buf, handleStart + handleBytes, off + recordLen)
      : null,
  }
}

function parseRecordName(buf: Buffer, start: number, end: number): Uint8Array | null {
  if (start >= end) return null
  const nul = buf.indexOf(0, start)
  const nameEnd = nul === -1 || nul > end ? end : nul
  if (nameEnd <= start) return null
  return Uint8Array.from(buf.subarray(start, nameEnd))
}

export type JoinedFsEventKind = 'create' | 'write' | 'read' | 'delete' | 'rename' | 'overflow'

interface JoinedFsEventBase {
  /** Absolute path; the rename destination for `rename`; '' for `overflow`. */
  path: string
  /** Rename source, when known. */
  fromPath?: string
  pid: number
  at: number
}

export type JoinedFsEvent = JoinedFsEventBase &
  (
    | { kind: 'read' | 'write' | 'overflow'; entryKind?: never }
    | { kind: 'create' | 'delete' | 'rename'; entryKind: 'file' | 'folder' }
  )

export interface RenameJoinerOptions {
  /** Bound for each internal cache (writers, pending legacy moves, dedupe tokens). */
  capacity: number
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number
}

export interface RenameJoiner {
  push(event: RawFanEvent): JoinedFsEvent[]
}

interface WriterEntry {
  pid: number
  at: number
  path: string | null
}

const WRITE_BITS = FAN.MODIFY | FAN.CLOSE_WRITE
const READ_BITS = FAN.ACCESS | FAN.OPEN | FAN.CLOSE_NOWRITE

/**
 * Content-only read classification: an event counts as a read when it carries
 * a read bit, no write bit (an open-for-write is not a content read), and is
 * not a directory event (`FAN_ONDIR` excluded — list/stat never count).
 */
export function isContentRead(mask: bigint): boolean {
  return (mask & READ_BITS) !== 0n && (mask & WRITE_BITS) === 0n && (mask & FAN.ONDIR) === 0n
}

/**
 * Joins the raw event stream into semantic filesystem events.
 *
 * The core move (proven in the FID spike): keep a bounded handle→writer cache
 * so a temp file's CLOSE_WRITE joins to the FAN_RENAME source/target and an
 * atomic save (`mv .tmp x`, python `os.replace`) is reported as a write to
 * the REAL filename with the writer's pid. FAN_RENAME is deduped against the
 * legacy MOVED_FROM/MOVED_TO bits the same syscall also emits, and a rename
 * onto an existing destination evicts the replaced file's writer entry.
 *
 * Events must have had their records' `objectPath` filled in by the caller;
 * events whose paths cannot be resolved are dropped (except overflow, which
 * is always surfaced).
 */
export function createRenameJoiner(options: RenameJoinerOptions): RenameJoiner {
  const capacity = Math.max(1, options.capacity)
  const now = options.now ?? Date.now
  /** child handleKey → last writer of that inode. */
  const writers = new Map<string, WriterEntry>()
  /** child handleKey → unmatched MOVED_FROM awaiting its MOVED_TO. */
  const pendingMoves = new Map<string, { fromPath: string | null }>()
  /** dedupe tokens for the FAN_RENAME vs legacy MOVED_FROM/TO double report. */
  const dedupe = new Map<string, number>()

  function boundedSet<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key)
    map.set(key, value)
    while (map.size > capacity) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  function consumeDedupe(key: string): boolean {
    const remaining = dedupe.get(key)
    if (remaining === undefined) return false
    if (remaining <= 1) dedupe.delete(key)
    else dedupe.set(key, remaining - 1)
    return true
  }

  function emitRename(
    out: JoinedFsEvent[],
    fromPath: string | null,
    toPath: string,
    pid: number,
    childKey: string | null,
    at: number,
    entryKind: 'file' | 'folder',
  ): void {
    // Destination replacement: the inode previously at toPath is now
    // unlinked — its writer entry must not attribute anything again.
    for (const [key, writer] of writers) {
      if (writer.path === toPath && key !== childKey) writers.delete(key)
    }
    const writer = childKey === null ? undefined : writers.get(childKey)
    if (writer !== undefined) {
      // Retained CLOSE_WRITE evidence means the renamed entry is a temporary
      // replacement. The destination identity survives, so only its write
      // crosses the joined-event seam; an ordinary move has no writer entry
      // and remains a rename whose source identity survives.
      out.push({ kind: 'write', path: toPath, pid: writer.pid, at })
      boundedSet(writers, childKey!, { ...writer, path: toPath })
      return
    }
    out.push({
      kind: 'rename',
      entryKind,
      path: toPath,
      ...(fromPath === null ? {} : { fromPath }),
      pid,
      at,
    })
  }

  return {
    push(event: RawFanEvent): JoinedFsEvent[] {
      const out: JoinedFsEvent[] = []
      const at = now()
      if (event.overflow) out.push({ kind: 'overflow', path: '', pid: event.pid, at })

      const child = event.records.find(record => record.kind === 'fid') ?? null
      const childKey = child === null ? null : child.handleKey
      const selfPath = entryPath(event.records, 'dfid_name') ?? child?.objectPath ?? null
      const { mask, pid } = event
      const entryKind = (mask & FAN.ONDIR) !== 0n ? 'folder' : 'file'

      if ((mask & FAN.CREATE) !== 0n && selfPath !== null) {
        out.push({ kind: 'create', entryKind, path: selfPath, pid, at })
      }
      if ((mask & WRITE_BITS) !== 0n && selfPath !== null) {
        out.push({ kind: 'write', path: selfPath, pid, at })
        if (childKey !== null) boundedSet(writers, childKey, { pid, at, path: selfPath })
      }
      if (isContentRead(mask) && selfPath !== null) {
        out.push({ kind: 'read', path: selfPath, pid, at })
      }
      if ((mask & FAN.DELETE) !== 0n && selfPath !== null) {
        out.push({ kind: 'delete', entryKind, path: selfPath, pid, at })
        if (childKey !== null) writers.delete(childKey)
        for (const [key, writer] of writers) {
          if (writer.path === selfPath) writers.delete(key)
        }
      }

      if ((mask & FAN.RENAME) !== 0n) {
        const fromPath = entryPath(event.records, 'old_dfid_name')
        const toPath = entryPath(event.records, 'new_dfid_name')
        if (toPath !== null && consumeDedupe(`RN:${childKey}|${fromPath}|${toPath}`)) {
          // The legacy pair already reported this rename.
        } else if (toPath !== null) {
          emitRename(out, fromPath, toPath, pid, childKey, at, entryKind)
          // The same rename syscall also emits legacy MOVED_FROM/MOVED_TO —
          // register one swallow token per side we were able to name.
          if (fromPath !== null) boundedSet(dedupe, `MF:${childKey}|${fromPath}`, 1)
          boundedSet(dedupe, `MT:${childKey}|${toPath}`, 1)
        }
      }

      if ((mask & FAN.MOVED_FROM) !== 0n && (mask & FAN.RENAME) === 0n) {
        if (selfPath === null || !consumeDedupe(`MF:${childKey}|${selfPath}`)) {
          if (childKey !== null) boundedSet(pendingMoves, childKey, { fromPath: selfPath })
        }
      }

      if ((mask & FAN.MOVED_TO) !== 0n && (mask & FAN.RENAME) === 0n) {
        if (selfPath !== null && !consumeDedupe(`MT:${childKey}|${selfPath}`)) {
          const pending = childKey === null ? undefined : pendingMoves.get(childKey)
          if (childKey !== null) pendingMoves.delete(childKey)
          const fromPath = pending?.fromPath ?? null
          emitRename(out, fromPath, selfPath, pid, childKey, at, entryKind)
          // A FAN_RENAME for the same move may still arrive — swallow it once.
          boundedSet(dedupe, `RN:${childKey}|${fromPath}|${selfPath}`, 1)
        }
      }

      return out
    },
  }
}

function entryPath(records: FidRecord[], kind: FidRecordKind): string | null {
  const record = records.find(candidate => candidate.kind === kind)
  if (record === undefined || record.objectPath === undefined) return null
  if (record.name === null) return record.objectPath
  return `${record.objectPath}/${decodeName(record.name)}`
}

/**
 * Decode an untrusted dirent name for path assembly. Invalid UTF-8 becomes
 * replacement characters; a '/' can never appear in a real dirent name, so
 * one in forged bytes is neutralized rather than allowed to splice paths.
 */
function decodeName(name: Uint8Array): string {
  return Buffer.from(name).toString('utf8').replaceAll('/', '�')
}

/**
 * Drive-prefix scoping for resolved absolute paths (MAP Q9/L9): only entries
 * strictly inside the drive root pass, gateway staging (`.duet/**`) and the
 * anchor marker are excluded, and non-canonical paths (empty, `.`, `..`
 * segments) are rejected rather than interpreted.
 */
export function drivePrefixFilter(driveRoot: string): (path: string) => boolean {
  const root = driveRoot.replace(/\/+$/, '')
  const prefix = `${root}/`
  return (path: string): boolean => {
    if (!path.startsWith(prefix)) return false
    for (const segment of path.slice(prefix.length).split('/')) {
      if (segment === '' || segment === '.' || segment === '..') return false
      if (segment === '.duet' || segment === DUET_ANCHOR_MARKER_FILE) return false
    }
    return true
  }
}
