import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Remove an X display lock left behind by a server that is no longer running.
 *
 * `kasmvncserver` refuses to start while `/tmp/.X<n>-lock` exists — "A VNC
 * server is already running as :<n>" — and nothing removes that file when the
 * server dies without its own teardown. The refusal is therefore permanent, and
 * it is the first domino in the 2026-08-27 pool exhaustion: the desktop target
 * could never activate, so the supervisor restarted the stack forever, and
 * those restarts leaked Chrome's per-launch metrics until the disk was full.
 *
 * Observed on a wedged production VM, where the lock named PID 939 — dead for
 * 23 hours, with no X server running and `/tmp/.X11-unix` empty.
 *
 * This lives in the gateway rather than the unit's ExecStartPre so it ships on
 * the gateway release rail: the lock is owned by the same unprivileged user the
 * gateway runs as, so no sudo and no image rebuild is involved. Note that
 * `kasmvncserver -kill` is not a substitute and was measured first — with no
 * live server to kill it reports failure and leaves the lock in place.
 */
export async function clearStaleDisplayLock(options: {
  display: number
  runDir?: string
  socketDir?: string
}): Promise<boolean> {
  const runDir = options.runDir ?? '/tmp'
  const socketDir = options.socketDir ?? '/tmp/.X11-unix'
  const lockPath = join(runDir, `.X${options.display}-lock`)

  let owner: number | undefined
  try {
    owner = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10)
  } catch {
    return false // No lock, or not ours to read: nothing to clear.
  }
  // A live owner is a real server, which must be left alone. Anything else —
  // dead pid, empty file, garbage — is debris from a server that is gone.
  if (Number.isFinite(owner) && owner > 0 && processIsAlive(owner)) return false

  // The lock is the thing that blocks the start, so only its removal is
  // reported; the caller logs this, and a log line claiming a lock was cleared
  // when it is still there would send the next reader down the wrong path.
  try {
    await unlink(lockPath)
  } catch {
    return false
  }
  await unlink(join(socketDir, `X${options.display}`)).catch(() => undefined)
  return true
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
