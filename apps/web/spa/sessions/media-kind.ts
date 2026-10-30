import { driveFileMimeType, driveMediaKind, type DriveMediaKind } from '@repo/contract'

/** Final path segment of a markdown reference, ignoring query and hash. */
export function finalPathSegment(src: string): string {
  const pathname = src.split(/[?#]/, 1)[0] ?? ''
  return pathname.slice(pathname.lastIndexOf('/') + 1) || pathname
}

/**
 * Whether a markdown reference embeds, and as what. The answer comes from the
 * type the drive would serve, so the renderer cannot embed a format the
 * gateway sends as `application/octet-stream` — a divergence that used to be
 * held off by a hand-kept extension list and a comment asking for care.
 */
export function mediaKind(src: string): DriveMediaKind {
  const finalSegment = finalPathSegment(src)
  // A leading dot makes the whole thing a name, not an extension: `.png` is a
  // file, and so is `.preview.png`.
  if (finalSegment.startsWith('.')) return 'file'
  if (finalSegment.lastIndexOf('.') <= 0) return 'file'
  return driveMediaKind(driveFileMimeType(finalSegment))
}
