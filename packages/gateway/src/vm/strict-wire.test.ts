import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { VmSyncRequestSchema, VmRegisterRequestSchema } from '@repo/contract'

import { createDesiredStateStore } from '../desired-state'
import { normalizeEnv } from '../runtime/env'
import { createVmPhoneHome, readVmToken } from './phone-home'
import { createRestoreWindow } from './restore-window'
import { createVmSyncClient } from './sync-client'

test('strict sync and pre-sync token recovery send only runtime and image identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vm-transition-wire-'))
  const runtime = '0.0.0+' + 'c'.repeat(64)
  const image = 'ghcr.io/aomni-com/duet-vm-image@sha256:' + 'd'.repeat(64)
  const sync = { pollAfterMs: 5000, anchors: [], mirrorMachineIds: [], updates: { paused: false } }
  const registrations: unknown[] = []
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json()
      if (new URL(request.url).pathname === '/v1/vm/register') {
        registrations.push(body)
        expect(body).not.toHaveProperty('gatewayVersion')
        const current = VmRegisterRequestSchema.parse(body)
        expect(current.runtimeVersion).toBe(runtime)
        expect('gatewayVersion' in current).toBe(false)
        return Response.json({
          vmToken: 'fixture-vm-token',
          syncIntervalSeconds: 5,
          sync,
        })
      }
      requests.push(body)
      expect(request.headers.get('authorization')).toBe('Bearer fixture-vm-token')
      expect((body as { versions: unknown }).versions).toEqual({ runtime, image })
      expect(VmSyncRequestSchema.parse(body).versions).toEqual({ runtime, image })
      return Response.json(sync)
    },
  })
  try {
    const stateDir = join(root, 'state')
    const config = normalizeEnv({
      stateDir,
      driveDir: join(root, 'drive'),
      apiUrl: server.url.origin,
      workspaceHint: 'fixture-workspace',
      provisioningToken: 'fixture-provisioning-token',
      runtimeVersion: runtime,
      imageVersion: image,
    })
    const phoneHome = createVmPhoneHome({
      config,
      setVmToken: () => {},
      restoreWindow: createRestoreWindow(),
    })
    const desired = createDesiredStateStore(stateDir)
    const client = createVmSyncClient({
      config,
      sink: {
        accept: async body => {
          await desired.accept(body)
        },
        acceptRuntimeRelease: async release => {
          await desired.acceptRuntimeRelease(release)
        },
      },
      getVmToken: () => readVmToken(stateDir),
      setVmToken: () => {},
      trainReports: { reports: () => [], acknowledge: () => {} },
      syncthingDeviceId: {
        read: async () => {
          throw new Error('No fixture Syncthing')
        },
      },
      shareSyncReports: { reports: () => [], acknowledge: () => {} },
      marketplacePullReports: { reports: () => [], acknowledge: () => {} },
      appReconciliationReports: { reports: () => [], acknowledge: () => {} },
      reportedVersions: async () => ({
        runtime: config.runtimeVersion,
        image: config.imageVersion,
      }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: phoneHome.registerOnce,
    })
    await client.syncOnce()
    // The deployed API replays provisioning registration before its first sync.
    // This tests that recovery window, not a spent provisioning-token reset.
    await rm(join(stateDir, 'vm-token'))
    await client.syncOnce()
    await client.syncOnce()
    expect(registrations).toHaveLength(2)
    expect(requests).toHaveLength(1)
    expect(await readFile(join(stateDir, 'vm-token'), 'utf8')).toBe('fixture-vm-token\n')
    expect((await stat(join(stateDir, 'vm-token'))).mode & 0o777).toBe(0o600)
    expect(desired.current()).toEqual({ generation: '1', paused: false, quiesced: false })
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
