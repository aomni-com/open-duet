import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'

import { hashApiKey, SERVICING_ARCHIVE_AFTER_MS, workspaceVmCapsForPlan } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  settleWorkspaceProvisioning,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { workspaceVmCreateOptions } from '../convex/domains/workspaces/vmAttach'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-api-internal-key'
const IMAGE_REF = 'ttl.sh/duet-test-slice04:1h'

let convex: ConvexDevFixture
let owner: SignedInUser
let sequence = 0

test('workspace VM create options pin bounded exe.dev caps', () => {
  const vmCaps = workspaceVmCapsForPlan(undefined)
  expect(
    workspaceVmCreateOptions({
      imageRef: IMAGE_REF,
      vmDiskGb: 28,
      vmCaps,
      registryAuth: 'user:pass',
      tags: ['duet-workspace'],
      env: ['DUET_WORKSPACE_HINT=workspace-id'],
    }),
  ).toMatchObject({
    image: IMAGE_REF,
    // Derived, not restated: this pins that create options CARRY the caps.
    // Duplicating the numbers here made a legitimate cap change look like a
    // regression, and the floor itself is owned by vm-caps-floor.test.ts.
    cpu: vmCaps.cpu,
    memory: vmCaps.memory,
    disk: '28GB',
    command: 'auto',
    registryAuth: 'user:pass',
  })
})

describe('workspace provisioning model', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys({ kid: 'test-key', alg: 'RS256' }),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_EDGE_INTERNAL_KEY: 'edge-secret',
        DUET_API_URL: 'http://api.example',
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_TEST_FAKE_EXE: '1',
        DUET_VM_IMAGE_REF: IMAGE_REF,
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('provision-owner'),
      'Provision Owner',
    )
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('provisioning tokens are hashed, replayable until the first sync, then spent', async () => {
    const now = 10_000
    const workspace = await prepareWorkspaceForRegistration(
      'single-use',
      'secret-token',
      now,
      now + 60_000,
    )
    const rawBefore = await rawWorkspace(workspace.workspaceId)
    expect(rawBefore.provisioningTokenHash).not.toBe('secret-token')

    const registered = await register(workspace.workspaceId, 'secret-token', now + 1_000)
    expect(registered.vmToken).toStartWith('duet_vm_')

    // The VM holds nothing but its provisioning token. If the API commits the
    // registration and then loses the response (2026-08-29: a deploy-window
    // contract skew answered two committed registrations with 401), a
    // single-use token bricks the workspace forever. Until the VM's first sync
    // proves the token landed, replaying the provisioning token hands back the
    // SAME VM token and counts as a fresh heartbeat.
    const replayed = await register(workspace.workspaceId, 'secret-token', now + 2_000)
    expect(replayed.vmToken).toBe(registered.vmToken)
    expect(await rawWorkspace(workspace.workspaceId)).toMatchObject({
      status: 'active',
      lastHeartbeatAt: now + 2_000,
    })
    const events = await auditEvents(workspace.workspaceId)
    expect(events.filter(event => event.event === 'workspace.vm_registered')).toHaveLength(1)
    expect(events.filter(event => event.event === 'workspace.vm_reregistered')).toHaveLength(1)

    // The first sync closes the door: from here the token is spent, and every
    // refusal names the workspace (a stuck VM retries every five minutes forever;
    // the log line is the only clue to which one).
    await syncObservation(registered.vmToken, now + 61_000)
    await expect(register(workspace.workspaceId, 'secret-token', now + 62_000)).rejects.toThrow(
      new RegExp(`already used.*${workspace.workspaceId}`),
    )
    await expect(register(workspace.workspaceId, 'wrong-token', now + 2_500)).rejects.toThrow(
      new RegExp(`Invalid provisioning token.*${workspace.workspaceId}`),
    )

    const expired = await prepareWorkspaceForRegistration('expired', 'expired-token', now, now - 1)
    await expect(register(expired.workspaceId, 'expired-token', now + 1)).rejects.toThrow(
      new RegExp(`expired.*${expired.workspaceId}`),
    )
  })

  test('a registration replay recovers a workspace the health sweep already marked unhealthy', async () => {
    // The prod shape: the VM never got its response, so it never synced; two
    // minutes later the sweep flipped the row to `unhealthy`, and every retry
    // from then on was refused as "Workspace is unhealthy" — for days.
    const now = 10_000
    const workspace = await prepareWorkspaceForRegistration(
      'replay-unhealthy',
      'replay-token',
      now,
      now + 60_000,
    )
    const registered = await register(workspace.workspaceId, 'replay-token', now + 1_000)
    const stale = (await mutate(convex, 'domains/workspaces/provisioning:markUnhealthyWorkspaces', {
      internalKey: INTERNAL_KEY,
      now: now + 121_001,
      staleAfterMs: 120_000,
    })) as { changed: string[] }
    expect(stale.changed).toContain(workspace.workspaceId)

    const replayed = await register(workspace.workspaceId, 'replay-token', now + 300_000)
    expect(replayed.vmToken).toBe(registered.vmToken)
    expect(await rawWorkspace(workspace.workspaceId)).toMatchObject({
      status: 'active',
      lastHeartbeatAt: now + 300_000,
    })
    const reregistered = (await auditEvents(workspace.workspaceId)).filter(
      event => event.event === 'workspace.vm_reregistered',
    )
    expect(reregistered).toHaveLength(1)
    expect(reregistered[0]!.provenance).toMatchObject({ previousStatus: 'unhealthy' })
    // The replayed token still authenticates the VM's first sync.
    await syncObservation(registered.vmToken, now + 361_000)
    expect((await rawWorkspace(workspace.workspaceId)).lastHeartbeatAt).toBe(now + 361_000)
  })

  test('VM registration clears a credential retry boundary inherited from the previous VM', async () => {
    const now = 11_000
    const workspace = await prepareWorkspaceForRegistration(
      'registration-retry',
      'registration-credential-retry-token',
      now,
      now + 60_000,
    )
    await mutate(convex, 'testing/workspaces:setVmModelCredentialRetryForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      retryAt: now + 24 * 60 * 60 * 1000,
      scopeKey: 'previous-vm-scope-set',
    })

    await register(workspace.workspaceId, 'registration-credential-retry-token', now + 1_000)
    const registered = await rawWorkspace(workspace.workspaceId)
    expect(registered.vmModelCredentialRetryAt).toBeUndefined()
    expect(registered.vmModelCredentialRetryScopeKey).toBeUndefined()
  })

  test('gateway resolution distinguishes a provisioning workspace from a missing one', async () => {
    const now = 12_000
    const slug = uniqueSlug('resolution-provisioning')
    const workspace = await prepareWorkspaceForRegistration(
      'resolution-provisioning',
      'resolution-token',
      now,
      now + 60_000,
      slug,
    )

    // Before the VM registers, the workspace is real but has no runtime: the
    // resolution is a typed retryable refusal. `null` is reserved for slugs
    // that do not exist at all — collapsing the two forced every caller to
    // guess whether waiting could help.
    expect(
      await query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug,
      }),
    ).toEqual({ refusal: 'provisioning' })
    expect(
      await query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug: uniqueSlug('never-existed'),
      }),
    ).toBeNull()

    // Registration flips the same slug to a live connection.
    await register(workspace.workspaceId, 'resolution-token', now + 1_000, {
      runtimeVersion: 'gateway-release-probe',
    })
    expect(
      await query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug,
      }),
    ).toMatchObject({
      workspaceId: workspace.workspaceId,
      runtimeVersion: 'gateway-release-probe',
    })
  })

  test('gateway resolution distinguishes unhealthy from provisioning and incomplete active rows', async () => {
    const now = 13_000
    const slug = uniqueSlug('resolution-unhealthy')
    const unhealthy = await prepareWorkspaceForRegistration(
      'resolution-unhealthy',
      'resolution-unhealthy-token',
      now,
      now + 60_000,
      slug,
    )
    await mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: unhealthy.workspaceId,
      status: 'unhealthy',
    })
    expect(
      await query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug,
      }),
    ).toEqual({ refusal: 'unhealthy' })

    await mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: unhealthy.workspaceId,
      status: 'active',
    })
    expect(
      await query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug,
      }),
    ).toEqual({ refusal: 'provisioning' })
  })

  test('deleted workspaces clear VM credentials and reject the old VM token', async () => {
    const now = 45_000
    const workspace = await prepareWorkspaceForRegistration(
      'delete-token',
      'delete-token',
      now,
      now + 60_000,
      uniqueSlug('delete-token'),
    )
    const registered = await register(workspace.workspaceId, 'delete-token', now + 1_000)

    await owner.client.mutation(
      makeFunctionReference(
        'domains/workspaces/mutations:deleteWorkspace',
      ) as FunctionReference<'mutation'>,
      { workspaceId: workspace.workspaceId },
    )

    const deleted = await rawWorkspace(workspace.workspaceId)
    expect(deleted.status).toBe('deleted')
    expect(deleted.vmTokenHash).toBeUndefined()

    await eventually(async () => {
      const raw = await rawWorkspace(workspace.workspaceId)
      expect(raw.status).toBe('deleted')
      expect(raw.vmTokenHash).toBeUndefined()
      expect(raw.vmTokenNonce).toBeUndefined()
      expect(raw.vmName).toBeUndefined()
      expect(raw.sshDest).toBeUndefined()
      expect(raw.httpsUrl).toBeUndefined()
    })
    await expect(syncObservation(registered.vmToken, now + 2_000)).rejects.toThrow(
      'Invalid VM token',
    )
  })

  test('teardown sweep recovers a terminal workspace whose retrier run was lost', async () => {
    // Capacity, not a plan assertion: this owner already holds its birth
    // workspace plus the two the tests above left live, which is all of pro.
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
        plan: 'max',
      },
    )
    const created = (await mutate(convex, 'domains/workspaces/birth:createWorkspace', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      slug: uniqueSlug('teardown-sweep'),
      name: 'Teardown Sweep',
    })) as { workspaceId: string }
    const workspaceId = created.workspaceId
    await eventually(async () => {
      expect(await rawWorkspace(workspaceId)).toMatchObject({
        vmName: expect.any(String),
      })
    })
    await mutate(convex, 'testing/workspaces:markWorkspaceVmTeardownLeakedForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      status: 'deleted',
    })

    const swept = (await mutate(
      convex,
      'domains/workspaces/provisioning:sweepLeakedWorkspaceVmTeardowns',
      { internalKey: INTERNAL_KEY },
    )) as { scheduled: string[] }

    expect(swept.scheduled).toEqual([workspaceId])
    await eventually(async () => {
      const row = await rawWorkspace(workspaceId)
      expect(row.status).toBe('deleted')
      expect(row.vmName).toBeUndefined()
      expect(row.vmTokenNonce).toBeUndefined()
      expect(row.vmTeardownRunId).toBeUndefined()
    })
  })

  test('teardown sweep skips deferred poison work and advances a later workspace', async () => {
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, plan: 'max' },
    )
    const deferred = (await mutate(convex, 'domains/workspaces/birth:createWorkspace', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      slug: uniqueSlug('teardown-deferred'),
      name: 'Deferred teardown',
    })) as { workspaceId: string }
    const ready = (await mutate(convex, 'domains/workspaces/birth:createWorkspace', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      slug: uniqueSlug('teardown-ready'),
      name: 'Ready teardown',
    })) as { workspaceId: string }
    await eventually(async () => {
      expect(await rawWorkspace(deferred.workspaceId)).toMatchObject({
        vmName: expect.any(String),
      })
      expect(await rawWorkspace(ready.workspaceId)).toMatchObject({
        vmName: expect.any(String),
      })
    })
    const now = Date.now()
    await mutate(convex, 'testing/workspaces:markWorkspaceVmTeardownLeakedForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: deferred.workspaceId,
      status: 'deleted',
      retryAt: now + 60_000,
    })
    await mutate(convex, 'testing/workspaces:markWorkspaceVmTeardownLeakedForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: ready.workspaceId,
      status: 'deleted',
    })

    const swept = (await mutate(
      convex,
      'domains/workspaces/provisioning:sweepLeakedWorkspaceVmTeardowns',
      { internalKey: INTERNAL_KEY, now },
    )) as { scheduled: string[] }
    expect(swept.scheduled).toEqual([ready.workspaceId])
    expect((await rawWorkspace(deferred.workspaceId)).vmTeardownRunId).toBeUndefined()
  })

  test('the VM system key carries workspace administration and runtime scopes', async () => {
    const now = 44_000
    const slug = uniqueSlug('vm-key-scopes')
    const workspace = await prepareWorkspaceForRegistration(
      'vm-key-scopes',
      'vm-key-scopes-token',
      now,
      now + 60_000,
      slug,
    )
    await register(workspace.workspaceId, 'vm-key-scopes-token', now + 1_000)
    const minted = (await mutate(convex, 'domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      now: now + 2_000,
    })) as VmModelKeyResult
    const capabilities = minted.scopes.map(scope => scope.split(':').slice(2).join(':')).sort()
    expect(capabilities).toEqual([
      'admin',
      'agents',
      'apps',
      'integrations',
      'services',
      'sessions',
    ])
    expect(minted.scopes.every(scope => scope.startsWith('ws:'))).toBe(true)
  })

  test('retiring a workspace revokes its live system VM model key', async () => {
    const now = 45_000
    const slug = uniqueSlug('retire-model-key')
    const workspace = await prepareWorkspaceForRegistration(
      'retire-model-key',
      'retire-model-key-token',
      now,
      now + 60_000,
      slug,
    )
    await register(workspace.workspaceId, 'retire-model-key-token', now + 1_000)
    const minted = (await mutate(convex, 'domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      now: now + 2_000,
    })) as VmModelKeyResult

    await markRetired(workspace.workspaceId, now + 3_000)

    const retired = await rawWorkspace(workspace.workspaceId)
    expect(retired.status).toBe('retired')
    expect(retired.vmTokenHash).toBeUndefined()

    expect(
      await query(convex, 'domains/apiKeys/api:resolveCredential', {
        internalKey: INTERNAL_KEY,
        hashedKey: await hashApiKey(minted.key),
        keyPrefix: minted.prefix,
        now: now + 4_000,
      }),
    ).toEqual({ ok: false, reason: 'revoked' })
    expect((await auditEvents(workspace.workspaceId)).map(event => event.event)).toContain(
      'api_key.vm_model_key_revoked',
    )
    await eventually(async () => {
      expect(await rawWorkspace(workspace.workspaceId)).toMatchObject({
        status: 'retired',
      })
      expect((await rawWorkspace(workspace.workspaceId)).vmName).toBeUndefined()
    })
  })

  test('explicit-discard reprovision rotates VM identity and revokes the old model key', async () => {
    const now = 47_000
    const slug = uniqueSlug('operator-reprovision')
    const workspace = await prepareWorkspaceForRegistration(
      'operator-reprovision',
      'operator-reprovision-token',
      now,
      now + 60_000,
      slug,
    )
    const first = await register(workspace.workspaceId, 'operator-reprovision-token', now + 1_000, {
      httpsUrl: 'https://old-reprovision-vm.exe.xyz',
      vmName: 'old-reprovision-vm',
    })
    const oldVmTokenNonce = (await rawWorkspace(workspace.workspaceId)).vmTokenNonce
    expect(oldVmTokenNonce).toBeDefined()
    const oldModelKey = (await mutate(convex, 'domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      now: now + 2_000,
    })) as VmModelKeyResult
    const clicks = (await Promise.all(
      [0, 1].map(() =>
        mutate(convex, 'domains/workspaces/lifecycle:requestReprovision', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          imageRef: 'ttl.sh/duet-reprovision-new:1h',
          discardState: true,
          now: now + 3_000,
        }),
      ),
    )) as Array<{ status: string; scheduled: boolean }>
    expect(clicks.map(click => click.status)).toEqual(['provisioning', 'provisioning'])
    expect(clicks.map(click => click.scheduled).sort()).toEqual([false, true])

    await eventually(async () => {
      const provisioning = await rawWorkspace(workspace.workspaceId)
      expect(provisioning).toMatchObject({
        status: 'provisioning',
        imageRef: 'ttl.sh/duet-reprovision-new:1h',
        vmName: expect.any(String),
        vmTokenNonce: expect.any(String),
      })
      expect(provisioning.vmTokenNonce).not.toBe(oldVmTokenNonce)
      expect(provisioning.vmAttachRunId).toBeUndefined()
    })
    const provisioning = await rawWorkspace(workspace.workspaceId)
    expect(provisioning.provisioningTokenHash).toBeDefined()
    await expect(syncObservation(first.vmToken, now + 3_500)).rejects.toThrow('Invalid VM token')
    expect(
      await query(convex, 'domains/apiKeys/api:resolveCredential', {
        internalKey: INTERNAL_KEY,
        hashedKey: await hashApiKey(oldModelKey.key),
        keyPrefix: oldModelKey.prefix,
        now: now + 4_000,
      }),
    ).toEqual({ ok: false, reason: 'revoked' })

    const attachEvents = (await auditEvents(workspace.workspaceId)).filter(
      event => event.event === 'workspace.vm_attach_scheduled',
    )
    expect(attachEvents).toHaveLength(1)
    expect(attachEvents[0]).toMatchObject({
      event: 'workspace.vm_attach_scheduled',
      provenance: { source: 'workspace_vm_schedule' },
    })

    const second = (await mutate(convex, 'domains/workspaces/provisioning:registerVm', {
      internalKey: INTERNAL_KEY,
      provisioningTokenHash: provisioning.provisioningTokenHash,
      workspaceHint: workspace.workspaceId,
      vmName: provisioning.vmName,
      sshDest: provisioning.sshDest,
      httpsUrl: provisioning.httpsUrl,
      deliverModelCredentials: true,
      now: now + 5_000,
    })) as { vmToken: string; modelCredentials: { apiKey: string } }

    expect(second.vmToken).toStartWith('duet_vm_')
    expect(second.vmToken).not.toBe(first.vmToken)
    expect(second.modelCredentials.apiKey).toStartWith('duet_sk_')
    expect((await rawWorkspace(workspace.workspaceId)).status).toBe('active')
    expect((await auditEvents(workspace.workspaceId)).map(event => event.event)).toEqual(
      expect.arrayContaining([
        'workspace.operator_reprovision_started',
        'api_key.vm_model_key_revoked',
        'api_key.vm_model_key_minted',
      ]),
    )
  })

  test('reprovisionWorkspace defers while agent sessions are active', async () => {
    const now = 48_000
    const workspace = await prepareWorkspaceForRegistration(
      'reprovision-defer',
      'reprovision-defer-token',
      now,
      now + 60_000,
    )
    await register(workspace.workspaceId, 'reprovision-defer-token', now + 1_000)
    await mutate(convex, 'domains/agentSessions/model:prepareRunnerInputDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      attemptId: 'reprovision-defer',
      input: {
        kind: 'initial_prompt',
        prompt: 'keep running',
        behavior: 'steer',
        sender: { kind: 'user', userId: owner.user._id },
      },
      now: now + 2_000,
    })

    const beforeAudit = await auditEvents(workspace.workspaceId)
    const result = (await mutate(convex, 'domains/workspaces/lifecycle:requestReprovision', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      imageRef: 'ttl.sh/duet-reprovision-deferred:1h',
      now: now + 3_000,
    })) as {
      status: string
      reason: string
      activeAgentSessions: number
      activeTrainJobs: number
    }

    expect(result).toEqual({
      status: 'deferred',
      reason: 'active_workspace_work',
      activeAgentSessions: 1,
      activeTrainJobs: 0,
    })
    expect((await rawWorkspace(workspace.workspaceId)).status).toBe('active')
    expect(newAuditEvents(beforeAudit, await auditEvents(workspace.workspaceId))).toEqual([
      expect.objectContaining({
        event: 'workspace.operator_reprovision_deferred',
        provenance: expect.objectContaining({
          reason: 'active_workspace_work',
          activeAgentSessions: 1,
        }),
      }),
    ])
  })

  test('reprovisionWorkspace can explicitly discard pre-launch VM state', async () => {
    const now = 49_000
    const workspace = await prepareWorkspaceForRegistration(
      'operator-discard',
      'operator-discard-token',
      now,
      now + 60_000,
    )
    let archiveRequests = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        archiveRequests += 1
        return new Response('archive must not be requested', { status: 500 })
      },
    })
    await register(workspace.workspaceId, 'operator-discard-token', now + 1_000, {
      httpsUrl: `http://127.0.0.1:${server.port}`,
      vmName: 'discarded-vm',
    })

    let result: {
      status: string
      imageRef?: string
      lifecycleBackupId?: string
    }
    try {
      result = (await mutate(convex, 'domains/workspaces/lifecycle:requestReprovision', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        imageRef: 'ttl.sh/duet-reprovision-discard:1h',
        discardState: true,
        now: now + 2_000,
      })) as typeof result
    } finally {
      server.stop(true)
    }

    expect(result).toMatchObject({
      status: 'provisioning',
      imageRef: 'ttl.sh/duet-reprovision-discard:1h',
    })
    expect(result.lifecycleBackupId).toBeUndefined()
    expect(archiveRequests).toBe(0)
  })

  test('expired provisioning rows become unhealthy without reviving through slug adoption', async () => {
    const now = 50_000
    const slug = uniqueSlug('never-register')
    const workspace = await prepareWorkspaceForRegistration(
      'never-register',
      'never-register-token',
      now,
      now + 1_000,
      slug,
    )
    const queuedSession = (await convex.mutation(
      'testing/agentSessions:createQueuedSessionForTest',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        workspaceId: workspace.workspaceId,
        prompt: 'Run after provisioning.',
        now,
      },
    )) as { sessionId: string }

    const expired = (await mutate(
      convex,
      'domains/workspaces/provisioning:markUnhealthyWorkspaces',
      {
        internalKey: INTERNAL_KEY,
        now: now + 1_001,
        staleAfterMs: 120_000,
      },
    )) as { changed: string[] }

    expect(expired.changed).toContain(workspace.workspaceId)
    const rawExpired = await rawWorkspace(workspace.workspaceId)
    expect(rawExpired.status).toBe('unhealthy')
    expect(rawExpired.provisioningTokenHash).toBeUndefined()
    await eventually(async () => {
      const session = (await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: queuedSession.sessionId,
      })) as { turnStatus: string; runnerInputPending?: boolean }
      expect(session.turnStatus).toBe('interrupted')
      expect(session.runnerInputPending).toBe(false)
    })

    await expect(
      prepareWorkspaceForRegistration(
        'never-register-retry',
        'retry-token',
        now + 2_000,
        now + 62_000,
        slug,
      ),
    ).rejects.toThrow('Workspace slug is already taken')
  })

  test('an archived workspace keeps its slug, so a later signup cannot adopt it', async () => {
    const now = 55_000
    const slug = uniqueSlug('archived-keeps-slug')
    const archived = await prepareWorkspaceForRegistration(
      'archived-keeps-slug',
      'archived-keeps-slug-token',
      now,
      now + 1_000,
      slug,
    )
    await mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: archived.workspaceId,
      status: 'archived',
    })

    // Archived is resumable: renewal flips the row straight back to
    // provisioning under the same slug. A second workspace born under it in
    // the meantime would leave two live rows on one slug.
    await expect(
      prepareWorkspaceForRegistration(
        'archived-keeps-slug-adopter',
        'archived-keeps-slug-adopter-token',
        now + 1,
        now + 1_001,
        slug,
      ),
    ).rejects.toThrow('Workspace slug is already taken')
    expect(
      await query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug,
      }),
    ).toEqual({ refusal: 'archived' })
  })

  test('the archived-slug repair moves an archived row off a slug a live workspace holds', async () => {
    const now = 56_000
    const slug = uniqueSlug('reslug')
    const archived = await prepareWorkspaceForRegistration(
      'collision-repair',
      'collision-repair-token',
      now,
      now + 1_000,
      slug,
    )
    await mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: archived.workspaceId,
      status: 'archived',
    })
    const adopter = await prepareWorkspaceForRegistration(
      'collision-repair-adopter',
      'collision-repair-adopter-token',
      now + 1,
      now + 60_000,
      uniqueSlug('reslug-adopter'),
    )
    // Rows born while archived slugs still read as free: the adopter took the
    // archived workspace's slug and went live under it.
    await mutate(convex, 'testing/workspaces:setWorkspaceSlugForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: adopter.workspaceId,
      slug,
    })
    await register(adopter.workspaceId, 'collision-repair-adopter-token', now + 2_000)
    await expect(
      query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug,
      }),
    ).rejects.toThrow('unique() query returned more than one result')

    // The live row keeps the slug its owner is using; the archived row moves.
    await mutate(convex, 'testing/workspaces:reslugArchivedWorkspaceCollisionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: adopter.workspaceId,
    })
    await mutate(convex, 'testing/workspaces:reslugArchivedWorkspaceCollisionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: archived.workspaceId,
    })
    expect((await rawWorkspace(adopter.workspaceId)).slug).toBe(slug)
    expect((await rawWorkspace(archived.workspaceId)).slug).toBe(`${slug}-2`)
    expect(
      await query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug,
      }),
    ).toMatchObject({ workspaceId: adopter.workspaceId })
    expect(
      (await auditEvents(archived.workspaceId)).filter(
        event => event.event === 'workspace.renamed',
      ),
    ).toMatchObject([{ provenance: { oldSlug: slug, newSlug: `${slug}-2` } }])

    // A second pass finds nothing to repair.
    await mutate(convex, 'testing/workspaces:reslugArchivedWorkspaceCollisionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: archived.workspaceId,
    })
    expect((await rawWorkspace(archived.workspaceId)).slug).toBe(`${slug}-2`)
    expect(
      (await auditEvents(archived.workspaceId)).filter(
        event => event.event === 'workspace.renamed',
      ),
    ).toHaveLength(1)
  })

  test('one malformed expired workspace does not roll back healthy expiry work', async () => {
    const now = 70_000
    const malformed = await prepareWorkspaceForRegistration(
      'malformed-expiry',
      'malformed-token',
      now,
      now + 1,
    )
    const healthy = await prepareWorkspaceForRegistration(
      'healthy-expiry',
      'healthy-token',
      now,
      now + 1,
    )
    await mutate(convex, 'testing/workspaces:clearWorkspaceCreatedByForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: malformed.workspaceId,
    })

    const result = (await mutate(
      convex,
      'domains/workspaces/provisioning:markUnhealthyWorkspaces',
      { internalKey: INTERNAL_KEY, now: now + 2 },
    )) as { changed: string[] }

    expect(result.changed).toContain(healthy.workspaceId)
    expect((await rawWorkspace(healthy.workspaceId)).status).toBe('unhealthy')
    expect((await rawWorkspace(malformed.workspaceId)).status).toBe('provisioning')
  })

  test('VM sync staleness is based on lastHeartbeatAt and a sync observation recovers it', async () => {
    const now = 100_000
    const workspace = await prepareWorkspaceForRegistration(
      'stale',
      'stale-token',
      now,
      now + 60_000,
    )
    const registered = await register(workspace.workspaceId, 'stale-token', now + 1_000)

    const stale = (await mutate(convex, 'domains/workspaces/provisioning:markUnhealthyWorkspaces', {
      internalKey: INTERNAL_KEY,
      now: now + 121_001,
      staleAfterMs: 120_000,
    })) as { changed: string[] }
    expect(stale.changed).toContain(workspace.workspaceId)
    expect((await rawWorkspace(workspace.workspaceId)).status).toBe('unhealthy')

    await syncObservation(registered.vmToken, now + 122_000)
    const recovered = await rawWorkspace(workspace.workspaceId)
    expect(recovered.status).toBe('active')
    expect(recovered.lastHeartbeatAt).toBe(now + 122_000)
  })

  test('stale-health failures cannot keep a later workspace outside every sweep', async () => {
    const now = 200_000
    const cohort = (await mutate(convex, 'testing/workspaces:createStaleHealthSweepCohortForTest', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      poisonCount: 1_000,
      now,
    })) as {
      healthyWorkspaceId: string
      firstPoisonWorkspaceId: string
    }

    await mutate(convex, 'domains/workspaces/provisioning:markUnhealthyWorkspaces', {
      internalKey: INTERNAL_KEY,
      now,
      staleAfterMs: 1,
    })
    const deferredPoison = await rawWorkspace(cohort.firstPoisonWorkspaceId)
    expect(deferredPoison.status).toBe('active')
    expect(deferredPoison.healthSweepRetryAt).toBeGreaterThan(now)
    const secondSweep = (await mutate(
      convex,
      'domains/workspaces/provisioning:markUnhealthyWorkspaces',
      {
        internalKey: INTERNAL_KEY,
        now: now + 1,
        staleAfterMs: 1,
      },
    )) as { changed: string[] }

    expect(secondSweep.changed).toContain(cohort.healthyWorkspaceId)
    expect((await rawWorkspace(cohort.healthyWorkspaceId)).status).toBe('unhealthy')
  })

  test('a new VM heartbeat cancels a pending stale-health retry', async () => {
    const now = 400_000
    const workspace = await prepareWorkspaceForRegistration(
      'health-retry-recovery',
      'health-retry-token',
      now,
      now + 60_000,
    )
    const registered = await register(workspace.workspaceId, 'health-retry-token', now + 1_000)
    await mutate(convex, 'testing/workspaces:clearWorkspaceCreatedByForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
    })

    await mutate(convex, 'domains/workspaces/provisioning:markUnhealthyWorkspaces', {
      internalKey: INTERNAL_KEY,
      now: now + 121_001,
      staleAfterMs: 120_000,
    })
    const retryAt = (await rawWorkspace(workspace.workspaceId)).healthSweepRetryAt
    expect(retryAt).toBeGreaterThan(now + 121_001)

    await mutate(convex, 'testing/workspaces:setWorkspaceCreatedByForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      actorId: owner.user._id,
    })
    await syncObservation(registered.vmToken, now + 122_000)
    expect(await rawWorkspace(workspace.workspaceId)).toMatchObject({
      status: 'active',
      lastHeartbeatAt: now + 122_000,
    })
    expect((await rawWorkspace(workspace.workspaceId)).healthSweepRetryAt).toBeUndefined()
  })

  test('SUBS-IMPL-07 registration after a mid-provision lapse finishes quiesced without model credentials', async () => {
    const now = Date.now()
    const workspace = await prepareWorkspaceForRegistration(
      'register-paused',
      'register-paused-token',
      now,
      now + 60_000,
    )
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      servicingStatus: 'paused',
      now: now + 500,
    })

    const registered = (await mutate(convex, 'domains/workspaces/provisioning:registerVm', {
      internalKey: INTERNAL_KEY,
      provisioningTokenHash: await sha256Hex('register-paused-token'),
      workspaceHint: workspace.workspaceId,
      vmName: 'register-paused-vm',
      sshDest: 'exedev@register-paused-vm.exe.xyz',
      httpsUrl: 'https://register-paused-vm.exe.xyz',
      deliverModelCredentials: true,
      now: now + 1_000,
    })) as { vmToken: string; modelCredentials?: unknown }

    expect(registered.vmToken).toStartWith('duet_vm_')
    expect(registered.modelCredentials).toBeUndefined()
    expect(registered).not.toHaveProperty('syncState')
    await expect(
      mutate(convex, 'domains/apiKeys/mutations:mintVmModelKey', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        now: now + 1_100,
      }),
    ).rejects.toThrow('Workspace not found')
    const pausedWorkspace = await rawWorkspace(workspace.workspaceId)
    expect(pausedWorkspace).toMatchObject({
      status: 'active',
      servicingStatus: 'paused',
    })
    expect(
      await query(convex, 'domains/workspaces/provisioning:gatewayConnectionBySlug', {
        internalKey: INTERNAL_KEY,
        slug: pausedWorkspace.slug,
      }),
    ).toEqual({ refusal: 'paused' })
  })

  test('servicing decommission never selects an active workspace regardless of inactivity', async () => {
    const now = 200_000
    const workspace = await prepareWorkspaceForRegistration('idle', 'idle-token', now, now + 60_000)
    const registered = await register(workspace.workspaceId, 'idle-token', now + 1_000)
    await syncObservation(registered.vmToken, now + 2_000)

    const candidates = await servicingDecommissionCandidates(now + 30 * 24 * 60 * 60 * 1_000)
    expect(candidates.map(candidate => candidate.workspaceId)).not.toContain(workspace.workspaceId)
  })

  test('servicing decommission selects paused workspaces only after seven continuous days', async () => {
    const now = 220_000
    const workspace = await prepareWorkspaceForRegistration(
      'paused-decommission',
      'paused-decommission-token',
      now,
      now + 60_000,
    )
    await register(workspace.workspaceId, 'paused-decommission-token', now + 1_000)
    const pausedAt = now + 2_000
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      servicingStatus: 'paused',
      now: pausedAt,
    })

    const before = await servicingDecommissionCandidates(pausedAt + SERVICING_ARCHIVE_AFTER_MS - 1)
    expect(before.map(candidate => candidate.workspaceId)).not.toContain(workspace.workspaceId)

    const atDeadline = await servicingDecommissionCandidates(pausedAt + SERVICING_ARCHIVE_AFTER_MS)
    expect(atDeadline.map(candidate => candidate.workspaceId)).toContain(workspace.workspaceId)

    /* A scoped sweep sees only its own workspace. The staging journey invokes
       the decommission ACTION against live staging to provoke one on its
       fixture — unscoped, that call reaps every qualifying real workspace as
       collateral, which is what deleted a real workspace on 2026-08-12. */
    // Scoped to a workspace this test creates for the purpose, not to whichever
    // row `listMine` happens to return first: the fixture belongs to the same
    // owner, so "the owner's first workspace" can BE the fixture, and the
    // assertion below then contradicts itself depending on test order.
    const elsewhere = await prepareWorkspaceForRegistration(
      'paused-other',
      'paused-other-token',
      now,
      now + 60_000,
    )
    const scopedElsewhere = (await query(
      convex,
      'domains/workspaces/provisioning:servicingDecommissionCandidates',
      {
        internalKey: INTERNAL_KEY,
        now: pausedAt + SERVICING_ARCHIVE_AFTER_MS,
        workspaceId: elsewhere.workspaceId,
      },
    )) as Array<{ workspaceId: string }>
    expect(scopedElsewhere.map(candidate => candidate.workspaceId)).not.toContain(
      workspace.workspaceId,
    )
  })

  /* An unhealthy workspace is one whose VM stopped answering the sync rail. It
     is still a VM: exe.dev bills it, `METERED_STATUSES` charges for it, and
     nothing else in the system ever removes it. The decommission sweep used to
     read only the `active` bucket, so a workspace that went unhealthy on its
     way to the deadline kept its VM forever, no matter how long the payer had
     been unentitled. Health is a fact about the VM; entitlement is a fact
     about the payer, and only the second one decides whether the VM lives. */
  test('servicing decommission selects an unhealthy workspace, not just an active one', async () => {
    const now = 230_000
    const workspace = await prepareWorkspaceForRegistration(
      'unhealthy-decommission',
      'unhealthy-decommission-token',
      now,
      now + 60_000,
    )
    await register(workspace.workspaceId, 'unhealthy-decommission-token', now + 1_000)
    const pausedAt = now + 2_000
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      servicingStatus: 'paused',
      now: pausedAt,
    })
    await mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      status: 'unhealthy',
    })

    const deadline = pausedAt + SERVICING_ARCHIVE_AFTER_MS
    expect(
      (await servicingDecommissionCandidates(deadline - 1)).map(row => row.workspaceId),
    ).not.toContain(workspace.workspaceId)
    const atDeadline = await servicingDecommissionCandidates(deadline)
    expect(atDeadline.map(row => row.workspaceId)).toContain(workspace.workspaceId)

    // The candidate carries the status the archive step reads, so an
    // unreachable VM's failed pull can be told apart from a transient one.
    expect(atDeadline.find(row => row.workspaceId === workspace.workspaceId)).toMatchObject({
      status: 'unhealthy',
    })

    // And the mutation that ends the row accepts it: a candidacy the closer
    // refuses is a sweep that runs every hour and never finishes anything.
    expect(
      await mutate(convex, 'domains/workspaces/provisioning:markServicingArchived', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        servicingStatus: 'paused',
        servicingStatusChangedAt: pausedAt,
        expectedVmName: (await rawWorkspace(workspace.workspaceId)).vmName,
        expectedVmTokenNonce: (await rawWorkspace(workspace.workspaceId)).vmTokenNonce,
        now: deadline,
      }),
    ).toMatchObject({ ok: true })
    await eventually(async () => {
      const row = await rawWorkspace(workspace.workspaceId)
      // `paused` archives; `retired` is the banned path. What matters here is
      // that the VM is gone — an unhealthy row's teardown runs like any other.
      expect(row.status).toBe('archived')
      expect(row.vmName).toBeUndefined()
    })
  })

  test('a banned workspace is a decommission candidate on the very next sweep', async () => {
    // The warning window belongs to a person whose trial lapsed. A ban is the
    // operator saying there is no such person — so the sweep owes it nothing,
    // and a farm's VMs do not get to run out their trials plus the window.
    const now = 240_000
    const workspace = await prepareWorkspaceForRegistration(
      'banned-decommission',
      'banned-decommission-token',
      now,
      now + 60_000,
    )
    await register(workspace.workspaceId, 'banned-decommission-token', now + 1_000)
    const bannedAt = now + 2_000
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      servicingStatus: 'banned',
      now: bannedAt,
    })

    expect(
      (await servicingDecommissionCandidates(bannedAt + 1)).map(row => row.workspaceId),
    ).toContain(workspace.workspaceId)
  })

  test('a pass that runs out of budget hands the rest to an immediate continuation', async () => {
    // The platform kills an action at ten minutes and the cron comes back in an
    // hour, so a queue of 140 twenty-second archives drained at sixteen an hour.
    // A pass stops at its own budget and schedules the remainder right away —
    // exactly the rows it deferred, so a failing row cannot loop the chain and
    // a row that becomes due later belongs to the next cron, not this chain.
    const now = Date.now()
    const server = Bun.serve({ port: 0, fetch: () => new Response('archive-bytes') })
    const rows = await Promise.all(
      ['budget-a', 'budget-b'].map(async prefix => {
        const workspace = await prepareWorkspaceForRegistration(
          prefix,
          `${prefix}-token`,
          now - 10_000,
          now + 60_000,
        )
        await register(workspace.workspaceId, `${prefix}-token`, now - 9_000, {
          httpsUrl: `http://127.0.0.1:${server.port}`,
          vmName: `${prefix}-vm`,
        })
        await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          servicingStatus: 'banned',
          now: now - 1_000,
        })
        return workspace.workspaceId
      }),
    )
    try {
      const first = (await convex.action(
        'domains/workspaces/provisioningActions:decommissionUnservicedWorkspaces',
        { internalKey: INTERNAL_KEY, now, budgetMs: 0 },
      )) as { retired: string[]; deferred: number }
      // A zero budget admits exactly one attempt; everything else is deferred.
      expect(first.retired.length + first.deferred).toBeGreaterThanOrEqual(rows.length)
      expect(first.deferred).toBeGreaterThanOrEqual(1)
      await eventually(async () => {
        for (const workspaceId of rows) {
          expect((await rawWorkspace(workspaceId)).status).toBe('retired')
        }
      })
    } finally {
      server.stop(true)
    }
  })

  test('trial decommission skips archive and preserves the workspace identity', async () => {
    const now = Date.now()
    const trialOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('trial-retire-owner'),
      'Trial Retire Owner',
    )
    await mutate(trialOwner.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: now - 10_000,
    })
    const workspace = await prepareWorkspaceForRegistration(
      'trial-retire',
      'trial-retire-token',
      now - 10_000,
      now + 60_000,
      uniqueSlug('trial-retire'),
      trialOwner,
      await defaultWorkspaceId(trialOwner),
    )
    let archiveFetches = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        archiveFetches += 1
        return new Response('must not be fetched')
      },
    })
    await register(workspace.workspaceId, 'trial-retire-token', now - 9_000, {
      httpsUrl: `http://127.0.0.1:${server.port}`,
      vmName: 'trial-retire-vm',
    })
    await mutate(convex, 'testing/workspaces:setWorkspacePartialVmIdentityForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
    })
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      servicingStatus: 'paused',
      now: now - SERVICING_ARCHIVE_AFTER_MS - 1,
    })

    try {
      const result = (await convex.action(
        'domains/workspaces/provisioningActions:decommissionUnservicedWorkspaces',
        { internalKey: INTERNAL_KEY, now },
      )) as { archived: string[] }
      expect(result.archived).toContain(workspace.workspaceId)
    } finally {
      server.stop(true)
    }

    expect(archiveFetches).toBe(0)
    const archived = await rawWorkspace(workspace.workspaceId)
    expect(archived).toMatchObject({
      _id: workspace.workspaceId,
      status: 'archived',
      servicingStatus: 'paused',
    })
    expect(archived.lifecycleBackupId).toBeUndefined()
    expect(
      (await auditEvents(workspace.workspaceId, trialOwner)).map(event => event.event),
    ).toContain('workspace.servicing_archived_without_archive')
  })

  test('subscription reactivation waits for an in-flight teardown before attaching', async () => {
    const now = Date.now()
    const subscriber = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('teardown-reactivation'),
      'Teardown Reactivation',
    )
    const workspaceId = await defaultWorkspaceId(subscriber)
    await mutate(convex, 'testing/workspaces:setWorkspaceVmHandoffForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      status: 'archived',
      servicingStatus: 'paused',
      vmName: 'old-trial-vm',
      vmTokenNonce: 'old-trial-generation',
      vmTeardownRunId: 'teardown-in-flight',
    })

    await mutate(
      subscriber.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, now },
    )

    const reactivated = await rawWorkspace(workspaceId)
    expect(reactivated).toMatchObject({
      _id: workspaceId,
      status: 'provisioning',
      servicingStatus: 'active',
      vmTeardownRunId: 'teardown-in-flight',
      attachAfterVmTeardown: true,
    })
    expect(reactivated.vmAttachRunId).toBeUndefined()
  })

  test('subscription reactivation tears down residual VM state before attaching', async () => {
    const now = Date.now()
    const subscriber = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('residual-reactivation'),
      'Residual Reactivation',
    )
    const workspaceId = await defaultWorkspaceId(subscriber)
    await mutate(convex, 'testing/workspaces:setWorkspaceVmHandoffForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      status: 'archived',
      servicingStatus: 'paused',
      vmName: 'residual-trial-vm',
      vmTokenNonce: 'residual-trial-generation',
    })

    await mutate(
      subscriber.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, now },
    )

    const reactivated = await rawWorkspace(workspaceId)
    expect(reactivated).toMatchObject({
      _id: workspaceId,
      status: 'provisioning',
      servicingStatus: 'active',
      vmTeardownRunId: expect.any(String),
      attachAfterVmTeardown: true,
    })
    expect(reactivated.vmAttachRunId).toBeUndefined()
  })

  test('servicing decommission commit ignores activity but rechecks servicing state', async () => {
    const now = Date.now()
    const workspace = await prepareWorkspaceForRegistration(
      'retire-recheck',
      'retire-recheck-token',
      now - 20_000,
      now + 60_000,
    )
    const registered = await register(workspace.workspaceId, 'retire-recheck-token', now - 19_000)

    const pausedAt = now - SERVICING_ARCHIVE_AFTER_MS - 1
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      servicingStatus: 'paused',
      now: pausedAt,
    })
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      servicingStatus: 'active',
      now,
    })
    expect(
      await mutate(convex, 'domains/workspaces/provisioning:markServicingArchived', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        servicingStatus: 'paused',
        servicingStatusChangedAt: pausedAt,
        now,
      }),
    ).toEqual({ ok: false })

    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      servicingStatus: 'paused',
      now: pausedAt,
    })
    const pausedCandidate = (await servicingDecommissionCandidates(now)).find(
      row => row.workspaceId === workspace.workspaceId,
    )
    expect(pausedCandidate).toBeDefined()
    await syncObservation(registered.vmToken, now + 1)
    expect(
      await mutate(convex, 'domains/workspaces/provisioning:markServicingArchived', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        servicingStatus: 'paused',
        servicingStatusChangedAt: pausedAt,
        expectedVmName: pausedCandidate!.vmName,
        expectedVmTokenNonce: pausedCandidate!.vmTokenNonce,
        now: now + 2,
      }),
    ).toEqual({ ok: true, status: 'archived' })
  })

  test('edge resolve requires the edge secret and resolves real app entities by visibility', async () => {
    const now = 300_000
    const slug = uniqueSlug('edge-resolve')
    const workspace = await prepareWorkspaceForRegistration(
      'edge-resolve',
      'edge-resolve-token',
      now,
      now + 60_000,
      slug,
    )
    await register(workspace.workspaceId, 'edge-resolve-token', now + 1_000, {
      httpsUrl: 'https://edge-resolve.example.exe.xyz',
      vmName: 'edge-resolve-vm',
    })
    await mutate(convex, 'domains/apps/model:registerApp', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: workspace.workspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4173,
      slug: 'site',
    })

    const body = {
      kind: 'app',
      host: `site--${slug}.edge.duet.so`,
      workspaceSlug: slug,
      appSlug: 'site',
    }
    expect(
      (
        await fetch(`${convex.siteUrl}/v1/edge/resolve`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401)

    const response = await fetch(`${convex.siteUrl}/v1/edge/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-duet-edge-secret': 'edge-secret',
      },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(403)

    await mutate(convex, 'domains/apps/model:setVisibility', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: workspace.workspaceId,
      slug: 'site',
      visibility: 'public',
    })

    const publicResponse = await fetch(`${convex.siteUrl}/v1/edge/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-duet-edge-secret': 'edge-secret',
      },
      body: JSON.stringify(body),
    })

    expect(publicResponse.status).toBe(200)
    expect(await publicResponse.json()).toMatchObject({
      visibility: 'public',
      workspace: {
        id: workspace.workspaceId,
        slug,
        httpsUrl: 'https://edge-resolve.example.exe.xyz',
        vmName: 'edge-resolve-vm',
      },
      origin: {
        httpsUrl: 'https://edge-resolve.example.exe.xyz',
        gatewayAuthToken: expect.any(String),
        gatewayPathPrefix: '/public/app',
      },
    })
  })

  test('tunnel edge resolve carries a gateway bearer for the proxied request', async () => {
    const now = 350_000
    const slug = uniqueSlug('tunnel-edge-resolve')
    const workspace = await prepareWorkspaceForRegistration(
      'tunnel-edge-resolve',
      'tunnel-edge-resolve-token',
      now,
      now + 60_000,
      slug,
    )
    await register(workspace.workspaceId, 'tunnel-edge-resolve-token', now + 1_000, {
      httpsUrl: 'https://tunnel-edge-resolve.example.exe.xyz',
      vmName: 'tunnel-edge-resolve-vm',
    })

    const response = await edgeResolve({
      kind: 'tunnel',
      workspaceSlug: slug,
      port: 8384,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      origin: {
        gatewayAuthToken: expect.any(String),
      },
    })
  })

  test('workspace suspension blocks app and publish edge resolves and unsuspend restores them', async () => {
    const now = 500_000
    const slug = uniqueSlug('suspend-edge')
    const workspace = await prepareWorkspaceForRegistration(
      'suspend-edge',
      'suspend-token',
      now,
      now + 60_000,
      slug,
    )
    await register(workspace.workspaceId, 'suspend-token', now + 1_000, {
      httpsUrl: 'https://suspend.example.exe.xyz',
      vmName: 'suspend-vm',
    })
    await mutate(convex, 'domains/apps/model:registerApp', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: workspace.workspaceId,
      path: 'apps/site',
      command: 'bun run start',
      apiScopes: [],
      port: 4173,
      slug: 'site',
    })
    await mutate(convex, 'domains/apps/model:setVisibility', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: workspace.workspaceId,
      slug: 'site',
      visibility: 'public',
    })
    await mutate(convex, 'domains/publishes/model:createPublish', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: workspace.workspaceId,
      path: 'reports/q2.md',
      kind: 'file',
      slug: 'q2',
    })

    expect(
      (
        await edgeResolve({
          kind: 'app',
          host: `site--${slug}.edge.duet.so`,
          workspaceSlug: slug,
          appSlug: 'site',
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await edgeResolve({
          kind: 'publish',
          host: 'duet.so',
          workspaceSlug: slug,
          publishSlug: 'q2',
        })
      ).status,
    ).toBe(200)

    const beforeSuspensionAudit = await auditEvents(workspace.workspaceId)
    await mutate(convex, 'domains/workspaces/mutations:setSuspended', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: workspace.workspaceId,
      suspended: true,
      reason: 'phishing report',
      now: now + 2_000,
    })

    const blockedApp = await edgeResolve({
      kind: 'app',
      host: `site--${slug}.edge.duet.so`,
      workspaceSlug: slug,
      appSlug: 'site',
    })
    const blockedPublish = await edgeResolve({
      kind: 'publish',
      host: 'duet.so',
      workspaceSlug: slug,
      publishSlug: 'q2',
    })
    expect(blockedApp.status).toBe(403)
    expect(await blockedApp.json()).toEqual({ error: 'suspended' })
    expect(blockedPublish.status).toBe(403)
    expect(await blockedPublish.json()).toEqual({ error: 'suspended' })
    expect(newAuditEvents(beforeSuspensionAudit, await auditEvents(workspace.workspaceId))).toEqual(
      [
        expect.objectContaining({
          event: 'workspace.suspended',
          provenance: expect.objectContaining({ reason: 'phishing report' }),
        }),
      ],
    )

    await mutate(convex, 'domains/workspaces/mutations:setSuspended', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: workspace.workspaceId,
      suspended: false,
      reason: 'review cleared',
      now: now + 3_000,
    })
    expect(
      (
        await edgeResolve({
          kind: 'app',
          host: `site--${slug}.edge.duet.so`,
          workspaceSlug: slug,
          appSlug: 'site',
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await edgeResolve({
          kind: 'publish',
          host: 'duet.so',
          workspaceSlug: slug,
          publishSlug: 'q2',
        })
      ).status,
    ).toBe(200)
  })
})

async function prepareWorkspaceForRegistration(
  prefix: string,
  token: string,
  now: number,
  expiresAt: number,
  slug = uniqueSlug(prefix),
  actor: SignedInUser = owner,
  workspaceId?: string,
) {
  if (workspaceId !== undefined) {
    await settleWorkspaceProvisioning(convex, { internalKey: INTERNAL_KEY, workspaceId })
  }
  return (await mutate(convex, 'testing/workspaces:prepareWorkspaceForRegistration', {
    internalKey: INTERNAL_KEY,
    actorId: actor.user._id,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    slug,
    name: `${prefix} workspace`,
    imageRef: IMAGE_REF,
    provisioningTokenHash: await sha256Hex(token),
    provisioningTokenExpiresAt: expiresAt,
    now,
  })) as { workspaceId: string }
}

/** A fresh sign-in auto-creates one workspace; unpaid owners may hold only that one. */
async function defaultWorkspaceId(actor: SignedInUser): Promise<string> {
  const rows = (await query(actor.client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: { _id: string }
  }>
  return rows[0]!.workspace._id
}

async function register(
  workspaceId: string,
  token: string,
  now: number,
  options: {
    httpsUrl?: string
    vmName?: string
    runtimeVersion?: string
    imageVersion?: string
  } = {},
): Promise<{ vmToken: string }> {
  const registered = (await mutate(convex, 'domains/workspaces/provisioning:registerVm', {
    internalKey: INTERNAL_KEY,
    provisioningTokenHash: await sha256Hex(token),
    workspaceHint: workspaceId,
    vmName: options.vmName ?? `vm-${workspaceId.slice(-6)}`,
    sshDest: `exedev@vm-${workspaceId.slice(-6)}.exe.xyz`,
    httpsUrl: options.httpsUrl ?? 'https://example.exe.xyz',
    runtimeVersion: options.runtimeVersion,
    imageVersion: options.imageVersion,
    now,
  })) as { vmToken: string }
  return registered
}

async function syncObservation(vmToken: string, now: number): Promise<unknown> {
  return await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
    internalKey: INTERNAL_KEY,
    vmTokenHash: await sha256Hex(vmToken),
    observation: {
      needsModelCredentials: false,
      versions: {
        runtime: '0.0.0',
        image: '0.0.0',
      },
    },
    now,
  })
}

async function markRetired(workspaceId: string, now: number): Promise<void> {
  await mutate(convex, 'domains/workspaces/provisioning:markRetired', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now,
  })
}

async function rawWorkspace(workspaceId: string): Promise<RawWorkspace> {
  const workspace = (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as RawWorkspace | null
  expect(workspace).toBeDefined()
  return workspace!
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await Bun.sleep(25)
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('eventually timed out')
}

async function edgeResolve(body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${convex.siteUrl}/v1/edge/resolve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-duet-edge-secret': 'edge-secret',
    },
    body: JSON.stringify(body),
  })
}

async function auditEvents(workspaceId: string, actor: SignedInUser = owner): Promise<AuditRow[]> {
  return (await actor.client.query(
    makeFunctionReference(
      'domains/workspaces/queries:getAuditEvents',
    ) as FunctionReference<'query'>,
    { workspaceId },
  )) as AuditRow[]
}

function newAuditEvents(before: AuditRow[], after: AuditRow[]): AuditRow[] {
  const existingIds = new Set(before.map(event => event.id))
  return after.filter(event => !existingIds.has(event.id))
}

interface DecommissionCandidate {
  workspaceId: string
  servicingStatusChangedAt: number
  status: 'active' | 'unhealthy'
  vmName?: string
  vmTokenNonce?: string
}

async function servicingDecommissionCandidates(now: number): Promise<DecommissionCandidate[]> {
  return (await query(convex, 'domains/workspaces/provisioning:servicingDecommissionCandidates', {
    internalKey: INTERNAL_KEY,
    now,
  })) as DecommissionCandidate[]
}

async function sha256Hex(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function uniqueSlug(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

interface UserRow {
  _id: string
  email: string
  name?: string
}

interface RawWorkspace {
  _id: string
  slug: string
  status: string
  imageRef?: string
  vmName?: string
  vmDiskGb?: number
  sshDest?: string
  httpsUrl?: string
  provisioningTokenHash?: string
  vmTokenHash?: string
  vmTokenNonce?: string
  vmAttachRunId?: string
  vmTeardownRunId?: string
  attachAfterVmTeardown?: boolean
  vmCleanupPending?: boolean
  servicingStatus?: string
  servicingStatusChangedAt?: number
  lifecycleBackupId?: string
  lastHeartbeatAt?: number
  healthSweepRetryAt?: number
  vmModelCredentialRetryAt?: number
  vmModelCredentialRetryScopeKey?: string
  runtimeVersion?: string
  imageVersion?: string
}

interface AuditRow {
  id: string
  event: string
  provenance?: Record<string, unknown>
}

interface VmModelKeyResult {
  key: string
  prefix: string
  scopes: string[]
}
