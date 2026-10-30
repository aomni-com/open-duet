import { describe, expect, test } from 'bun:test'
import { join, relative } from 'node:path'

import {
  VmSyncRequestSchema,
  VmRegisterResponseSchema,
  RUNTIME_RELEASE_ARTIFACT_NAMES,
  type GatewayTrainJobReport,
  type VmRegisterResponse,
  type VmSyncResponse,
} from '@repo/contract'

import { createVmSyncClient } from './sync-client'

const SYNCTHING_DEVICE_ID = 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'

describe('VM sync client', () => {
  test('registration fallback retains its committed token without applying a nonauthoritative snapshot', async () => {
    let token: string | null = null
    const accepted: VmSyncResponse[] = []
    const clientToken = async () => token
    const client = createVmSyncClient({
      config: { apiUrl: 'https://ctl.test', fetch: async () => Response.json(syncResponse()) },
      sink: {
        accept: async snapshot => void accepted.push(snapshot),
        acceptRuntimeRelease: async () => {},
      },
      getVmToken: clientToken,
      setVmToken: value => {
        token = value
      },
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      reportedVersions: async () => ({ runtime: '1.2.3', image: 'original-image' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () =>
        VmRegisterResponseSchema.parse({
          vmToken: 'committed-token',
          syncIntervalSeconds: 5,
          sync: { pollAfterMs: 5000, anchors: [], updates: { paused: true } },
        }),
    })
    await client.syncOnce()
    expect(await clientToken()).toBe('committed-token')
    expect(accepted).toEqual([])
    await client.syncOnce()
    expect(accepted).toEqual([syncResponse()])
  })
  test('a refresh queued behind an old snapshot wins, and a failed sync does not block the next one', async () => {
    let completeOld!: () => void
    const oldResponse = new Promise<void>(resolve => {
      completeOld = resolve
    })
    const accepted: number[] = []
    let requests = 0
    let fail = false
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test',
        fetch: async () => {
          const request = ++requests
          if (request === 1) await oldResponse
          if (fail) return new Response('unavailable', { status: 503 })
          return Response.json({ ...syncResponse(), pollAfterMs: request * 1_000 })
        },
      },
      sink: {
        accept: async payload => {
          accepted.push(payload.pollAfterMs)
        },
        acceptRuntimeRelease: async () => undefined,
      },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })
    const old = client.syncOnce()
    await waitFor(() => requests === 1)
    const refresh = client.syncOnce()
    await new Promise(resolve => setTimeout(resolve, 10))
    completeOld()
    await Promise.all([old, refresh])
    expect(accepted).toEqual([1_000, 2_000])
    fail = true
    await expect(client.syncOnce()).rejects.toThrow('sync failed with HTTP 503')
    fail = false
    await client.syncOnce()
    expect(accepted.at(-1)).toBe(4_000)
  })

  test('carries train reports and acknowledges the accepted outbox generations', async () => {
    const report: GatewayTrainJobReport = {
      generation: 'train-1:2',
      jobId: 'train-1',
      creatorUserId: 'user-1',
      state: 'running',
      phase: 'training',
      createdAt: 1,
      updatedAt: 2,
      startedAt: 1,
    }
    let outbox = [report]
    let posted: unknown
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test',
        fetch: async (_input, init) => {
          posted = JSON.parse(String(init?.body))
          return Response.json({
            ...syncResponse(),
            acceptedTrainReportGenerations: [report.generation],
          })
        },
      },
      sink: { accept: async () => undefined, acceptRuntimeRelease: async () => undefined },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: {
        reports: () => outbox,
        acknowledge: generations => {
          outbox = outbox.filter(item => !generations.includes(item.generation))
        },
      },
      ...emptyShareSyncObservations(),
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })

    await client.syncOnce()

    expect(posted).toMatchObject({ trainReports: [report] })
    expect(outbox).toEqual([])
  })

  test('sends the contract request and accepts one valid response exactly once', async () => {
    const accepted: VmSyncResponse[] = []
    const requests: Request[] = []
    const response = syncResponse()
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test/',
        workspaceHint: 'workspace-1',
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init)
          requests.push(request)
          return Response.json(response)
        },
      },
      sink: {
        accept: async payload => void accepted.push(payload),
        acceptRuntimeRelease: async () => undefined,
      },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      reportedVersions: async () => ({
        runtime: '1.2.3',
        image: '4.5.6',
      }),
      needsModelCredentials: () => true,
      needsAppCredentials: () => ['app-a'],
      registerOnce: async () => registration(response),
    })

    await client.syncOnce()

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://ctl.test/v1/vm/sync')
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer vm-token')
    expect(VmSyncRequestSchema.parse(await requests[0]!.json())).toEqual({
      workspaceHint: 'workspace-1',
      trainReports: [],
      needsModelCredentials: true,
      needsAppCredentials: ['app-a'],
      versions: {
        runtime: '1.2.3',
        image: '4.5.6',
      },
    })
    expect(accepted).toEqual([response])
  })

  test('memoizes the Syncthing device id after success and retries while unavailable', async () => {
    const posted: unknown[] = []
    let reads = 0
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test',
        fetch: async (_input, init) => {
          posted.push(JSON.parse(String(init?.body)))
          return Response.json(syncResponse())
        },
      },
      sink: { accept: async () => undefined, acceptRuntimeRelease: async () => undefined },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      syncthingDeviceId: {
        read: async () => {
          reads += 1
          if (reads === 1) throw new Error('Syncthing unavailable')
          return SYNCTHING_DEVICE_ID
        },
      },
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })

    await client.syncOnce()
    await client.syncOnce()
    await client.syncOnce()

    expect(posted).toEqual([
      expect.not.objectContaining({ syncthingDeviceId: expect.anything() }),
      expect.objectContaining({ syncthingDeviceId: SYNCTHING_DEVICE_ID }),
      expect.objectContaining({ syncthingDeviceId: SYNCTHING_DEVICE_ID }),
    ])
    expect(reads).toBe(2)
  })

  test('retains share realization reports after failed delivery and acknowledges a valid response', async () => {
    const report = {
      shareId: 'share-1',
      generation: 'generation-1',
      state: 'ready' as const,
    }
    let outbox = [report]
    const posted: unknown[] = []
    let attempts = 0
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test',
        fetch: async (_input, init) => {
          attempts += 1
          posted.push(JSON.parse(String(init?.body)))
          return attempts === 1
            ? new Response('try again', { status: 503 })
            : Response.json({ ...syncResponse(), futureSection: { enabled: true } })
        },
      },
      sink: { accept: async () => undefined, acceptRuntimeRelease: async () => undefined },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      shareSyncReports: {
        reports: () => outbox,
        acknowledge: reports => {
          outbox = outbox.filter(candidate => !reports.includes(candidate))
        },
      },
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })

    await expect(client.syncOnce()).rejects.toThrow('sync failed with HTTP 503')
    expect(outbox).toEqual([report])
    await client.syncOnce()

    expect(posted).toEqual([
      expect.objectContaining({ shareSyncReports: [report] }),
      expect.objectContaining({ shareSyncReports: [report] }),
    ])
    expect(outbox).toEqual([])
  })

  test('retains official-agent pull reports after failed delivery and acknowledges a valid response', async () => {
    const report = {
      subscriptionId: 'subscription-1',
      state: 'active' as const,
      appliedEtag: '"tree-1"',
      lastAppliedAt: 123,
    }
    let outbox = [report]
    const posted: unknown[] = []
    let attempts = 0
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test',
        fetch: async (_input, init) => {
          attempts += 1
          posted.push(JSON.parse(String(init?.body)))
          return attempts === 1
            ? new Response('try again', { status: 503 })
            : Response.json(syncResponse())
        },
      },
      sink: { accept: async () => undefined, acceptRuntimeRelease: async () => undefined },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      marketplacePullReports: {
        reports: () => outbox,
        acknowledge: reports => {
          outbox = outbox.filter(candidate => !reports.includes(candidate))
        },
      },
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })

    await expect(client.syncOnce()).rejects.toThrow('sync failed with HTTP 503')
    expect(outbox).toEqual([report])
    await client.syncOnce()

    expect(posted).toEqual([
      expect.objectContaining({ marketplacePullReports: [report] }),
      expect.objectContaining({ marketplacePullReports: [report] }),
    ])
    expect(outbox).toEqual([])
  })

  test('retains app reconciliation reports after failed delivery and drains a valid response', async () => {
    const report = {
      slug: 'hello',
      command: 'bun run start',
      port: 41_000,
      anchorPath: 'welcome/hello-app',
      appId: 'fixture-app',
      apiScopes: [],
      status: 'reconciled' as const,
    }
    let outbox = [report]
    const posted: unknown[] = []
    let attempts = 0
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test',
        fetch: async (_input, init) => {
          attempts += 1
          posted.push(JSON.parse(String(init?.body)))
          return attempts === 1
            ? new Response('try again', { status: 503 })
            : Response.json(syncResponse())
        },
      },
      sink: { accept: async () => undefined, acceptRuntimeRelease: async () => undefined },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      appReconciliationReports: {
        reports: () => outbox,
        acknowledge: reports => {
          outbox = outbox.filter(candidate => !reports.includes(candidate))
        },
      },
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })

    await expect(client.syncOnce()).rejects.toThrow('sync failed with HTTP 503')
    expect(outbox).toEqual([report])
    await client.syncOnce()

    expect(posted).toEqual([
      expect.objectContaining({ appReconciliationReports: [report] }),
      expect.objectContaining({ appReconciliationReports: [report] }),
    ])
    expect(outbox).toEqual([])
  })

  test('backs off after an error and keeps polling', async () => {
    let attempts = 0
    const sleeps: number[] = []
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test',
        fetch: async () => {
          attempts += 1
          return attempts === 1
            ? new Response('try again', { status: 503 })
            : Response.json(syncResponse())
        },
        sleep: async ms => {
          sleeps.push(ms)
          if (sleeps.length > 1) await new Promise(() => undefined)
        },
      },
      sink: { accept: async () => undefined, acceptRuntimeRelease: async () => undefined },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })

    client.start()
    await waitFor(() => attempts === 2)

    expect(sleeps.slice(0, 2)).toEqual([5_000, 5_000])
  })

  test('accepts registration sync before the first regular sync', async () => {
    let token: string | null = null
    const order: string[] = []
    const sleepDurations: number[] = []
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test',
        fetch: async () => {
          order.push('request:sync')
          return Response.json({ ...syncResponse(), pollAfterMs: 2_000 })
        },
        sleep: async ms => {
          sleepDurations.push(ms)
          if (sleepDurations.length > 1) await new Promise(() => undefined)
        },
      },
      sink: {
        accept: async payload => void order.push(`sink:${payload.pollAfterMs}`),
        acceptRuntimeRelease: async () => undefined,
      },
      getVmToken: async () => token,
      setVmToken: value => {
        token = value
      },
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => {
        order.push('request:register')
        return registration({ ...syncResponse(), pollAfterMs: 1_000 })
      },
    })

    client.start()
    await waitFor(() => order.includes('sink:2000'))

    expect(order).toEqual(['request:register', 'sink:1000', 'request:sync', 'sink:2000'])
    expect(sleepDurations).toEqual([5_000, 2_000])
  })

  test('does not call the sink for a non-ok response', async () => {
    let accepted = 0
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test',
        fetch: async () => new Response('unauthorized', { status: 401 }),
      },
      sink: {
        accept: async () => void (accepted += 1),
        acceptRuntimeRelease: async () => undefined,
      },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })

    await expect(client.syncOnce()).rejects.toThrow('sync failed with HTTP 401')
    expect(accepted).toBe(0)
  })

  test('is the only recurring control-plane URL in gateway source', async () => {
    const sourceRoot = join(import.meta.dir, '..')
    const recurring: string[] = []
    for await (const path of new Bun.Glob('**/*.ts').scan({ cwd: sourceRoot, absolute: true })) {
      if (path.endsWith('.test.ts')) continue
      const source = await Bun.file(path).text()
      for (const match of source.matchAll(/\/v1\/vm\/(?:sync|anchors)(?!\/move-candidates)/g)) {
        recurring.push(`${relative(sourceRoot, path)}:${match[0]}`)
      }
    }

    expect(recurring).toEqual(['vm/sync-client.ts:/v1/vm/sync'])
  })

  test('applies runtimeRelease even when the full response fails to validate', async () => {
    const releases: unknown[] = []
    const accepted: VmSyncResponse[] = []
    // A response an older gateway can't understand: a known field is malformed,
    // plus a field from a future feature. The full parse must fail — but the
    // runtimeRelease is still salvaged so the gateway can roll forward.
    const brokenResponse = {
      pollAfterMs: 'later',
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true },
      futureFeature: { widget: true },
      runtimeRelease: {
        formatVersion: 1,
        version: '0.0.0+rescue',
        artifacts: RUNTIME_RELEASE_ARTIFACT_NAMES.map(name => ({
          name,
          sha256: 'a'.repeat(64),
          byteLength: 10,
          mode: name === 'duet' ? 0o755 : 0o644,
          href: `https://ctl.test/rel/${name}`,
        })),
      },
    }
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test/',
        fetch: async () => Response.json(brokenResponse),
      },
      sink: {
        accept: async payload => void accepted.push(payload),
        acceptRuntimeRelease: async descriptor => void releases.push(descriptor),
      },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })

    await expect(client.syncOnce()).rejects.toThrow()
    expect(releases).toHaveLength(1)
    expect((releases[0] as { version: string }).version).toBe('0.0.0+rescue')
    // The full accept never ran (the response was unparseable), but the release
    // was applied — the gateway will roll forward on the next restart.
    expect(accepted).toEqual([])
  })

  test('legacy directives are ignored in normal responses and malformed-response rescue', async () => {
    const accepted: VmSyncResponse[] = []
    const releases: unknown[] = []
    let broken = false
    const legacy = {
      gatewayRelease: {
        version: '0.0.0+legacy',
        artifacts: [
          { name: 'index.js', sha256: 'a'.repeat(64), href: 'https://ctl.test/rel' },
          { name: 'helper.js', sha256: 'b'.repeat(64), href: 'https://ctl.test/rel/helper' },
        ],
      },
      updates: {
        paused: false,
        agent: { package: '@duetso/agent', version: '0.3.36' },
        duetfs: { package: 'duetfs', version: '0.1.0' },
      },
    }
    const client = createVmSyncClient({
      config: {
        apiUrl: 'https://ctl.test',
        fetch: async () =>
          Response.json({
            ...syncResponse(),
            ...legacy,
            ...(broken ? { pollAfterMs: 'broken' } : {}),
          }),
      },
      sink: {
        accept: async payload => void accepted.push(payload),
        acceptRuntimeRelease: async descriptor => void releases.push(descriptor),
      },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      reportedVersions: async () => ({
        runtime: '1.2.3',
        image: 'ghcr.io/aomni-com/duet-vm@sha256:real-image-identity',
      }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })
    await client.syncOnce()
    expect(accepted).toEqual([
      { pollAfterMs: 5000, anchors: [], mirrorMachineIds: [], updates: { paused: false } },
    ])
    expect(releases).toEqual([])
    broken = true
    await expect(client.syncOnce()).rejects.toThrow()
    expect(releases).toEqual([])
    expect(accepted).toHaveLength(1)
  })

  test('does not invoke the rescue when the response carries no runtimeRelease', async () => {
    const releases: unknown[] = []
    const client = createVmSyncClient({
      config: { apiUrl: 'https://ctl.test/', fetch: async () => Response.json(syncResponse()) },
      sink: {
        accept: async () => undefined,
        acceptRuntimeRelease: async descriptor => void releases.push(descriptor),
      },
      getVmToken: async () => 'vm-token',
      setVmToken: () => undefined,
      trainReports: emptyTrainReports(),
      ...emptyShareSyncObservations(),
      reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
      needsModelCredentials: () => false,
      needsAppCredentials: () => [],
      registerOnce: async () => registration(syncResponse()),
    })

    await client.syncOnce()
    expect(releases).toEqual([])
  })
})

function syncResponse(): VmSyncResponse {
  return { pollAfterMs: 5_000, anchors: [], mirrorMachineIds: [], updates: { paused: true } }
}

function registration(sync: VmSyncResponse): VmRegisterResponse {
  return { vmToken: 'vm-token', syncIntervalSeconds: 5, sync }
}

function emptyTrainReports() {
  return { reports: () => [], acknowledge: (_generations: string[]) => undefined }
}

function emptyShareSyncObservations() {
  return {
    syncthingDeviceId: {
      read: async (): Promise<string> => {
        throw new Error('Syncthing unavailable in test')
      },
    },
    shareSyncReports: {
      reports: () => [],
      acknowledge: () => undefined,
    },
    marketplacePullReports: {
      reports: () => [],
      acknowledge: () => undefined,
    },
    appReconciliationReports: {
      reports: () => [],
      acknowledge: () => undefined,
    },
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

test('new backup work wakes an idle sync and terminal retries use their due time', async () => {
  const sleeps: number[] = []
  let backupDelay: number | undefined
  const client = createVmSyncClient({
    config: {
      apiUrl: 'https://ctl.test',
      fetch: async () => Response.json({ ...syncResponse(), pollAfterMs: 300_000 }),
      backupPollAfterMs: () => backupDelay,
      sleep: ms => {
        sleeps.push(ms)
        return new Promise(() => {})
      },
    },
    sink: { accept: async () => {}, acceptRuntimeRelease: async () => {} },
    getVmToken: async () => 'token',
    setVmToken: () => {},
    trainReports: emptyTrainReports(),
    ...emptyShareSyncObservations(),
    reportedVersions: async () => ({ runtime: '1.2.3', image: '4.5.6' }),
    needsModelCredentials: () => false,
    needsAppCredentials: () => [],
    registerOnce: async () => registration(syncResponse()),
  })
  async function observed(count: number) {
    for (let i = 0; i < 100 && sleeps.length < count; i++) await Bun.sleep(1)
    expect(sleeps).toHaveLength(count)
  }
  client.start()
  await observed(1)
  expect(sleeps[0]).toBe(300_000)
  backupDelay = 5_000
  client.wake()
  await observed(2)
  expect(sleeps[1]).toBe(5_000)
  backupDelay = 45_000
  client.wake()
  await observed(3)
  expect(sleeps[2]).toBe(45_000)
  backupDelay = undefined
  client.wake()
  await observed(4)
  expect(sleeps[3]).toBe(300_000)
})
