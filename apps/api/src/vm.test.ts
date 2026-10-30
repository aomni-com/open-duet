import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'
import { getFunctionName } from 'convex/server'

import { WhoamiResponseSchema } from '@repo/contract'

import {
  IMAGE_REF,
  INTERNAL_KEY,
  SKILLS_FIXTURE_MODEL,
  SYNCTHING_DEVICE_ID_ONE,
  SYNCTHING_DEVICE_ID_TWO,
  VmRegisterResponseSchema,
  VmSyncResponseSchema,
  WorkspaceCreateResultSchema,
  app,
  auditEvents,
  authed,
  authedWith,
  bootApiSuite,
  composedRunnerMessage,
  convex,
  createApiApp,
  createHash,
  eventually,
  expectedRunnerInput,
  hashApiKey,
  issueKey,
  humanWorkspaceFixture,
  join,
  mkdtemp,
  mutate,
  owner,
  prepareWorkspaceForHttpRegistration,
  provisionRegisteredWorkspace,
  query,
  rawWorkspace,
  resetApiSuiteBetweenTests,
  rm,
  runnerInputReceipt,
  signInWithMagicLink,
  skillsFixtureCatalog,
  stopApiSuite,
  tmpdir,
  uniqueEmail,
  uniqueSlug,
  vmSyncRequest,
  writeFile,
} from './index-suite'
import type {
  GatewayAnchor,
  RuntimeReleaseDescriptor,
  GatewayRunnerInputRequest,
  UserRow,
} from './index-suite'
import { writeRuntimeReleaseFixture } from './runtime/release.fixture'

// The VM data plane: sync polls, registration, provisioning, release manifests.
// One topic slice of the api v1 suite; each slice file boots its own
// deployment through the shared kit in index-suite.ts.
describe('api v1: vm sync and registration', () => {
  beforeAll(bootApiSuite, 240_000)
  afterAll(stopApiSuite)
  afterEach(resetApiSuiteBetweenTests)

  test('removed VM heartbeat and anchor endpoints return 404', async () => {
    const key = await issueKey(owner.client)
    for (const [path, method] of [
      ['/v1/vm/heartbeat', 'POST'],
      ['/v1/vm/anchors', 'GET'],
    ] as const) {
      const response = await authedWith(app, path, key.key, { method })
      expect(response.status).toBe(404)
    }
  })

  test('owner reprovision reports the durable backup while the existing VM remains attached', async () => {
    const registered = await provisionRegisteredWorkspace(uniqueSlug('api-reprovision-backup'))
    const before = await rawWorkspace(registered.workspaceId)
    const key = await issueKey(owner.client)
    const response = await authedWith(app, `/v1/ws/${registered.slug}/reprovision`, key.key, {
      method: 'POST',
    })
    expect(response.status).toBe(202)
    const body = (await response.json()) as {
      status: string
      workspaceId: string
      backupId: string
    }
    expect(body).toEqual({
      status: 'backup_pending',
      workspaceId: registered.workspaceId,
      backupId: expect.any(String),
    })
    const backup = (await query(convex, 'domains/workspaceBackups/jobs:get', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      backupId: body.backupId,
    })) as Record<string, unknown>
    expect(backup.purpose).toBe('reprovision')
    expect(backup.lifecycle).toMatchObject({ kind: 'reprovision', status: 'capturing' })
    const after = await rawWorkspace(registered.workspaceId)
    expect(after.vmTokenNonce).toBe(before.vmTokenNonce)
    expect(after.vmName).toBe(before.vmName)
    const repeated = await authedWith(app, `/v1/ws/${registered.slug}/reprovision`, key.key, {
      method: 'POST',
    })
    expect(repeated.status).toBe(202)
    expect(await repeated.json()).toEqual(body)
  })

  test('owner reprovision identifies a competing backup without accepting replacement', async () => {
    const registered = await provisionRegisteredWorkspace(uniqueSlug('api-reprovision-busy'))
    const key = await issueKey(owner.client)
    const created = await authedWith(app, `/v1/ws/${registered.slug}/backups`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
    })
    expect(created.status).toBe(202)
    const { backup } = (await created.json()) as { backup: { id: string } }
    const response = await authedWith(app, `/v1/ws/${registered.slug}/reprovision`, key.key, {
      method: 'POST',
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'backup_in_progress', backupId: backup.id })
    expect((await rawWorkspace(registered.workspaceId)).pendingBackupLifecycle).toBeUndefined()
  })

  test('owner reprovision composes teardown with one attach and rotates the VM nonce', async () => {
    const slug = uniqueSlug('api-reprovision')
    const provisioningToken = `provision-${slug}`
    const now = Date.now()
    const created = (await mutate(
      owner.client,
      'testing/workspaces:prepareWorkspaceForRegistration',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        slug,
        name: 'API Reprovision',
        imageRef: IMAGE_REF,
        provisioningTokenHash: await hashApiKey(provisioningToken),
        provisioningTokenExpiresAt: now + 60_000,
        now,
      },
    )) as { workspaceId: string }
    await mutate(owner.client, 'domains/workspaces/provisioning:registerVm', {
      internalKey: INTERNAL_KEY,
      provisioningTokenHash: await hashApiKey(provisioningToken),
      workspaceHint: created.workspaceId,
      vmName: 'old-api-reprovision-vm',
      sshDest: 'exedev@old-api-reprovision-vm.exe.xyz',
      now: now + 1_000,
    })
    const oldNonce = (await rawWorkspace(created.workspaceId)).vmTokenNonce
    expect(oldNonce).toEqual(expect.any(String))
    await mutate(owner.client, 'domains/workspaces/provisioning:markUnhealthyWorkspaces', {
      internalKey: INTERNAL_KEY,
      now: now + 122_000,
      staleAfterMs: 120_000,
    })
    expect((await rawWorkspace(created.workspaceId)).status).toBe('unhealthy')

    const coOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('api-reprovision-co-owner'),
      'API Reprovision Co-owner',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: created.workspaceId,
      userId: coOwner.user._id,
      role: 'owner',
    })

    const viewerKey = await issueKey(
      (await humanWorkspaceFixture(created.workspaceId, 'viewer')).client,
    )
    const adminKey = await issueKey(coOwner.client)
    const denied = await authedWith(app, `/v1/ws/${slug}/reprovision`, viewerKey.key, {
      method: 'POST',
    })
    expect(denied.status).toBe(403)

    const response = await authedWith(app, `/v1/ws/${slug}/reprovision`, adminKey.key, {
      method: 'POST',
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      status: 'provisioning',
      scheduled: true,
      workspaceId: created.workspaceId,
    })

    await eventually(async () => {
      const row = await rawWorkspace(created.workspaceId)
      expect(row).toMatchObject({
        status: 'provisioning',
        vmName: expect.any(String),
        vmTokenNonce: expect.any(String),
        provisioningTokenHash: expect.any(String),
      })
      expect(row.vmTokenNonce).not.toBe(oldNonce)
      expect(row.vmAttachRunId).toBeUndefined()
    })
    const attached = await rawWorkspace(created.workspaceId)

    const secondClick = await authedWith(app, `/v1/ws/${slug}/reprovision`, adminKey.key, {
      method: 'POST',
    })
    expect(secondClick.status).toBe(202)
    expect(await secondClick.json()).toMatchObject({
      status: 'provisioning',
      scheduled: false,
    })
    const attachEvents = (await auditEvents(owner.client, created.workspaceId)).filter(
      event => event.event === 'workspace.vm_attach_scheduled',
    )
    expect(attachEvents).toHaveLength(1)
    expect(attachEvents[0]).toMatchObject({
      event: 'workspace.vm_attach_scheduled',
      provenance: { source: 'workspace_vm_schedule' },
    })
    expect(
      (await auditEvents(coOwner.client, created.workspaceId)).find(
        event => event.event === 'workspace.operator_reprovision_started',
      ),
    ).toMatchObject({ actorId: coOwner.user._id })

    await mutate(owner.client, 'domains/workspaces/provisioning:registerVm', {
      internalKey: INTERNAL_KEY,
      provisioningTokenHash: attached.provisioningTokenHash,
      workspaceHint: created.workspaceId,
      vmName: attached.vmName,
      sshDest: attached.sshDest,
      httpsUrl: attached.httpsUrl,
      now: now + 123_000,
    })
    expect((await rawWorkspace(created.workspaceId)).status).toBe('active')
  })

  test('runtime artifact auth follows the live VM token through workspace servicing pauses', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'duet-runtime-release-'))
    try {
      const manifest = await writeRuntimeReleaseFixture(releaseDir)
      const vm = await provisionRegisteredWorkspace(uniqueSlug('runtime-release'))
      const releaseApp = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        runtimeReleaseDir: releaseDir,
      })
      const headers = { authorization: `Bearer ${vm.vmToken}` }
      const path = '/v1/vm/runtime-release/artifacts/duet'
      expect((await releaseApp.request(path)).status).toBe(401)
      expect(
        (await releaseApp.request(path, { headers: { authorization: 'Bearer duet_vm_wrong' } }))
          .status,
      ).toBe(401)
      const response = await releaseApp.request('/v1/vm/runtime-release/manifest', { headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(manifest)
      await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: vm.workspaceId,
        servicingStatus: 'paused',
        now: Date.now(),
      })
      const paused = await releaseApp.request(path, { headers })
      expect(paused.status).toBe(200)
      expect(await paused.text()).toBe('runtime fixture duet\n')
      await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: vm.workspaceId,
        servicingStatus: 'active',
        now: Date.now(),
      })
    } finally {
      await rm(releaseDir, { recursive: true, force: true })
    }
  })

  test('VM sync advertises stable catalog-sensitive skills bytes behind VM auth', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('skills-delivery'))
    const secondVm = await provisionRegisteredWorkspace(uniqueSlug('skills-delivery-second'))
    const skillsApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      appUrl: 'https://app.skills.test',
      approvedModelCatalog: skillsFixtureCatalog(),
    })

    const firstResponse = await vmSyncRequest(skillsApp, vm.vmToken)
    const secondResponse = await vmSyncRequest(skillsApp, vm.vmToken)
    const otherWorkspaceResponse = await vmSyncRequest(skillsApp, secondVm.vmToken)
    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    const first = VmSyncResponseSchema.parse(await firstResponse.json())
    const second = VmSyncResponseSchema.parse(await secondResponse.json())
    const otherWorkspace = VmSyncResponseSchema.parse(await otherWorkspaceResponse.json())
    expect(first.skills).toEqual({
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      url: `http://localhost/v1/vm/skills/${first.skills?.hash}`,
    })
    expect(second.skills).toEqual(first.skills)
    expect(otherWorkspace.skills).toEqual(first.skills)

    const artifactPath = new URL(first.skills!.url).pathname
    const artifactResponse = await skillsApp.request(artifactPath, {
      headers: { authorization: `Bearer ${vm.vmToken}` },
    })
    expect(artifactResponse.status).toBe(200)
    expect(artifactResponse.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const bytes = await artifactResponse.text()
    expect(createHash('sha256').update(bytes, 'utf8').digest('hex')).toBe(first.skills!.hash)
    expect(bytes).toContain('https://app.skills.test/settings/api-keys')
    expect(bytes).not.toMatch(/https:\/\/app\.skills\.test\/w\//)

    const otherWorkspaceArtifact = await skillsApp.request(artifactPath, {
      headers: { authorization: `Bearer ${secondVm.vmToken}` },
    })
    expect(otherWorkspaceArtifact.status).toBe(200)
    expect(await otherWorkspaceArtifact.text()).toBe(bytes)

    const changedCatalogApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      appUrl: 'https://app.skills.test',
      approvedModelCatalog: skillsFixtureCatalog({
        ...SKILLS_FIXTURE_MODEL,
        gatewayModelId: 'fixture/skills-chat-repointed',
      }),
    })
    const changedResponse = await vmSyncRequest(changedCatalogApp, vm.vmToken)
    const changed = VmSyncResponseSchema.parse(await changedResponse.json())
    expect(changed.skills?.hash).not.toBe(first.skills!.hash)

    const changedOriginApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      appUrl: 'https://other.skills.test',
      approvedModelCatalog: skillsFixtureCatalog(),
    })
    const changedOriginResponse = await vmSyncRequest(changedOriginApp, vm.vmToken)
    const changedOrigin = VmSyncResponseSchema.parse(await changedOriginResponse.json())
    expect(changedOrigin.skills?.hash).not.toBe(first.skills!.hash)

    const stale = await changedCatalogApp.request(artifactPath, {
      headers: { authorization: `Bearer ${vm.vmToken}` },
    })
    expect(stale.status).toBe(404)
    expect(await stale.json()).toEqual({ error: 'not_found' })

    const badToken = await skillsApp.request(artifactPath, {
      headers: { authorization: 'Bearer duet_vm_wrong' },
    })
    expect(badToken.status).toBe(401)
    expect(await badToken.json()).toEqual({ error: 'unauthorized' })
  })

  test('VM sync defaults to updates flowing with the complete baked runtime', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'duet-vm-sync-release-'))
    try {
      const manifest = await writeRuntimeReleaseFixture(releaseDir)
      const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-paused'))
      const registeredApp = (await mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId: vm.workspaceId,
        path: 'apps/sync-calendar',
        command: 'bun run start',
        apiScopes: [],
        installCommand: 'bun install',
        slug: 'sync-calendar',
      })) as { id: string; port: number }
      const syncApp = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        runtimeReleaseDir: releaseDir,
      })

      const response = await syncApp.request('/v1/vm/sync', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${vm.vmToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          needsModelCredentials: false,
          versions: { runtime: '1.0.0', image: '1.0.0' },
          syncthingDeviceId: 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY',
          shareSyncReports: [
            {
              shareId: 'share-1',
              generation: 'generation-1',
              state: 'ready',
            },
          ],
        }),
      })

      expect(response.status).toBe(200)
      const body = VmSyncResponseSchema.parse(await response.json())
      const descriptor: RuntimeReleaseDescriptor = {
        ...manifest,
        artifacts: manifest.artifacts.map(artifact => ({
          ...artifact,
          href: `http://localhost/v1/vm/runtime-release/artifacts/${artifact.name}`,
        })),
      }
      expect(body.anchors.map(anchor => anchor.path)).toEqual(['apps/sync-calendar'])
      expect(body).toMatchObject({
        pollAfterMs: 3_000,
        apps: [
          {
            appId: registeredApp.id,
            slug: 'sync-calendar',
            command: 'bun run start',
            installCommand: 'bun install',
            port: registeredApp.port,
            anchorPath: 'apps/sync-calendar',
            apiScopes: [],
          },
        ],
        runtimeRelease: descriptor,
        updates: { paused: false },
      })
      expect(body.runtimeRelease).toEqual(descriptor)
      expect(
        await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: vm.workspaceId,
        }),
      ).toMatchObject({
        syncthingDeviceId: 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY',
      })
      expect(
        await query(convex, 'testing/workspaces:rawShareSyncReportsForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: vm.workspaceId,
        }),
      ).toEqual([
        expect.objectContaining({
          workspaceId: vm.workspaceId,
          shareId: 'share-1',
          generation: 'generation-1',
          state: 'ready',
        }),
      ])
      for (const artifact of descriptor.artifacts) {
        const artifactResponse = await syncApp.request(new URL(artifact.href).pathname, {
          headers: { authorization: `Bearer ${vm.vmToken}` },
        })
        expect(artifactResponse.status).toBe(200)
        const served = Buffer.from(await artifactResponse.arrayBuffer())
        expect(served.toString()).toBe(`runtime fixture ${artifact.name}\n`)
        expect(createHash('sha256').update(served).digest('hex')).toBe(artifact.sha256)
      }
    } finally {
      await rm(releaseDir, { recursive: true, force: true })
    }
  })

  test('VM sync requires a VM token, strips unknown fields, and rescues unparseable senders', async () => {
    const validBody = {
      needsModelCredentials: false,
      versions: { runtime: '1.0.0', image: '1.0.0' },
    }
    const unauthenticated = await app.request('/v1/vm/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toEqual({ error: 'unauthorized' })

    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-schema'))
    // Unknown keys strip (a skewed sender must never brick): the request
    // parses and the sync proceeds normally.
    const stripped = await app.request('/v1/vm/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${vm.vmToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...validBody, unexpected: true }),
    })
    expect(stripped.status).toBe(200)

    // A request the schema cannot parse at all (bad known-field type) means
    // the sender is outdated: authenticated senders get a 200 rescue
    // envelope carrying only the gateway release, which the gateway's
    // pre-validation rescue parse installs — schema breaks heal in one
    // sync cycle instead of bricking the fleet.
    const unparseable = await app.request('/v1/vm/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${vm.vmToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...validBody, needsModelCredentials: 'nope' }),
    })
    expect(unparseable.status).toBe(200)
    // The envelope carries the announced release when one exists (none is
    // built in this test env); the contract is 200-with-no-error so the
    // gateway's rescue parse can act instead of the sender wedging on 400.
    const rescueBody = (await unparseable.json()) as Record<string, unknown>
    expect('error' in rescueBody).toBe(false)

    // Unparseable + bad token still refuses.
    const unparseableWrongToken = await app.request('/v1/vm/sync', {
      method: 'POST',
      headers: {
        authorization: 'Bearer duet_vm_wrong',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...validBody, needsModelCredentials: 'nope' }),
    })
    expect(unparseableWrongToken.status).toBe(401)

    const wrongToken = await app.request('/v1/vm/sync', {
      method: 'POST',
      headers: {
        authorization: 'Bearer duet_vm_wrong',
        'content-type': 'application/json',
      },
      body: JSON.stringify(validBody),
    })
    expect(wrongToken.status).toBe(401)
  })

  test('VM sync round-trips a backend connected-provider disconnect directive', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-provider-disconnect'))
    await mutate(owner.client, 'domains/connectedProviders/model:completeConnect', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: vm.workspaceId,
      connection: {
        provider: 'openai-codex',
        state: 'connected',
        connectedAt: 180_000,
      },
    })
    await mutate(owner.client, 'domains/connectedProviders/model:requestDisconnect', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: vm.workspaceId,
      provider: 'openai-codex',
    })

    const directed = VmSyncResponseSchema.parse(
      await vmSyncRequest(app, vm.vmToken, {
        connectedProviders: [
          {
            provider: 'openai-codex',
            state: 'connected',
            connectedAt: 180_000,
          },
        ],
      }).then(response => response.json()),
    )
    expect(directed.disconnectConnectedProviders).toEqual(['openai-codex'])

    const acknowledged = VmSyncResponseSchema.parse(
      await vmSyncRequest(app, vm.vmToken, { connectedProviders: [] }).then(response =>
        response.json(),
      ),
    )
    expect(acknowledged.disconnectConnectedProviders).toEqual(['openai-codex'])

    /* What retires the directive is an observation, not the poll. The sync rail
       stopped carrying a copy of the credential store, so a VM reporting no
       providers says nothing about them any more — the reading that settles
       this is folded in by `applyObservation` when someone looks at the page. */
    await mutate(owner.client, 'domains/connectedProviders/model:applyObservation', {
      internalKey: INTERNAL_KEY,
      workspaceId: vm.workspaceId,
      connectedProviders: [],
    })

    const settled = VmSyncResponseSchema.parse(
      await vmSyncRequest(app, vm.vmToken, { connectedProviders: [] }).then(response =>
        response.json(),
      ),
    )
    expect(settled.disconnectConnectedProviders).toBeUndefined()
  })

  test('VM sync applies matching app reconciliation reports and ignores stale configs', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-app-report'))
    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: vm.workspaceId,
      path: 'apps/reported',
      command: 'bun run start:v1',
      apiScopes: [],
      port: 40_123,
      name: 'Reported App v1',
    })) as {
      id: string
      slug: string
      command: string
      name?: string
      port: number
      anchorPath: string
      apiScopes: string[]
    }
    const reportedConfig = {
      appId: registered.id,
      slug: registered.slug,
      command: registered.command,
      name: registered.name,
      port: registered.port,
      anchorPath: registered.anchorPath,
      apiScopes: registered.apiScopes,
    }

    const accepted = await vmSyncRequest(app, vm.vmToken, {
      appReconciliationReports: [{ ...reportedConfig, status: 'reconciled' }],
    })
    expect(accepted.status).toBe(200)
    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId: vm.workspaceId,
        slug: registered.slug,
      }),
    ).toMatchObject({ runtimeStatus: 'reconciled' })

    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: vm.workspaceId,
      slug: registered.slug,
      command: 'bun run start:v2',
    })
    const stale = await vmSyncRequest(app, vm.vmToken, {
      appReconciliationReports: [{ ...reportedConfig, status: 'reconciled' }],
    })
    expect(stale.status).toBe(200)
    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId: vm.workspaceId,
        slug: registered.slug,
      }),
    ).toMatchObject({
      command: 'bun run start:v2',
      runtimeStatus: 'reconciling',
    })

    const failed = await vmSyncRequest(app, vm.vmToken, {
      appReconciliationReports: [
        {
          ...reportedConfig,
          command: 'bun run start:v2',
          status: 'reconcile_failed',
          error: 'App did not bind its configured port',
        },
      ],
    })
    expect(failed.status).toBe(200)
    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId: vm.workspaceId,
        slug: registered.slug,
      }),
    ).toMatchObject({
      command: 'bun run start:v2',
      runtimeStatus: 'reconcile_failed',
      reconciliationError: 'App did not bind its configured port',
    })

    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: vm.workspaceId,
      slug: registered.slug,
      name: 'Reported App v2',
    })
    const staleName = await vmSyncRequest(app, vm.vmToken, {
      appReconciliationReports: [
        {
          ...reportedConfig,
          command: 'bun run start:v2',
          status: 'reconciled',
        },
      ],
    })
    expect(staleName.status).toBe(200)
    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId: vm.workspaceId,
        slug: registered.slug,
      }),
    ).toMatchObject({
      name: 'Reported App v2',
      runtimeStatus: 'reconcile_failed',
      reconciliationError: 'App did not bind its configured port',
    })
  })

  test('VM sync persists train generations outside the observation throttle before acknowledging', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-train'))
    const syncApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 50_000,
    })
    const baseReport = {
      jobId: 'train-sync-rail',
      creatorUserId: owner.user._id,
      state: 'running' as const,
      createdAt: 49_000,
      startedAt: 49_001,
    }
    const first = await vmSyncRequest(syncApp, vm.vmToken, {
      trainReports: [
        {
          ...baseReport,
          generation: 'train-sync-rail:1',
          phase: 'preparing',
          updatedAt: 49_001,
        },
      ],
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({
      acceptedTrainReportGenerations: ['train-sync-rail:1'],
    })

    const second = await vmSyncRequest(syncApp, vm.vmToken, {
      trainReports: [
        {
          ...baseReport,
          generation: 'train-sync-rail:2',
          phase: 'training',
          updatedAt: 49_002,
        },
      ],
    })
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      acceptedTrainReportGenerations: ['train-sync-rail:2'],
    })
    const rows = (await query(convex, 'testing/train:listRawForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: vm.workspaceId,
    })) as Array<Record<string, unknown>>
    expect(rows.find(row => row.jobId === 'train-sync-rail')).toMatchObject({
      generation: 'train-sync-rail:2',
      phase: 'training',
      updatedAt: 49_002,
    })
  })

  test('VM sync with an unresolvable train job creator still acks and never 401s', async () => {
    // An unresolvable creator can't be emailed, but the terminal transition must
    // still persist and ack — never a 401 (the gateway would re-register) and
    // never a 500 (train ingestion must not sink the core sync loop).
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-train-failure'))
    const response = await vmSyncRequest(app, vm.vmToken, {
      trainReports: [
        {
          generation: 'train-sync-failure:1',
          jobId: 'train-sync-failure',
          creatorUserId: 'not-a-convex-user-id',
          state: 'done',
          phase: 'done',
          createdAt: 1,
          updatedAt: 2,
          completedAt: 2,
        },
      ],
    })

    expect(response.status).toBe(200)
    expect(response.status).not.toBe(401)
    expect(await response.json()).toMatchObject({
      acceptedTrainReportGenerations: ['train-sync-failure:1'],
    })
  })

  test('VM sync applies marketplace pull reports and survives a failing subscription apply', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-marketplace'))
    const goldenWorkspaceId = (await mutate(
      owner.client,
      'testing/workspaces:createWorkspaceForTest',
      {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('vm-sync-marketplace-golden'),
        name: 'Marketplace Golden',
      },
    )) as string
    await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: goldenWorkspaceId,
      path: 'official',
      kind: 'folder',
      slug: 'official-agents',
    })
    await mutate(convex, 'testing/marketplace:markVerifiedPublisherForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: goldenWorkspaceId,
      now: Date.now(),
    })
    const hubPublish = (await query(convex, 'testing/marketplace:publishBySlugForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: goldenWorkspaceId,
      slug: 'official-agents',
    })) as { _id: string }
    const goldenAgent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: goldenWorkspaceId,
      path: 'official/research',
      slug: 'research',
      name: 'research',
    })) as { id: string; anchorId: string }
    const listingId = (await mutate(convex, 'testing/marketplace:insertListingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: goldenWorkspaceId,
      agentId: goldenAgent.id,
      anchorId: goldenAgent.anchorId,
      publishId: hubPublish._id,
      agentName: 'research',
      agentSubpath: 'research',
      createdByUserId: owner.user._id,
      now: Date.now(),
    })) as string
    const subscription = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId: vm.workspaceId,
      listingId,
    })) as { id: string }

    // The healthy rail: a pull report riding the recurring poll lands on the
    // subscription before the poll answers.
    const healthy = await vmSyncRequest(app, vm.vmToken, {
      marketplacePullReports: [
        {
          subscriptionId: subscription.id,
          state: 'active',
          appliedEtag: 'etag-rail-1',
          lastAppliedAt: Date.now(),
        },
      ],
    })
    expect(healthy.status).toBe(200)
    expect(
      await query(owner.client, 'domains/marketplace/model:listByWorkspace', {
        workspaceId: vm.workspaceId,
      }),
    ).toContainEqual(
      expect.objectContaining({
        id: subscription.id,
        state: 'active',
        appliedEtag: 'etag-rail-1',
      }),
    )

    // Poison the next apply: the workspace claims the publisher's future app
    // path with an incompatible anchor, then the publisher declares the app.
    // The poll must keep answering 200 with its full sync payload — marketplace
    // apply, like train ingestion, must never sink the core sync loop — and
    // the failure lands on the subscription's own row.
    await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: vm.workspaceId,
      path: 'agents/research/apps/panel',
      kind: 'agent',
      settings: {},
    })
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: goldenWorkspaceId,
      path: 'official/research/apps/panel',
      slug: 'panel',
      command: 'bun run panel',
      apiScopes: [],
    })
    const poisoned = await vmSyncRequest(app, vm.vmToken, {
      marketplacePullReports: [
        {
          subscriptionId: subscription.id,
          state: 'active',
          appliedEtag: 'etag-rail-2',
          lastAppliedAt: Date.now(),
        },
      ],
    })
    expect(poisoned.status).toBe(200)
    const body = VmSyncResponseSchema.parse(await poisoned.json())
    expect(body.workspaceSlug).toBe(vm.slug)
    expect(
      await query(owner.client, 'domains/marketplace/model:listByWorkspace', {
        workspaceId: vm.workspaceId,
      }),
    ).toContainEqual(
      expect.objectContaining({
        id: subscription.id,
        state: 'error',
        lastErrorCode: 'apply_failed',
      }),
    )
  })

  test('VM sync carries the listForVm anchor projection byte-for-byte', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-anchors'))
    await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: vm.workspaceId,
      path: 'apps/vm-sync-fixture',
      kind: 'app',
      settings: {},
      now: Date.now(),
    })
    const fixture = (await query(convex, 'domains/anchors/model:listForVm', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await hashApiKey(vm.vmToken),
    })) as GatewayAnchor[]
    const syncApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      runtimeReleaseDir: join(tmpdir(), 'missing-vm-sync-anchor-release'),
    })

    const response = await syncApp.request('/v1/vm/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${vm.vmToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceHint: vm.workspaceId,
        needsModelCredentials: false,
        versions: { runtime: '1.0.0', image: '1.0.0' },
        telemetry: { cpuPct: 12.5, memUsedMb: 256 },
      }),
    })

    expect(response.status).toBe(200)
    const body = VmSyncResponseSchema.parse(await response.json())
    expect(body.anchors).toEqual(fixture)
  })

  test('VM sync retains the complete runtime descriptor while rollout is paused', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'duet-vm-sync-active-'))
    try {
      const manifest = await writeRuntimeReleaseFixture(releaseDir)
      await convex.mutation('domains/workspaces/vmSync:setUpdatesPaused', {
        internalKey: INTERNAL_KEY,
        paused: false,
        now: Date.now(),
      })
      const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-active'))
      const syncApp = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        runtimeReleaseDir: releaseDir,
      })

      const active = await vmSyncRequest(syncApp, vm.vmToken)
      expect(active.status).toBe(200)
      expect(VmSyncResponseSchema.parse(await active.json()).updates).toEqual({
        paused: false,
      })

      await convex.mutation('domains/workspaces/vmSync:setUpdatesPaused', {
        internalKey: INTERNAL_KEY,
        paused: true,
        now: Date.now(),
      })
      const paused = await vmSyncRequest(syncApp, vm.vmToken)
      const pausedBody = VmSyncResponseSchema.parse(await paused.json())
      expect(pausedBody.updates).toEqual({ paused: true })
      expect(pausedBody.runtimeRelease?.version).toBe(manifest.version)
    } finally {
      await rm(releaseDir, { recursive: true, force: true })
    }
  })

  test('version drift is the update rail`s schedule, not a reason to poll fast', async () => {
    // A VM that cannot land its pinned CLI version would otherwise sprint on
    // the fast cadence forever — the 2026-08-18 staging saturation. The rail
    // paces its own install attempts; an otherwise-quiet workspace stays on
    // the idle cadence even while its reported versions lag the pin.
    await convex.mutation('domains/workspaces/vmSync:setUpdatesPaused', {
      internalKey: INTERNAL_KEY,
      paused: false,
      now: Date.now(),
    })
    const releaseDir = await mkdtemp(join(tmpdir(), 'duet-vm-sync-drift-'))
    try {
      await writeRuntimeReleaseFixture(releaseDir)
      const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-drift'))
      const syncApp = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        runtimeReleaseDir: releaseDir,
        vmSyncIntervalSeconds: 5,
        vmIdleSyncIntervalSeconds: 30,
      })

      // The reported runtime lags the available inventory.
      const response = await vmSyncRequest(syncApp, vm.vmToken, {
        versions: { runtime: '0.0.0+old', image: '1.0.0' },
      })
      expect(response.status).toBe(200)
      const body = VmSyncResponseSchema.parse(await response.json())
      expect((await rawWorkspace(vm.workspaceId)).runtimeVersion).toBe('0.0.0+old')
      expect(body.updates).toEqual({
        paused: false,
      })
      // The first poll of a fresh workspace legitimately rides the fast
      // cadence (it delivers the just-minted model credentials). The claim
      // under test is the settled state: still-drifting versions alone leave
      // the workspace on the idle cadence.
      const settled = await vmSyncRequest(syncApp, vm.vmToken, {
        versions: { runtime: '0.0.0+old', image: '1.0.0' },
      })
      expect(settled.status).toBe(200)
      expect(VmSyncResponseSchema.parse(await settled.json()).pollAfterMs).toBe(30_000)
    } finally {
      await rm(releaseDir, { recursive: true, force: true })
    }
  })

  test('twelve VM sync polls persist and drain parked input at most once', async () => {
    const slug = uniqueSlug('vm-sync-throttle')
    const begun = await prepareWorkspaceForHttpRegistration(slug, 'VM Sync Throttle')
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: unknown[] = []
    let persistedNow = Date.now() + 1_000
    const syncApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      runtimeReleaseDir: join(tmpdir(), 'missing-vm-sync-throttle-release'),
      now: () => ++persistedNow,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        return gatewayCalls.length === 1
          ? Response.json({ error: 'unauthorized' }, { status: 401 })
          : runnerInputReceipt(body, 'hydrated')
      },
    })
    const parked = await authedWith(syncApp, `/v1/ws/${slug}/agent/sessions`, agentKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'deliver on due sync only' }),
    })
    expect(parked.status).toBe(201)

    const registered = await syncApp.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: begun.provisioningToken,
        workspaceHint: begun.workspaceId,
        vmName: `duet-test-${slug}`,
        sshDest: `exedev@duet-test-${slug}.exe.xyz`,
        httpsUrl: `https://gateway-${slug}.exe.xyz`,
        runtimeVersion: '1.0.0',
        imageVersion: '1.0.0',
      }),
    })
    expect(registered.status).toBe(200)
    const registration = (await registered.json()) as { vmToken: string }
    const persistedHeartbeats: number[] = []

    for (let poll = 0; poll < 12; poll += 1) {
      const response = await vmSyncRequest(syncApp, registration.vmToken, {
        versions: { runtime: '2.0.0', image: '1.0.0' },
      })
      expect(response.status).toBe(200)
      VmSyncResponseSchema.parse(await response.json())
      persistedHeartbeats.push((await rawWorkspace(begun.workspaceId)).lastHeartbeatAt as number)
    }

    expect(new Set(persistedHeartbeats)).toEqual(new Set([persistedHeartbeats[0]!]))
    expect(gatewayCalls).toHaveLength(2)
  }, 60_000)

  // The sync poll is the single largest source of Convex function calls in
  // production — every VM, every few seconds, forever — so what one idle poll
  // costs is a fleet-wide number. Measured before this test existed: five
  // calls per poll, of which the train reconcile ran with an EMPTY batch and
  // the runner drain ran with nothing parked.
  test('an idle VM sync poll makes no train or drain calls', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-idle-calls'))
    const { client, called } = recordingConvexClient()
    const idleApp = createApiApp({
      convexUrl: convex.url,
      convexClient: client,
      internalKey: INTERNAL_KEY,
      runtimeReleaseDir: join(tmpdir(), 'missing-vm-sync-idle-calls-release'),
    })

    const response = await vmSyncRequest(idleApp, vm.vmToken)

    expect(response.status).toBe(200)
    expect(called).not.toContain('domains/train/model:reconcileFromVm')
    expect(called).not.toContain('domains/agentSessions/model:listRunnerInputDrainCandidates')
  })

  // THE BUDGET. What one idle VM costs in Convex function calls per minute is
  // (polls per minute) × (calls per poll): the gateway owns the first only by
  // obeying `pollAfterMs`, the API owns the second outright. This drives the
  // route exactly the way the gateway's sync loop does — poll, sleep for
  // `pollAfterMs`, poll again — on a fake clock, so it measures the product of
  // both factors under the real cadence policy. A regression in either one
  // fails it: an extra call per poll, or anything that holds an idle VM on the
  // fast cadence.
  //
  // The constant is a ratchet, never a target to grow into: it is set to what
  // the route costs today and lowered as calls are folded away. The goal is 3.
  test('an idle VM stays inside its Convex call budget', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-idle-budget'))
    const { client, called } = recordingConvexClient()
    let now = Date.now()
    const budgetApp = createApiApp({
      convexUrl: convex.url,
      convexClient: client,
      internalKey: INTERNAL_KEY,
      now: () => now,
      runtimeReleaseDir: join(tmpdir(), 'missing-vm-sync-idle-budget-release'),
    })

    // The first poll after registration is the boot handshake — it delivers the
    // model credential, which is activity, so it comes back on the fast
    // cadence. Let it happen, then measure from steady state.
    {
      const boot = await vmSyncRequest(budgetApp, vm.vmToken)
      expect(boot.status).toBe(200)
      now += VmSyncResponseSchema.parse(await boot.json()).pollAfterMs
      called.length = 0
    }
    const start = now
    const end = now + 10 * 60_000
    let polls = 0
    while (now < end) {
      const response = await vmSyncRequest(budgetApp, vm.vmToken)
      expect(response.status).toBe(200)
      const { pollAfterMs } = VmSyncResponseSchema.parse(await response.json())
      polls += 1
      // Each poll owns the interval that follows it, so the window closes when
      // the NEXT poll would be due — otherwise the poll at t=0 is charged to a
      // window that has not started.
      now += pollAfterMs
    }

    const simulatedMinutes = (now - start) / 60_000
    const callsPerMinute = called.length / simulatedMinutes
    expect(
      callsPerMinute,
      `${called.length} Convex calls over ${polls} polls in ${simulatedMinutes} simulated minutes: ${JSON.stringify(tally(called))}`,
    ).toBeLessThanOrEqual(IDLE_VM_CONVEX_CALLS_PER_MINUTE_BUDGET)
  }, 120_000)

  test('VM sync wraps requested model credentials and forbids response caching', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-credentials'))
    const syncApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      modelGatewayUrl: 'https://model-gateway.sync.test/',
      runtimeReleaseDir: join(tmpdir(), 'missing-vm-sync-credentials-release'),
    })

    const response = await vmSyncRequest(syncApp, vm.vmToken, {
      needsModelCredentials: true,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = VmSyncResponseSchema.parse(await response.json())
    expect(body.modelCredentials).toMatchObject({
      apiKey: expect.stringContaining('duet_sk_'),
      gatewayBaseUrl: 'https://model-gateway.sync.test',
      expiresAt: expect.any(Number),
    })
  })

  test('VM sync omits a model credential this deployment cannot address', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-no-model-rail'))
    // Backend delivery is unprompted — the workspace holds no live key, so one is
    // minted whether or not the VM asked. An API with no model rail has no
    // `gatewayBaseUrl` to complete the envelope, and a half-built credential
    // fails the VM's own response schema.
    const railless = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      runtimeReleaseDir: join(tmpdir(), 'missing-vm-sync-no-model-rail-release'),
    })

    const response = await vmSyncRequest(railless, vm.vmToken, {
      needsModelCredentials: false,
    })

    expect(response.status).toBe(200)
    expect(VmSyncResponseSchema.parse(await response.json()).modelCredentials).toBeUndefined()
  })

  test('VM sync delivers refreshed model credentials before draining parked runner input', async () => {
    const slug = uniqueSlug('vm-sync-credential-before-input')
    const vm = await provisionRegisteredWorkspace(slug)
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const syncApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      modelGatewayUrl: 'https://model-gateway.sync.test/',
      runtimeReleaseDir: join(tmpdir(), 'missing-vm-sync-credential-before-input-release'),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        return gatewayCalls.length === 1
          ? Response.json({ error: 'runner_unavailable' }, { status: 503 })
          : runnerInputReceipt(body, 'hydrated')
      },
    })

    const parked = await authedWith(syncApp, `/v1/ws/${slug}/agent/sessions`, agentKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'run after the refreshed key lands' }),
    })
    expect(parked.status).toBe(201)
    expect(gatewayCalls).toHaveLength(1)

    const credentialSync = await vmSyncRequest(syncApp, vm.vmToken, {
      needsModelCredentials: true,
    })
    expect(credentialSync.status).toBe(200)
    expect(VmSyncResponseSchema.parse(await credentialSync.json()).modelCredentials).toMatchObject({
      apiKey: expect.stringContaining('duet_sk_'),
      gatewayBaseUrl: 'https://model-gateway.sync.test',
    })
    expect(gatewayCalls).toHaveLength(1)

    const acknowledgedSync = await vmSyncRequest(syncApp, vm.vmToken)
    expect(acknowledgedSync.status).toBe(200)
    expect(gatewayCalls).toHaveLength(2)
    expect(gatewayCalls[1]?.input).toMatchObject({
      kind: 'prompt',
      message: composedRunnerMessage({
        seq: 2,
        body: 'run after the refreshed key lands',
      }),
    })
  }, 60_000)

  test('VM sync passes requested app credentials through and forbids response caching', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-app-credentials'))
    const registered = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: vm.workspaceId,
      path: 'apps/api-caller',
      command: 'bun run start',
      apiScopes: ['members'],
      slug: 'api-caller',
    })) as { id: string }

    const response = await vmSyncRequest(app, vm.vmToken, {
      needsAppCredentials: [registered.id],
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = VmSyncResponseSchema.parse(await response.json())
    expect(body.appCredentials).toEqual([
      {
        appId: registered.id,
        apiKey: expect.stringContaining('duet_sk_'),
        scopes: ['members'],
        expiresAt: expect.any(Number),
      },
    ])
  })

  test('VM sync emits complementary accepted-share snapshots without cacheable credentials', async () => {
    const source = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-share-source'))
    const recipient = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-share-recipient'))
    for (const [vm, syncthingDeviceId] of [
      [source, SYNCTHING_DEVICE_ID_ONE],
      [recipient, SYNCTHING_DEVICE_ID_TWO],
    ] as const) {
      const observed = await vmSyncRequest(app, vm.vmToken, {
        syncthingDeviceId,
      })
      expect(observed.status).toBe(200)
    }
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: source.workspaceId,
      toEmail: owner.user.email,
      path: 'projects/rail-proof',
      mode: 'read',
    })) as { share: { id: string } }
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: recipient.workspaceId,
      mountPath: 'shared/rail-proof',
    })

    const [sourceResponse, recipientResponse] = await Promise.all([
      vmSyncRequest(app, source.vmToken),
      vmSyncRequest(app, recipient.vmToken),
    ])
    for (const response of [sourceResponse, recipientResponse]) {
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }
    const sourceBody = VmSyncResponseSchema.parse(await sourceResponse.json())
    const recipientBody = VmSyncResponseSchema.parse(await recipientResponse.json())
    expect(sourceBody.shareSync?.shares).toEqual([
      expect.objectContaining({
        shareId: created.share.id,
        folder: expect.objectContaining({
          role: 'origin',
          path: 'projects/rail-proof',
        }),
      }),
    ])
    expect(recipientBody.shareSync?.shares).toEqual([
      expect.objectContaining({
        shareId: created.share.id,
        folder: expect.objectContaining({
          role: 'recipient',
          path: 'shared/rail-proof',
        }),
        mount: expect.objectContaining({ path: 'shared/rail-proof' }),
      }),
    ])
    expect(JSON.stringify({ sourceBody, recipientBody })).not.toContain('tokenSecret')
  })

  // Measured in production the first minute the fast-cadence log existed: 42%
  // of ALL sync polls were paused or banned workspaces on the five-second
  // cadence — 62 of them, forever, to be told "stay paused". A quiesce is a
  // state the gateway re-applies idempotently on every poll, not an exchange
  // with anything pending, so it is no more a reason to poll fast than version
  // drift is. Nothing a person waits on rides this: un-pausing is a billing
  // event the next poll picks up, and bringing apps back takes longer than the
  // poll interval anyway.
  test('a paused workspace polls no faster than an idle one', async () => {
    const idle = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-idle-peer'))
    const paused = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-paused'))
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: paused.workspaceId,
      servicingStatus: 'paused',
      now: Date.now(),
    })
    const cadenceApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      runtimeReleaseDir: join(tmpdir(), 'missing-vm-sync-paused-cadence-release'),
    })
    // First polls deliver credentials and are fast for both; the second poll is
    // the steady state this test is about. The paused VM keeps ASKING for a
    // model credential — that is what a real paused VM does, since it is
    // refused one every time — and the request must not count as activity.
    const settle = async (vmToken: string, body: Record<string, unknown> = {}) => {
      await vmSyncRequest(cadenceApp, vmToken, body)
      return VmSyncResponseSchema.parse(
        await (await vmSyncRequest(cadenceApp, vmToken, body)).json(),
      )
    }

    const idleResponse = await settle(idle.vmToken)
    const pausedResponse = await settle(paused.vmToken, { needsModelCredentials: true })

    expect(pausedResponse.quiesce).toBe(true)
    expect(pausedResponse.pollAfterMs).toBe(idleResponse.pollAfterMs)
  })

  // The projection is one Convex query, so a pause cannot land between the
  // roster and the shares: a paused poll is a whole quiesced snapshot, and the
  // first poll after un-pausing is a whole live one. (This used to be two
  // queries with a race between them that the route had to detect and paper
  // over; the race no longer has anywhere to happen.)
  test('a paused poll is a whole quiesced snapshot, and un-pausing heals on the next poll', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-pause'))
    await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: vm.workspaceId,
      path: 'projects/pause',
      kind: 'publish',
      settings: {},
    })
    const pauseApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      appUrl: 'http://localhost:3000',
    })
    const setServicing = async (servicingStatus: 'paused' | 'active') =>
      await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: vm.workspaceId,
        servicingStatus,
        now: Date.now(),
      })

    await setServicing('paused')
    const paused = VmSyncResponseSchema.parse(
      await (await vmSyncRequest(pauseApp, vm.vmToken)).json(),
    )
    expect(paused).toMatchObject({
      quiesce: true,
      anchors: [],
      agents: [],
      apps: [],
      shareSync: { shares: [] },
    })

    await setServicing('active')
    const healed = VmSyncResponseSchema.parse(
      await (await vmSyncRequest(pauseApp, vm.vmToken)).json(),
    )
    expect(healed.quiesce).toBe(false)
    expect(healed.anchors.map(anchor => anchor.path)).toContain('projects/pause')
  })

  test('VM sync degrades to a paused-shaped 200 when the baked manifest is unreadable', async () => {
    await convex.mutation('domains/workspaces/vmSync:setUpdatesPaused', {
      internalKey: INTERNAL_KEY,
      paused: false,
      now: Date.now(),
    })
    const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-degraded'))
    const syncApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      runtimeReleaseDir: join(tmpdir(), 'missing-vm-sync-degraded-release'),
    })

    const response = await vmSyncRequest(syncApp, vm.vmToken)

    expect(response.status).toBe(200)
    const body = VmSyncResponseSchema.parse(await response.json())
    expect(body.runtimeRelease).toBeUndefined()
    expect(body.updates).toEqual({ paused: true })
  })

  test('VM sync degrades when the baked manifest version is not exact semver', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'duet-vm-sync-invalid-version-'))
    try {
      const manifest = await writeRuntimeReleaseFixture(releaseDir)
      await writeFile(
        join(releaseDir, 'manifest.json'),
        JSON.stringify({ ...manifest, version: 'next' }),
      )
      const vm = await provisionRegisteredWorkspace(uniqueSlug('vm-sync-invalid-version'))
      const syncApp = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        runtimeReleaseDir: releaseDir,
      })

      const response = await vmSyncRequest(syncApp, vm.vmToken)

      expect(response.status).toBe(200)
      const body = VmSyncResponseSchema.parse(await response.json())
      expect(body.runtimeRelease).toBeUndefined()
      expect(body.updates).toEqual({ paused: true })
    } finally {
      await rm(releaseDir, { recursive: true, force: true })
    }
  })

  test('VM register embeds the initial sync snapshot and API-owned interval', async () => {
    const begun = await prepareWorkspaceForHttpRegistration(
      uniqueSlug('vm-register-sync'),
      'VM Register Sync',
    )
    const registerApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      runtimeReleaseDir: join(tmpdir(), 'missing-vm-register-sync-release'),
      modelGatewayUrl: 'https://model-gateway.register.test/',
      vmSyncIntervalSeconds: 7,
      approvedModelCatalog: skillsFixtureCatalog(),
    })

    const response = await registerApp.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: begun.provisioningToken,
        workspaceHint: begun.workspaceId,
        runtimeVersion: '2.3.4',
        // The frozen first-adoption client still sends this equal alias.
        gatewayVersion: '2.3.4',
        imageVersion: '1.0.0',
      }),
    })

    expect(response.status).toBe(200)
    expect((await rawWorkspace(begun.workspaceId)).runtimeVersion).toBe('2.3.4')
    expect(await rawWorkspace(begun.workspaceId)).not.toHaveProperty('gatewayVersion')
    expect(await rawWorkspace(begun.workspaceId)).not.toHaveProperty('agentVersion')
    expect(await rawWorkspace(begun.workspaceId)).not.toHaveProperty('duetfsVersion')
    const rawBody = (await response.json()) as Record<string, unknown>
    expect(Object.keys(rawBody).sort()).toEqual([
      'restore',
      'sync',
      'syncIntervalSeconds',
      'vmToken',
      'vmTokenPrefix',
    ])
    const body = VmRegisterResponseSchema.parse(rawBody)
    expect(body.syncIntervalSeconds).toBe(7)
    expect(body.sync.pollAfterMs).toBe(7_000)
    expect(body.sync.anchors).toEqual([])
    expect(body.sync.shareSync).toEqual({ shares: [] })
    expect(body.sync.skills).toEqual({
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      url: `http://localhost/v1/vm/skills/${body.sync.skills?.hash}`,
    })
    expect(body.sync.modelCredentials).toMatchObject({
      apiKey: expect.stringContaining('duet_sk_'),
      gatewayBaseUrl: 'https://model-gateway.register.test',
      expiresAt: expect.any(Number),
    })
  })

  test('VM register still delivers its minted token when the initial projection refuses', async () => {
    const begun = await prepareWorkspaceForHttpRegistration(
      uniqueSlug('vm-register-projection-refusal'),
      'VM Register Projection Refusal',
    )
    await mutate(owner.client, 'testing/apps:seedWorkspaceAppsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: begun.workspaceId,
      createdByUserId: owner.user._id,
      count: 101,
      matchingPath: 'apps',
    })

    const response = await app.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: begun.provisioningToken,
        workspaceHint: begun.workspaceId,
        runtimeVersion: '1.0.0',
        imageVersion: '1.0.0',
      }),
    })

    expect(response.status).toBe(200)
    const body = VmRegisterResponseSchema.parse(await response.json())
    expect(body.vmToken).toStartWith('duet_vm_')
    expect(body.sync.apps).toEqual([])
    expect(body.sync.shareSync).toEqual({ shares: [] })
  })

  test('VM register delivers its committed token through every post-commit failure seam', async () => {
    for (const seam of [
      'core_projection',
      'release',
      'skills',
      'restore_url',
      'composition',
      'serialization',
    ] as const) {
      const begun = await prepareWorkspaceForHttpRegistration(
        uniqueSlug(`vm-register-${seam.replace('_', '-')}`),
        `VM Register ${seam}`,
      )
      const faultingApp = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        appUrl: 'http://localhost:3000',
        vmRegistrationPostCommitTestHooks: {
          before: reached => {
            if (reached === seam) throw new Error(`injected ${seam}`)
          },
        },
      })

      const response = await faultingApp.request('/v1/vm/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provisioningToken: begun.provisioningToken,
          workspaceHint: begun.workspaceId,
          runtimeVersion: '1.0.0',
          imageVersion: '1.0.0',
        }),
      })

      expect(response.status, seam).toBe(200)
      expect(response.headers.get('cache-control'), seam).toBe('private, no-store')
      const body = VmRegisterResponseSchema.parse(await response.json())
      expect(body.vmToken, seam).toStartWith('duet_vm_')
      expect(body.restore, seam).toBeNull()
      expect(body.sync, seam).toMatchObject({
        anchors: [],
        agents: [],
        apps: [],
        shareSync: { shares: [] },
        updates: { paused: true },
      })
    }
  })

  test('VM register fallback preserves a committed birth seed handoff', async () => {
    const uploadUrl = (await mutate(convex, 'testing/seedDrive:generateSeedBundleUploadUrl', {
      internalKey: INTERNAL_KEY,
    })) as string
    const contents = 'birth seed archive'
    const sha256 = createHash('sha256').update(contents).digest('hex')
    const upload = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-tar' },
      body: contents,
    })
    expect(upload.ok).toBe(true)
    const { storageId } = (await upload.json()) as { storageId: string }
    try {
      await mutate(convex, 'testing/seedDrive:recordSeedBundle', {
        internalKey: INTERNAL_KEY,
        storageId,
        sha256,
      })
      const begun = await prepareWorkspaceForHttpRegistration(
        uniqueSlug('vm-register-restore-fallback'),
        'VM Register Restore Fallback',
      )
      await mutate(convex, 'testing/seedDrive:seedWorkspaceAtBirthForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: begun.workspaceId,
        actorId: owner.user._id,
        now: Date.now(),
      })
      const faultingApp = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        appUrl: 'http://localhost:3000',
        vmRegistrationPostCommitTestHooks: {
          before: seam => {
            if (seam === 'restore_url') throw new Error('injected restore URL failure')
          },
        },
      })
      const response = await faultingApp.request('/v1/vm/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provisioningToken: begun.provisioningToken,
          workspaceHint: begun.workspaceId,
          runtimeVersion: '1.0.0',
          imageVersion: '1.0.0',
        }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      const body = VmRegisterResponseSchema.parse(await response.json())
      expect(body.restore).toMatchObject({ kind: 'birth-seed', sha256 })
      if (body.restore?.kind !== 'birth-seed') throw new Error('Missing birth seed')
      const archive = await fetch(body.restore.url)
      expect(archive.status).toBe(200)
      expect(await archive.text()).toBe(contents)
    } finally {
      await mutate(convex, 'testing/seedDrive:clearCurrentSeedBundleForTest', {
        internalKey: INTERNAL_KEY,
      })
      await mutate(convex, 'testing/seedDrive:deleteSeedStorageForTest', {
        internalKey: INTERNAL_KEY,
        storageId,
      })
    }
  })

  test('VM register answers a committed registration with its token even when the mutation result is not the shape this API expects', async () => {
    // 2026-08-29: one Vercel build deploys Convex, then promotes the API, so a
    // release that changes registerVm's result shape serves new Convex to the
    // old API for the build's duration. The old guard rejected the committed
    // result and answered 401 — the VM's token was spent and it re-registered
    // every five minutes for days. A commit must always come back as a token.
    const begun = await prepareWorkspaceForHttpRegistration(
      uniqueSlug('vm-register-skewed-result'),
      'VM Register Skewed Result',
    )
    const skewedApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      appUrl: 'http://localhost:3000',
      vmRegistrationPostCommitTestHooks: {
        // The pre-a384c90d9 result: no workspaceId/workspaceSlug, a syncState blob.
        committedResult: result => {
          const { vmToken, vmTokenPrefix, restore } = result as Record<string, unknown>
          return { vmToken, vmTokenPrefix, restore, syncState: { legacy: true } }
        },
      },
    })

    const response = await skewedApp.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: begun.provisioningToken,
        workspaceHint: begun.workspaceId,
        runtimeVersion: '1.0.0',
        imageVersion: '1.0.0',
      }),
    })

    expect(response.status).toBe(200)
    const body = VmRegisterResponseSchema.parse(await response.json())
    // The delivered token is the committed one: it authenticates the VM's first sync.
    const sync = await vmSyncRequest(skewedApp, body.vmToken, {
      versions: { runtime: '1.0.0', image: '1.0.0' },
    })
    expect(sync.status).toBe(200)
  })

  test('VM register keeps pre-commit credential failures unauthorized', async () => {
    const begun = await prepareWorkspaceForHttpRegistration(
      uniqueSlug('vm-register-invalid-credential'),
      'VM Register Invalid Credential',
    )
    const response = await app.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: `${begun.provisioningToken}-wrong`,
        workspaceHint: begun.workspaceId,
      }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  test('a provisioning workspace answers the files proxy as provisioning, not as missing', async () => {
    const slug = uniqueSlug('files-provisioning')
    await prepareWorkspaceForHttpRegistration(slug, 'Files While Provisioning')
    const key = await issueKey(owner.client)

    // The workspace row exists but its gateway has not registered. A caller
    // must be able to tell "wait and retry" from "no such workspace": the
    // answer is the typed provisioning refusal, never `not_found`.
    const response = await authed(`/v1/ws/${slug}/files?list=1`, key.key)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'workspace_provisioning' })
  })

  test('workspace create returns before attach and status advances after VM registration', async () => {
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
        plan: 'pro',
      },
    )
    const key = await issueKey(owner.client)
    const beforeWhoami = await authed('/v1/whoami', key.key)
    expect(beforeWhoami.status).toBe(200)
    const beforeIdentity = WhoamiResponseSchema.parse(await beforeWhoami.json())
    const slug = uniqueSlug('api-create')

    const response = await app.request('/v1/workspaces', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        slug,
        name: 'Created Over API',
        imageRef: 'ignored-by-api',
      }),
    })

    expect(response.status).toBe(202)
    const created = WorkspaceCreateResultSchema.parse(await response.json())
    expect(created).toEqual({
      workspaceId: expect.any(String),
      slug,
      status: 'provisioning',
    })
    expect(await rawWorkspace(created.workspaceId)).toMatchObject({
      slug,
      name: 'Created Over API',
      createdByUserId: owner.user._id,
      status: 'provisioning',
    })

    await eventually(async () => {
      const row = await rawWorkspace(created.workspaceId)
      expect(row).toMatchObject({
        imageRef: IMAGE_REF,
        vmName: expect.any(String),
        vmTokenNonce: expect.any(String),
      })
      expect(row).not.toHaveProperty('vmAttachRunId')
      const events = await auditEvents(owner.client, created.workspaceId)
      expect(events.filter(event => event.event === 'workspace.vm_attach_scheduled')).toHaveLength(
        1,
      )
      expect(events.filter(event => event.event === 'workspace.vm_attached')).toHaveLength(1)
    })

    const provisioningWhoami = await authed('/v1/whoami', key.key)
    expect(provisioningWhoami.status).toBe(200)
    const provisioningIdentity = WhoamiResponseSchema.parse(await provisioningWhoami.json())
    expect(provisioningIdentity.workspaces.map(workspace => workspace.id).sort()).toEqual(
      [...beforeIdentity.workspaces.map(workspace => workspace.id), created.workspaceId].sort(),
    )
    expect(
      provisioningIdentity.workspaces.filter(workspace => workspace.id === created.workspaceId),
    ).toEqual([
      expect.objectContaining({
        id: created.workspaceId,
        slug,
        name: 'Created Over API',
        role: 'owner',
        status: 'provisioning',
      }),
    ])

    const provisioningToken = `register-${slug}`
    const now = Date.now()
    const attached = await rawWorkspace(created.workspaceId)
    await mutate(owner.client, 'testing/workspaces:prepareWorkspaceForRegistration', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: created.workspaceId,
      slug,
      name: 'Created Over API',
      imageRef: IMAGE_REF,
      provisioningTokenHash: await hashApiKey(provisioningToken),
      provisioningTokenExpiresAt: now + 60_000,
      now,
    })
    const registered = await app.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken,
        workspaceHint: created.workspaceId,
        vmName: attached.vmName,
        sshDest: attached.sshDest,
        httpsUrl: attached.httpsUrl,
      }),
    })
    expect(registered.status).toBe(200)

    const activeWhoami = await authed('/v1/whoami', key.key)
    expect(activeWhoami.status).toBe(200)
    const activeIdentity = WhoamiResponseSchema.parse(await activeWhoami.json())
    expect(activeIdentity.workspaces.map(workspace => workspace.id).sort()).toEqual(
      provisioningIdentity.workspaces.map(workspace => workspace.id).sort(),
    )
    expect(
      activeIdentity.workspaces.filter(workspace => workspace.id === created.workspaceId),
    ).toEqual([
      expect.objectContaining({
        id: created.workspaceId,
        slug,
        name: 'Created Over API',
        role: 'owner',
        status: 'active',
      }),
    ])
    expect(
      await query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug,
      }),
    ).toMatchObject({
      workspaceId: created.workspaceId,
      vmName: attached.vmName,
    })
  }, 60_000)

  test('VM register drains provisioning agent turns in order exactly once', async () => {
    // The launch tier follows the payer's plan, and this asserts the default
    // one. An earlier test in this file leaves the shared owner on `pro`
    // (whose default is `balanced`), so the plan is stated here rather than
    // inherited — the assertion is about draining turns, not about billing.
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, plan: 'starter' },
    )
    const slug = uniqueSlug('register-agent-drain')
    const begun = await prepareWorkspaceForHttpRegistration(slug, 'Register Agent Drain')
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const drainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        return runnerInputReceipt(body)
      },
    })
    const parkedSessionIds: string[] = []

    for (const prompt of ['first parked turn', 'second parked turn']) {
      const parked = await authedWith(drainApp, `/v1/ws/${slug}/agent/sessions`, agentKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      expect(parked.status).toBe(201)
      const parkedBody = (await parked.json()) as {
        session: { sessionId: string }
        dispatched: boolean
        error?: unknown
      }
      expect(parkedBody.dispatched).toBe(false)
      expect(parkedBody.error).toBeUndefined()
      parkedSessionIds.push(parkedBody.session.sessionId)
    }
    expect(gatewayCalls).toEqual([])

    const registered = await drainApp.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: begun.provisioningToken,
        workspaceHint: begun.workspaceId,
        vmName: 'duet-test-register-agent-drain',
        sshDest: 'exedev@duet-test-register-agent-drain.exe.xyz',
        httpsUrl: 'https://gateway-register-agent-drain.exe.xyz',
      }),
    })

    expect(registered.status).toBe(200)
    expect(gatewayCalls).toEqual([
      expectedRunnerInput({
        throughSeq: 2,
        message: 'first parked turn',
        behavior: 'steer',
      }),
      expectedRunnerInput({
        throughSeq: 2,
        message: 'second parked turn',
        behavior: 'steer',
      }),
    ])
  }, 60_000)

  test('VM register delivers initial model credentials before draining provisioning input', async () => {
    const slug = uniqueSlug('register-credential-before-input')
    const begun = await prepareWorkspaceForHttpRegistration(slug, 'Register Credential First')
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const registerApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      modelGatewayUrl: 'https://model-gateway.register.test/',
      runtimeReleaseDir: join(tmpdir(), 'missing-register-credential-before-input-release'),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        return runnerInputReceipt(body)
      },
    })
    const parked = await authedWith(registerApp, `/v1/ws/${slug}/agent/sessions`, agentKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'run after registration credentials land',
      }),
    })
    expect(parked.status).toBe(201)
    expect(gatewayCalls).toBeEmpty()

    const registered = await registerApp.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: begun.provisioningToken,
        workspaceHint: begun.workspaceId,
        vmName: `duet-test-${slug}`,
        sshDest: `exedev@duet-test-${slug}.exe.xyz`,
        httpsUrl: `https://gateway-${slug}.exe.xyz`,
        runtimeVersion: '1.0.0',
        imageVersion: '1.0.0',
      }),
    })
    expect(registered.status).toBe(200)
    const registration = VmRegisterResponseSchema.parse(await registered.json())
    expect(registration.sync.modelCredentials).toMatchObject({
      apiKey: expect.stringContaining('duet_sk_'),
      gatewayBaseUrl: 'https://model-gateway.register.test',
    })
    expect(gatewayCalls).toBeEmpty()

    const acknowledgedSync = await vmSyncRequest(registerApp, registration.vmToken)
    expect(acknowledgedSync.status).toBe(200)
    expect(gatewayCalls).toHaveLength(1)
    expect(gatewayCalls[0]?.input).toMatchObject({
      kind: 'prompt',
      message: composedRunnerMessage({
        seq: 2,
        body: 'run after registration credentials land',
      }),
    })
  }, 60_000)

  test('VM register with no parked agent turns makes no gateway dispatch', async () => {
    const slug = uniqueSlug('register-agent-empty')
    const begun = await prepareWorkspaceForHttpRegistration(slug, 'Register Agent Empty')
    const gatewayCalls: unknown[] = []
    const drainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        gatewayCalls.push(init)
        return Response.json({ ok: true })
      },
    })

    const registered = await drainApp.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: begun.provisioningToken,
        workspaceHint: begun.workspaceId,
        vmName: 'duet-test-register-agent-empty',
        sshDest: 'exedev@duet-test-register-agent-empty.exe.xyz',
        httpsUrl: 'https://gateway-register-agent-empty.exe.xyz',
      }),
    })

    expect(registered.status).toBe(200)
    expect(gatewayCalls).toEqual([])
  }, 60_000)

  test('VM register agent drain respects the existing delivery cap', async () => {
    const slug = uniqueSlug('register-agent-limit')
    const begun = await prepareWorkspaceForHttpRegistration(slug, 'Register Agent Limit')
    const agentKey = await issueKey(owner.client)
    const gatewayPrompts: string[] = []
    const drainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        if (body.input.kind === 'prompt') gatewayPrompts.push(body.input.message)
        return runnerInputReceipt(body)
      },
    })
    const sessionIds: string[] = []
    for (let index = 0; index < 11; index += 1) {
      const parked = await authedWith(drainApp, `/v1/ws/${slug}/agent/sessions`, agentKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: `parked turn ${index}` }),
      })
      sessionIds.push(
        ((await parked.json()) as { session: { sessionId: string } }).session.sessionId,
      )
    }

    const registered = await drainApp.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: begun.provisioningToken,
        workspaceHint: begun.workspaceId,
        vmName: 'duet-test-register-agent-limit',
        sshDest: 'exedev@duet-test-register-agent-limit.exe.xyz',
        httpsUrl: 'https://gateway-register-agent-limit.exe.xyz',
      }),
    })

    expect(registered.status).toBe(200)
    expect(gatewayPrompts).toEqual(
      Array.from({ length: 10 }, (_, index) =>
        composedRunnerMessage({ seq: 2, body: `parked turn ${index}` }),
      ),
    )
    const stillParked = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      workspaceId: begun.workspaceId,
      sessionId: sessionIds[10]!,
    })) as { lastDeliveredInputSeq: number }
    expect(stillParked.lastDeliveredInputSeq).toBe(0)
  }, 60_000)

  test('an optional file read answers a missing path with 204, and the gateway never sees the flag', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('files-optional'))
    const readKey = await issueKey(owner.client)
    const gatewayUrls: string[] = []
    const proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        const url = String(input)
        gatewayUrls.push(url)
        if (url.endsWith('/v1/files/agents/research/AGENTS.md'))
          return new Response('# Research', { status: 200, headers: { etag: '"v1"' } })
        return Response.json({ error: 'not_found' }, { status: 404 })
      },
    })
    const read = (path: string) =>
      authedWith(proxyApp, `/v1/ws/${proxied.slug}/files/${path}`, readKey.key)

    // A missing optional file or folder is an answer, not an error: 204 with no
    // body, so a browser reading a purely optional file logs nothing.
    const missingFile = await read('agents/research/agent.json?optional=1')
    expect(missingFile.status).toBe(204)
    expect(await missingFile.text()).toBe('')
    const missingFolder = await read('agents/research/.agents/skills?list=1&optional=1')
    expect(missingFolder.status).toBe(204)
    // A present file travels exactly as before.
    const present = await read('agents/research/AGENTS.md?optional=1')
    expect(present.status).toBe(200)
    expect(await present.text()).toBe('# Research')
    // Without the flag, missing stays 404 — the drive's ordinary answer.
    const required = await read('agents/research/agent.json')
    expect(required.status).toBe(404)
    expect(await required.json()).toEqual({ error: 'not_found' })

    // The flag is the API's to honour; the gateway parses its query strictly
    // and must only ever see the parameters it owns.
    expect(gatewayUrls.map(url => url.slice(url.indexOf('/v1/files')))).toEqual([
      '/v1/files/agents/research/agent.json',
      '/v1/files/agents/research/.agents/skills?list=1',
      '/v1/files/agents/research/AGENTS.md',
      '/v1/files/agents/research/agent.json',
    ])
  })

  test('SUBS-IMPL-FIX23 returns workspace_paused for authorized paused data-plane requests', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('files-paused'))
    const readKey = await issueKey(owner.client)
    const memoryKey = await issueKey(owner.client)
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      servicingStatus: 'paused',
      now: Date.now(),
    })
    let gatewayRequests = 0
    const pausedApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => {
        gatewayRequests += 1
        return Response.json({ unexpected: true })
      },
    })

    const response = await authedWith(pausedApp, `/v1/ws/${proxied.slug}/files?list=1`, readKey.key)

    expect(response.status).toBe(402)
    expect(await response.json()).toEqual({ error: 'workspace_paused' })
    const trainResponse = await authedWith(
      pausedApp,
      `/v1/ws/${proxied.slug}/train`,
      memoryKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls: ['https://example.com/paused'] }),
      },
    )
    expect(trainResponse.status).toBe(402)
    expect(await trainResponse.json()).toEqual({ error: 'workspace_paused' })
    expect(gatewayRequests).toBe(0)
  })

  test('vm file-events ingest is vm-token gated, schema validated, and derives its workspace from VM auth', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('file-events'))
    const otherVm = await provisionRegisteredWorkspace(uniqueSlug('file-events-other'))
    const batch = {
      batchId: 'slice03-batch-1',
      events: [
        {
          kind: 'write',
          path: 'docs/a.txt',
          actor: 'api-key:abc123',
          at: 1_000,
        },
        { kind: 'read', path: 'docs/a.txt', actor: 'web:user123', at: 2_000 },
      ],
      droppedReads: 0,
      overflow: 0,
    }

    const noToken = await app.request('/v1/vm/file-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    })
    expect(noToken.status).toBe(401)

    const badToken = await app.request('/v1/vm/file-events', {
      method: 'POST',
      headers: {
        authorization: 'Bearer not-a-vm-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(batch),
    })
    expect(badToken.status).toBe(401)

    for (const invalid of [
      {},
      { ...batch, batchId: '' },
      {
        ...batch,
        events: [{ kind: 'write', path: '/absolute', actor: 'web:u', at: 1 }],
      },
      {
        ...batch,
        events: [{ kind: 'write', path: 'a.txt', actor: 'nonsense actor', at: 1 }],
      },
      { ...batch, droppedReads: -1 },
    ]) {
      const rejected = await app.request('/v1/vm/file-events', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${vm.vmToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(invalid),
      })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({ error: 'invalid_request' })
    }

    // The payload cannot choose its workspace: a smuggled workspaceId is
    // accepted-and-ignored, and the events land under the authenticated VM's
    // workspace, which the recorded rows below prove. Ingest parses tolerantly
    // on purpose — this wire carries a VM gateway that updates on its own
    // schedule, and a strict parser turns every field the producer adds into a
    // rejected batch until the API catches up.
    const accepted = await app.request('/v1/vm/file-events', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${vm.vmToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...batch, workspaceId: otherVm.workspaceId }),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({
      deduped: false,
      appended: 2,
      lastSeq: 2,
    })

    const recorded = (await convex.query('testing/fileActivity:rawFileEventsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: vm.workspaceId,
    })) as Array<{ path?: string; actorContext: string }>
    expect(recorded.map(event => event.actorContext)).toEqual(['api-key:abc123', 'web:user123'])
    expect(
      (await convex.query('testing/fileActivity:rawFileEventsForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: otherVm.workspaceId,
      })) as unknown[],
    ).toEqual([])

    // Relay retries reuse the batch id and dedupe instead of double-writing.
    const retried = await app.request('/v1/vm/file-events', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${vm.vmToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(batch),
    })
    expect(retried.status).toBe(200)
    expect(await retried.json()).toEqual({
      deduped: true,
      appended: 0,
      lastSeq: 2,
    })
  })
})

/**
 * Convex function calls one idle VM may cost per minute. A ratchet: set to what
 * the sync route costs today, lowered each time a call is folded away, never
 * raised to make room. Today: one projection read and one persist per poll,
 * one poll every five minutes — 0.4 a minute.
 */
const IDLE_VM_CONVEX_CALLS_PER_MINUTE_BUDGET = 1

/** A real Convex client that also records every function it was asked to run. */
function recordingConvexClient(): { client: ConvexHttpClient; called: string[] } {
  const called: string[] = []
  const real = new ConvexHttpClient(convex.url, {
    logger: false,
    skipConvexDeploymentUrlCheck: true,
  })
  const client = new Proxy(real, {
    get(target, property, receiver) {
      if (property !== 'query' && property !== 'mutation') {
        return Reflect.get(target, property, receiver)
      }
      return (reference: unknown, args: unknown) => {
        called.push(getFunctionName(reference as never))
        return (target[property] as (r: unknown, a: unknown) => Promise<unknown>).call(
          target,
          reference,
          args,
        )
      }
    },
  })
  return { client, called }
}

function tally(names: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1
  return counts
}
