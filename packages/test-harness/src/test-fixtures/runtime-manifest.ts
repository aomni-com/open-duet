import { createHash } from 'node:crypto'

import { canonicalRuntimeReleaseIdentityInput, type RuntimeReleaseManifest } from '@repo/contract'

import captured from './runtime-manifest.json'

/** Captured manifest metadata with distinct identities for controlled HTTP tests. */
export function runtimeManifestFixture(label: string): RuntimeReleaseManifest {
  const artifacts = captured.artifacts.map(artifact => ({
    ...artifact,
    sha256: createHash('sha256').update(`${label}:${artifact.name}`).digest('hex'),
  })) as RuntimeReleaseManifest['artifacts']
  return {
    formatVersion: 1,
    version:
      '0.0.0+' +
      createHash('sha256').update(canonicalRuntimeReleaseIdentityInput(artifacts)).digest('hex'),
    artifacts,
  }
}
