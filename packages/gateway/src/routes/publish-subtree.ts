import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MAX_RECURSIVE_FILE_BYTES,
  MAX_RECURSIVE_FILE_ENTRIES,
  isPublishExcludedDrivePath,
} from '@repo/contract'

export interface PublishSubtreeEntry {
  absolutePath: string
  relativePath: string
  kind: 'directory' | 'file'
  size: number
  mtimeMs: number
  mtimeNs: bigint
}

export type PublishSubtreeResult =
  | { ok: true; entries: PublishSubtreeEntry[] }
  | { ok: false; error: 'recursive_limit_exceeded' }

/** One bounded publish walk shared by zip and frozen-snapshot creation. */
export async function collectPublishSubtree(root: string): Promise<PublishSubtreeResult> {
  const entries: PublishSubtreeEntry[] = []
  let entryCount = 0
  let bytes = 0
  const pending: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: root, relativePath: '' },
  ]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const name of await readdir(current.absolutePath)) {
      const relativePath = current.relativePath === '' ? name : `${current.relativePath}/${name}`
      if (isPublishExcludedDrivePath(relativePath)) continue
      const absolutePath = join(current.absolutePath, name)
      const info = await lstat(absolutePath, { bigint: true })
      if (info.isSymbolicLink()) continue
      entryCount += 1
      if (entryCount > MAX_RECURSIVE_FILE_ENTRIES)
        return { ok: false, error: 'recursive_limit_exceeded' }
      if (info.isDirectory()) {
        entries.push({
          absolutePath,
          relativePath,
          kind: 'directory',
          size: 0,
          mtimeMs: Number(info.mtimeMs),
          mtimeNs: info.mtimeNs,
        })
        pending.push({ absolutePath, relativePath })
        continue
      }
      if (!info.isFile()) continue
      bytes += Number(info.size)
      if (bytes > MAX_RECURSIVE_FILE_BYTES) return { ok: false, error: 'recursive_limit_exceeded' }
      entries.push({
        absolutePath,
        relativePath,
        kind: 'file',
        size: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
        mtimeNs: info.mtimeNs,
      })
    }
  }
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))
  return { ok: true, entries }
}
