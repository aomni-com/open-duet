import { statfs } from 'node:fs/promises'

import { DRIVE_FREE_SPACE_RESERVE_BYTES } from '@repo/contract'

export interface DiskGuard {
  /**
   * Whether `incomingBytes` more may land while leaving the reserve intact.
   *
   * Callers that are only about to grow the drive by an unknown amount (a
   * session starting, a folder being made) pass nothing and ask the plain
   * reserve question. An upload knows what it is carrying and says so, because
   * a file that cannot possibly fit should be refused before it is streamed
   * rather than after.
   */
  ensureWritable(incomingBytes?: number): Promise<'ok' | 'full'>
}

/**
 * The guard's own filesystem probe.
 *
 * It used to borrow `statvfs` from the VM telemetry sampler's dependency bag,
 * which made deleting that sampler silently disarm the thing that stops a
 * workspace filling its disk -- a failure that only appears at runtime, inside
 * a VM, with a nearly-full drive. The guard owns its probe now.
 */
export async function diskGuardStatvfs(path: string): Promise<{ bavail: number; frsize: number }> {
  const stats = await statfs(path)
  return { bavail: stats.bavail, frsize: stats.bsize }
}

export interface DiskGuardDependencies {
  driveMount: string
  statvfs?(path: string): Promise<{ bavail: number; frsize: number }>
  now?: () => number
  ttlMs?: number
  reserveBytes?: number
}

export const DISK_GUARD_TTL_MS = 3_000

export function createDiskGuard(dependencies: DiskGuardDependencies): DiskGuard {
  const statvfs = dependencies.statvfs ?? diskGuardStatvfs
  const now = dependencies.now ?? Date.now
  const ttlMs = dependencies.ttlMs ?? DISK_GUARD_TTL_MS
  const reserveBytes = dependencies.reserveBytes ?? DRIVE_FREE_SPACE_RESERVE_BYTES
  // Free bytes, not a verdict: the same probe answers "is there room at all"
  // and "is there room for these seven gigabytes", so caching the verdict would
  // hand the second question the first one's answer.
  let cached: { freeBytes: number; expiresAt: number } | null = null

  return {
    async ensureWritable(incomingBytes = 0) {
      const checkedAt = now()
      if (cached === null || checkedAt >= cached.expiresAt) {
        try {
          const stats = await statvfs(dependencies.driveMount)
          cached = { freeBytes: stats.bavail * stats.frsize, expiresAt: checkedAt + ttlMs }
        } catch {
          // Best-effort guard: an unavailable probe must not brick the drive.
          cached = { freeBytes: Number.POSITIVE_INFINITY, expiresAt: checkedAt + ttlMs }
        }
      }
      return cached.freeBytes - incomingBytes < reserveBytes ? 'full' : 'ok'
    },
  }
}
