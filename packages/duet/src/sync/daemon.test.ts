import { describe, expect, test } from 'bun:test'

import type { WorkspaceSummary } from '@repo/contract'

import { CliError, EXIT_CODES } from '../exit-codes.js'
import type { SyncStatusSnapshot } from './daemon-status.js'
import { createDaemon } from './daemon.js'
import type { MirrorSnapshot, StartWorkspaceMirror, WorkspaceMirrorHandle } from './mirror.js'

// The daemon is tested against a fake workspace list + fake mirror starter (no
// real Syncthing, no network). HTTP supplies the real whoami contract; the lifecycle
// logic — add, drop, retire, backoff, aggregate — is exercised here; the
// transfer/reconnect it composes is proven in slice 21's suite.

type DaemonWorkspace = Pick<WorkspaceSummary, 'slug' | 'status'>

function whoami(
  workspaces: DaemonWorkspace[],
  writable = workspaces.map(workspace => workspace.slug),
) {
  return {
    user: { id: 'user_1', email: 'user@example.com' },
    workspaces: workspaces.map(workspace => ({
      id: workspace.slug,
      slug: workspace.slug,
      name: workspace.slug,
      status: workspace.status,
      servicingStatus: 'active',
      role: writable.includes(workspace.slug) ? 'editor' : 'viewer',
      billingUserId: 'user_1',
      funding: { plan: null, active: true },
      creditRecovery: null,
      defaultTier: { effective: 'balanced' },
    })),
    scopes: writable.map(slug => `ws:${slug}:files:write`),
    versions: { api: 1 },
    internalAdmin: false,
  }
}

const CONVERGED: MirrorSnapshot = {
  connected: true,
  converged: true,
  needBytes: 0,
  remoteCompletion: 100,
  conflicts: 0,
  reposMissingRemote: [],
}

interface FakeHandle extends WorkspaceMirrorHandle {
  stops: number
  setSnapshot(snapshot: MirrorSnapshot): void
}

function makeStarter(): {
  start: StartWorkspaceMirror
  starts: string[]
  handles: Map<string, FakeHandle>
  failNext: Set<string>
} {
  const starts: string[] = []
  const handles = new Map<string, FakeHandle>()
  const failNext = new Set<string>()
  const start: StartWorkspaceMirror = async ({ slug, localDir }) => {
    starts.push(slug)
    if (failNext.has(slug)) {
      failNext.delete(slug)
      throw new Error(`VM not ready: ${slug}`)
    }
    let snapshot: MirrorSnapshot = CONVERGED
    const handle: FakeHandle = {
      slug,
      localDir,
      stops: 0,
      setSnapshot: next => (snapshot = next),
      poll: async () => snapshot,
      stop: async () => {
        handle.stops += 1
      },
    }
    handles.set(slug, handle)
    return handle
  }
  return { start, starts, handles, failNext }
}

function makeDaemon(
  starter: ReturnType<typeof makeStarter>,
  workspaces: () => DaemonWorkspace[],
  clock: { now: number },
) {
  const snapshots: SyncStatusSnapshot[] = []
  const daemon = createDaemon({
    session: {
      apiOrigin: 'https://api.example',
      api: {
        request: async path =>
          path === '/whoami'
            ? Response.json(whoami(workspaces()))
            : Response.json({
                items: [
                  {
                    machineId: 'machine_mac',
                    name: 'MacBook',
                    syncthingDeviceId: 'AAAAAAA-BBBBBBB',
                    createdAt: 1,
                    lastUsedAt: 1,
                  },
                ],
                nextCursor: null,
              }),
      },
      machineId: 'machine_mac',
      startMirror: starter.start,
    },
    home: '/home/test',
    writeSnapshot: async snapshot => void snapshots.push(snapshot),
    now: () => clock.now,
    sleep: async () => {},
    baseBackoffMs: 1_000,
  })
  return { daemon, snapshots }
}

describe('daemon reconcile', () => {
  test('starts a mirror per active workspace and lists it in the snapshot', async () => {
    const starter = makeStarter()
    const clock = { now: 1000 }
    const { daemon } = makeDaemon(
      starter,
      () => [
        { slug: 'acme', status: 'active' },
        { slug: 'studio', status: 'active' },
      ],
      clock,
    )
    await daemon.reconcileOnce()
    expect(starter.starts.sort()).toEqual(['acme', 'studio'])
    await daemon.pollOnce()
    const rows = daemon.snapshot().workspaces
    expect(rows.map(r => r.slug).sort()).toEqual(['acme', 'studio'])
    expect(rows.every(r => r.state === 'up-to-date')).toBe(true)
  })

  test('removal of this Mac stops every mirror without registering it again', async () => {
    const starter = makeStarter()
    let removed = false
    const requests: string[] = []
    const daemon = createDaemon({
      session: {
        apiOrigin: 'https://api.example',
        api: {
          request: async path => {
            requests.push(path)
            if (path === '/whoami')
              return Response.json(
                whoami([
                  { slug: 'acme', status: 'active' },
                  { slug: 'studio', status: 'active' },
                ]),
              )
            return Response.json({
              items: [
                {
                  machineId: 'machine_mac',
                  name: 'MacBook',
                  syncthingDeviceId: 'AAAAAAA-BBBBBBB',
                  createdAt: 1,
                  lastUsedAt: 1,
                  ...(removed ? { removedAt: 2 } : {}),
                },
              ],
              nextCursor: null,
            })
          },
        },
        machineId: 'machine_mac',
        startMirror: starter.start,
      },
      home: '/home/test',
      writeSnapshot: async () => {},
    })
    await daemon.reconcileOnce()
    removed = true
    await daemon.reconcileOnce()
    await daemon.reconcileOnce()
    expect(starter.handles.get('acme')!.stops).toBe(1)
    expect(starter.handles.get('studio')!.stops).toBe(1)
    expect(starter.starts).toEqual(['acme', 'studio'])
    expect(daemon.snapshot().workspaces.every(row => row.state === 'error' && !row.connected)).toBe(
      true,
    )
    expect(requests).toEqual([
      '/user/sync-machines?limit=100',
      '/whoami',
      '/user/sync-machines?limit=100',
      '/user/sync-machines?limit=100',
    ])
    removed = false // Explicit account registration reactivates the same peer.
    await daemon.reconcileOnce()
    expect(starter.starts).toEqual(['acme', 'studio', 'acme', 'studio'])
    await daemon.stopAll()
  })

  test('live whoami permissions add and detach mirrors while both memberships remain', async () => {
    const starter = makeStarter()
    let writable = ['acme']
    const daemon = createDaemon({
      session: {
        apiOrigin: 'https://api.example',
        machineId: 'machine_mac',
        startMirror: starter.start,
        api: {
          request: async path => {
            if (path.startsWith('/user/sync-machines?'))
              return Response.json({
                items: [
                  {
                    machineId: 'machine_mac',
                    name: 'Mac',
                    syncthingDeviceId: 'AAAAAAA-BBBBBBB',
                    createdAt: 1,
                    lastUsedAt: 1,
                  },
                ],
                nextCursor: null,
              })
            return Response.json(
              whoami(
                [
                  { slug: 'acme', status: 'active' },
                  { slug: 'studio', status: 'active' },
                ],
                writable,
              ),
            )
          },
        },
      },
      home: '/home/test',
      writeSnapshot: async () => {},
    })
    await daemon.reconcileOnce()
    expect(starter.starts).toEqual(['acme'])
    writable = ['acme', 'studio']
    await daemon.reconcileOnce()
    expect(starter.starts).toEqual(['acme', 'studio'])
    const acme = starter.handles.get('acme')!
    writable = ['studio']
    await daemon.reconcileOnce()
    expect(acme.stops).toBe(1)
    expect(starter.handles.get('studio')!.stops).toBe(0)
    expect(daemon.snapshot().workspaces.map(row => row.slug)).toEqual(['studio'])
    await daemon.stopAll()
  })

  test('a new membership on a later reconcile is picked up (no restart of existing)', async () => {
    const starter = makeStarter()
    const clock = { now: 1000 }
    let list: DaemonWorkspace[] = [{ slug: 'acme', status: 'active' }]
    const { daemon } = makeDaemon(starter, () => list, clock)
    await daemon.reconcileOnce()
    expect(starter.starts).toEqual(['acme'])
    list = [
      { slug: 'acme', status: 'active' },
      { slug: 'new-ws', status: 'active' },
    ]
    await daemon.reconcileOnce()
    // acme is not restarted; only the newcomer starts.
    expect(starter.starts).toEqual(['acme', 'new-ws'])
  })

  test('losing membership stops the mirror and drops it from the snapshot', async () => {
    const starter = makeStarter()
    const clock = { now: 1000 }
    let list: DaemonWorkspace[] = [{ slug: 'acme', status: 'active' }]
    const { daemon } = makeDaemon(starter, () => list, clock)
    await daemon.reconcileOnce()
    const handle = starter.handles.get('acme')!
    list = []
    await daemon.reconcileOnce()
    expect(handle.stops).toBe(1)
    expect(daemon.snapshot().workspaces).toHaveLength(0)
  })

  test('retired is surfaced but never mirrored, and never auto-un-retired', async () => {
    const starter = makeStarter()
    const clock = { now: 1000 }
    let list: DaemonWorkspace[] = [{ slug: 'acme', status: 'active' }]
    const { daemon } = makeDaemon(starter, () => list, clock)
    await daemon.reconcileOnce()
    const handle = starter.handles.get('acme')!

    // Server retires it → stop, surface as retired, do not start again.
    list = [{ slug: 'acme', status: 'retired' }]
    await daemon.reconcileOnce()
    await daemon.reconcileOnce()
    expect(handle.stops).toBe(1)
    const retired = daemon.snapshot().workspaces.find(r => r.slug === 'acme')!
    expect(retired.state).toBe('retired')
    // Only the one start ever happened — no un-retire from the daemon side.
    expect(starter.starts).toEqual(['acme'])

    // Server un-retires it (marks active again) → the daemon resumes it.
    list = [{ slug: 'acme', status: 'active' }]
    await daemon.reconcileOnce()
    expect(starter.starts).toEqual(['acme', 'acme'])
  })

  test('a workspace 404 stops its failed mirror and recovers without disabling the other workspace', async () => {
    const starter = makeStarter()
    const clock = { now: 1000 }
    const { daemon } = makeDaemon(
      starter,
      () => [
        { slug: 'acme', status: 'active' },
        { slug: 'studio', status: 'active' },
      ],
      clock,
    )
    await daemon.reconcileOnce()
    const failed = starter.handles.get('acme')!
    failed.poll = async () => {
      throw new CliError('not_found', 'VM not ready', EXIT_CODES.notFound)
    }
    await daemon.pollOnce()
    expect(failed.stops).toBe(1)
    expect(starter.handles.get('studio')!.stops).toBe(0)
    expect(daemon.snapshot().workspaces.find(row => row.slug === 'acme')?.connected).toBe(false)
    await daemon.reconcileOnce()
    expect(starter.starts).toEqual(['acme', 'studio'])
    clock.now += 1000
    await daemon.reconcileOnce()
    await daemon.pollOnce()
    expect(starter.starts).toEqual(['acme', 'studio', 'acme'])
    expect(daemon.snapshot().workspaces.every(row => row.state === 'up-to-date')).toBe(true)
    await daemon.stopAll()
  })

  test('a start failure surfaces as error and retries only after backoff', async () => {
    const starter = makeStarter()
    starter.failNext.add('acme')
    const clock = { now: 1000 }
    const { daemon } = makeDaemon(starter, () => [{ slug: 'acme', status: 'active' }], clock)
    await daemon.reconcileOnce()
    let row = daemon.snapshot().workspaces[0]!
    expect(row.state).toBe('error')
    expect(row.note).toContain('VM not ready')

    // Same instant: no retry (backoff not elapsed).
    await daemon.reconcileOnce()
    expect(starter.starts).toEqual(['acme'])

    // After the backoff window: retried, and now it succeeds.
    clock.now += 1_000
    await daemon.reconcileOnce()
    expect(starter.starts).toEqual(['acme', 'acme'])
    row = daemon.snapshot().workspaces[0]!
    expect(row.state).toBe('starting')
  })

  test('provisioning workspaces are ignored until active', async () => {
    const starter = makeStarter()
    const clock = { now: 1000 }
    const { daemon } = makeDaemon(starter, () => [{ slug: 'fresh', status: 'provisioning' }], clock)
    await daemon.reconcileOnce()
    expect(starter.starts).toHaveLength(0)
    expect(daemon.snapshot().workspaces).toHaveLength(0)
  })
})

describe('daemon status aggregation', () => {
  test('poll maps convergence to up-to-date / syncing and counts conflicts', async () => {
    const starter = makeStarter()
    const clock = { now: 1000 }
    const { daemon } = makeDaemon(starter, () => [{ slug: 'acme', status: 'active' }], clock)
    await daemon.reconcileOnce()
    const handle = starter.handles.get('acme')!

    handle.setSnapshot({
      connected: true,
      converged: false,
      needBytes: 4096,
      remoteCompletion: 55,
      conflicts: 2,
      reposMissingRemote: [],
    })
    await daemon.pollOnce()
    const row = daemon.snapshot().workspaces[0]!
    expect(row.state).toBe('syncing')
    expect(row.needBytes).toBe(4096)
    expect(row.conflicts).toBe(2)
  })

  test('a repo with no remote surfaces a nag note', async () => {
    const starter = makeStarter()
    const clock = { now: 1000 }
    const { daemon } = makeDaemon(starter, () => [{ slug: 'acme', status: 'active' }], clock)
    await daemon.reconcileOnce()
    starter.handles.get('acme')!.setSnapshot({ ...CONVERGED, reposMissingRemote: ['api'] })
    await daemon.pollOnce()
    const row = daemon.snapshot().workspaces[0]!
    expect(row.missingRemote).toBe(true)
    expect(row.note).toContain('no git remote')
  })

  test('a transient poll error surfaces without tearing the mirror down', async () => {
    const starter = makeStarter()
    const clock = { now: 1000 }
    const { daemon } = makeDaemon(starter, () => [{ slug: 'acme', status: 'active' }], clock)
    await daemon.reconcileOnce()
    const handle = starter.handles.get('acme')!
    handle.poll = async () => {
      throw new Error('syncthing restarting')
    }
    await daemon.pollOnce()
    expect(handle.stops).toBe(0)
    expect(daemon.snapshot().workspaces[0]!.state).toBe('error')
  })
})
