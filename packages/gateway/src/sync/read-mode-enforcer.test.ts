import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeMounts } from './mount-store'
import { createReadModeEnforcer, enforceReadModeIndexUpdate } from './read-mode-enforcer'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('read-mode selective enforcement', () => {
  test('never repairs through a mount root symlink that escapes the drive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const outsideDir = join(root, 'outside')
    const outsideFile = join(outsideDir, 'tracked.txt')
    await mkdir(driveDir)
    await mkdir(outsideDir)
    await writeFile(outsideFile, 'outside data')
    await symlink(outsideDir, join(driveDir, 'shared'))
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])

    await enforceReadModeIndexUpdate(
      {
        stateDir,
        driveDir,
        connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
        fetch: async input => {
          const url = new URL(String(input))
          if (url.pathname === '/rest/db/file') {
            return Response.json({
              global: { name: 'tracked.txt', deleted: false, localFlags: 0 },
              local: { name: 'tracked.txt', deleted: false, localFlags: 8 },
            })
          }
          throw new Error(`unexpected destructive request: ${url}`)
        },
      },
      {
        id: 1,
        type: 'LocalIndexUpdated',
        data: { folder: 'share-read', filenames: ['tracked.txt'] },
      },
    )

    expect(await readFile(outsideFile, 'utf8')).toBe('outside data')
  })

  test('does not enforce local-index events for write-mode mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const filePath = join(mountDir, 'coauthored.txt')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-write',
        shareId: 'share-write',
        path: 'shared',
        mode: 'write',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(filePath, 'viewer edit')

    await enforceReadModeIndexUpdate(
      {
        stateDir,
        driveDir,
        connection: async () => {
          throw new Error('write mounts must not contact the enforcement REST seam')
        },
        fetch: async () => new Response('unexpected', { status: 500 }),
      },
      {
        id: 1,
        type: 'LocalIndexUpdated',
        data: { folder: 'share-write', filenames: ['coauthored.txt'] },
      },
    )

    expect(await readFile(filePath, 'utf8')).toBe('viewer edit')
  })

  test('does not enforce creator changes on an origin read folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const filePath = join(mountDir, 'creator-edit.txt')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read-origin',
        shareId: 'share-read-origin',
        path: 'shared',
        mode: 'read',
        role: 'origin',
        ignorePatterns: [],
      },
    ])
    await writeFile(filePath, 'creator edit')

    await enforceReadModeIndexUpdate(
      {
        stateDir,
        driveDir,
        connection: async () => {
          throw new Error('origin folders must not contact the enforcement REST seam')
        },
        fetch: async () => new Response('unexpected', { status: 500 }),
      },
      {
        id: 1,
        type: 'LocalIndexUpdated',
        data: { folder: 'share-read-origin', filenames: ['creator-edit.txt'] },
      },
    )

    expect(await readFile(filePath, 'utf8')).toBe('creator edit')
  })

  test('sweeps receive-only changes that predate the event cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const trackedPath = join(mountDir, 'tracked.txt')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(trackedPath, 'viewer edit before gateway restart')
    let listed = 0
    let restored = false
    const enforcer = createReadModeEnforcer({
      stateDir,
      driveDir,
      connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
      fetch: async input => {
        const url = new URL(String(input))
        if (url.pathname === '/rest/db/localchanged') {
          listed += 1
          return Response.json({ files: [{ name: 'tracked.txt' }] })
        }
        if (url.pathname === '/rest/events') return Response.json([])
        if (url.pathname === '/rest/db/file') {
          return Response.json({
            global: { name: 'tracked.txt', deleted: false, localFlags: 0 },
            local: { name: 'tracked.txt', deleted: false, localFlags: restored ? 0 : 8 },
          })
        }
        if (url.pathname === '/rest/db/scan') {
          await writeFile(trackedPath, 'creator version')
          restored = true
          return Response.json({ ok: true })
        }
        return new Response('not found', { status: 404 })
      },
    })

    enforcer.start()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await readFile(trackedPath, 'utf8').catch(() => '')) === 'creator version') break
      await Bun.sleep(1)
    }
    enforcer.stop()

    expect(await readFile(trackedPath, 'utf8')).toBe('creator version')
    expect(listed).toBe(1)
  })

  test('the enforcement loop settles one repair before consuming its queued scan events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const trackedPath = join(mountDir, 'tracked.txt')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(trackedPath, 'viewer edit')
    let eventPolls = 0
    let scans = 0
    let restored = false
    let restoreStarted: Promise<void> | undefined
    const enforcer = createReadModeEnforcer({
      stateDir,
      driveDir,
      connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
      fetch: async input => {
        const url = new URL(String(input))
        if (url.pathname === '/rest/db/localchanged') return Response.json({ files: [] })
        if (url.pathname === '/rest/events') {
          eventPolls += 1
          return Response.json(
            eventPolls === 1
              ? []
              : [
                  {
                    id: 1,
                    type: 'LocalIndexUpdated',
                    data: { folder: 'share-read', filenames: ['tracked.txt'] },
                  },
                  {
                    id: 2,
                    type: 'LocalIndexUpdated',
                    data: { folder: 'share-read', filenames: ['tracked.txt'] },
                  },
                ],
          )
        }
        if (url.pathname === '/rest/db/file') {
          return Response.json({
            global: { name: 'tracked.txt', deleted: false, localFlags: 0 },
            local: {
              name: 'tracked.txt',
              deleted: scans > 0 && !restored,
              localFlags: restored ? 0 : 8,
            },
          })
        }
        if (url.pathname === '/rest/db/scan') {
          scans += 1
          restoreStarted ??= (async () => {
            await Bun.sleep(20)
            await writeFile(trackedPath, 'creator version')
            restored = true
          })()
          return Response.json({ ok: true })
        }
        return new Response('not found', { status: 404 })
      },
      backoffMs: 0,
      sleep: async () => Bun.sleep(0),
    })

    enforcer.start()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await readFile(trackedPath, 'utf8').catch(() => '')) === 'creator version') break
      await Bun.sleep(1)
    }
    enforcer.stop()
    await restoreStarted

    expect(await readFile(trackedPath, 'utf8')).toBe('creator version')
    expect(eventPolls).toBeGreaterThanOrEqual(2)
    expect(scans).toBe(1)
    expect(
      (await readdir(mountDir)).filter(name => name.startsWith('tracked.sync-conflict-')),
    ).toHaveLength(1)
  })

  test('relearns the cursor and re-sweeps after a Syncthing poll failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const trackedPath = join(mountDir, 'tracked.txt')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(trackedPath, 'viewer edit')
    let headReads = 0
    let sweeps = 0
    let restored = false
    const enforcer = createReadModeEnforcer({
      stateDir,
      driveDir,
      connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
      fetch: async input => {
        const url = new URL(String(input))
        if (url.pathname === '/rest/db/localchanged') {
          sweeps += 1
          return Response.json({ files: [] })
        }
        if (url.pathname === '/rest/events' && url.searchParams.has('limit')) {
          headReads += 1
          return Response.json([{ id: headReads === 1 ? 10 : 1, type: 'LocalIndexUpdated' }])
        }
        if (url.pathname === '/rest/events' && url.searchParams.get('since') === '10') {
          return new Response('restarted', { status: 503 })
        }
        if (url.pathname === '/rest/events' && url.searchParams.get('since') === '1') {
          return Response.json([
            {
              id: 2,
              type: 'LocalIndexUpdated',
              data: { folder: 'share-read', filenames: ['tracked.txt'] },
            },
          ])
        }
        if (url.pathname === '/rest/events' && url.searchParams.get('since') === '2') {
          return Response.json([])
        }
        if (url.pathname === '/rest/db/file') {
          return Response.json({
            global: { name: 'tracked.txt', deleted: false, localFlags: 0 },
            local: { name: 'tracked.txt', deleted: false, localFlags: restored ? 0 : 8 },
          })
        }
        if (url.pathname === '/rest/db/scan') {
          await writeFile(trackedPath, 'creator version')
          restored = true
          return Response.json({ ok: true })
        }
        return new Response('not found', { status: 404 })
      },
      backoffMs: 0,
      sleep: async () => Bun.sleep(0),
    })

    enforcer.start()
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readFile(trackedPath, 'utf8').catch(() => '')) === 'creator version') break
      await Bun.sleep(1)
    }
    enforcer.stop()

    expect(await readFile(trackedPath, 'utf8')).toBe('creator version')
    expect(headReads).toBe(2)
    expect(sweeps).toBe(2)
  })

  test('captures the event head before sweeping so startup changes are not skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const trackedPath = join(mountDir, 'tracked.txt')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(trackedPath, 'viewer edit during startup')
    let sweepListed = false
    let restored = false
    const calls: string[] = []
    const enforcer = createReadModeEnforcer({
      stateDir,
      driveDir,
      connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
      fetch: async input => {
        const url = new URL(String(input))
        if (url.pathname === '/rest/db/localchanged') {
          calls.push('sweep')
          sweepListed = true
          return Response.json({ files: [] })
        }
        if (url.pathname === '/rest/events' && url.searchParams.has('limit')) {
          calls.push('head')
          return Response.json([{ id: sweepListed ? 6 : 5, type: 'LocalIndexUpdated' }])
        }
        if (url.pathname === '/rest/events' && url.searchParams.get('since') === '5') {
          return Response.json([
            {
              id: 6,
              type: 'LocalIndexUpdated',
              data: { folder: 'share-read', filenames: ['tracked.txt'] },
            },
          ])
        }
        if (url.pathname === '/rest/events' && url.searchParams.get('since') === '6') {
          return Response.json([])
        }
        if (url.pathname === '/rest/db/file') {
          return Response.json({
            global: { name: 'tracked.txt', deleted: false, localFlags: 0 },
            local: { name: 'tracked.txt', deleted: false, localFlags: restored ? 0 : 8 },
          })
        }
        if (url.pathname === '/rest/db/scan') {
          await writeFile(trackedPath, 'creator version')
          restored = true
          return Response.json({ ok: true })
        }
        return new Response('not found', { status: 404 })
      },
    })

    enforcer.start()
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readFile(trackedPath, 'utf8').catch(() => '')) === 'creator version') break
      await Bun.sleep(1)
    }
    enforcer.stop()

    expect(await readFile(trackedPath, 'utf8')).toBe('creator version')
    expect(calls.slice(0, 2)).toEqual(['head', 'sweep'])
  })

  test('repairs a viewer-modified creator file by removing and scanning only that path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const trackedPath = join(mountDir, 'tracked.txt')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(trackedPath, 'viewer edit')
    const scans: string[] = []
    let restored = false

    await enforceReadModeIndexUpdate(
      {
        stateDir,
        driveDir,
        connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
        fetch: async input => {
          const url = new URL(String(input))
          if (url.pathname === '/rest/db/file') {
            return Response.json({
              global: { name: 'tracked.txt', deleted: false, localFlags: 0 },
              local: { name: 'tracked.txt', deleted: false, localFlags: restored ? 0 : 8 },
            })
          }
          if (url.pathname === '/rest/db/scan') {
            scans.push(url.searchParams.get('sub') ?? '')
            await writeFile(trackedPath, 'creator version')
            restored = true
            return Response.json({ ok: true })
          }
          return new Response('not found', { status: 404 })
        },
      },
      {
        id: 1,
        type: 'LocalIndexUpdated',
        data: { folder: 'share-read', filenames: ['tracked.txt'] },
      },
    )

    expect(await readFile(trackedPath, 'utf8')).toBe('creator version')
    expect(scans).toEqual(['tracked.txt'])
    const conflict = (await readdir(mountDir)).find(name =>
      name.startsWith('tracked.sync-conflict-'),
    )
    expect(conflict).toBeDefined()
    expect(await readFile(join(mountDir, conflict!), 'utf8')).toBe('viewer edit')
  })

  test('applies a creator tombstone while preserving the viewer edit as a conflict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const trackedPath = join(mountDir, 'removed.txt')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(trackedPath, 'viewer edit')
    let scanned = false
    let settled = false

    await enforceReadModeIndexUpdate(
      {
        stateDir,
        driveDir,
        connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
        fetch: async input => {
          const url = new URL(String(input))
          if (url.pathname === '/rest/db/file') {
            return Response.json({
              global: { name: 'removed.txt', deleted: true, localFlags: 0 },
              local: {
                name: 'removed.txt',
                deleted: settled,
                localFlags: settled ? 0 : 8,
              },
            })
          }
          if (url.pathname === '/rest/db/scan') {
            scanned = true
            expect(await readFile(trackedPath, 'utf8').catch(() => null)).toBeNull()
            settled = true
            return Response.json({ ok: true })
          }
          return new Response('not found', { status: 404 })
        },
      },
      {
        id: 2,
        type: 'LocalIndexUpdated',
        data: { folder: 'share-read', filenames: ['removed.txt'] },
      },
    )

    expect(scanned).toBeTrue()
    expect(await readFile(trackedPath, 'utf8').catch(() => null)).toBeNull()
    const conflict = (await readdir(mountDir)).find(name =>
      name.startsWith('removed.sync-conflict-'),
    )
    expect(await readFile(join(mountDir, conflict!), 'utf8')).toBe('viewer edit')
  })

  test('applies a creator file-to-directory replacement without losing viewer bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const trackedPath = join(mountDir, 'replaced')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(trackedPath, 'viewer file')
    let restored = false

    await enforceReadModeIndexUpdate(
      {
        stateDir,
        driveDir,
        connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
        fetch: async input => {
          const url = new URL(String(input))
          if (url.pathname === '/rest/db/file') {
            return Response.json({
              global: {
                name: 'replaced',
                deleted: false,
                localFlags: 0,
                type: 'FILE_INFO_TYPE_DIRECTORY',
              },
              local: {
                name: 'replaced',
                deleted: false,
                localFlags: restored ? 0 : 8,
                type: restored ? 'FILE_INFO_TYPE_DIRECTORY' : 'FILE_INFO_TYPE_FILE',
              },
            })
          }
          if (url.pathname === '/rest/db/scan') {
            await mkdir(trackedPath)
            restored = true
            return Response.json({ ok: true })
          }
          return new Response('not found', { status: 404 })
        },
      },
      {
        id: 3,
        type: 'LocalIndexUpdated',
        data: { folder: 'share-read', filenames: ['replaced'] },
      },
    )

    expect((await readdir(mountDir)).some(name => name.startsWith('replaced.sync-conflict-'))).toBe(
      true,
    )
    expect(await readdir(trackedPath)).toEqual([])
  })

  test('ignores a recipient-local addition instead of feeding it to a folder revert', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const localPath = join(mountDir, 'local-only.txt')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(localPath, 'recipient local')

    await enforceReadModeIndexUpdate(
      {
        stateDir,
        driveDir,
        connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
        fetch: async input => {
          const url = new URL(String(input))
          if (url.pathname === '/rest/db/file') {
            return Response.json({
              global: { name: 'local-only.txt', deleted: false, localFlags: 8 },
              local: { name: 'local-only.txt', deleted: false, localFlags: 8 },
            })
          }
          throw new Error(`unexpected destructive request: ${url}`)
        },
      },
      {
        id: 2,
        type: 'LocalIndexUpdated',
        data: { folder: 'share-read', filenames: ['local-only.txt'] },
      },
    )

    expect(await readFile(localPath, 'utf8')).toBe('recipient local')
  })

  test('preserves a local sync-conflict copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const conflictName = 'notes.sync-conflict-20260715-082912-CREATOR.txt'
    const conflictPath = join(mountDir, conflictName)
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(conflictPath, 'viewer collision')

    await enforceReadModeIndexUpdate(
      {
        stateDir,
        driveDir,
        connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
        fetch: async input => {
          const url = new URL(String(input))
          if (url.pathname === '/rest/db/file') {
            return Response.json({
              global: { name: conflictName, deleted: false, localFlags: 8 },
              local: { name: conflictName, deleted: false, localFlags: 8 },
            })
          }
          throw new Error(`unexpected destructive request: ${url}`)
        },
      },
      {
        id: 3,
        type: 'LocalIndexUpdated',
        data: { folder: 'share-read', filenames: [conflictName] },
      },
    )

    expect(await readFile(conflictPath, 'utf8')).toBe('viewer collision')
  })

  test('repairs a viewer-deleted creator file without reverting neighboring additions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-read-enforcer-'))
    tempDirs.push(root)
    const stateDir = join(root, 'state')
    const driveDir = join(root, 'drive')
    const mountDir = join(driveDir, 'shared')
    const trackedPath = join(mountDir, 'tracked.txt')
    const localPath = join(mountDir, 'local-only.txt')
    await mkdir(mountDir, { recursive: true })
    await writeMounts(stateDir, [
      {
        id: 'share-read',
        shareId: 'share-read',
        path: 'shared',
        mode: 'read',
        role: 'recipient',
        ignorePatterns: [],
      },
    ])
    await writeFile(localPath, 'recipient local')
    const scanStates: string[] = []
    let restored = false

    await enforceReadModeIndexUpdate(
      {
        stateDir,
        driveDir,
        connection: async () => ({ base: 'http://syncthing.local', headers: {} }),
        fetch: async input => {
          const url = new URL(String(input))
          if (url.pathname === '/rest/db/file') {
            return Response.json({
              global: { name: 'tracked.txt', deleted: false, localFlags: 0 },
              local: {
                name: 'tracked.txt',
                deleted: !restored,
                localFlags: restored ? 0 : 8,
              },
            })
          }
          if (url.pathname === '/rest/db/scan') {
            const contents = await readFile(trackedPath, 'utf8').catch(() => null)
            scanStates.push(contents === null ? 'absent' : 'placeholder')
            if (contents === null) {
              await writeFile(trackedPath, 'creator version')
              restored = true
            }
            return Response.json({ ok: true })
          }
          return new Response('not found', { status: 404 })
        },
      },
      {
        id: 4,
        type: 'LocalIndexUpdated',
        data: { folder: 'share-read', filenames: ['tracked.txt'] },
      },
    )

    expect(scanStates).toEqual(['placeholder', 'absent'])
    expect(await readFile(trackedPath, 'utf8')).toBe('creator version')
    expect(await readFile(localPath, 'utf8')).toBe('recipient local')
  })
})
