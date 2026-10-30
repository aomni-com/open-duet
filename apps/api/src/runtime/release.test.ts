import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalRuntimeReleaseIdentityInput } from '@repo/contract'

import {
  announcedRuntimeRelease as announcedRelease,
  readRuntimeReleaseManifest as readManifest,
} from './release'
import { writeRuntimeReleaseFixture } from './release.fixture'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'api-runtime-release-'))
  directories.push(directory)
  return { directory, manifest: await writeRuntimeReleaseFixture(directory) }
}

test('announces the complete verified runtime and URL-independent identity', async () => {
  const { directory, manifest } = await fixture()
  expect(await readManifest(directory)).toEqual(manifest)
  const descriptor = await announcedRelease({
    releaseDir: directory,
    apiBaseUrl: 'https://api.test',
  })
  expect(descriptor).toEqual({
    ...manifest,
    artifacts: manifest.artifacts.map(artifact => ({
      ...artifact,
      href: `https://api.test/v1/vm/runtime-release/artifacts/${artifact.name}`,
    })),
  })
})

test('refuses wrong identity and any missing, corrupt or wrong-length artifact', async () => {
  for (const defect of ['identity', 'missing', 'corrupt', 'length'] as const) {
    const { directory, manifest } = await fixture()
    if (defect === 'identity') manifest.version = '0.0.0+' + '0'.repeat(64)
    else if (defect === 'missing') await rm(join(directory, 'photon_rs_bg.wasm'))
    else if (defect === 'corrupt')
      await writeFile(
        join(directory, 'duet'),
        Buffer.alloc((await readFile(join(directory, 'duet'))).length, 'x'),
      )
    else manifest.artifacts[0]!.byteLength++
    if (defect === 'length')
      manifest.version =
        '0.0.0+' +
        createHash('sha256')
          .update(canonicalRuntimeReleaseIdentityInput(manifest.artifacts))
          .digest('hex')
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    expect(
      await announcedRelease({ releaseDir: directory, apiBaseUrl: 'https://api.test' }),
      defect,
    ).toBeNull()
  }
})

test('an incomplete local build can recover at the same directory', async () => {
  const { directory, manifest } = await fixture()
  await rm(join(directory, 'photon_rs_bg.wasm'))
  expect(await announcedRelease({ releaseDir: directory })).toBeNull()
  await writeRuntimeReleaseFixture(directory)
  expect((await announcedRelease({ releaseDir: directory }))?.version).toBe(manifest.version)
})

test('a rejected mounted artifact reports its exact metadata failure without logging contents', async () => {
  const { directory, manifest } = await fixture()
  const duet = manifest.artifacts.find(artifact => artifact.name === 'duet')!
  await writeFile(join(directory, duet.name), Buffer.alloc(duet.byteLength + 1, 'x'))
  const messages: unknown[][] = []
  const logger = spyOn(console, 'error').mockImplementation((...args) => messages.push(args))
  try {
    expect(await readManifest(directory)).toBeNull()
    expect(messages).toEqual([
      [
        'runtime release verification failed',
        {
          releaseDir: directory,
          artifact: 'duet',
          reason: 'artifact_metadata',
          isFile: true,
          expectedByteLength: duet.byteLength,
          observedByteLength: duet.byteLength + 1,
        },
      ],
    ])
  } finally {
    logger.mockRestore()
  }
})
