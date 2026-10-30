import { expect, test, spyOn } from 'bun:test'

import { waitForWorkspace } from './staging-live-http'
import { readAnnouncedRuntime } from './staging-live-runtime'
import { runtimeManifestFixture } from './test-fixtures/runtime-manifest'

test('an asynchronous release predicate cannot certify its first stale observation', async () => {
  let reads = 0
  const sleep = spyOn(Bun, 'sleep').mockImplementation(async () => {})
  try {
    expect(
      await waitForWorkspace({
        workspaceId: 'fixture',
        load: async () => ({ runtimeVersion: ++reads === 1 ? 'old' : 'new' }),
        predicate: async row => row.runtimeVersion === 'new',
        timeoutMs: 1000,
        pollMs: 1,
      }),
    ).toEqual({ runtimeVersion: 'new' })
  } finally {
    sleep.mockRestore()
  }
})

test('manifest HTTP fetch uses VM auth and rejects a wrong aggregate identity', async () => {
  const manifest = runtimeManifestFixture('http')
  let corrupt = false
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      expect(new URL(request.url).pathname).toBe('/v1/vm/runtime-release/manifest')
      expect(request.headers.get('authorization')).toBe('Bearer duet_vm_fixture')
      return Response.json(corrupt ? { ...manifest, version: '0.0.0+' + '0'.repeat(64) } : manifest)
    },
  })
  try {
    expect(
      await readAnnouncedRuntime({ apiUrl: server.url.origin, vmToken: 'duet_vm_fixture' }),
    ).toEqual(manifest)
    corrupt = true
    await expect(
      readAnnouncedRuntime({ apiUrl: server.url.origin, vmToken: 'duet_vm_fixture' }),
    ).rejects.toThrow('runtime manifest identity')
  } finally {
    await server.stop(true)
  }
})
