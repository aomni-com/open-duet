import { createHash } from 'node:crypto'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  canonicalRuntimeReleaseIdentityInput,
  RUNTIME_RELEASE_ARTIFACT_NAMES,
  type RuntimeReleaseManifest,
} from '@repo/contract'

/** Synthetic bytes for transport and sync tests, never an executable payload. */
export async function writeRuntimeReleaseFixture(
  directory: string,
): Promise<RuntimeReleaseManifest> {
  const artifacts: RuntimeReleaseManifest['artifacts'] = []
  for (const name of RUNTIME_RELEASE_ARTIFACT_NAMES) {
    const bytes = Buffer.from(`runtime fixture ${name}\n`)
    const mode = name === 'duet' ? 0o755 : 0o644
    await writeFile(join(directory, name), bytes)
    await chmod(join(directory, name), mode)
    artifacts.push({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      mode,
    })
  }
  const manifest: RuntimeReleaseManifest = {
    formatVersion: 1,
    version:
      '0.0.0+' +
      createHash('sha256').update(canonicalRuntimeReleaseIdentityInput(artifacts)).digest('hex'),
    artifacts,
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest) + '\n')
  return manifest
}
