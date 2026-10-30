import { copyFile, cp, mkdir, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { RuntimeReleaseManifestSchema } from '@repo/contract'

/** The image consumes the shared constructor's output without changing its bytes or identity. */
export async function stageRuntime(
  releaseDir: string,
  bootstrapPath: string,
  destination: string,
): Promise<void> {
  const manifest = RuntimeReleaseManifestSchema.parse(
    JSON.parse(await readFile(join(releaseDir, 'manifest.json'), 'utf8')),
  )
  const relativeRelease = join('releases', manifest.version)
  await mkdir(join(destination, 'bin'), { recursive: true })
  await cp(releaseDir, join(destination, relativeRelease), { recursive: true })
  await symlink(relativeRelease, join(destination, 'current'))
  await copyFile(bootstrapPath, join(destination, 'bin/runtime-bootstrap.js'))
}
