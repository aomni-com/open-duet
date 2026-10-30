import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConvexHttpClient } from 'convex/browser'

import type { App } from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { StagingResourceLedger } from './staging-live-resource-ledger.ts'
import {
  buildMarkerPreservingCopyDeleteCommand,
  deleteShareRoot,
  loadGatewayObservationConnection,
  registerTrackedShareApp,
  SHARE_INVITE_SUBJECT,
  waitForReplicaState,
  waitForShareMountPruned,
  waitForShareState,
} from './staging-live-shares.ts'

test('matches the deployed transactional share-invite subject', () => {
  expect(SHARE_INVITE_SUBJECT.test('Alice Example shared “field-notes” with you')).toBe(true)
  expect(SHARE_INVITE_SUBJECT.test("Alice Example shared 'field-notes' with you on Duet")).toBe(
    false,
  )
})

test('derives gateway observation credentials through the Convex HTTP provisioning seam', async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const query = await request.json() as { path: string; args: Array<{ internalKey: string; slug: string }> }
      if (query.path !== 'domains/workspaces/provisioning:gatewayConnectionBySlug' ||
          query.args[0]?.internalKey !== 'internal-key' || query.args[0]?.slug !== 'acme') {
        return Response.json({ status: 'error', errorMessage: 'wrong provisioning scope' })
      }
      return Response.json({ status: 'success', value: {
        httpsUrl: 'https://acme.example.test', vmToken: 'duet_vm_derived',
      } })
    },
  })
  try {
    await expect(loadGatewayObservationConnection({
      convex: new ConvexHttpClient(server.url.toString()),
      env: { internalKey: 'internal-key' } as never,
    }, 'acme')).resolves.toEqual({
      httpsUrl: 'https://acme.example.test', vmToken: 'duet_vm_derived',
    })
  } finally {
    server.stop(true)
  }
})

const replicaApp: App = {
  id: 'app_replica',
  workspaceId: 'workspace_recipient',
  anchorId: 'anchor_replica',
  anchorPath: 'shared/project',
  anchorState: 'active',
  command: 'bun run start',
  apiScopes: [],
  port: 41_000,
  slug: 'shared-app',
  visibility: 'folder',
  canonicalUrl: 'https://shared-app--recipient.edge-staging.duet.so',
  runtimeStatus: 'reconciled',
  sourceShareId: 'share_target',
  sourceAppId: 'app_source',
  createdByUserId: 'user_owner',
  createdAt: 1,
  updatedAt: 1,
  controls: {
    manageDomain: true,
    updateRuntime: true,
    makePublic: true,
    makePrivate: true,
    delete: true,
  },
}

async function registerCleanupRetryFixture(args: {
  ledger: StagingResourceLedger
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  sleep: (milliseconds: number) => Promise<unknown>
}): Promise<void> {
  const sourceApp: App = {
    ...replicaApp,
    id: 'app_source',
    workspaceId: 'workspace_owner',
    anchorId: 'anchor_source',
    anchorPath: 'apps/run_12345678-relocation-fixture',
    slug: 'share-relocation-12345678',
    canonicalUrl: 'https://share-relocation-12345678--owner.edge-staging.duet.so',
    sourceShareId: undefined,
    sourceAppId: undefined,
  }
  await registerTrackedShareApp({
    apiUrl: 'https://ctl-staging.duet.so',
    workspace: {
      _id: 'workspace_owner',
      slug: 'owner-workspace',
      status: 'active',
    },
    token: 'owner-token',
    runId: 'run_12345678',
    label: 'relocation',
    sourceRoot: sourceApp.anchorPath,
    ledger: args.ledger,
    convex: {
      query: async () => ({ status: 'deleted' }),
    } as never,
    internalKey: 'internal-key',
    artifacts: new StagingArtifactCollector('/tmp/share-app-cleanup-retry-test', []),
    requestJson: async () => ({ app: sourceApp }),
    fetchImpl: args.fetchImpl,
    sleep: args.sleep,
  })
}

test('waits for the replica attached to the target share', async () => {
  const observations: App[][] = [
    [],
    [{ ...replicaApp, sourceShareId: 'share_other' }],
    [{ ...replicaApp, sourceAppId: undefined }],
    [replicaApp],
  ]

  const replica = await waitForReplicaState({
    appSlug: replicaApp.slug,
    sourceShareId: 'share_target',
    expectedState: 'attached',
    loadApps: async () => observations.shift() ?? [replicaApp],
    sleep: async () => undefined,
    timeoutMs: 10,
  })

  expect(replica).toEqual(replicaApp)
})

test('waits until an attached replica becomes a local app', async () => {
  const localApp = { ...replicaApp, sourceShareId: undefined, sourceAppId: undefined }
  const observations: App[][] = [
    [replicaApp],
    [{ ...replicaApp, sourceShareId: undefined }],
    [localApp],
  ]

  const replica = await waitForReplicaState({
    appSlug: replicaApp.slug,
    sourceShareId: 'share_target',
    expectedState: 'detached',
    loadApps: async () => observations.shift() ?? [localApp],
    sleep: async () => undefined,
    timeoutMs: 10,
  })

  expect(replica).toEqual(localApp)
})

test('waits until revocation removes the attached replica', async () => {
  const observations: App[][] = [[replicaApp], []]

  const replica = await waitForReplicaState({
    appSlug: replicaApp.slug,
    sourceShareId: 'share_target',
    expectedState: 'absent',
    loadApps: async () => observations.shift() ?? [],
    sleep: async () => undefined,
    timeoutMs: 10,
  })

  expect(replica).toBeUndefined()
})

test('records a source app in the cleanup ledger as part of registration', async () => {
  const ledger = new StagingResourceLedger('run_12345678', () => 1_000)
  const sourceApp: App = {
    ...replicaApp,
    id: 'app_source',
    workspaceId: 'workspace_owner',
    anchorId: 'anchor_source',
    anchorPath: 'share-journey/run_12345678/origin-delete',
    slug: 'share-origin-delete-12345678',
    canonicalUrl: 'https://share-origin-delete-12345678--owner.edge-staging.duet.so',
    sourceShareId: undefined,
    sourceAppId: undefined,
  }
  let requestUrl: string | undefined
  let requestBody: unknown

  const registered = await registerTrackedShareApp({
    apiUrl: 'https://ctl-staging.duet.so',
    workspace: {
      _id: 'workspace_owner',
      slug: 'owner-workspace',
      status: 'active',
    },
    token: 'owner-token',
    runId: 'run_12345678',
    label: 'origin-delete',
    sourceRoot: sourceApp.anchorPath,
    ledger,
    convex: new ConvexHttpClient('https://fixture.convex.cloud'),
    internalKey: 'internal-key',
    artifacts: new StagingArtifactCollector('/tmp/share-app-test', []),
    requestJson: async (url, init) => {
      requestUrl = url
      requestBody = JSON.parse(String(init.body))
      return { app: sourceApp }
    },
  })

  expect(registered).toEqual(sourceApp)
  expect(requestUrl).toBe('https://ctl-staging.duet.so/v1/ws/owner-workspace/apps')
  expect(requestBody).toEqual({
    path: sourceApp.anchorPath,
    command: 'python3 -m http.server $PORT',
    apiScopes: [],
    slug: sourceApp.slug,
  })
  expect(ledger.snapshot()).toEqual([
    {
      kind: 'app',
      id: sourceApp.id,
      label: 'run_12345678:share-app:share-origin-delete-12345678',
      recordedAt: 1_000,
      status: 'recorded',
    },
  ])
})

test('retries a transient source app cleanup response before recording an error', async () => {
  const ledger = new StagingResourceLedger('run_12345678', () => 1_000)
  const statuses = [502, 200]
  const observedStatuses: number[] = []
  const sleeps: number[] = []

  await registerCleanupRetryFixture({
    ledger,
    fetchImpl: async () => {
      const status = statuses.shift() ?? 200
      observedStatuses.push(status)
      return new Response(null, { status })
    },
    sleep: async milliseconds => {
      sleeps.push(milliseconds)
    },
  })

  const report = await ledger.cleanupAll()

  expect(report.status).toBe('pass')
  expect(observedStatuses).toEqual([502, 200])
  expect(sleeps.length).toBeGreaterThan(0)
  expect(sleeps.every(delay => Number.isFinite(delay) && delay > 0)).toBe(true)
})

test('keeps a persistent source app cleanup failure visible after bounded retries', async () => {
  const ledger = new StagingResourceLedger('run_12345678', () => 1_000)
  const observedStatuses: number[] = []
  const sleeps: number[] = []

  await registerCleanupRetryFixture({
    ledger,
    fetchImpl: async () => {
      observedStatuses.push(502)
      return new Response(null, { status: 502 })
    },
    sleep: async milliseconds => {
      sleeps.push(milliseconds)
    },
  })

  const report = await ledger.cleanupAll()

  expect(report.status).toBe('fail')
  expect(report.resources[0]?.error).toBe('share source app cleanup returned HTTP 502')
  expect(observedStatuses.length).toBeGreaterThan(1)
  expect(observedStatuses.every(status => status === 502)).toBe(true)
  expect(sleeps).toHaveLength(observedStatuses.length - 1)
  expect(sleeps.every(delay => Number.isFinite(delay) && delay > 0)).toBe(true)
})

test('registers a tracked workspace fixture with an explicit command', async () => {
  const ledger = new StagingResourceLedger('run_12345678', () => 1_000)
  const fixtureApp: App = {
    ...replicaApp,
    id: 'app_relocator',
    workspaceId: 'workspace_recipient',
    anchorId: 'anchor_relocator',
    anchorPath: 'apps/run_12345678-relocation-fixture',
    slug: 'share-relocation-12345678',
    canonicalUrl: 'https://share-relocation-12345678--recipient.edge-staging.duet.so',
    sourceShareId: undefined,
    sourceAppId: undefined,
  }
  let requestBody: unknown

  await registerTrackedShareApp({
    apiUrl: 'https://ctl-staging.duet.so',
    workspace: {
      _id: 'workspace_recipient',
      slug: 'recipient-workspace',
      status: 'active',
    },
    token: 'recipient-token',
    runId: 'run_12345678',
    label: 'relocation',
    sourceRoot: fixtureApp.anchorPath,
    command: 'cp -a -- source destination && rm -rf -- source && python3 -m http.server $PORT',
    ledger,
    convex: new ConvexHttpClient('https://fixture.convex.cloud'),
    internalKey: 'internal-key',
    artifacts: new StagingArtifactCollector('/tmp/share-relocation-app-test', []),
    requestJson: async (_url, init) => {
      requestBody = JSON.parse(String(init.body))
      return { app: fixtureApp }
    },
  })

  expect(requestBody).toEqual({
    path: fixtureApp.anchorPath,
    command: 'cp -a -- source destination && rm -rf -- source && python3 -m http.server $PORT',
    apiScopes: [],
    slug: fixtureApp.slug,
  })
})

test('deletes a non-empty share root recursively so the rail can observe its removal', async () => {
  let request: { url: string; init?: RequestInit } | undefined

  await deleteShareRoot(
    { apiUrl: 'https://ctl-staging.duet.so' },
    'recipient-workspace',
    'recipient-token',
    'shared/project',
    async (input, init) => {
      request = { url: String(input), init }
      return new Response('{}', { status: 200 })
    },
  )

  expect(request?.url).toBe('https://ctl-staging.duet.so/v1/ws/recipient-workspace/files/actions')
  expect(request?.init?.method).toBe('POST')
  expect(JSON.parse(String(request?.init?.body))).toEqual({
    operation: 'delete',
    path: 'shared/project',
    recursive: true,
  })
})

test('marker-preserving copy-delete changes the root inode without losing identity or bytes', async () => {
  const driveRoot = await mkdtemp(join(tmpdir(), 'share-relocation-'))
  const source = "shared/source folder's project"
  const destination = 'archive/destination project'
  const sourceRoot = join(driveRoot, source)
  const destinationRoot = join(driveRoot, destination)

  try {
    await mkdir(join(sourceRoot, 'nested'), { recursive: true })
    await mkdir(join(driveRoot, 'archive'))
    await writeFile(join(sourceRoot, '.duet-anchor'), 'duet-anchor:v1:anchor:nonce\n')
    await writeFile(join(sourceRoot, 'nested', 'note.txt'), 'kept bytes')
    const sourceInode = (await stat(sourceRoot)).ino

    const command = buildMarkerPreservingCopyDeleteCommand({
      driveRoot,
      source,
      destination,
    })
    const run = Bun.spawn(['bash', '-lc', command], { stdout: 'pipe', stderr: 'pipe' })
    expect(await run.exited).toBe(0)

    await expect(stat(sourceRoot)).rejects.toThrow()
    expect((await stat(destinationRoot)).ino).not.toBe(sourceInode)
    expect(await readFile(join(destinationRoot, '.duet-anchor'), 'utf8')).toBe(
      'duet-anchor:v1:anchor:nonce\n',
    )
    expect(await readFile(join(destinationRoot, 'nested', 'note.txt'), 'utf8')).toBe('kept bytes')
  } finally {
    await rm(driveRoot, { recursive: true, force: true })
  }
})

test('waits until a live share reaches the expected lifecycle state', async () => {
  const observed = ['pending', 'active']

  const share = await waitForShareState({
    expectedState: 'active',
    load: async () => ({ id: 'share_1', state: observed.shift() ?? 'active' }),
    sleep: async () => undefined,
    timeoutMs: 10,
  })

  expect(share).toEqual({ id: 'share_1', state: 'active' })
})

test('fails immediately with the observed terminal share state', async () => {
  let loads = 0

  await expect(
    waitForShareState({
      expectedState: 'active',
      terminalStates: ['unlinked', 'revoked'],
      load: async () => {
        loads += 1
        return { id: 'share_1', state: 'unlinked', mountPath: 'shared/old-path' }
      },
      describe: share => `share ${share.id}: state=${share.state}, mountPath=${share.mountPath}`,
      sleep: async () => undefined,
      timeoutMs: 10,
    }),
  ).rejects.toThrow(
    'Share reached terminal state unlinked while waiting for active (share share_1: state=unlinked, mountPath=shared/old-path)',
  )
  expect(loads).toBe(1)
})

test('waits for both workspace gateways to prune the revoked share mount', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = []

  await waitForShareMountPruned({
    shareId: 'share_1',
    gateways: [
      { httpsUrl: 'https://origin-vm.example', vmToken: 'origin-token' },
      { httpsUrl: 'https://recipient-vm.example', vmToken: 'recipient-token' },
    ],
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers)
      requests.push({ url: String(input), authorization: headers.get('authorization') })
      const poll = Math.floor((requests.length - 1) / 2)
      const mounts =
        poll === 0 && String(input).includes('origin-vm') ? [{ id: 'share-share_1' }] : []
      return Response.json({ mounts })
    },
    sleep: async () => undefined,
    timeoutMs: 10,
  })

  expect(requests).toEqual([
    {
      url: 'https://origin-vm.example/v1/sync/mounts',
      authorization: 'Bearer origin-token',
    },
    {
      url: 'https://recipient-vm.example/v1/sync/mounts',
      authorization: 'Bearer recipient-token',
    },
    {
      url: 'https://origin-vm.example/v1/sync/mounts',
      authorization: 'Bearer origin-token',
    },
    {
      url: 'https://recipient-vm.example/v1/sync/mounts',
      authorization: 'Bearer recipient-token',
    },
  ])
})

test('reports the lifecycle state that never converged', async () => {
  let now = 0

  await expect(
    waitForShareState({
      expectedState: 'unlinked',
      load: async () => ({ id: 'share_1', state: 'active' }),
      sleep: async () => undefined,
      now: () => now++,
      timeoutMs: 2,
    }),
  ).rejects.toThrow('share state unlinked')
})
