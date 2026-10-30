import { describe, expect, test } from 'bun:test'

import { createSyncthingConfigCoordinator, type SyncthingConfig } from './syncthing-client'

describe('Syncthing config coordinator', () => {
  test('serializes an exclusive service operation with config projections', async () => {
    const events: string[] = []
    let releaseExclusive: (() => void) | undefined
    const exclusiveMayFinish = new Promise<void>(resolve => {
      releaseExclusive = resolve
    })
    const coordinator = createSyncthingConfigCoordinator(
      { stateDir: '/unused', syncthingApiUrl: 'http://syncthing', syncthingApiKey: 'key' },
      async (_input, init) => {
        events.push(init?.method === 'PUT' ? 'write' : 'read')
        return init?.method === 'PUT'
          ? Response.json({ ok: true })
          : Response.json({ devices: [], folders: [] })
      },
    )

    const exclusive = coordinator.exclusive(async () => {
      events.push('exclusive:start')
      await exclusiveMayFinish
      events.push('exclusive:end')
    })
    const projection = coordinator.reconcile(current => current)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(events).toEqual(['exclusive:start'])
      releaseExclusive?.()

      await Promise.all([exclusive, projection])
      expect(events).toEqual(['exclusive:start', 'exclusive:end', 'read'])
    } finally {
      releaseExclusive?.()
      await Promise.allSettled([exclusive, projection])
    }
  })

  test('serializes concurrent projections so the later writer reads the first result', async () => {
    let config: SyncthingConfig = { devices: [], folders: [] }
    let releaseFirst: (() => void) | undefined
    const firstMayFinish = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const coordinator = createSyncthingConfigCoordinator(
      { stateDir: '/unused', syncthingApiUrl: 'http://syncthing', syncthingApiKey: 'key' },
      async (input, init) => {
        expect(new URL(String(input)).pathname).toBe('/rest/config')
        if (init?.method === 'PUT') {
          config = JSON.parse(String(init.body)) as SyncthingConfig
          return Response.json({ ok: true })
        }
        return Response.json(config)
      },
    )

    const first = coordinator.reconcile(async current => {
      await firstMayFinish
      current.devices = [{ deviceID: 'SHARE' }]
      return current
    })
    const second = coordinator.reconcile(current => {
      current.devices = [...(current.devices ?? []), { deviceID: 'MIRROR' }]
      return current
    })
    releaseFirst?.()

    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(config.devices).toEqual([{ deviceID: 'SHARE' }, { deviceID: 'MIRROR' }])
  })

  test('a failed projection does not poison later reconciliation', async () => {
    let config: SyncthingConfig = { devices: [] }
    const coordinator = createSyncthingConfigCoordinator(
      { stateDir: '/unused', syncthingApiUrl: 'http://syncthing', syncthingApiKey: 'key' },
      async (_input, init) => {
        if (init?.method === 'PUT') {
          config = JSON.parse(String(init.body)) as SyncthingConfig
          return Response.json({ ok: true })
        }
        return Response.json(config)
      },
    )

    await expect(
      coordinator.reconcile(() => {
        throw new Error('projection failed')
      }),
    ).rejects.toThrow('projection failed')
    await expect(
      coordinator.reconcile(current => {
        current.devices = [{ deviceID: 'RECOVERED' }]
        return current
      }),
    ).resolves.toBe(true)
    expect(config.devices).toEqual([{ deviceID: 'RECOVERED' }])
  })

  test('waits for the REST listener before the first post-restart projection', async () => {
    let reads = 0
    const coordinator = createSyncthingConfigCoordinator(
      { stateDir: '/unused', syncthingApiUrl: 'http://syncthing', syncthingApiKey: 'key' },
      async (_input, init) => {
        if (init?.method === 'PUT') return Response.json({ ok: true })
        reads += 1
        if (reads < 3) throw new Error('Connection refused')
        return Response.json({ devices: [], folders: [] })
      },
      async () => undefined,
    )

    await expect(coordinator.reconcile(current => current, { waitForReady: true })).resolves.toBe(
      false,
    )
    expect(reads).toBe(3)
  })
})
