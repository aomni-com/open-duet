import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MirrorDeviceListSchema, SyncMachinePageSchema, SyncMachineSchema } from '@repo/contract'

import { createCommandContext } from '../../duet/src/cli-support'
import { configPathForHome, saveConfig } from '../../duet/src/config'
import { workspaceSyncKey } from '../../duet/src/sync/daemon-status'
import { registerSyncMachine } from '../../duet/src/sync/machine'
import {
  createRealMirrorStarter,
  isAdmissionRefusal,
  type WorkspaceMirrorHandle,
} from '../../duet/src/sync/mirror'
import { fnQuery, type Workspace } from './staging-live-env'
import { apiJson, bearer, stagingFetch } from './staging-live-http'
import type { WorkspaceBrowserJourneyContext } from './staging-live-workspace-browser'

export function recordUnifiedSyncMachineCleanup(
  context: Pick<
    WorkspaceBrowserJourneyContext,
    'env' | 'runId' | 'ledger' | 'artifacts' | 'convex'
  >,
  machineId: string,
  actorId: string,
  cleanupKey: string,
) {
  context.ledger.record({
    kind: 'sync-machine',
    id: machineId,
    label: `${context.runId}:scratch-machine:${machineId}`,
    cleanup: async () => {
      await apiJson(
        `${context.env.apiUrl}/v1/user/sync-machines/${machineId}`,
        { method: 'DELETE', headers: bearer(cleanupKey) },
        200,
        'scratch machine cleanup',
        context.artifacts,
      )
    },
    // Ledger verification follows identity retirement, so read through the existing internal owner.
    verify: async () =>
      (await context.convex.query(fnQuery('domains/syncMachines/api:owned'), {
        internalKey: context.env.internalKey,
        actorId,
        machineId,
      })) === false,
  })
}

export async function registerTrackedSyncMachine(
  context: Pick<
    WorkspaceBrowserJourneyContext,
    'env' | 'runId' | 'ledger' | 'artifacts' | 'convex'
  >,
  home: string,
  binary: string,
  actorId: string,
  cleanupKey: string,
) {
  const { ctx } = await createCommandContext(['whoami'], {
    home,
    env: {},
    fetch: async (url, init) => {
      const response = await stagingFetch(url, init)
      if (
        init?.method === 'POST' &&
        new URL(String(url)).pathname === '/v1/user/sync-machines' &&
        response.ok
      ) {
        // The real CLI saves config after parsing this response. Own the remote row first.
        const machine = SyncMachineSchema.parse(await response.clone().json())
        recordUnifiedSyncMachineCleanup(context, machine.machineId, actorId, cleanupKey)
      }
      return response
    },
  })
  return { ctx, machineId: await registerSyncMachine(ctx, binary) }
}

export async function exerciseSync(
  context: WorkspaceBrowserJourneyContext,
  key: string,
  cleanupKey: string,
  actorId: string,
  binary: string,
  scratch: string,
  workspace: Workspace,
  handles: WorkspaceMirrorHandle[],
) {
  const machines = []
  for (const index of [0, 1]) {
    const home = join(scratch, `machine-${index}`)
    await saveConfig(
      { apiKey: key, apiUrl: context.env.apiUrl, defaultWorkspace: workspace.slug },
      configPathForHome(home),
    )
    const { ctx, machineId } = await registerTrackedSyncMachine(
      context,
      home,
      binary,
      actorId,
      cleanupKey,
    )
    const listed = SyncMachinePageSchema.parse(
      await apiJson(
        `${context.env.apiUrl}/v1/user/sync-machines?limit=100`,
        { headers: bearer(key) },
        200,
        'scratch machine inventory',
        context.artifacts,
      ),
    )
    const machine = listed.items.find(row => row.machineId === machineId)
    assert(machine, 'Registered machine was not listed')
    machines.push({ home, machineId, syncthingDeviceId: machine.syncthingDeviceId })
    const handle = await createRealMirrorStarter({
      api: ctx.api,
      machineId,
      home,
      binaryPath: binary,
      fetch: stagingFetch,
    })({
      slug: workspace.slug,
      syncKey: workspaceSyncKey(context.env.apiUrl, workspace._id),
      localDir: join(home, 'drive'),
      log: () => {},
    })
    handles.push(handle)
  }
  assert.notEqual(
    machines[0]!.machineId,
    machines[1]!.machineId,
    'Two peers collapsed into one machine',
  )
  const bytes = Buffer.from([0, 255, 128, 1, 2, 10, ...Buffer.from(context.runId)])
  await writeFile(join(handles[0]!.localDir, 'two-machine.bin'), bytes)
  await waitBytes(join(handles[1]!.localDir, 'two-machine.bin'), bytes)
  const remote = await stagingFetch(
    `${context.env.apiUrl}/v1/ws/${workspace.slug}/files/two-machine.bin`,
    { headers: bearer(key) },
  )
  assert.equal(remote.status, 200)
  assert.deepEqual(Buffer.from(await remote.arrayBuffer()), bytes, 'Synced VM bytes differ')
  const reverse = Buffer.concat([bytes, Buffer.from('reverse')])
  await writeFile(join(handles[1]!.localDir, 'two-machine.bin'), reverse)
  await waitBytes(join(handles[0]!.localDir, 'two-machine.bin'), reverse)
  return { machines, bytesSha256: createHash('sha256').update(reverse).digest('hex') }
}

export async function waitBytes(path: string, expected: Buffer) {
  const deadline = Date.now() + 180_000
  for (;;) {
    let observed: Buffer | undefined
    try {
      observed = await readFile(path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (observed?.equals(expected)) return
    assert(Date.now() < deadline, 'Scratch sync bytes did not converge')
    await Bun.sleep(500)
  }
}

/** Require both the gateway registry and the already-running local peer to detach. */
export async function waitMirrorDetached(
  context: Pick<WorkspaceBrowserJourneyContext, 'env' | 'apiToken' | 'artifacts'>,
  workspace: Workspace,
  machineId: string,
  handle: WorkspaceMirrorHandle,
) {
  const deadline = Date.now() + 90_000
  for (;;) {
    const devices = MirrorDeviceListSchema.parse(
      await apiJson(
        `${context.env.apiUrl}/v1/ws/${workspace.slug}/mirror-devices?limit=100`,
        { headers: bearer(context.apiToken) },
        200,
        'gateway mirror detach observation',
        context.artifacts,
      ),
    )
    assert.equal(devices.nextCursor, null, 'Mirror detach inventory was incomplete')
    let connected = true
    try {
      connected = (await handle.poll()).connected
    } catch (error) {
      if (!isAdmissionRefusal(error)) throw error
      connected = false
    }
    if (!devices.items.some(row => row.machineId === machineId) && !connected) return
    assert(Date.now() < deadline, 'Existing mirror did not detach after removal')
    await Bun.sleep(500)
  }
}

export async function stopMirrors(handles: WorkspaceMirrorHandle[]) {
  const stopped = await Promise.allSettled(handles.map(handle => handle.stop()))
  const failed = stopped.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failed.length > 0)
    throw new AggregateError(
      failed.map(result => result.reason),
      'Scratch mirror shutdown failed',
    )
  handles.length = 0
}
