import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGatewayRuntime } from '../runtime/http'
import { runtimeFixture } from '../testing/runtime-release-fixture'

test('runtime activation refuses new backup capture before restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-activation-'))
  try {
    const driveDir = join(root, 'drive'),
      stateDir = join(root, 'state')
    const releasesDir = join(root, 'releases'),
      currentReleaseLink = join(root, 'current')
    await mkdir(driveDir)
    await mkdir(stateDir)
    await writeFile(join(stateDir, 'vm-token'), 'vm-token')
    const old = runtimeFixture('backup-old'),
      next = runtimeFixture('backup-new')
    await old.write(join(releasesDir, old.manifest.version))
    await symlink(join(releasesDir, old.manifest.version), currentReleaseLink)
    let restarted!: () => void
    const restartRequested = new Promise<void>(resolve => {
      restarted = resolve
    })
    const runtime = createGatewayRuntime({
      driveDir,
      stateDir,
      releasesDir,
      currentReleaseLink,
      apiUrl: 'https://control.test',
      runtimeVersion: old.manifest.version,
      exit: () => restarted(),
      fetch: async input => {
        const url = new URL(input instanceof Request ? input.url : input)
        if (url.pathname === '/v1/vm/sync')
          return Response.json({
            pollAfterMs: 5000,
            anchors: [],
            mirrorMachineIds: [],
            updates: { paused: false },
            runtimeRelease: {
              ...next.manifest,
              artifacts: next.manifest.artifacts.map(artifact => ({
                ...artifact,
                href: 'https://control.test/v1/vm/runtime-release/artifacts/' + artifact.name,
              })),
            },
          })
        return next.fetch(url)
      },
    })
    await runtime.syncOnce()
    await restartRequested
    const response = await runtime.app.request('/v1/backups/backup/start', {
      method: 'POST',
      headers: { authorization: 'Bearer vm-token', 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'after-activation' }),
    })
    const body = await response.json()
    // A broken fence can start capture; settle it before removing scratch state.
    if (response.status === 202)
      await runtime.app.request('/v1/backups/backup', {
        method: 'DELETE',
        headers: { authorization: 'Bearer vm-token', 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'after-activation' }),
      })
    expect(response.status).toBe(409)
    expect(body).toEqual({ error: 'backup_worker_busy' })
    const health = await runtime.app.request('/health', {
      headers: { authorization: 'Bearer vm-token' },
    })
    expect((await health.json()).diagnostics.backup).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10000)

test('backup commands use the existing VM bearer boundary and cancel only the matching attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-routes-'))
  try {
    const driveDir = join(root, 'drive'),
      stateDir = join(root, 'state')
    await mkdir(driveDir)
    await mkdir(stateDir)
    await writeFile(join(stateDir, 'vm-token'), 'vm-token')
    const runtime = createGatewayRuntime({
      driveDir,
      stateDir,
      apiUrl: 'https://control.test',
      fetch: async () => new Promise(() => {}),
    })
    const command = (method: string, path: string, attemptId: string, authorized = true) =>
      runtime.app.request(path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(authorized ? { authorization: 'Bearer vm-token' } : {}),
        },
        body: JSON.stringify({ attemptId }),
      })
    expect((await command('POST', '/v1/backups/backup/start', 'attempt', false)).status).toBe(401)
    expect((await command('POST', '/v1/backups/backup/start', 'attempt')).status).toBe(202)
    expect((await command('POST', '/v1/backups/backup/start', 'attempt')).status).toBe(202)
    expect((await command('POST', '/v1/backups/other/start', 'different')).status).toBe(409)
    expect(await (await command('DELETE', '/v1/backups/backup', 'stale')).json()).toEqual({
      cancelled: false,
    })
    expect(await (await command('DELETE', '/v1/backups/backup', 'attempt')).json()).toEqual({
      cancelled: true,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
