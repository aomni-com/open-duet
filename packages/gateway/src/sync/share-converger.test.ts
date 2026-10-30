import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE,
  MIRROR_FOLDER_ID,
  type VmDesiredShareSync,
} from '@repo/contract'

import { createTunnelAcceptRegistry } from '../routes/tunnel'
import { SyncBridgeRegistry } from './bridge-registry'
import { readMounts, writeMirrorDevices, writeMounts } from './mount-store'
import {
  createShareConverger,
  oldPathHasSyncthingMarker,
  removeSyncthingFolderXml,
  repathSyncthingFolderXml,
  type ShareRelocationOperations,
} from './share-converger'
import type { SyncthingConfig } from './syncthing-client'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('share converger', () => {
  test('treats only a missing old-root marker as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'share-marker-guard-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    await mkdir(driveDir)

    expect(await oldPathHasSyncthingMarker(driveDir, 'missing')).toBe(false)

    await writeFile(join(driveDir, 'not-a-directory'), 'occupied')
    await expect(oldPathHasSyncthingMarker(driveDir, 'not-a-directory')).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  test('repaths only the selected Syncthing XML folder and escapes the new path', () => {
    const xml =
      '<configuration><folder id="other" path="/keep"/><folder id="share-&amp;-a" path="/old"/></configuration>'

    expect(repathSyncthingFolderXml(xml, 'share-&-a', '/new/$&-$`-$\'-"<&')).toBe(
      '<configuration><folder id="other" path="/keep"/><folder id="share-&amp;-a" path="/new/$&amp;-$`-$\'-&quot;&lt;&amp;"/></configuration>',
    )
    expect(repathSyncthingFolderXml(xml, 'missing', '/new')).toBe(xml)
  })

  test('removes only the selected Syncthing XML folder and is idempotent', () => {
    const xml =
      '<configuration><folder id="keep" path="/keep"><device id="A"/></folder><folder id="remove" path="/old"><device id="B"/></folder></configuration>'
    const removed =
      '<configuration><folder id="keep" path="/keep"><device id="A"/></folder></configuration>'

    expect(removeSyncthingFolderXml(xml, 'remove')).toBe(removed)
    expect(removeSyncthingFolderXml(removed, 'remove')).toBe(removed)
  })

  test('is idempotent, refreshes credentials without redialing, and preserves mirror state', async () => {
    let folderPreparations = 0
    const fixture = await createFixture({
      prepareFolder: async desired => {
        folderPreparations += 1
        const path = join(fixture.driveDir, desired.folder.path)
        await mkdir(path, { recursive: true })
        return path
      },
    })
    const desired = snapshot(share('a', { peerDeviceId: 'PEER-A' }))

    expect((await fixture.converger.converge(desired)).reports).toEqual([
      expect.objectContaining({ shareId: 'a', state: 'ready' }),
    ])
    expect(fixture.syncthing.writes).toBe(1)
    expect(fixture.bridgeStarts).toBe(1)

    const repeated = await fixture.converger.converge(desired)
    expect(fixture.syncthing.writes).toBe(1)
    expect(fixture.bridgeStarts).toBe(1)
    expect(folderPreparations).toBe(1)
    expect(repeated.changes).toBe(0)

    await fixture.converger.converge(
      snapshot(
        share('a', {
          peerDeviceId: 'PEER-A',
          tunnelToken: 'refreshed-token',
          tokenDigest: 'b'.repeat(64),
          expiresAt: 3_000,
        }),
      ),
    )
    expect(fixture.syncthing.writes).toBe(1)
    expect(fixture.bridgeStarts).toBe(1)

    await fixture.converger.converge({ shares: [] })
    expect(fixture.syncthing.config.devices).toEqual([
      expect.objectContaining({ deviceID: 'MIRROR-DEVICE' }),
    ])
    expect(fixture.syncthing.config.folders).toEqual([
      expect.objectContaining({ id: MIRROR_FOLDER_ID }),
    ])
    expect(await readMounts(fixture.stateDir)).toEqual([])
    expect(fixture.bridgeCloses).toBe(1)
  })

  test('ref-counts one peer device across shares and maps read modes by role', async () => {
    const fixture = await createFixture()
    await fixture.converger.converge(
      snapshot(
        share('origin', { peerDeviceId: 'SHARED-PEER', role: 'origin', mode: 'read' }),
        share('recipient', {
          peerDeviceId: 'SHARED-PEER',
          role: 'recipient',
          mode: 'read',
          path: 'shared/recipient',
        }),
      ),
    )

    expect(
      fixture.syncthing.config.devices?.filter(device => device.deviceID === 'SHARED-PEER'),
    ).toHaveLength(1)
    expect(
      fixture.syncthing.config.folders?.find(folder => folder.id === 'share-origin')?.type,
    ).toBe('sendonly')
    expect(
      fixture.syncthing.config.folders?.find(folder => folder.id === 'share-recipient')?.type,
    ).toBe('receiveonly')

    await fixture.converger.converge(
      snapshot(
        share('recipient', {
          peerDeviceId: 'SHARED-PEER',
          role: 'recipient',
          mode: 'read',
          path: 'shared/recipient',
        }),
      ),
    )
    expect(
      fixture.syncthing.config.devices?.filter(device => device.deviceID === 'SHARED-PEER'),
    ).toHaveLength(1)
  })

  test('pauses a share without changing its topology and reports paused after config read-back', async () => {
    const fixture = await createFixture()
    await fixture.converger.converge(snapshot(share('a')))
    const configured = fixture.syncthing.config.folders?.find(folder => folder.id === 'share-a')
    expect(configured).toBeDefined()
    if (configured === undefined) throw new Error('fixture share folder is missing')
    const before = structuredClone(configured)
    const bridgeStarts = fixture.bridgeStarts

    const result = await fixture.converger.converge(
      snapshot(share('a', { paused: true, generation: 'b'.repeat(64) })),
    )

    expect(result.reports).toEqual([{ shareId: 'a', generation: 'b'.repeat(64), state: 'paused' }])
    expect(fixture.syncthing.config.folders?.find(folder => folder.id === 'share-a')).toEqual({
      ...before,
      paused: true,
    })
    expect(fixture.bridgeStarts).toBe(bridgeStarts)
    expect(fixture.accepts.get('accept-a')).toBeDefined()
  })

  test('does not report paused when Syncthing read-back lacks the requested pause', async () => {
    const fixture = await createFixture()
    await fixture.converger.converge(snapshot(share('a')))
    fixture.syncthing.dropPausedOnNextWrite = true

    const result = await fixture.converger.converge(
      snapshot(share('a', { paused: true, generation: 'b'.repeat(64) })),
    )

    expect(result.reports).toEqual([
      {
        shareId: 'a',
        generation: 'b'.repeat(64),
        state: 'error',
        errorCode: 'syncthing_config_readback_mismatch',
      },
    ])
  })

  test('two paused configs transfer nothing and resume bidirectional flow', async () => {
    const origin = await createFixture()
    const recipient = await createFixture()
    const pausedGeneration = 'b'.repeat(64)
    await Promise.all([
      origin.converger.converge(
        snapshot(share('a', { role: 'origin', paused: true, generation: pausedGeneration })),
      ),
      recipient.converger.converge(
        snapshot(share('a', { role: 'recipient', paused: true, generation: pausedGeneration })),
      ),
    ])
    const originRoot = join(origin.driveDir, 'projects/a')
    const recipientRoot = join(recipient.driveDir, 'projects/a')
    await writeFile(join(originRoot, 'from-origin.txt'), 'origin edit')
    await writeFile(join(recipientRoot, 'from-recipient.txt'), 'recipient edit')

    expect(await simulateBidirectionalTransfer(origin, recipient, 'a')).toBe(0)
    await expect(readFile(join(recipientRoot, 'from-origin.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(originRoot, 'from-recipient.txt'), 'utf8')).rejects.toThrow()

    const resumedGeneration = 'c'.repeat(64)
    const [originResult, recipientResult] = await Promise.all([
      origin.converger.converge(
        snapshot(share('a', { role: 'origin', generation: resumedGeneration })),
      ),
      recipient.converger.converge(
        snapshot(share('a', { role: 'recipient', generation: resumedGeneration })),
      ),
    ])
    expect(originResult.reports).toEqual([
      { shareId: 'a', generation: resumedGeneration, state: 'ready' },
    ])
    expect(recipientResult.reports).toEqual([
      { shareId: 'a', generation: resumedGeneration, state: 'ready' },
    ])
    expect(await simulateBidirectionalTransfer(origin, recipient, 'a')).toBe(2)
    expect(await readFile(join(recipientRoot, 'from-origin.txt'), 'utf8')).toBe('origin edit')
    expect(await readFile(join(originRoot, 'from-recipient.txt'), 'utf8')).toBe('recipient edit')
  })

  test('reports one share error without blocking healthy shares', async () => {
    const fixture = await createFixture({
      prepareFolder: async desired => {
        if (desired.shareId === 'bad') throw new Error('fixture mount failure')
        return join(fixtureRootPlaceholder, desired.folder.path)
      },
    })
    const result = await fixture.converger.converge(
      snapshot(share('good'), share('bad', { path: 'bad' })),
    )

    expect(result.reports).toEqual([
      expect.objectContaining({ shareId: 'bad', state: 'error', errorCode: 'mount_failed' }),
      expect.objectContaining({ shareId: 'good', state: 'ready' }),
    ])
    expect(fixture.syncthing.config.folders?.map(folder => folder.id)).toContain('share-good')
    expect(fixture.syncthing.config.folders?.map(folder => folder.id)).not.toContain('share-bad')
  })

  test('rebuilds process-local accepts and bridges after restart', async () => {
    const fixture = await createFixture()
    const desired = snapshot(share('a'))
    await fixture.converger.converge(desired)

    const restartedAccepts = createTunnelAcceptRegistry({ now: () => 100 })
    const restartedBridges = new SyncBridgeRegistry({
      start: async () => {
        fixture.bridgeStarts += 1
        return { host: '127.0.0.1', port: 24_000, close: async () => undefined }
      },
    })
    const restarted = createShareConverger({
      driveDir: fixture.driveDir,
      stateDir: fixture.stateDir,
      fetch: fixture.syncthing.fetch,
      syncthingApiKey: 'test-key',
      accepts: restartedAccepts,
      bridges: restartedBridges,
    })
    await restarted.converge(desired)

    expect(restartedAccepts.get('accept-a')).toBeDefined()
    expect(fixture.bridgeStarts).toBe(2)
  })

  test('keeps realization reports until the exact delivered state is acknowledged', async () => {
    const fixture = await createFixture()
    const desired = snapshot(share('a'))
    await fixture.converger.converge(desired)
    expect(fixture.converger.reports()).toEqual([
      expect.objectContaining({ shareId: 'a', state: 'ready' }),
    ])

    fixture.converger.acknowledge([{ shareId: 'a', generation: 'wrong', state: 'ready' }])
    expect(fixture.converger.reports()).toHaveLength(1)
    fixture.converger.acknowledge(fixture.converger.reports())
    expect(fixture.converger.reports()).toEqual([])
  })

  test('rejects nested desired roots without applying either share', async () => {
    const fixture = await createFixture()
    const result = await fixture.converger.converge(
      snapshot(share('outer', { path: 'shared' }), share('inner', { path: 'shared/nested' })),
    )

    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'inner',
        state: 'error',
        errorCode: 'nested_share_path',
      }),
      expect.objectContaining({
        shareId: 'outer',
        state: 'error',
        errorCode: 'nested_share_path',
      }),
    ])
    expect(fixture.syncthing.config.folders?.map(folder => folder.id)).toEqual([MIRROR_FOLDER_ID])
  })

  test('rejects two desired shares at the same root', async () => {
    const fixture = await createFixture()
    const result = await fixture.converger.converge(
      snapshot(share('left', { path: 'shared' }), share('right', { path: 'shared' })),
    )

    expect(result.reports).toEqual([
      expect.objectContaining({ shareId: 'left', errorCode: 'nested_share_path' }),
      expect.objectContaining({ shareId: 'right', errorCode: 'nested_share_path' }),
    ])
    expect(fixture.syncthing.config.folders?.map(folder => folder.id)).toEqual([MIRROR_FOLDER_ID])
  })

  test('does not recreate a missing root for an already configured share', async () => {
    const fixture = await createFixture()
    const desired = snapshot(share('moving', { path: 'shared/old' }))
    await fixture.converger.converge(desired)
    const oldRoot = join(fixture.driveDir, 'shared/old')
    await rm(oldRoot, { recursive: true })

    const result = await fixture.converger.converge(desired)

    await expect(stat(oldRoot)).rejects.toThrow()
    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'mount_failed',
      }),
    ])
  })

  test('stops Syncthing before relocating a live share and reports ready only after rescan', async () => {
    const events: string[] = []
    let stateDir = ''
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: {
        oldPathHasSyncthingMarker: async () => false,
        stop: async () => {
          events.push('stop')
        },
        remove: async () => {
          throw new Error('active relocation must not remove its folder')
        },
        repath: async (folderId, path) => {
          const mount = (await readMounts(stateDir)).find(candidate => candidate.id === folderId)
          events.push(`repath:${mount?.path}:${path}`)
        },
        start: async () => {
          events.push('start')
        },
        rescan: async folderId => {
          events.push(`rescan:${folderId}`)
        },
      },
    })
    stateDir = fixture.stateDir
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    events.length = 0

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual([
      'stop',
      `repath:shared/new:${join(fixtureRootPlaceholder, 'shared/new')}`,
      'start',
      'rescan:share-moving',
    ])
    expect(result.reports).toEqual([expect.objectContaining({ shareId: 'moving', state: 'ready' })])

    events.length = 0
    const idle = await fixture.converger.converge(snapshot(share('moving', { path: 'shared/new' })))
    expect(events).toEqual([])
    expect(idle.changes).toBe(0)
  })

  test('aborts relocation when the old root reappears with its Syncthing marker', async () => {
    const events: string[] = []
    const control: RelocationControl = {}
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: recordingRelocation(events, control),
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    events.length = 0
    control.oldPathHasSyncthingMarker = true

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual(['stop', 'remove', 'start'])
    expect(await readMounts(fixture.stateDir)).toEqual([
      expect.objectContaining({ id: 'share-moving', path: 'shared/old' }),
    ])
    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'relocation_old_path_reappeared',
      }),
    ])
  })

  test('restarts Syncthing and reports an error when the old-root guard cannot be read', async () => {
    const events: string[] = []
    const control: RelocationControl = {}
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: recordingRelocation(events, control),
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    events.length = 0
    control.fail = 'guard'

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual(['stop', 'remove', 'start'])
    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'relocation_guard_failed',
      }),
    ])
  })

  test('recreates a quarantined folder before rescan once the old-root hazard clears', async () => {
    const events: string[] = []
    let markerPresent = false
    let fixture: Awaited<ReturnType<typeof createFixture>>
    fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: {
        async oldPathHasSyncthingMarker(path) {
          events.push(`guard:${path}`)
          return markerPresent
        },
        async stop() {
          events.push('stop')
        },
        async remove(folderId) {
          events.push('remove')
          fixture.syncthing.config.folders = fixture.syncthing.config.folders?.filter(
            folder => folder.id !== folderId,
          )
        },
        async repath() {
          events.push('repath')
        },
        async start() {
          events.push('start')
        },
        async rescan(folderId) {
          events.push('rescan')
          const folder = fixture.syncthing.config.folders?.find(
            candidate => candidate.id === folderId,
          )
          if (folder?.path !== join(fixtureRootPlaceholder, 'shared/new')) {
            throw new Error('folder was not recreated before rescan')
          }
        },
      },
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    markerPresent = true
    events.length = 0

    const blocked = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )
    expect(events).toEqual(['stop', 'guard:shared/old', 'remove', 'start'])
    expect(blocked.reports).toEqual([
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'relocation_old_path_reappeared',
      }),
    ])
    expect(fixture.syncthing.config.folders?.map(folder => folder.id)).not.toContain('share-moving')

    markerPresent = false
    events.length = 0
    const recovered = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual(['stop', 'guard:shared/old', 'repath', 'start', 'rescan'])
    expect(recovered.reports).toEqual([
      expect.objectContaining({ shareId: 'moving', state: 'ready' }),
    ])
    expect(await readRelocationJournal(fixture.stateDir)).toEqual([])
  })

  test('reports a recoverable error when stopping Syncthing for relocation fails', async () => {
    const events: string[] = []
    const control: RelocationControl = {}
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: recordingRelocation(events, control),
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    events.length = 0
    control.fail = 'stop'

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual(['stop'])
    expect(await readMounts(fixture.stateDir)).toEqual([
      expect.objectContaining({ id: 'share-moving', path: 'shared/old' }),
    ])
    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'relocation_stop_failed',
      }),
    ])
  })

  test('restarts Syncthing and keeps the old mount when relocation persistence fails', async () => {
    const events: string[] = []
    let failPersist = false
    const control: RelocationControl = {}
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      persistMounts: async (stateDir, mounts) => {
        if (failPersist) throw new Error('mount store failed')
        await writeMounts(stateDir, mounts)
      },
      relocation: recordingRelocation(events, control),
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    events.length = 0
    failPersist = true

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual(['stop', 'start'])
    expect(await readMounts(fixture.stateDir)).toEqual([
      expect.objectContaining({ id: 'share-moving', path: 'shared/old' }),
    ])
    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'relocation_mount_store_failed',
      }),
    ])
  })

  test('rolls back the mount store when Syncthing repath fails', async () => {
    const events: string[] = []
    const control: RelocationControl = {}
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: recordingRelocation(events, control),
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    events.length = 0
    control.fail = 'repath'

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual(['stop', 'repath', 'start'])
    expect(await readMounts(fixture.stateDir)).toEqual([
      expect.objectContaining({ id: 'share-moving', path: 'shared/old' }),
    ])
    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'relocation_repath_failed',
      }),
    ])
  })

  test('resumes a persisted relocation after mount rollback is interrupted', async () => {
    const events: string[] = []
    const control: RelocationControl = {}
    let interruptRollback = false
    let relocationWrites = 0
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      persistMounts: async (stateDir, mounts) => {
        if (interruptRollback) {
          relocationWrites += 1
          if (relocationWrites === 2) throw new Error('rollback interrupted')
        }
        await writeMounts(stateDir, mounts)
      },
      relocation: recordingRelocation(events, control),
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    events.length = 0
    interruptRollback = true
    control.fail = 'repath'

    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/new' })))
    expect(await readMounts(fixture.stateDir)).toEqual([
      expect.objectContaining({ id: 'share-moving', path: 'shared/new' }),
    ])

    const restartedEvents: string[] = []
    const restarted = createShareConverger({
      driveDir: fixture.driveDir,
      stateDir: fixture.stateDir,
      fetch: fixture.syncthing.fetch,
      syncthingApiKey: 'test-key',
      accepts: fixture.accepts,
      bridges: fixture.bridges,
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: recordingRelocation(restartedEvents, {}),
    })
    const result = await restarted.converge(snapshot(share('moving', { path: 'shared/new' })))

    expect(restartedEvents).toEqual(['stop', 'repath', 'start', 'rescan'])
    expect(result.reports).toEqual([expect.objectContaining({ shareId: 'moving', state: 'ready' })])
  })

  test('recovers Syncthing and removes an obsolete journaled folder before pruning it', async () => {
    const events: string[] = []
    let fixture: Awaited<ReturnType<typeof createFixture>>
    fixture = await createFixture({
      relocation: {
        async oldPathHasSyncthingMarker() {
          throw new Error('obsolete relocation must not inspect the old root')
        },
        async stop() {
          events.push('stop')
        },
        async remove(folderId) {
          events.push(`remove:${folderId}`)
        },
        async repath() {
          throw new Error('obsolete relocation must not repath')
        },
        async start() {
          events.push('start')
          fixture.syncthing.unavailable = false
        },
        async rescan() {
          throw new Error('obsolete relocation must not rescan')
        },
      },
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    await writeRelocationJournal(fixture.stateDir, {
      shareId: 'moving',
      folderId: 'share-moving',
      fromPath: 'shared/old',
      toPath: 'shared/new',
    })
    fixture.syncthing.unavailable = true
    events.length = 0

    const result = await fixture.converger.converge(snapshot())

    expect(result.reports).toEqual([])
    expect(events).toEqual(['stop', 'remove:share-moving', 'start'])
    expect(fixture.syncthing.config.folders?.map(folder => folder.id)).not.toContain('share-moving')
    expect(await readRelocationJournal(fixture.stateDir)).toEqual([])
  })

  test('replays a pending relocation when the mount-store row was lost', async () => {
    const events: string[] = []
    let fixture: Awaited<ReturnType<typeof createFixture>>
    fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: {
        async oldPathHasSyncthingMarker(path) {
          events.push(`guard:${path}`)
          return false
        },
        async stop() {
          events.push('stop')
        },
        async remove() {
          throw new Error('active relocation must not remove its folder')
        },
        async repath() {
          events.push('repath')
        },
        async start() {
          events.push('start')
          fixture.syncthing.unavailable = false
        },
        async rescan() {
          events.push('rescan')
        },
      },
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    await writeRelocationJournal(fixture.stateDir, {
      shareId: 'moving',
      folderId: 'share-moving',
      fromPath: 'shared/old',
      toPath: 'shared/new',
    })
    await writeMounts(fixture.stateDir, [])
    fixture.syncthing.unavailable = true
    events.length = 0

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual(['stop', 'guard:shared/old', 'repath', 'start', 'rescan'])
    expect(result.reports).toEqual([expect.objectContaining({ shareId: 'moving', state: 'ready' })])
    expect(await readMounts(fixture.stateDir)).toEqual([
      expect.objectContaining({ id: 'share-moving', path: 'shared/new' }),
    ])
    expect(await readRelocationJournal(fixture.stateDir)).toEqual([])
  })

  test('cancels a pending relocation when desired state returns to its source path', async () => {
    const events: string[] = []
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: {
        async oldPathHasSyncthingMarker(path) {
          events.push(`guard:${path}`)
          return false
        },
        async stop() {
          events.push('stop')
        },
        async remove() {
          throw new Error('canceled relocation must not remove its folder')
        },
        async repath() {
          events.push('repath')
        },
        async start() {
          events.push('start')
        },
        async rescan() {
          events.push('rescan')
        },
      },
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    await writeRelocationJournal(fixture.stateDir, {
      shareId: 'moving',
      folderId: 'share-moving',
      fromPath: 'shared/old',
      toPath: 'shared/new',
    })
    await writeMounts(fixture.stateDir, [
      {
        id: 'share-moving',
        shareId: 'moving',
        path: 'shared/new',
        mode: 'write',
        role: 'origin',
        ignorePatterns: ['.git', '.duet-anchor'],
      },
    ])
    events.length = 0

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/old' })),
    )

    expect(events).toEqual(['stop', 'guard:shared/new', 'repath', 'start', 'rescan'])
    expect(result.reports).toEqual([expect.objectContaining({ shareId: 'moving', state: 'ready' })])
    expect(await readMounts(fixture.stateDir)).toEqual([
      expect.objectContaining({ id: 'share-moving', path: 'shared/old' }),
    ])
    expect(await readRelocationJournal(fixture.stateDir)).toEqual([])

    events.length = 0
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    expect(events).toEqual([])
  })

  test('rolls back the mount store when Syncthing restart fails', async () => {
    const events: string[] = []
    const control: RelocationControl = {}
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: recordingRelocation(events, control),
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    events.length = 0
    control.onFail = step => {
      if (step === 'start') fixture.syncthing.unavailable = true
    }
    control.fail = 'start'

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual(['stop', 'repath', 'start'])
    expect(await readMounts(fixture.stateDir)).toEqual([
      expect.objectContaining({ id: 'share-moving', path: 'shared/old' }),
    ])
    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'relocation_start_failed',
      }),
    ])
  })

  test('reports restart failure and skips REST even when the old-root guard also fails', async () => {
    const events: string[] = []
    const control: RelocationControl = {}
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: recordingRelocation(events, control),
    })
    await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/old' }), share('healthy')),
    )
    events.length = 0
    control.onFail = step => {
      if (step === 'start') fixture.syncthing.unavailable = true
    }
    control.fail = ['guard', 'start']

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' }), share('healthy')),
    )

    expect(events).toEqual(['stop', 'remove', 'start'])
    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'healthy',
        state: 'error',
        errorCode: 'syncthing_unavailable',
      }),
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'relocation_start_failed',
      }),
    ])
  })

  test('keeps Syncthing stopped when an unsafe folder cannot be quarantined', async () => {
    const events: string[] = []
    const control: RelocationControl = {}
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: recordingRelocation(events, control),
    })
    await fixture.converger.converge(
      snapshot(
        share('moving', { path: 'shared/old' }),
        share('second', { path: 'shared/second-old' }),
      ),
    )
    events.length = 0
    control.onFail = step => {
      if (step === 'remove') fixture.syncthing.unavailable = true
    }
    control.fail = ['guard', 'remove']

    const result = await fixture.converger.converge(
      snapshot(
        share('moving', { path: 'shared/new' }),
        share('second', { path: 'shared/second-new' }),
      ),
    )

    expect(events).toEqual(['stop', 'remove'])
    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'relocation_quarantine_failed',
      }),
      expect.objectContaining({
        shareId: 'second',
        state: 'error',
        errorCode: 'syncthing_unavailable',
      }),
    ])
  })

  test('keeps the new mount aligned and retries a failed targeted rescan', async () => {
    const events: string[] = []
    const control: RelocationControl = {}
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
      relocation: recordingRelocation(events, control),
    })
    await fixture.converger.converge(snapshot(share('moving', { path: 'shared/old' })))
    events.length = 0
    control.fail = 'rescan'

    const result = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual(['stop', 'repath', 'start', 'rescan'])
    expect(await readMounts(fixture.stateDir)).toEqual([
      expect.objectContaining({ id: 'share-moving', path: 'shared/new' }),
    ])
    expect(await readRelocationJournal(fixture.stateDir)).toEqual([
      expect.objectContaining({
        folderId: 'share-moving',
        fromPath: 'shared/old',
        toPath: 'shared/new',
      }),
    ])
    expect(result.reports).toEqual([
      expect.objectContaining({
        shareId: 'moving',
        state: 'error',
        errorCode: 'relocation_rescan_failed',
      }),
    ])

    events.length = 0
    control.fail = undefined
    const retried = await fixture.converger.converge(
      snapshot(share('moving', { path: 'shared/new' })),
    )

    expect(events).toEqual(['stop', 'repath', 'start', 'rescan'])
    expect(await readMounts(fixture.stateDir)).toEqual([
      expect.objectContaining({ id: 'share-moving', path: 'shared/new' }),
    ])
    expect(await readRelocationJournal(fixture.stateDir)).toEqual([])
    expect(retried.reports).toEqual([
      expect.objectContaining({ shareId: 'moving', state: 'ready' }),
    ])
  })

  test('detached accepts recover after an outer failure and coalesce to the latest snapshot', async () => {
    let releaseFirst: (() => void) | undefined
    const firstPreparation = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let preparations = 0
    const fixture = await createFixture({
      prepareFolder: async desired => {
        preparations += 1
        if (preparations === 1) await firstPreparation
        return join(fixtureRootPlaceholder, desired.folder.path)
      },
    })
    fixture.syncthing.failNextWrite = true

    fixture.converger.accept(snapshot(share('first')))
    await waitFor(() => preparations === 1)
    fixture.converger.accept(snapshot(share('superseded')))
    fixture.converger.accept(snapshot(share('latest')))
    releaseFirst?.()

    await waitFor(
      () =>
        fixture.converger.reports().some(report => report.shareId === 'latest') &&
        fixture.syncthing.config.folders?.some(folder => folder.id === 'share-latest') === true,
    )
    expect(fixture.syncthing.config.folders?.some(folder => folder.id === 'share-first')).toBe(
      false,
    )
    expect(fixture.syncthing.config.folders?.some(folder => folder.id === 'share-superseded')).toBe(
      false,
    )
    expect(fixture.converger.reports()).toEqual([
      expect.objectContaining({ shareId: 'latest', state: 'ready' }),
    ])
  })

  test('drains realization reports in rail-sized batches', async () => {
    const fixture = await createFixture({
      prepareFolder: async desired => join(fixtureRootPlaceholder, desired.folder.path),
    })
    await fixture.converger.converge(
      snapshot(
        ...Array.from({ length: MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE + 1 }, (_, index) =>
          share(`batch-${String(index).padStart(3, '0')}`),
        ),
      ),
    )

    const first = fixture.converger.reports()
    expect(first).toHaveLength(MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE)
    fixture.converger.acknowledge(first)
    await fixture.converger.converge(
      snapshot(
        ...Array.from({ length: MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE + 1 }, (_, index) =>
          share(`batch-${String(index).padStart(3, '0')}`),
        ),
      ),
    )
    expect(fixture.converger.reports()).toEqual([
      expect.objectContaining({
        shareId: `batch-${String(MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE).padStart(3, '0')}`,
        state: 'ready',
      }),
    ])
  })
})

const fixtureRootPlaceholder = '/tmp/share-converger-fixture'

type RelocationStep = 'guard' | 'stop' | 'remove' | 'repath' | 'start' | 'rescan'

interface RelocationControl {
  fail?: RelocationStep | RelocationStep[]
  oldPathHasSyncthingMarker?: boolean
  onFail?: (step: RelocationStep) => void
}

function recordingRelocation(
  events: string[],
  control: RelocationControl,
): ShareRelocationOperations {
  function failAt(step: RelocationStep): void {
    if (control.fail === step || (Array.isArray(control.fail) && control.fail.includes(step))) {
      control.onFail?.(step)
      throw new Error(`${step} failed`)
    }
  }
  return {
    async oldPathHasSyncthingMarker() {
      failAt('guard')
      return control.oldPathHasSyncthingMarker ?? false
    },
    async stop() {
      events.push('stop')
      failAt('stop')
    },
    async remove() {
      events.push('remove')
      failAt('remove')
    },
    async repath() {
      events.push('repath')
      failAt('repath')
    },
    async start() {
      events.push('start')
      failAt('start')
    },
    async rescan() {
      events.push('rescan')
      failAt('rescan')
    },
  }
}

async function writeRelocationJournal(
  stateDir: string,
  ...entries: Array<{
    shareId: string
    folderId: string
    fromPath: string
    toPath: string
  }>
): Promise<void> {
  await writeFile(
    join(stateDir, 'sync-share-relocations.json'),
    `${JSON.stringify(entries, null, 2)}\n`,
  )
}

async function readRelocationJournal(stateDir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(stateDir, 'sync-share-relocations.json'), 'utf8'))
}

async function createFixture(
  overrides: {
    prepareFolder?: Parameters<typeof createShareConverger>[0]['prepareFolder']
    persistMounts?: Parameters<typeof createShareConverger>[0]['persistMounts']
    relocation?: Parameters<typeof createShareConverger>[0]['relocation']
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'share-converger-'))
  roots.push(root)
  const driveDir = join(root, 'drive')
  const stateDir = join(root, 'state')
  await writeMirrorDevices(stateDir, [
    {
      machineId: 'mirror-a',
      syncthingDeviceId: 'MIRROR-DEVICE',
      registeredAt: 1,
    },
  ])
  const syncthing = fakeSyncthing({
    devices: [{ deviceID: 'MIRROR-DEVICE', addresses: ['dynamic'] }],
    folders: [
      {
        id: MIRROR_FOLDER_ID,
        path: driveDir,
        type: 'sendreceive',
        devices: [{ deviceID: 'MIRROR-DEVICE' }],
      },
    ],
  })
  let bridgeStarts = 0
  let bridgeCloses = 0
  const accepts = createTunnelAcceptRegistry({ now: () => 100 })
  const bridges = new SyncBridgeRegistry({
    start: async () => {
      bridgeStarts += 1
      return {
        host: '127.0.0.1',
        port: 23_000,
        close: async () => {
          bridgeCloses += 1
        },
      }
    },
  })
  const fixture = {
    driveDir,
    stateDir,
    syncthing,
    accepts,
    bridges,
    get bridgeStarts() {
      return bridgeStarts
    },
    set bridgeStarts(value: number) {
      bridgeStarts = value
    },
    get bridgeCloses() {
      return bridgeCloses
    },
    converger: createShareConverger({
      driveDir,
      stateDir,
      fetch: syncthing.fetch,
      syncthingApiKey: 'test-key',
      accepts,
      bridges,
      ...overrides,
    }),
  }
  return fixture
}

function snapshot(...shares: VmDesiredShareSync['shares']): VmDesiredShareSync {
  return { shares }
}

function share(
  id: string,
  overrides: {
    peerDeviceId?: string
    role?: 'origin' | 'recipient'
    mode?: 'read' | 'write'
    path?: string
    tunnelToken?: string
    tokenDigest?: string
    expiresAt?: number
    paused?: boolean
    generation?: string
  } = {},
): VmDesiredShareSync['shares'][number] {
  const role = overrides.role ?? 'origin'
  const path = overrides.path ?? `projects/${id}`
  return {
    shareId: id,
    generation: overrides.generation ?? 'a'.repeat(64),
    folder: {
      id: `share-${id}`,
      path,
      mode: overrides.mode ?? 'write',
      role,
      peerDeviceId: overrides.peerDeviceId ?? `PEER-${id.toUpperCase()}`,
      ignorePatterns: ['.git', '.duet-anchor'],
      paused: overrides.paused ?? false,
    },
    ...(role === 'recipient' ? { mount: { path } } : {}),
    accept: {
      acceptId: `accept-${id}`,
      targetPort: 22_000,
      tokenDigest: overrides.tokenDigest ?? 'a'.repeat(64),
      expiresAt: overrides.expiresAt ?? 2_000,
    },
    bridge: {
      peerDeviceId: overrides.peerDeviceId ?? `PEER-${id.toUpperCase()}`,
      peerUrl: `wss://peer.example/v1/tunnel/accept/out-${id}`,
      tunnelToken: overrides.tunnelToken ?? `token-${id}`,
      acceptId: `out-${id}`,
    },
  }
}

function fakeSyncthing(initial: SyncthingConfig) {
  const state = {
    config: structuredClone(initial),
    writes: 0,
    failNextWrite: false,
    unavailable: false,
    dropPausedOnNextWrite: false,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      if (state.unavailable) throw new Error('fixture Syncthing unavailable')
      const request = new Request(input, init)
      if (new URL(request.url).pathname !== '/rest/config') {
        return Response.json({ error: 'not_found' }, { status: 404 })
      }
      if (request.method === 'GET') return Response.json(state.config)
      if (state.failNextWrite) {
        state.failNextWrite = false
        throw new Error('fixture Syncthing write failure')
      }
      state.config = JSON.parse(await request.text()) as SyncthingConfig
      if (state.dropPausedOnNextWrite) {
        state.dropPausedOnNextWrite = false
        for (const folder of state.config.folders ?? []) delete folder.paused
      }
      state.writes += 1
      return Response.json({ ok: true })
    },
  }
  return state
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await Bun.sleep(5)
  }
}

async function simulateBidirectionalTransfer(
  origin: Awaited<ReturnType<typeof createFixture>>,
  recipient: Awaited<ReturnType<typeof createFixture>>,
  shareId: string,
): Promise<number> {
  const originFolder = origin.syncthing.config.folders?.find(
    folder => folder.id === `share-${shareId}`,
  )
  const recipientFolder = recipient.syncthing.config.folders?.find(
    folder => folder.id === `share-${shareId}`,
  )
  if (originFolder?.paused !== false || recipientFolder?.paused !== false) return 0
  const originRoot = join(origin.driveDir, `projects/${shareId}`)
  const recipientRoot = join(recipient.driveDir, `projects/${shareId}`)
  await writeFile(
    join(recipientRoot, 'from-origin.txt'),
    await readFile(join(originRoot, 'from-origin.txt')),
  )
  await writeFile(
    join(originRoot, 'from-recipient.txt'),
    await readFile(join(recipientRoot, 'from-recipient.txt')),
  )
  return 2
}
