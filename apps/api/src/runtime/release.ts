import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import {
  canonicalRuntimeReleaseIdentityInput,
  DUET_API_ORIGIN,
  RUNTIME_RELEASE_MANIFEST_FILE,
  RuntimeReleaseDescriptorSchema,
  RuntimeReleaseManifestSchema,
  type RuntimeReleaseDescriptor,
  type RuntimeReleaseManifest,
} from '@repo/contract'

import type { GatewayConnection } from '../gateway/client'

export const DEFAULT_RUNTIME_RELEASE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'runtime-release',
)

// Baked release directories are immutable for the lifetime of one API process.
// Coalesce the full inventory scan rather than hashing the executable on every VM poll.
// Failed scans are evicted so an incomplete local build can recover at the same path.
const verifiedReleases = new Map<string, Promise<RuntimeReleaseManifest | null>>()

export async function announcedRuntimeRelease(options?: {
  releaseDir?: string
  apiBaseUrl?: string
}): Promise<RuntimeReleaseDescriptor | null> {
  const releaseDir = resolve(options?.releaseDir ?? DEFAULT_RUNTIME_RELEASE_DIR)
  const apiBaseUrl = (options?.apiBaseUrl ?? process.env.DUET_API_URL ?? DUET_API_ORIGIN).replace(
    /\/+$/,
    '',
  )
  const manifest = await readRuntimeReleaseManifest(releaseDir)
  if (manifest === null) {
    console.error('runtime release announcement unavailable', { releaseDir })
    return null
  }
  return RuntimeReleaseDescriptorSchema.parse({
    ...manifest,
    artifacts: manifest.artifacts.map(artifact => ({
      ...artifact,
      href: new URL(
        `/v1/vm/runtime-release/artifacts/${artifact.name}`,
        `${apiBaseUrl}/`,
      ).toString(),
    })),
  })
}

export function logRuntimeReleaseAccess(kind: string, gateway: GatewayConnection): void {
  if (process.env.NODE_ENV === 'test') return
  console.info(
    JSON.stringify({
      event: 'runtime_release_fetch',
      kind,
      workspaceId: gateway.workspaceId,
      vmName: gateway.vmName,
    }),
  )
}

export function readRuntimeReleaseManifest(
  releaseDir: string,
): Promise<RuntimeReleaseManifest | null> {
  const directory = resolve(releaseDir)
  const existing = verifiedReleases.get(directory)
  if (existing !== undefined) return existing
  const scan = verifyRuntimeRelease(directory).then(manifest => {
    if (manifest === null) verifiedReleases.delete(directory)
    return manifest
  })
  verifiedReleases.set(directory, scan)
  return scan
}

export async function readRuntimeReleaseArtifact(
  releaseDir: string,
  name: string,
): Promise<{
  body: ReadableStream<Uint8Array>
  byteLength: number
  contentType: string
} | null> {
  const manifest = await readRuntimeReleaseManifest(releaseDir)
  const artifact = manifest?.artifacts.find(artifact => artifact.name === name)
  if (artifact === undefined || !(await verifiedArtifact(releaseDir, artifact))) return null
  return {
    body: Readable.toWeb(
      createReadStream(join(releaseDir, artifact.name)),
    ) as unknown as ReadableStream<Uint8Array>,
    byteLength: artifact.byteLength,
    contentType: name.endsWith('.js')
      ? 'application/javascript; charset=utf-8'
      : 'application/octet-stream',
  }
}

async function verifyRuntimeRelease(releaseDir: string): Promise<RuntimeReleaseManifest | null> {
  try {
    const parsed = RuntimeReleaseManifestSchema.safeParse(
      JSON.parse(await readFile(join(releaseDir, RUNTIME_RELEASE_MANIFEST_FILE), 'utf8')),
    )
    if (!parsed.success) {
      console.error('runtime release verification failed', {
        releaseDir,
        reason: 'manifest_schema',
      })
      return null
    }
    const manifest = parsed.data
    const digest = createHash('sha256')
      .update(canonicalRuntimeReleaseIdentityInput(manifest.artifacts))
      .digest('hex')
    if (manifest.version !== `0.0.0+${digest}`) {
      console.error('runtime release verification failed', {
        releaseDir,
        reason: 'manifest_identity',
      })
      return null
    }
    const verified = await Promise.all(
      manifest.artifacts.map(artifact => verifiedArtifact(releaseDir, artifact)),
    )
    return verified.every(Boolean) ? manifest : null
  } catch (error) {
    console.error('runtime release verification failed', {
      releaseDir,
      reason: 'manifest_read_or_parse',
      errorCode:
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : error instanceof Error
            ? error.name
            : 'unknown',
    })
    return null
  }
}

async function verifiedArtifact(
  releaseDir: string,
  artifact: RuntimeReleaseManifest['artifacts'][number],
): Promise<boolean> {
  try {
    const path = join(releaseDir, artifact.name)
    const metadata = await stat(path)
    // Hosting serves bytes; manifest modes describe the VM installation, not
    // the platform's mounted filesystem permissions.
    if (!metadata.isFile() || metadata.size !== artifact.byteLength) {
      console.error('runtime release verification failed', {
        releaseDir,
        artifact: artifact.name,
        reason: 'artifact_metadata',
        isFile: metadata.isFile(),
        expectedByteLength: artifact.byteLength,
        observedByteLength: metadata.size,
      })
      return false
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest('hex') === artifact.sha256) return true
    console.error('runtime release verification failed', {
      releaseDir,
      artifact: artifact.name,
      reason: 'artifact_digest',
    })
    return false
  } catch (error) {
    console.error('runtime release verification failed', {
      releaseDir,
      artifact: artifact.name,
      reason: 'artifact_read',
      errorCode:
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : error instanceof Error
            ? error.name
            : 'unknown',
    })
    return false
  }
}
