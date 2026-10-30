import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export async function sweepDriveUploadTemps(
  tempDir: string,
  onError?: (error: unknown) => void,
): Promise<void> {
  let entries
  try {
    if ((await lstat(tempDir)).isSymbolicLink()) return
    entries = await readdir(tempDir)
  } catch (error) {
    if (isNotFoundError(error)) return
    onError?.(error)
    return
  }
  const results = await Promise.allSettled(
    entries.filter(entry => entry.startsWith('upload-')).map(entry => unlink(join(tempDir, entry))),
  )
  for (const result of results) {
    if (result.status === 'rejected') onError?.(result.reason)
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
