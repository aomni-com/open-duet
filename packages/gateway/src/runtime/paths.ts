import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { RuntimeReleaseManifestSchema, RUNTIME_RELEASE_MANIFEST_FILE } from '@repo/contract'

export function resolveRuntimePaths(entryPath: string = import.meta.path) {
  const directory = dirname(realpathSync(entryPath))
  let version: string | undefined
  try {
    version = RuntimeReleaseManifestSchema.parse(
      JSON.parse(readFileSync(join(directory, RUNTIME_RELEASE_MANIFEST_FILE), 'utf8')),
    ).version
  } catch (error) {
    // Source/dev execution has no constructed inventory. A present manifest
    // must describe a full runtime; old gateway-only layouts cannot be adopted.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    directory,
    version,
    duet: version === undefined ? 'duet' : join(directory, 'duet'),
    helper: join(directory, 'helper.js'),
  }
}

// Capture before current can switch: subprocesses belong to this gateway.
export const RUNNING_RUNTIME = resolveRuntimePaths()
