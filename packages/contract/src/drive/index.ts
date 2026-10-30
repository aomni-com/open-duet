export const DRIVE_ROOT_PATH = '/home/exedev/drive'
export const DUET_STATE_DIR_PATH = '/home/exedev/.duet'
export const DUET_ANCHOR_MARKER_FILE = '.duet-anchor'
export const DRIVE_FREE_SPACE_RESERVE_BYTES = 1024 ** 3
/** Storage ceiling for every persisted logical Drive path. */
export const MAX_DRIVE_PATH_UTF8_BYTES = 4_096

/**
 * The largest single file the Drive accepts, in bytes.
 *
 * A product rule, not a transport one: a Drive `PUT` streams straight to disk,
 * so nothing technical stops a much larger file. The limit exists because an
 * upload nobody can abandon is worse than one that is refused — at a plausible
 * uplink this is already hours of waiting, and there is no resume.
 *
 * Decimal rather than binary so it renders as an exact figure in the surfaces
 * that enforce it (`formatBytes(…, 1000)`); a binary cap would read as
 * "34.4 GB", which is a confusing thing to be told about a 33 GB file.
 *
 * Two things depend on this number and must keep depending on it rather than
 * restating it. `serve-limits.ts` in the gateway derives its transport ceiling
 * from it — deliberately in that direction, because Bun refuses an oversize
 * body on the declared `Content-Length` alone, before any handler and so
 * before any CORS header, leaving a browser with an unexplained network
 * failure instead of a status. And the browser's own pre-check compares
 * against it through `exceedsDriveUploadLimit`, so a picked file is refused
 * before a byte is sent.
 *
 * Note it sits *above* a Starter workspace's whole disk, so free space refuses
 * those uploads first and this cap only ever fires for Pro and Max.
 */
export const DRIVE_UPLOAD_MAX_BYTES = 32_000_000_000

/** Whether a file of this size is refused by the Drive's per-file limit. */
export function exceedsDriveUploadLimit(bytes: number): boolean {
  return bytes > DRIVE_UPLOAD_MAX_BYTES
}

type DrivePathSafetyResult =
  | { ok: true; relativePath: string; absolutePath: string }
  | {
      ok: false
      reason:
        | 'empty'
        | 'absolute'
        | 'traversal'
        | 'reserved'
        | 'invalid_character'
        | 'decode_error'
        | 'too_long'
    }

interface DrivePathOptions {
  allowRoot?: boolean
}

export function normalizeDrivePath(
  path: string,
  options: DrivePathOptions = {},
): DrivePathSafetyResult {
  if (path.includes('\0')) return { ok: false, reason: 'invalid_character' }
  if (new TextEncoder().encode(path).byteLength > MAX_DRIVE_PATH_UTF8_BYTES) {
    return { ok: false, reason: 'too_long' }
  }
  const normalizedSeparators = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return { ok: false, reason: 'absolute' }
  const parts = normalizedSeparators.split('/').filter(part => part.length > 0)
  if (parts.length === 0) {
    return options.allowRoot === true
      ? { ok: true, relativePath: '', absolutePath: DRIVE_ROOT_PATH }
      : { ok: false, reason: 'empty' }
  }
  for (const part of parts) {
    if (part === '.' || part === '..') return { ok: false, reason: 'traversal' }
    if (part === '.duet' || part === DUET_ANCHOR_MARKER_FILE)
      return { ok: false, reason: 'reserved' }
  }
  const relativePath = parts.join('/')
  return { ok: true, relativePath, absolutePath: `${DRIVE_ROOT_PATH}/${relativePath}` }
}

export function normalizeDriveUrlPath(
  rawPath: string,
  options: DrivePathOptions = {},
): DrivePathSafetyResult {
  // URL escaping is transport, not identity: decode once at this boundary so
  // percent-looking filename bytes can never become separators in a later pass.
  const decodedParts: string[] = []
  for (const rawPart of rawPath.split('/')) {
    let decodedPart: string
    try {
      decodedPart = decodeURIComponent(rawPart)
    } catch {
      return { ok: false, reason: 'decode_error' }
    }
    if (decodedPart.includes('/') || decodedPart.includes('\\') || decodedPart.includes('\0')) {
      return { ok: false, reason: 'decode_error' }
    }
    decodedParts.push(decodedPart)
  }
  return normalizeDrivePath(decodedParts.join('/'), options)
}

export function isDrivePathWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

// Both arguments must already be resolved absolute POSIX paths (callers
// realpath/resolve first) — this is a containment check, not a normalizer.
// Pure string logic keeps the module loadable in the Convex isolate runtime.
export function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`)
}

export function assertPathOutsideDriveRoot(
  rawPath: string,
  driveRootPath = DRIVE_ROOT_PATH,
): string {
  const path = normalizeAbsolutePosixPath(rawPath, 'path')
  const driveRoot = normalizeAbsolutePosixPath(driveRootPath, 'drive root')
  if (path === driveRoot || path.startsWith(`${driveRoot}/`)) {
    throw new Error(`path must be outside the drive root: ${path}`)
  }
  return path
}

function normalizeAbsolutePosixPath(rawPath: string, label: string): string {
  if (!rawPath.startsWith('/')) throw new Error(`${label} must be an absolute path`)
  const parts: string[] = []
  for (const part of rawPath.split('/')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join('/')}`
}

/**
 * Directory names whose contents are DERIVED — produced by a build or an
 * install from files that were authored elsewhere, and reproducible by running
 * that step again.
 *
 * This is a different question from the publish floor, which asks what may be
 * SERVED. `node_modules` appears on both lists for opposite reasons: it is
 * never published because it is huge and machine-specific, and it is never
 * authored, so nothing is lost by removing it when whatever produced it is
 * removed. Being unpublishable is exactly what made it look like the user's own
 * work — it was never in a publisher's manifest, so the one rule protecting
 * local additions protected it too, and an uninstalled app left its dependencies
 * behind as the only thing in the folder.
 *
 * Deliberately conservative. `dist`, `build`, `out`, `target`, `vendor` and
 * `coverage` are absent: all of them are commonly authored or committed, and
 * the cost of being wrong here is deleting someone's work to save some disk.
 * A name earns its place only if its contents are always regenerable.
 */
const DERIVED_CONTENT_SEGMENTS = new Set([
  'node_modules',
  '__pycache__',
  '.venv',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.angular',
  '.turbo',
  '.parcel-cache',
  '.vite',
  '.cache',
  '.gradle',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
])

/** Whether any segment of this drive-relative path is derived content. */
export function isDerivedContentPath(path: string): boolean {
  return path
    .split('/')
    .filter(part => part.length > 0)
    .some(part => DERIVED_CONTENT_SEGMENTS.has(part))
}

/**
 * Returns the earliest regenerable or Git metadata tree containing a path.
 * This classifies work for bounded scans and activity folding; it must never
 * be used to decide whether a known path exists.
 */
export function noisyTreeRoot(path: string): string | null {
  const normalized = normalizeDrivePath(path)
  if (!normalized.ok) return null
  const parts = normalized.relativePath.split('/')
  for (let index = 0; index < parts.length; index += 1) {
    const segment = parts[index]!
    if (segment === '.git' || DERIVED_CONTENT_SEGMENTS.has(segment)) {
      return parts.slice(0, index + 1).join('/')
    }
  }
  return null
}
