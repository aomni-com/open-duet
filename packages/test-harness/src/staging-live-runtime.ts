import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { canonicalRuntimeReleaseIdentityInput, RuntimeReleaseManifestSchema } from '@repo/contract'

import type { StagingArtifactCollector } from './staging-live-artifacts'
import { apiJson, bearer } from './staging-live-http'

/** Reject a partial inventory or a stamp that does not identify its artifact metadata. */
export function parseRuntimeReleaseManifest(value: unknown) {
  const manifest = RuntimeReleaseManifestSchema.parse(value)
  const digest = createHash('sha256')
    .update(canonicalRuntimeReleaseIdentityInput(manifest.artifacts))
    .digest('hex')
  assert.equal(
    manifest.version,
    `0.0.0+${digest}`,
    'runtime manifest identity does not match its complete inventory',
  )
  return manifest
}

export async function readAnnouncedRuntime(options: {
  apiUrl: string
  vmToken: string
  label?: string
  artifacts?: StagingArtifactCollector
}) {
  return parseRuntimeReleaseManifest(
    await apiJson(
      `${options.apiUrl}/v1/vm/runtime-release/manifest`,
      { headers: bearer(options.vmToken) },
      200,
      options.label ?? 'announced runtime release',
      options.artifacts,
    ),
  )
}

/** Slice06 reads the historical diagnostic column; slice10 removes this fleet transition edge. */
