import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { lock } from 'proper-lockfile'

export interface FileLockOptions {
  waitMs?: number
  staleMs?: number
  retryMs?: number
}

export async function withFileLock<T>(
  path: string,
  action: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const retryMs = options.retryMs ?? 25
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let release: () => Promise<void>
  try {
    release = await lock(path, {
      lockfilePath: path,
      realpath: false,
      stale: options.staleMs ?? 60 * 60 * 1000,
      retries: {
        retries: Math.max(0, Math.ceil((options.waitMs ?? 30_000) / retryMs) - 1),
        factor: 1,
        minTimeout: retryMs,
        maxTimeout: retryMs,
        randomize: false,
      },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new Error(`Timed out acquiring file lock: ${path}`, { cause: error })
    }
    throw error
  }
  try {
    return await action()
  } finally {
    await release()
  }
}
