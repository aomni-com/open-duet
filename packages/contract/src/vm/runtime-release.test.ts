import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  RUNTIME_RELEASE_ARTIFACT_NAMES,
  RuntimeReleaseDescriptorSchema,
  RuntimeReleaseManifestSchema,
  type RuntimeReleaseManifest,
  canonicalRuntimeReleaseIdentityInput,
} from './index'

function inventory(): RuntimeReleaseManifest['artifacts'] {
  return RUNTIME_RELEASE_ARTIFACT_NAMES.map(name => ({
    name,
    sha256: 'a'.repeat(64),
    byteLength: 10,
    mode: name === 'duet' ? 0o755 : 0o644,
  }))
}

describe('runtime release inventory', () => {
  test('identity excludes transport URLs and includes every artifact and its install metadata', () => {
    const artifacts = inventory()
    const identity = (value: typeof artifacts) =>
      createHash('sha256').update(canonicalRuntimeReleaseIdentityInput(value)).digest('hex')
    const original = identity(artifacts)
    const descriptor = RuntimeReleaseDescriptorSchema.parse({
      formatVersion: 1,
      version: `0.0.0+${original}`,
      artifacts: artifacts.map(artifact => ({
        ...artifact,
        href: `https://ctl.duet.so/v1/vm/runtime-release/artifacts/${artifact.name}`,
      })),
    })
    expect(identity(descriptor.artifacts)).toBe(original)
    expect(identity([...artifacts].reverse())).toBe(original)
    for (let index = 0; index < artifacts.length; index++) {
      const changed = structuredClone(artifacts)
      changed[index]!.sha256 = 'b'.repeat(64)
      expect(identity(changed)).not.toBe(original)
    }
    expect(
      identity(artifacts.map(value => ({ ...value, byteLength: value.byteLength + 1 }))),
    ).not.toBe(original)
    expect(identity(artifacts.map(value => ({ ...value, mode: 0o755 })))).not.toBe(original)
  })

  test('an incomplete or misinstalled inventory cannot become a transportable release', () => {
    const manifest: RuntimeReleaseManifest = {
      formatVersion: 1,
      version: '0.0.0+abc',
      artifacts: inventory(),
    }
    expect(RuntimeReleaseManifestSchema.parse(manifest)).toEqual(manifest)
    for (const artifacts of [
      manifest.artifacts.slice(1),
      [...manifest.artifacts.slice(1), manifest.artifacts[1]],
      [...manifest.artifacts].reverse(),
      manifest.artifacts.map(value => ({ ...value, mode: 0o644 })),
      manifest.artifacts.map(value => ({ ...value, byteLength: -1 })),
    ]) {
      expect(RuntimeReleaseManifestSchema.safeParse({ ...manifest, artifacts }).success).toBe(false)
    }
    expect(
      RuntimeReleaseManifestSchema.safeParse({
        version: '0.0.0+abc',
        sha256: 'a'.repeat(64),
        helperSha256: 'b'.repeat(64),
      }).success,
    ).toBe(false)
  })
})
