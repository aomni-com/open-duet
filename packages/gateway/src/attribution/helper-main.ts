import { dlopen, FFIType, ptr, read as ffiRead } from 'bun:ffi'
/**
 * Privileged fanotify attribution helper — standalone Bun entry (slice 09).
 *
 *   sudo -n bun helper-main.js <driveDir> <gatewayPid>
 *
 * Turns kernel filesystem events into attributed NDJSON `HelperEvent` frames
 * on stdout (a pipe — never a file on the watched filesystem, MAP L12) and
 * obeys `HelperCommand` frames on stdin. Emits `unit` (cgroup leaf) or null,
 * nothing more — actor policy stays in the gateway (slice 11).
 *
 * Two fanotify groups (mechanism probe-proven,
 * specs/done/file-attribution/research/fan-open-perm-probe.md):
 *
 * 1. NOTIF group — `FAN_CLASS_NOTIF | FAN_REPORT_FID | FAN_REPORT_DFID_NAME |
 *    FAN_REPORT_TARGET_FID`, marked `FAN_MARK_FILESYSTEM` (FID-mode marks
 *    reject `FAN_MARK_MOUNT` with EINVAL) with content + dirent masks. Bytes
 *    are decoded by the slice-07 codec; this file is thin I/O around it.
 *
 * 2. Perm pinning group — `FAN_CLASS_CONTENT | FAN_OPEN_PERM`, mount-scoped
 *    via a bind mount of the drive that this helper creates/reuses (the drive
 *    shares the root superblock, so a filesystem-wide perm mark would gate
 *    every open on the VM). It never authorizes anything: on each open-perm
 *    event the opener is blocked in open(2), so `/proc/<pid>/cgroup` is read
 *    race-free, cached, and the event answered `FAN_ALLOW`. Later async NOTIF
 *    events resolve `unit` from that pin — this is what attributes short-lived
 *    processes (the 0/20 case the first FID spike failed). Descendants are
 *    free: cgroup membership is inherited.
 *
 * Load-bearing safety rules (not hygiene — probe-proven landmines):
 * - Handle resolution is O_PATH-ONLY. A readable handle on the watched fs
 *   emits fresh gated events for our own pid: NOTIF self-amplifies to OOM
 *   (slice-13 probe), and a gated open would deadlock the single responder.
 * - After the perm mark is armed, this process never open(2)s anything under
 *   the drive. Startup opens (mount fd) happen before arming.
 * - Self-pid and gateway-pid events are dropped BEFORE any handle open (L9).
 * - The perm response path never blocks on slow work: cached pids are allowed
 *   with no /proc read, and if a pin read ever exceeds its budget the helper
 *   flips to allow-first (racy pin, counted misses) until reads are fast again.
 * - A dead helper cannot wedge VM I/O: the kernel auto-allows pending perm
 *   events when the group fd closes (probe §3).
 */
import { openSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename } from 'node:path'

import { RUNNERS_CGROUP } from '@repo/contract'

import { sessionForCgroupLeaf } from '../runner/cgroup'
import {
  createRenameJoiner,
  drivePrefixFilter,
  FAN,
  parseFanotifyBuffer,
  type FidRecord,
  type JoinedFsEvent,
} from './fanotify-codec'
import {
  HELPER_PROTOCOL_VERSION,
  encodeHelperEvent,
  parseHelperCommand,
  type HelperEvent,
} from './helper-protocol'

// ── Bounded, insertion-ordered retention ───────────────────────────────────

/**
 * Drop oldest-first until `entries` fits `capacity`. A Map iterates in
 * insertion order, so the first key is the oldest write — the caches here
 * bound memory by age of *entry*, not by recency of read.
 */
function retainNewest<Key, Value>(entries: Map<Key, Value>, capacity: number): void {
  while (entries.size > capacity) {
    const oldest = entries.keys().next()
    if (oldest.done === true) return
    entries.delete(oldest.value)
  }
}

// ── Handle path cache: fid → absolute path ─────────────────────────────────

/**
 * `FAN_REPORT_FID` forbids a mount mark, so the NOTIF group must watch the
 * whole filesystem and discard what falls outside the drive. That makes the
 * discards — every read-close by every process on the VM — the dominant cost,
 * and resolving a handle costs an `open_by_handle_at` plus a `readlink`.
 *
 * Inodes recur far faster than they move, so resolution is cached on the
 * codec's `handleKey`. Unresolvable handles are cached too: a handle the
 * kernel would not resolve once will not resolve on the next event either.
 * Correctness rests on seeing every rename on the filesystem, which the
 * filesystem-wide mark guarantees: a moved entry drops its own key, and a
 * moved *directory* drops everything, since it renames every path beneath it.
 */
export interface HandlePathCacheOptions {
  capacity: number
  resolve: (record: FidRecord) => string | null
}

export interface HandlePathCache {
  /** Fill `objectPath` on each record, resolving only uncached handles. */
  fill(records: FidRecord[]): void
  /** Drop what an event's rename or deletion just invalidated. */
  observe(event: { mask: bigint; records: FidRecord[] }): void
}

const PATH_INVALIDATING =
  FAN.MOVED_FROM | FAN.MOVED_TO | FAN.RENAME | FAN.DELETE | FAN.DELETE_SELF | FAN.MOVE_SELF

export function createHandlePathCache(options: HandlePathCacheOptions): HandlePathCache {
  // Insertion-ordered, so the oldest key is the first the iterator yields.
  const paths = new Map<string, string | null>()

  return { fill, observe }

  function fill(records: FidRecord[]): void {
    for (const record of records) {
      let path = paths.get(record.handleKey)
      if (path === undefined && !paths.has(record.handleKey)) {
        path = options.resolve(record)
        remember(record.handleKey, path)
      }
      if (path !== null && path !== undefined) record.objectPath = path
    }
  }

  function observe(event: { mask: bigint; records: FidRecord[] }): void {
    if ((event.mask & PATH_INVALIDATING) === 0n) return
    // A directory moved: every path beneath it changed, and the cache cannot
    // tell which of its entries are beneath it.
    if ((event.mask & FAN.ONDIR) !== 0n) {
      paths.clear()
      return
    }
    for (const record of event.records) paths.delete(record.handleKey)
  }

  function remember(handleKey: string, path: string | null): void {
    paths.set(handleKey, path)
    retainNewest(paths, options.capacity)
  }
}

// ── Pin cache: pid → cgroup unit, the helper's only process state ──────────

export interface PinCacheOptions {
  /** Bounded pin capacity; newest pins replace the oldest entries. */
  capacity: number
  /** Reads /proc/<pid>/cgroup (whole file) or null when unreadable. */
  readCgroup?: (pid: number) => string | null
  /** Reads the pid's kernel start time (procfs stat field 22) or null when gone. */
  readStartTime?: (pid: number) => number | null
}

export interface PinCache {
  /**
   * Perm-event fast path: true when the pid is cached AND provably still the
   * same process (start-time match). A reused pid is pruned here, so the
   * caller falls through to pin() and re-reads the truth.
   */
  isFresh(pid: number): boolean
  /** Pins pid→unit while the opener is provably alive (blocked in open). */
  pin(pid: number): void
  /**
   * NOTIF-side resolution: pinned unit if the entry is not stale, else a live
   * /proc read (covers long-lived and dirent-only processes the perm gate
   * never saw), else null + a counted miss. A pid that died after pinning
   * keeps its pin — the pin is the only truth left, and pid reuse within the
   * event-delivery window is not physically possible.
   */
  resolve(pid: number): string | null
  /** Startup seeding from the runners cgroup scan. */
  seed(pid: number, leaf: string): void
  misses(): number
}

interface PinEntry {
  unit: string | null
  startTime: number | null
}

export function createPinCache(options: PinCacheOptions): PinCache {
  const capacity = Math.max(1, options.capacity)
  const readCgroup = options.readCgroup ?? defaultReadCgroup
  const readStartTime = options.readStartTime ?? defaultReadStartTime
  const entries = new Map<number, PinEntry>()
  let misses = 0

  function remember(pid: number, entry: PinEntry): void {
    // Re-pinning refreshes recency: delete before set so the entry moves to
    // the back of the insertion order.
    entries.delete(pid)
    entries.set(pid, entry)
    retainNewest(entries, capacity)
  }

  function pin(pid: number): void {
    const startTime = readStartTime(pid)
    const content = readCgroup(pid)
    if (content === null) {
      misses += 1
      // Negative-cache the dead pid: its other in-flight events cost one
      // counted miss total, and a live reuse never matches (a null start
      // time is never fresh, so any live process re-pins).
      remember(pid, { unit: null, startTime: null })
      return
    }
    remember(pid, { unit: unitForCgroupContent(content), startTime })
  }

  return {
    isFresh(pid: number): boolean {
      const entry = entries.get(pid)
      if (entry === undefined) return false
      if (entry.startTime !== null && readStartTime(pid) === entry.startTime) return true
      entries.delete(pid)
      return false
    },
    pin,
    resolve(pid: number): string | null {
      const entry = entries.get(pid)
      if (entry !== undefined) {
        const startTime = readStartTime(pid)
        if (startTime === null || startTime === entry.startTime) return entry.unit
        entries.delete(pid) // pid reused by a live different process
      }
      pin(pid)
      return entries.get(pid)?.unit ?? null
    },
    seed(pid: number, leaf: string): void {
      remember(pid, { unit: validUnit(leaf), startTime: readStartTime(pid) })
    },
    misses: () => misses,
  }
}

/**
 * Extracts the attribution unit from /proc/<pid>/cgroup content: the leaf
 * name of a canonical session leaf under the unified hierarchy's `/runners/`
 * (slice 08 owns the naming; `sessionForCgroupLeaf` is the validator — a
 * non-canonical leaf is not a session and yields null).
 */
export function unitForCgroupContent(content: string): string | null {
  const line = content.split('\n').find(candidate => candidate.startsWith('0::'))
  if (line === undefined) return null
  const segments = line.slice(3).split('/')
  if (segments[1] !== basename(RUNNERS_CGROUP)) return null
  const leaf = segments[2] ?? ''
  return validUnit(leaf)
}

function validUnit(leaf: string): string | null {
  return sessionForCgroupLeaf(leaf) === null ? null : leaf
}

function defaultReadCgroup(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8')
  } catch {
    return null
  }
}

function defaultReadStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm (field 2) may contain spaces/parens; fields resume after the last
    // ')'. starttime is field 22 → index 19 of the post-comm fields.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTime = Number(rest[19])
    return Number.isFinite(startTime) ? startTime : null
  } catch {
    return null
  }
}

// ── Constants (uapi fanotify.h / fcntl.h; masks come from the codec's FAN) ──

const FAN_CLOEXEC = 0x1
const FAN_NONBLOCK = 0x2
const FAN_CLASS_CONTENT = 0x4
const FAN_CLASS_NOTIF = 0x0
const FAN_REPORT_FID = 0x200
const FAN_REPORT_DIR_FID = 0x400
const FAN_REPORT_NAME = 0x800
const FAN_REPORT_TARGET_FID = 0x1000
const FAN_MARK_ADD = 0x1
const FAN_MARK_MOUNT = 0x10
const FAN_MARK_FILESYSTEM = 0x100
const FAN_OPEN_PERM = 0x10000n
const FAN_ALLOW = 0x01
const O_PATH = 0x200000
const AT_FDCWD = -100
const POLLIN = 0x1
const EINTR = 4
const EAGAIN = 11

/**
 * Dirent + content masks per the FID spike. FAN_OPEN is deliberately absent:
 * an open-for-write would misreport as a content read at OPEN time, while
 * CLOSE_NOWRITE fires exactly once per read fd and never for written ones —
 * the unambiguous content-read signal (codec `isContentRead` classifies it).
 */
const NOTIF_MASK =
  FAN.CREATE |
  FAN.DELETE |
  FAN.MOVED_FROM |
  FAN.MOVED_TO |
  FAN.RENAME |
  FAN.MODIFY |
  FAN.CLOSE_WRITE |
  FAN.CLOSE_NOWRITE |
  FAN.EVENT_ON_CHILD |
  FAN.ONDIR

const PIN_CAPACITY = 4096
/** Distinct inodes whose resolved path is retained; see createHandlePathCache. */
const HANDLE_PATH_CAPACITY = 8192
const JOINER_CAPACITY = 4096
/** A pin read past this flips to allow-first until reads are fast again. */
const PIN_BUDGET_NS = 5_000_000
const STATS_INTERVAL_MS = 5_000

/**
 * How long `poll(2)` may block. Every fd the helper cares about — stdin, the
 * perm group, the notif group — is in the poll set, so the kernel wakes it the
 * instant there is anything to do and a timed wake-up can only ever discover
 * that there is not. The one deadline that is not an fd is the periodic stats
 * frame, so that is exactly how long it blocks. A signal still interrupts the
 * call (EINTR), so shutdown does not wait for the deadline.
 */
export function pollTimeoutMs(now: number, lastStats: number, statsIntervalMs: number): number {
  return Math.max(0, Math.min(statsIntervalMs, statsIntervalMs - (now - lastStats)))
}
/** NOTIF chunks per loop turn — bounds perm-response latency under storms. */
const MAX_NOTIF_CHUNKS_PER_TURN = 16

// ── Entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [driveDir, gatewayPidArg] = process.argv.slice(2)
  const gatewayPid = Number(gatewayPidArg)
  if (
    driveDir === undefined ||
    !driveDir.startsWith('/') ||
    !Number.isInteger(gatewayPid) ||
    gatewayPid <= 0
  ) {
    console.error('usage: sudo -n bun helper-main.js <absolute driveDir> <gatewayPid>')
    process.exit(1)
  }
  if (process.getuid?.() !== 0) {
    console.error('helper-main must run as root (fanotify + /proc access)')
    process.exit(1)
  }
  const selfPid = process.pid

  const libc = dlopen('libc.so.6', {
    fanotify_init: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    fanotify_mark: {
      args: [FFIType.i32, FFIType.u32, FFIType.u64, FFIType.i32, FFIType.cstring],
      returns: FFIType.i32,
    },
    open_by_handle_at: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  })
  const errno = (): number => {
    const location = libc.symbols.__errno_location()
    return location === null ? 0 : ffiRead.i32(location, 0)
  }

  // The drive shares the root superblock; a bind mount of the drive onto
  // itself lets FAN_MARK_MOUNT scope the blocking perm gate to opens resolved
  // through the drive path only. Reused if a previous helper left it mounted.
  ensureDriveBindMount(driveDir)

  // O_RDONLY (not O_PATH — open_by_handle_at rejects O_PATH mount fds with
  // EBADF, FID spike). Opened BEFORE the perm mark is armed: this is the last
  // open(2) this process ever performs under the drive.
  const mountFd = openSync(driveDir, 0)

  const notifFd = libc.symbols.fanotify_init(
    FAN_CLOEXEC |
      FAN_NONBLOCK |
      FAN_CLASS_NOTIF |
      FAN_REPORT_FID |
      FAN_REPORT_DIR_FID |
      FAN_REPORT_NAME |
      FAN_REPORT_TARGET_FID,
    0,
  )
  if (notifFd < 0) throw new Error(`fanotify_init(notif) errno=${errno()}`)
  if (
    libc.symbols.fanotify_mark(
      notifFd,
      FAN_MARK_ADD | FAN_MARK_FILESYSTEM,
      NOTIF_MASK,
      AT_FDCWD,
      Buffer.from(`${driveDir}\0`),
    ) < 0
  ) {
    throw new Error(`fanotify_mark(notif) errno=${errno()}`)
  }

  const permFd = libc.symbols.fanotify_init(FAN_CLOEXEC | FAN_NONBLOCK | FAN_CLASS_CONTENT, 0)
  if (permFd < 0) throw new Error(`fanotify_init(perm) errno=${errno()}`)
  if (
    libc.symbols.fanotify_mark(
      permFd,
      FAN_MARK_ADD | FAN_MARK_MOUNT,
      FAN_OPEN_PERM,
      AT_FDCWD,
      Buffer.from(`${driveDir}\0`),
    ) < 0
  ) {
    throw new Error(`fanotify_mark(perm) errno=${errno()}`)
  }

  const pins = createPinCache({ capacity: PIN_CAPACITY })
  seedPinsFromRunnersCgroup(pins)

  const joiner = createRenameJoiner({ capacity: JOINER_CAPACITY })
  const inDrive = drivePrefixFilter(driveDir)
  const driveRoot = driveDir.replace(/\/+$/, '')

  const stdout = Bun.stdout.writer()
  function emit(event: HelperEvent): void {
    stdout.write(encodeHelperEvent(event))
    stdout.flush()
  }

  let stopping = false
  let suppressed = false
  let overflow = 0
  // Pids dropped exactly like self/gateway (before any handle open — L9): the
  // Syncthing daemon, pushed by the gateway via `exclude-pids`. Whole-set
  // replacement so a stale pid never lingers past a daemon restart.
  const excludedPids = new Set<number>()
  const isExcluded = (pid: number): boolean =>
    pid === selfPid || pid === gatewayPid || excludedPids.has(pid)
  /** True after a pin read blew its budget: allow-first until reads are fast. */
  let pinLagging = false
  process.on('SIGTERM', () => {
    stopping = true
  })
  process.on('SIGINT', () => {
    stopping = true
  })

  // ── Perm group: pin, then FAN_ALLOW — never authorizes, only observes ────
  const permBuf = Buffer.allocUnsafe(128 * 1024)
  const permResponse = Buffer.allocUnsafe(8)
  function respondAllow(fd: number): void {
    permResponse.writeInt32LE(fd, 0)
    permResponse.writeUInt32LE(FAN_ALLOW, 4)
    libc.symbols.write(permFd, ptr(permResponse), 8)
    libc.symbols.close(fd)
  }
  function timedPin(pid: number): void {
    const start = Bun.nanoseconds()
    pins.pin(pid)
    pinLagging = Bun.nanoseconds() - start > PIN_BUDGET_NS
  }
  function drainPerm(): void {
    for (;;) {
      const got = Number(libc.symbols.read(permFd, ptr(permBuf), permBuf.length))
      if (got < 0) {
        const code = errno()
        if (code === EAGAIN) return
        if (code === EINTR) continue
        throw new Error(`read(perm) errno=${code}`)
      }
      if (got === 0) return
      let offset = 0
      while (offset + 24 <= got) {
        // Perm events are plain metadata (no FID records): u32 event_len at 0,
        // s32 fd at 16, s32 pid at 20 — the codec owns FID bytes, not these.
        const eventLen = permBuf.readUInt32LE(offset)
        if (eventLen < 24 || offset + eventLen > got) break
        const fd = permBuf.readInt32LE(offset + 16)
        const pid = permBuf.readInt32LE(offset + 20)
        offset += eventLen
        if (fd < 0) continue
        if (isExcluded(pid) || pins.isFresh(pid)) {
          respondAllow(fd)
        } else if (pinLagging) {
          respondAllow(fd) // budget breached: never hold I/O on /proc again
          timedPin(pid)
        } else {
          timedPin(pid) // opener is blocked — the race-free pin
          respondAllow(fd)
        }
      }
    }
  }

  // ── NOTIF group: decode via the codec, resolve O_PATH-only, join, emit ───
  const notifBuf = Buffer.allocUnsafe(512 * 1024)
  const handleScratch = Buffer.allocUnsafe(8 + 128)
  function resolveHandle(record: FidRecord): string | null {
    // struct file_handle { u32 handle_bytes; s32 handle_type; u8 f_handle[] }
    handleScratch.writeUInt32LE(record.handle.length, 0)
    handleScratch.writeInt32LE(record.handleType, 4)
    handleScratch.set(record.handle, 8)
    // O_PATH-ONLY (the OOM landmine): never a readable handle on the
    // watched fs. ESTALE (deleted inode) is expected — the surviving
    // parent-dir record still names the entry.
    const fd = libc.symbols.open_by_handle_at(mountFd, ptr(handleScratch), O_PATH)
    if (fd < 0) return null
    try {
      return readlinkSync(`/proc/self/fd/${fd}`)
    } catch {
      // Unresolvable handle: the codec drops pathless events.
      return null
    } finally {
      libc.symbols.close(fd)
    }
  }
  const handlePaths = createHandlePathCache({
    capacity: HANDLE_PATH_CAPACITY,
    resolve: resolveHandle,
  })
  function emitJoined(event: JoinedFsEvent): void {
    if (event.kind === 'overflow') {
      overflow += 1
      return
    }
    if (suppressed) return
    if (!inDrive(event.path)) return
    const fromPath =
      event.fromPath !== undefined && inDrive(event.fromPath)
        ? event.fromPath.slice(driveRoot.length + 1)
        : undefined
    const base = {
      t: 'fs',
      path: event.path.slice(driveRoot.length + 1),
      pid: event.pid,
      unit: pins.resolve(event.pid),
      at: event.at,
    } as const
    if (event.kind === 'rename') {
      emit({
        ...base,
        kind: 'rename',
        entryKind: event.entryKind,
        ...(fromPath === undefined ? {} : { fromPath }),
      })
    } else if (event.kind === 'create' || event.kind === 'delete') {
      emit({ ...base, kind: event.kind, entryKind: event.entryKind })
    } else {
      emit({ ...base, kind: event.kind })
    }
  }
  /** Processes one read(2) chunk. Returns false when the queue is empty. */
  function drainNotifChunk(): boolean {
    const got = Number(libc.symbols.read(notifFd, ptr(notifBuf), notifBuf.length))
    if (got < 0) {
      const code = errno()
      if (code === EAGAIN || code === EINTR) return false
      throw new Error(`read(notif) errno=${code}`)
    }
    if (got === 0) return false
    const events = parseFanotifyBuffer(notifBuf, got)
    // Warm pass: pin every event pid NOW, before any handle resolution.
    // Open-less short-lived processes (rm/mv do unlink/rename with no open,
    // so the perm gate never pinned them) are racing us to exit; a full
    // chunk's O_PATH resolution takes milliseconds, so reading /proc first
    // shrinks their loss window. The race stays fundamentally lossy —
    // probe-measured best-effort (helper-probe.md §5), never wrong.
    for (const raw of events) {
      if (!raw.overflow && !isExcluded(raw.pid)) pins.resolve(raw.pid)
    }
    for (const raw of events) {
      if (raw.overflow) {
        overflow += 1
        continue
      }
      // Self/gateway/syncthing drop BEFORE any handle open (L9 + OOM landmine).
      if (isExcluded(raw.pid)) continue
      // Invalidate before filling: this event's own rename may be what makes a
      // cached path stale.
      handlePaths.observe(raw)
      handlePaths.fill(raw.records)
      for (const joined of joiner.push(raw)) emitJoined(joined)
    }
    return true
  }

  // ── stdin commands ─────────────────────────────────────────────────────
  const stdinBuf = Buffer.allocUnsafe(4096)
  let stdinPending = ''
  function drainStdin(): void {
    // Single read per poll readiness (fd 0 stays blocking; poll guarantees
    // this one read cannot block). EOF = the gateway hung up — an orphaned
    // helper must not outlive it.
    const got = Number(libc.symbols.read(0, ptr(stdinBuf), stdinBuf.length))
    if (got < 0) return
    if (got === 0) {
      stopping = true
      return
    }
    stdinPending += stdinBuf.toString('utf8', 0, got)
    for (;;) {
      const newline = stdinPending.indexOf('\n')
      if (newline < 0) break
      const command = parseHelperCommand(stdinPending.slice(0, newline))
      stdinPending = stdinPending.slice(newline + 1)
      if (command === null) continue
      if (command.t === 'shutdown') stopping = true
      else if (command.t === 'suppress') suppressed = command.on
      else {
        excludedPids.clear()
        for (const pid of command.pids) excludedPids.add(pid)
      }
    }
  }

  // ── Main loop ──────────────────────────────────────────────────────────
  // struct pollfd { i32 fd; i16 events; i16 revents } ×3: stdin, perm, notif.
  const pollFds = Buffer.alloc(8 * 3)
  pollFds.writeInt32LE(0, 0)
  pollFds.writeInt16LE(POLLIN, 4)
  pollFds.writeInt32LE(permFd, 8)
  pollFds.writeInt16LE(POLLIN, 12)
  pollFds.writeInt32LE(notifFd, 16)
  pollFds.writeInt16LE(POLLIN, 20)

  function emitStats(at: number): void {
    emit({ t: 'stats', overflow, cgroupMisses: pins.misses(), at })
  }

  emit({ t: 'ready', pid: selfPid, protocol: HELPER_PROTOCOL_VERSION })
  let lastStats = Date.now()
  while (!stopping) {
    const ready = libc.symbols.poll(
      ptr(pollFds),
      3,
      pollTimeoutMs(Date.now(), lastStats, STATS_INTERVAL_MS),
    )
    if (ready < 0 && errno() !== EINTR) throw new Error(`poll errno=${errno()}`)
    if (ready > 0) {
      if (pollFds.readInt16LE(6) !== 0) drainStdin()
      if (pollFds.readInt16LE(14) !== 0) drainPerm()
      if (pollFds.readInt16LE(22) !== 0) {
        for (let chunk = 0; chunk < MAX_NOTIF_CHUNKS_PER_TURN; chunk += 1) {
          if (!drainNotifChunk()) break
          drainPerm() // blocked openers outrank async decode
        }
      }
    }
    const now = Date.now()
    if (now - lastStats >= STATS_INTERVAL_MS) {
      lastStats = now
      emitStats(now)
    }
    // Yield so signal handlers can run — the loop is otherwise synchronous.
    await Bun.sleep(0)
  }

  // Clean shutdown: answer any pending perm events (the kernel would
  // auto-allow on close anyway), drain what's decoded, report final counters.
  drainPerm()
  drainNotifChunk()
  emitStats(Date.now())
  libc.symbols.close(permFd)
  libc.symbols.close(notifFd)
  libc.symbols.close(mountFd)
  stdout.flush()
  await stdout.end()
}

function ensureDriveBindMount(driveDir: string): void {
  const isMountpoint = (): boolean => Bun.spawnSync(['mountpoint', '-q', driveDir]).exitCode === 0
  if (isMountpoint()) return // reuse a previous helper's bind mount
  const mounted = Bun.spawnSync(['mount', '--bind', driveDir, driveDir])
  if (mounted.exitCode !== 0 || !isMountpoint()) {
    throw new Error(
      `cannot bind-mount ${driveDir} onto itself — refusing to arm an unscoped perm gate: ${mounted.stderr.toString()}`,
    )
  }
}

function seedPinsFromRunnersCgroup(pins: PinCache): void {
  let leaves: string[]
  try {
    leaves = readdirSync(RUNNERS_CGROUP)
  } catch {
    return // no runners cgroup yet — nothing to seed
  }
  for (const leaf of leaves) {
    let procs: string
    try {
      procs = readFileSync(`${RUNNERS_CGROUP}/${leaf}/cgroup.procs`, 'utf8')
    } catch {
      continue
    }
    for (const line of procs.split('\n')) {
      const pid = Number(line)
      if (Number.isInteger(pid) && pid > 0) pins.seed(pid, leaf)
    }
  }
}

if (import.meta.main) {
  await main()
}
