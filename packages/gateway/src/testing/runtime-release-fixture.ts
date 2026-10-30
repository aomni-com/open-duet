import { createHash } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  canonicalRuntimeReleaseIdentityInput,
  RUNTIME_RELEASE_ARTIFACT_NAMES,
  type RuntimeReleaseManifest,
} from '@repo/contract'

export function runtimeFixture(seed: string) {
  const bytes = new Map(
    RUNTIME_RELEASE_ARTIFACT_NAMES.map(name => [name, Buffer.from(`${seed}:${name}`)]),
  )
  const artifacts: RuntimeReleaseManifest['artifacts'] = RUNTIME_RELEASE_ARTIFACT_NAMES.map(
    name => ({
      name,
      sha256: createHash('sha256').update(bytes.get(name)!).digest('hex'),
      byteLength: bytes.get(name)!.length,
      mode: name === 'duet' ? 0o755 : 0o644,
    }),
  )
  const manifest: RuntimeReleaseManifest = {
    formatVersion: 1,
    version: `0.0.0+${createHash('sha256').update(canonicalRuntimeReleaseIdentityInput(artifacts)).digest('hex')}`,
    artifacts,
  }
  return {
    manifest,
    bytes,
    async write(dir: string) {
      await mkdir(dir, { recursive: true })
      for (const artifact of artifacts) {
        await writeFile(join(dir, artifact.name), bytes.get(artifact.name)!)
        await chmod(join(dir, artifact.name), artifact.mode)
      }
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
    },
    async fetch(input: string | URL | Request): Promise<Response> {
      const path = new URL(String(input)).pathname
      if (path === '/v1/vm/runtime-release/manifest') return Response.json(manifest)
      const name = decodeURIComponent(path.split('/').at(-1)!)
      const content = bytes.get(name as (typeof RUNTIME_RELEASE_ARTIFACT_NAMES)[number])
      return content === undefined
        ? new Response('not found', { status: 404 })
        : new Response(content)
    },
  }
}
