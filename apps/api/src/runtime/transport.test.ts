import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConvexHttpClient } from 'convex/browser'
import { getFunctionName } from 'convex/server'

import { hashApiKey } from '@repo/contract'

import { createApiApp } from '../index'
import { writeRuntimeReleaseFixture } from './release.fixture'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const releaseDir = await mkdtemp(join(tmpdir(), 'api-runtime-transport-'))
  directories.push(releaseDir)
  const manifest = await writeRuntimeReleaseFixture(releaseDir)
  const token = 'duet_vm_fixture'
  const hash = await hashApiKey(token)
  const client = {
    async query(fn: Parameters<ConvexHttpClient['query']>[0], args: Record<string, unknown>) {
      expect(getFunctionName(fn)).toBe('domains/workspaces/provisioning:gatewayConnectionByVmToken')
      expect(args.internalKey).toBe('fixture-internal')
      return args.vmTokenHash === hash
        ? { workspaceId: 'workspace-fixture', vmName: 'vm-fixture' }
        : null
    },
  } as unknown as ConvexHttpClient
  const app = createApiApp({
    convexClient: client,
    convexUrl: 'http://127.0.0.1:3210',
    internalKey: 'fixture-internal',
    runtimeReleaseDir: releaseDir,
  })
  return { releaseDir, manifest, app, headers: { authorization: `Bearer ${token}` } }
}

test('runtime manifest and each actual artifact stream require a live VM token', async () => {
  const { releaseDir, manifest, app, headers } = await fixture()
  const base = '/v1/vm/runtime-release'
  for (const path of [`${base}/manifest`, `${base}/artifacts/duet`]) {
    expect((await app.request(path)).status).toBe(401)
    expect((await app.request(path, { headers: { authorization: 'Bearer wrong' } })).status).toBe(
      401,
    )
  }
  const response = await app.request(`${base}/manifest`, { headers })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(manifest)
  for (const artifact of manifest.artifacts) {
    const served = await app.request(`${base}/artifacts/${artifact.name}`, { headers })
    expect(served.status).toBe(200)
    expect(served.headers.get('content-length')).toBe(String(artifact.byteLength))
    expect(served.headers.get('content-type')).toBe(
      artifact.name.endsWith('.js')
        ? 'application/javascript; charset=utf-8'
        : 'application/octet-stream',
    )
    expect(Buffer.from(await served.arrayBuffer())).toEqual(
      await readFile(join(releaseDir, artifact.name)),
    )
  }
  expect((await app.request(`${base}/artifacts/package.json`, { headers })).status).toBe(404)
})

test('does not stream changed requested bytes after announcement', async () => {
  const { releaseDir, app, headers } = await fixture()
  expect((await app.request('/v1/vm/runtime-release/manifest', { headers })).status).toBe(200)
  await writeFile(join(releaseDir, 'helper.js'), 'tampered helper')
  const corrupt = await app.request('/v1/vm/runtime-release/artifacts/helper.js', { headers })
  expect(corrupt.status).toBe(503)
  expect(await corrupt.json()).toEqual({ error: 'runtime_release_unavailable' })
})

test('an incomplete inventory cannot be served as an available manifest', async () => {
  const { releaseDir, app, headers } = await fixture()
  await rm(join(releaseDir, 'photon_rs_bg.wasm'))
  const response = await app.request('/v1/vm/runtime-release/manifest', { headers })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'runtime_release_unavailable' })
})
