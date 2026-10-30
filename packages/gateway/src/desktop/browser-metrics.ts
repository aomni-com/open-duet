import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Chrome's per-launch UMA scratch, and why the gateway has to reap it.
 *
 * Chrome memory-maps a 4 MiB `BrowserMetrics-*.pma` file on every launch and
 * only reaps the previous ones once a launch gets far enough to finish
 * startup. A Chrome that dies before that point therefore leaks one file per
 * attempt — and because the desktop is supervised, a Chrome that cannot start
 * is retried, so the leak is bounded only by the disk.
 *
 * On 2026-08-27 that filled a 28 GiB root disk on 32 production workspaces:
 * 4,856 files, 19 GiB. The full disk is then what stops Chrome creating its
 * profile socket, so the failure that caused the leak became permanent and
 * self-sustaining. Bounding this directory is what breaks that cycle, and it
 * heals an already-full workspace on the first start after a gateway release
 * rather than needing an operator.
 */
export const BROWSER_METRICS_DIR_REL = 'BrowserMetrics'

/**
 * How many to spare. Chrome reads unreaped files once, to fold the previous
 * session's metrics into the next upload, so keeping a few preserves the
 * behaviour we would otherwise be silently changing. It is deliberately far
 * below the thousands a leak produces.
 */
export const BROWSER_METRICS_KEEP = 16

/**
 * A file this young may belong to a Chrome starting at this very moment, whose
 * mapping we must not pull out from under it. Every leaked file is older than
 * this within a minute of being orphaned, so the guard costs nothing.
 */
export const BROWSER_METRICS_MIN_AGE_MS = 5 * 60_000

export interface MetricsFile {
  name: string
  modifiedAt: number
}

/**
 * The names to delete: everything but the newest `BROWSER_METRICS_KEEP`, and
 * never anything younger than `BROWSER_METRICS_MIN_AGE_MS`.
 */
export function selectReapableMetricsFiles(
  files: readonly MetricsFile[],
  options: { now: number },
): string[] {
  const newestFirst = files.slice().sort((left, right) => right.modifiedAt - left.modifiedAt)
  return newestFirst
    .slice(BROWSER_METRICS_KEEP)
    .filter(file => options.now - file.modifiedAt >= BROWSER_METRICS_MIN_AGE_MS)
    .map(file => file.name)
}

export interface BrowserMetricsReap {
  deleted: number
  failed: number
}

/**
 * Reap the leaked files in one Chrome profile. Never throws: a missing profile
 * directory, a racing Chrome, and a read-only mount all mean "nothing to reap
 * right now", and none of them is a reason to fail the desktop start this runs
 * ahead of.
 */
export async function reapBrowserMetrics(options: {
  profileDir: string
  now: () => number
}): Promise<BrowserMetricsReap> {
  const dir = join(options.profileDir, BROWSER_METRICS_DIR_REL)
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.pma'))
  } catch {
    return { deleted: 0, failed: 0 }
  }

  const files: MetricsFile[] = []
  for (const name of names) {
    try {
      files.push({ name, modifiedAt: (await stat(join(dir, name))).mtimeMs })
    } catch {
      // Reaped by Chrome between the listing and the stat; nothing to do.
    }
  }

  let deleted = 0
  let failed = 0
  for (const name of selectReapableMetricsFiles(files, { now: options.now() })) {
    try {
      await unlink(join(dir, name))
      deleted += 1
    } catch {
      failed += 1
    }
  }
  return { deleted, failed }
}
