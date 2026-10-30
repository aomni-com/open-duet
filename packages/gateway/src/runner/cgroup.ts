import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { promisify } from 'node:util'

import { RUNNERS_CGROUP } from '@repo/contract'

const execFileAsync = promisify(execFile)
const PERIOD_US = 100_000
const SUDO_TIMEOUT_MS = 5_000
// The gateway keeps one core for itself; runners share the rest. Not
// configurable: session cgroups also carry attribution identity, so their
// setup must never depend on tuning knobs.
const GATEWAY_RESERVED_CORES = 1

// Leaves are named by sessionId, never pid (MAP L1): the leaf name under
// /sys/fs/cgroup/runners IS the watcher's cgroup→session interface. The
// attribution helper reverse-maps leaf names with sessionForCgroupLeaf — no
// registration protocol exists.
const LEAF_PREFIX = 'session-'
// Characters the leaf encoding passes through unescaped. Every other UTF-8
// byte is escaped as `_xx` (lowercase hex), so leaves are always safe as
// cgroupfs names and for shell interpolation, and the encoding is injective:
// two distinct session ids can never share a leaf.
const LEAF_SAFE = /^[A-Za-z0-9-]$/

// Drain window between runner turn end and leaf rmdir (MAP L8
// exit-plus-drain): the attribution watcher must still resolve
// cgroup→session for events in flight when the runner exits. Knob: ~2× the
// attribution pipeline's ~5s flush window; tune with slice-11 soak data.
export const DRAIN_MS = 10_000

export interface RunnerCgroupOps {
  /** Runs a shell script with root privileges (default: `sudo -n sh -c`). */
  sh?: (script: string) => Promise<void>
  /** Lists leaf directory names under the runners cgroup (default: readdir). */
  listLeaves?: () => Promise<string[]>
  /** Waits before the post-exit rmdir (default: a real timer). */
  delay?: (ms: number) => Promise<void>
  drainMs?: number
}

let parentReady = false

export async function ensureRunnerCgroup(ops: RunnerCgroupOps = {}): Promise<boolean> {
  const sh = ops.sh ?? sudoSh
  const budgetCores = Math.max(1, availableParallelism() - GATEWAY_RESERVED_CORES)
  const budgetUs = Math.round(budgetCores * PERIOD_US)
  try {
    await sh(
      `mkdir -p ${RUNNERS_CGROUP} && ` +
        `{ grep -qw cpu ${RUNNERS_CGROUP}/cgroup.subtree_control || echo +cpu > ${RUNNERS_CGROUP}/cgroup.subtree_control; } && ` +
        `echo "${budgetUs} ${PERIOD_US}" > ${RUNNERS_CGROUP}/cpu.max`,
    )
    parentReady = true
    return true
  } catch {
    parentReady = false
    return false
  }
}

/** Encodes a session id into its cgroup leaf name. Injective and canonical. */
export function cgroupLeafForSession(sessionId: string): string {
  let encoded = ''
  for (const byte of Buffer.from(sessionId, 'utf8')) {
    const char = String.fromCharCode(byte)
    encoded += LEAF_SAFE.test(char) ? char : `_${byte.toString(16).padStart(2, '0')}`
  }
  return LEAF_PREFIX + encoded
}

/**
 * Inverse of cgroupLeafForSession. Returns null for anything that is not a
 * canonical session leaf (no prefix, unsafe characters, malformed or
 * non-canonical escapes, invalid UTF-8) — e.g. legacy pid-named leaves.
 */
export function sessionForCgroupLeaf(leaf: string): string | null {
  if (!leaf.startsWith(LEAF_PREFIX)) return null
  const encoded = leaf.slice(LEAF_PREFIX.length)
  const bytes: number[] = []
  for (let i = 0; i < encoded.length; i += 1) {
    const char = encoded[i]!
    if (char === '_') {
      const hex = encoded.slice(i + 1, i + 3)
      if (!/^[0-9a-f]{2}$/.test(hex)) return null
      bytes.push(Number.parseInt(hex, 16))
      i += 2
    } else if (LEAF_SAFE.test(char)) {
      bytes.push(char.charCodeAt(0))
    } else {
      return null
    }
  }
  const sessionId = Buffer.from(bytes).toString('utf8')
  // Only canonical encodings invert (rejects `_41` for `A`, uppercase hex,
  // invalid UTF-8), so leaf↔session is a true bijection.
  return cgroupLeafForSession(sessionId) === leaf ? sessionId : null
}

export async function placeRunnerInCgroup(
  pid: number,
  sessionId: string,
  ops: RunnerCgroupOps = {},
): Promise<void> {
  if (!parentReady || !Number.isInteger(pid) || pid <= 0) return
  const sh = ops.sh ?? sudoSh
  const path = leafPath(sessionId)
  try {
    await sh(`mkdir -p ${path} && echo ${pid} > ${path}/cgroup.procs`)
  } catch {
    // Best effort only: the session runs unbudgeted (and unattributed by the
    // watcher) rather than not at all. Also covers leaves beyond NAME_MAX.
  }
}

/**
 * Exit-plus-drain teardown (MAP L8): after the runner's turn ends, keep the
 * leaf for DRAIN_MS so the attribution watcher can still resolve the session
 * for final in-flight events, then rmdir it.
 */
export async function removeRunnerCgroupWhenDrained(
  sessionId: string,
  ops: RunnerCgroupOps = {},
): Promise<void> {
  if (!parentReady) return
  const delay = ops.delay ?? sleep
  const sh = ops.sh ?? sudoSh
  await delay(ops.drainMs ?? DRAIN_MS)
  try {
    await sh(`rmdir ${leafPath(sessionId)}`)
  } catch {
    // Best effort. EBUSY here means a newer turn re-populated the leaf during
    // the drain window — the kernel refuses to remove a cgroup with live
    // members, and that turn's own teardown will retire it.
  }
}

/**
 * GC for crash-leaked leaves: removes session leaves whose session is no
 * longer active, plus legacy pid-named leaves (always stale once the orphan
 * sweep has run). Called from the same startup path as sweepOrphanRunners.
 */
export async function sweepStaleRunnerLeaves(
  activeSessionIds: () => string[],
  ops: RunnerCgroupOps = {},
): Promise<void> {
  const sh = ops.sh ?? sudoSh
  const listLeaves = ops.listLeaves ?? defaultListLeaves
  const active = new Set(activeSessionIds())
  for (const leaf of await listLeaves()) {
    const sessionId = sessionForCgroupLeaf(leaf)
    // Only leaves this module named are eligible (both shapes are shell-safe
    // by construction); unknown leaf shapes are left alone.
    const stale = sessionId !== null ? !active.has(sessionId) : /^\d+$/.test(leaf)
    if (!stale) continue
    try {
      await sh(`rmdir ${RUNNERS_CGROUP}/${leaf}`)
    } catch {
      // Best effort — a leaf that became populated after the listing is
      // protected by the kernel's EBUSY.
    }
  }
}

export function resetRunnerCgroupStateForTests(): void {
  parentReady = false
}

async function sudoSh(script: string): Promise<void> {
  await execFileAsync('sudo', ['-n', 'sh', '-c', script], { timeout: SUDO_TIMEOUT_MS })
}

async function defaultListLeaves(): Promise<string[]> {
  try {
    const entries = await readdir(RUNNERS_CGROUP, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

function leafPath(sessionId: string): string {
  return `${RUNNERS_CGROUP}/${cgroupLeafForSession(sessionId)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
