import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * The shared containment stanza: the file's real target must live inside the
 * drive's real root and be a readable regular file. Symlinks inside the drive
 * can point at gateway state outside it, so every drive read the gateway makes
 * on its own behalf goes through here.
 *
 * Gateway-private on purpose: only the process that owns the filesystem can
 * decide what is really inside the drive, so anything that needs drive content
 * to answer a question has to be answered here rather than upstream.
 */
export function containedDriveRealpath(driveDir: string, file: string): string | undefined {
  try {
    const realRoot = realpathSync(resolve(driveDir))
    const realFile = realpathSync(file)
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) return undefined
    if (!statSync(realFile).isFile()) return undefined
    accessSync(realFile, constants.R_OK)
    return realFile
  } catch {
    return undefined
  }
}

export function readContainedDriveFile(driveDir: string, file: string): string | undefined {
  const real = containedDriveRealpath(driveDir, file)
  if (real === undefined) return undefined
  try {
    return readFileSync(real, 'utf8')
  } catch {
    return undefined
  }
}
