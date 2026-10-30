import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'

import {
  MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE,
  VM_MODEL_CREDENTIAL_REFRESH_WINDOW_MS,
} from '@repo/contract'
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

import {
  keyPrefix,
  MAX_UNREVOKED_VM_MODEL_KEYS_PER_WORKSPACE,
  VM_MODEL_KEY_EXPIRES_MS,
} from '../convex/domains/apiKeys/model'
import { GATED_REVALIDATE_INTERVAL_MS } from '../convex/domains/marketplace/model'
import { MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC } from '../convex/domains/shares/syncProjection'
import {
  planVmSyncPersistence,
  type VmSyncPersistenceSnapshot,
} from '../convex/domains/workspaces/vmSync'

describe('VM sync persistence planning', () => {
  test('persists when no sync observation has been recorded', () => {
    expect(
      planVmSyncPersistence(
        { status: 'active', runtimeVersion: '1.0.0', imageVersion: '2.0.0' },
        {
          needsModelCredentials: false,
          versions: { runtime: '1.0.0', image: '2.0.0' },
        },
        100_000,
      ),
    ).toEqual({
      persist: true,
      reasons: ['observation_missing'],
    })
  })

  test('reports every urgent and time-based reason in stable policy order', () => {
    const observation = {
      needsModelCredentials: true,
      versions: {
        runtime: '1.1.0',
        image: '4.1.0',
      },
    }

    expect(
      planVmSyncPersistence(
        {
          status: 'unhealthy',
          lastHeartbeatAt: 40_000,
          runtimeVersion: '1.0.0',
          imageVersion: '4.0.0',
          syncthingDeviceId: SYNCTHING_DEVICE_ID_ONE,
        },
        { ...observation, syncthingDeviceId: SYNCTHING_DEVICE_ID_TWO },
        100_000,
      ),
    ).toEqual({
      persist: true,
      reasons: [
        'observation_due',
        'status_recovery',
        'runtime_version_changed',
        'image_version_changed',
        'syncthing_device_id_changed',
        'credentials_requested',
      ],
    })
  })

  test('persists for each policy trigger and not for an idle observation', () => {
    const snapshot: VmSyncPersistenceSnapshot = {
      status: 'active',
      lastHeartbeatAt: 50_000,
      runtimeVersion: '1.0.0',
      imageVersion: '4.0.0',
      syncthingDeviceId: SYNCTHING_DEVICE_ID_ONE,
    }
    const observation = {
      needsModelCredentials: false,
      versions: {
        runtime: '1.0.0',
        image: '4.0.0',
      },
    }
    const cases = [
      { name: 'idle', snapshot, observation, now: 109_999, reasons: [] },
      {
        name: 'interval',
        snapshot,
        observation,
        now: 110_000,
        reasons: ['observation_due'],
      },
      {
        name: 'recovery',
        snapshot: { ...snapshot, status: 'unhealthy' as const },
        observation,
        now: 100_000,
        reasons: ['status_recovery'],
      },
      ...(['runtime', 'image'] as const).map(component => ({
        name: component,
        snapshot,
        observation: {
          ...observation,
          versions: { ...observation.versions, [component]: '9.0.0' },
        },
        now: 100_000,
        reasons: [`${component}_version_changed`],
      })),
      {
        name: 'credentials',
        snapshot,
        observation: { ...observation, needsModelCredentials: true },
        now: 100_000,
        reasons: ['credentials_requested'],
      },
      {
        name: 'app credentials',
        snapshot,
        observation: { ...observation, needsAppCredentials: ['app_1'] },
        now: 100_000,
        reasons: ['credentials_requested'],
      },
      {
        name: 'syncthing device',
        snapshot,
        observation: {
          ...observation,
          syncthingDeviceId: SYNCTHING_DEVICE_ID_TWO,
        },
        now: 100_000,
        reasons: ['syncthing_device_id_changed'],
      },
    ]

    for (const policyCase of cases) {
      expect(
        planVmSyncPersistence(policyCase.snapshot, policyCase.observation, policyCase.now),
        policyCase.name,
      ).toEqual({
        persist: policyCase.reasons.length > 0,
        reasons: policyCase.reasons,
      })
    }
  })

  test('amplifies twelve idle five-second observations into one write per minute', () => {
    let snapshot: VmSyncPersistenceSnapshot = {
      status: 'active' as const,
      runtimeVersion: idleObservation.versions.runtime,
      imageVersion: idleObservation.versions.image,
    }
    let persists = 0

    for (let now = 0; now < 60_000; now += 5_000) {
      const plan = planVmSyncPersistence(snapshot, idleObservation, now)
      if (!plan.persist) continue
      persists += 1
      snapshot = {
        ...snapshot,
        lastHeartbeatAt: now,
      }
    }

    expect(persists).toBe(1)
  })
})

const INTERNAL_KEY = 'test-api-internal-key'
const BACKEND_DIR = new URL('..', import.meta.url).pathname
const SYNCTHING_DEVICE_ID_ONE = 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'
const SYNCTHING_DEVICE_ID_TWO = 'A5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'

let convex: ConvexDevFixture
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let member: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0

describe('VM sync Convex domain', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys({ kid: 'test-key', alg: 'RS256' }),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_API_URL: 'http://api.example',
        DUET_APP_URL: 'http://localhost:3000',
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        // The projection derives listing source URLs and edgeHost() fails closed.
        DUET_EDGE_HOST: 'edge-staging.duet.so',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_TEST_FAKE_EXE: '1',
        DUET_VM_IMAGE_REF: 'ttl.sh/duet-vm-sync-test:1h',
      },
      reset: true,
    })
    owner = await signInWithMagicLink(convex, uniqueEmail('vm-sync-owner'), 'VM Sync Owner')
    member = await signInWithMagicLink(convex, uniqueEmail('vm-sync-member'), 'VM Sync Member')
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

  test('treats a missing update-control row as unpaused — the row is an explicit brake', async () => {
    const registered = await registeredWorkspace('missing-control', 10_000)

    const state = (await query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      now: 11_000,
    })) as { updatesPaused: boolean }

    expect(state.updatesPaused).toBe(false)
  })

  // Must run before any test seeds the update-control row: the quiesce
  // projection has its own default site for the missing singleton.
  test('quiesced workspace with a missing update-control row is still unpaused', async () => {
    const registered = await registeredWorkspace('missing-control-quiesce', 10_000)
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      servicingStatus: 'paused',
      now: 10_100,
    })

    const state = (await query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      now: 11_000,
    })) as { quiesce: boolean; updatesPaused: boolean }

    expect(state.quiesce).toBe(true)
    expect(state.updatesPaused).toBe(false)
  })

  test('SUBS-IMPL-07 projects a per-workspace quiesce without using update rollout pause', async () => {
    const registered = await registeredWorkspace('servicing-quiesce', 10_000)
    await mutate(convex, 'domains/workspaces/vmSync:setUpdatesPaused', {
      internalKey: INTERNAL_KEY,
      paused: false,
      now: 10_100,
    })
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      servicingStatus: 'paused',
      now: 10_200,
    })

    const state = (await query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      now: 11_000,
    })) as {
      quiesce: boolean
      updatesPaused: boolean
      anchors: unknown[]
      apps: unknown[]
      shareSync: { shares: unknown[] }
    }
    const shareSync = state.shareSync

    expect(state).toMatchObject({
      quiesce: true,
      updatesPaused: false,
      anchors: [],
      apps: [],
      // The quiesce branch hand-builds its return, so a roster added only to
      // the happy path would be undefined here rather than empty.
      agents: [],
    })
    expect(shareSync).toEqual({ shares: [] })
  })

  test('projects the existing VM anchor list without a second filtering path', async () => {
    const registered = await registeredWorkspace('anchor-projection', 12_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: registered.workspaceId,
      path: 'apps/calendar',
      kind: 'app',
      settings: {},
      now: 14_000,
    })

    const [existing, state] = (await Promise.all([
      query(convex, 'domains/anchors/model:listForVm', {
        internalKey: INTERNAL_KEY,
        vmTokenHash,
      }),
      query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
        internalKey: INTERNAL_KEY,
        vmTokenHash,
        now: 14_000,
      }),
    ])) as [Array<{ path: string }>, { anchors: Array<{ path: string }> }]

    expect(state.anchors).toEqual(existing)
    expect(state.anchors.map(anchor => anchor.path)).toEqual(['apps/calendar'])
  })

  test('projects the agent roster beside the anchors, root first', async () => {
    const registered = await registeredWorkspace('agent-roster', 16_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    await mutate(owner.client, 'domains/agents/model:updateDefaultAgent', {
      workspaceId: registered.workspaceId,
      name: 'HQ',
    })
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: registered.workspaceId,
      path: 'agents/zebra',
      slug: 'zebra',
    })
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: registered.workspaceId,
      path: 'agents/research',
      slug: 'research',
      name: 'Research',
    })
    await mutate(owner.client, 'domains/agents/model:setAgentOnboarded', {
      workspaceId: registered.workspaceId,
      slug: 'research',
      onboarded: true,
      now: 16_500,
    })
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: registered.workspaceId,
      path: 'agents/off',
      slug: 'off',
    })
    await mutate(owner.client, 'domains/agents/model:setAgentDisabled', {
      workspaceId: registered.workspaceId,
      slug: 'off',
      disabled: true,
      now: 17_000,
    })

    const state = (await query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      now: 18_000,
    })) as {
      anchors: Array<{ path: string; agentId?: string }>
      agents: Array<Record<string, unknown>>
    }

    // Root leads with the workspace's own name, so a top-level agent can name
    // the one agent above it; registered agents follow in slug order. The
    // disabled agent is absent through the SAME branch that drops its
    // GatewayAnchor.agentId — one rule, not two.
    expect(
      state.agents.map(agent => [agent.kind, agent.slug, agent.name, agent.onboardedAt]),
    ).toEqual([
      ['root', 'root', 'HQ', undefined],
      ['agent', 'research', 'Research', 16_500],
      ['agent', 'zebra', 'zebra', undefined],
    ])
    const research = state.agents[1] as {
      agentId: string
      anchorId: string
      anchorPath: string
    }
    expect(research.anchorPath).toBe('agents/research')
    expect(state.anchors.find(anchor => anchor.path === 'agents/research')?.agentId).toBe(
      research.agentId,
    )
    // The disabled agent's anchor is still active on disk — only its agent
    // identity is withheld, from the anchor and the roster alike.
    expect(state.anchors.some(anchor => anchor.path === 'agents/off')).toBe(true)
  })

  test('gathers complementary desired share sync state from persisted share topology', async () => {
    const source = await registeredWorkspace('share-source', 13_000)
    const target = await registeredWorkspace('share-target', 13_500)
    await mutate(convex, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: source.workspaceId,
      now: 14_000,
    })
    await mutate(convex, 'testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      now: 14_500,
    })
    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(source.vmToken),
      observation: {
        ...idleObservation,
        syncthingDeviceId: SYNCTHING_DEVICE_ID_ONE,
      },
      now: 15_000,
    })
    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(target.vmToken),
      observation: {
        ...idleObservation,
        syncthingDeviceId: SYNCTHING_DEVICE_ID_TWO,
      },
      now: 15_500,
    })
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: source.workspaceId,
      toEmail: owner.user.email,
      path: 'projects/demo',
      mode: 'read',
      now: 16_000,
    })) as { share: { id: string } }
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: target.workspaceId,
      mountPath: 'shared/demo',
      now: 17_000,
    })

    const [sourceState, targetState] = (
      (await Promise.all([
        query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
          internalKey: INTERNAL_KEY,
          vmTokenHash: await sha256Hex(source.vmToken),
          now: 18_000,
        }),
        query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
          internalKey: INTERNAL_KEY,
          vmTokenHash: await sha256Hex(target.vmToken),
          now: 18_000,
        }),
      ])) as Array<{ shareSync: unknown }>
    ).map(state => state.shareSync) as [
      { shares: Array<{ folder: { role: string; path: string } }> },
      {
        shares: Array<{
          folder: { role: string; path: string }
          mount?: unknown
        }>
      },
    ]

    expect(sourceState.shares[0]?.folder).toMatchObject({
      role: 'origin',
      path: 'projects/demo',
    })
    expect(targetState.shares[0]).toMatchObject({
      folder: { role: 'recipient', path: 'shared/demo' },
      mount: { path: 'shared/demo' },
    })
    expect(JSON.stringify({ sourceState, targetState })).not.toContain('tokenSecret')
  })

  test('renews near-expiry share credentials during observation persistence without generation churn', async () => {
    const source = await registeredWorkspace('share-renew-source', 18_000)
    const target = await registeredWorkspace('share-renew-target', 18_500)
    for (const [workspaceId, now] of [
      [source.workspaceId, 19_000],
      [target.workspaceId, 19_500],
    ] as const) {
      await mutate(convex, 'testing/workspaces:markWorkspaceLiveForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        now,
      })
    }
    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(source.vmToken),
      observation: {
        ...idleObservation,
        syncthingDeviceId: SYNCTHING_DEVICE_ID_ONE,
      },
      now: 20_000,
    })
    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(target.vmToken),
      observation: {
        ...idleObservation,
        syncthingDeviceId: SYNCTHING_DEVICE_ID_TWO,
      },
      now: 20_500,
    })
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: source.workspaceId,
      toEmail: owner.user.email,
      path: 'projects/renew',
      mode: 'write',
      now: 21_000,
    })) as { share: { id: string } }
    const acceptedAt = 22_000
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: target.workspaceId,
      mountPath: 'shared/renew',
      now: acceptedAt,
    })
    const shareSyncFor = async (now: number) =>
      (
        (await query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
          internalKey: INTERNAL_KEY,
          vmTokenHash: await sha256Hex(source.vmToken),
          now,
        })) as {
          shareSync: {
            shares: Array<{
              generation: string
              accept: { tokenDigest: string; expiresAt: number }
              bridge: { tunnelToken: string }
            }>
          }
        }
      ).shareSync
    const initial = await shareSyncFor(acceptedAt + 1)

    const renewalAt = acceptedAt + 23 * 60 * 60 * 1000
    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(source.vmToken),
      observation: idleObservation,
      now: renewalAt,
    })
    const renewed = await shareSyncFor(renewalAt + 1)

    expect(renewed.shares[0]?.generation).toBe(initial.shares[0]?.generation)
    expect(renewed.shares[0]?.accept.expiresAt).toBeGreaterThan(initial.shares[0]!.accept.expiresAt)
    expect(renewed.shares[0]?.bridge.tunnelToken).not.toBe(initial.shares[0]?.bridge.tunnelToken)
    expect(renewed.shares[0]?.accept.tokenDigest).not.toBe(initial.shares[0]?.accept.tokenDigest)
  })

  test('changes global update pause state without a deploy', async () => {
    const registered = await registeredWorkspace('pause-control', 15_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)

    await mutate(convex, 'domains/workspaces/vmSync:setUpdatesPaused', {
      internalKey: INTERNAL_KEY,
      paused: false,
      reason: 'maintenance complete',
      now: 17_000,
    })
    const state = (await query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      now: 17_000,
    })) as { updatesPaused: boolean }

    expect(state.updatesPaused).toBe(false)
  })

  test('recovers an unhealthy workspace and audits the transition exactly once', async () => {
    const registered = await registeredWorkspace('healthy-recovery', 30_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    await mutate(convex, 'domains/workspaces/provisioning:markUnhealthyWorkspaces', {
      internalKey: INTERNAL_KEY,
      now: 92_000,
      staleAfterMs: 60_000,
    })

    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: idleObservation,
      now: 93_000,
    })
    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: idleObservation,
      now: 94_000,
    })

    expect(await rawWorkspace(registered.workspaceId)).toMatchObject({
      status: 'active',
      lastHeartbeatAt: 93_000,
    })
    const healthyEvents = (await auditEvents(registered.workspaceId)).filter(
      event => event.event === 'workspace.became_healthy',
    )
    expect(healthyEvents).toHaveLength(1)
  })

  test('a gateway report with custom-domain metadata restores an unhealthy workspace heartbeat', async () => {
    const registered = await registeredWorkspace('report-metadata', 47_000)
    // Registered for its side effect only — the run config is read back below by
    // slug, so the returned id/port are never needed.
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'apps/reported',
      command: 'bun run start',
      apiScopes: [],
      slug: 'reported',
      now: 47_100,
    })
    const configs = (await query(convex, 'domains/apps/model:runConfigForWorkspace', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
    })) as Array<Record<string, unknown>>
    const config = configs.find(candidate => candidate.slug === 'reported')!

    await mutate(convex, 'domains/workspaces/provisioning:markUnhealthyWorkspaces', {
      internalKey: INTERNAL_KEY,
      now: 109_000,
      staleAfterMs: 60_000,
    })

    const accepted = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      observation: {
        ...idleObservation,
        appReconciliationReports: [
          {
            ...config,
            visibility: 'folder',
            canonicalUrl: 'https://reported--example.edge-staging.duet.so/',
            customDomain: { hostname: 'reported.example.com', status: 'active' },
            status: 'reconciled',
          },
        ],
      },
      now: 110_000,
    })) as { persisted: boolean }
    expect(accepted).toBeDefined()
    expect(
      await query(owner.client, 'domains/apps/model:getBySlug', {
        workspaceId: registered.workspaceId,
        slug: 'reported',
      }),
    ).toMatchObject({ runtimeStatus: 'reconciled' })
    expect(await rawWorkspace(registered.workspaceId)).toMatchObject({
      status: 'active',
      lastHeartbeatAt: 110_000,
    })
  })

  test('delivers rotated credentials unprompted when the live key scope set is stale', async () => {
    const registered = await registeredWorkspace('scope-drift-heal', 46_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const minted = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: true },
      now: 46_100,
    })) as { modelCredentials: { apiKey: string } }
    // Display prefix = 'duet_sk_' + 8 chars, matching the API's auth lookup.
    const keyPrefix = minted.modelCredentials.apiKey.slice(0, 16)
    const slug = (await rawWorkspace(registered.workspaceId)).slug as string
    await mutate(convex, 'testing/apiKeys:replaceApiKeyScopesForTest', {
      internalKey: INTERNAL_KEY,
      keyPrefix,
      scopes: [`ws:${slug}:services`, `ws:${slug}:apps`, `ws:${slug}:agents`],
    })

    // The VM did not ask (needsModelCredentials: false), but the server sees
    // the pre-`sessions` scope set and heals it within this one poll.
    const healed = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: false },
      now: 46_200,
    })) as { modelCredentials?: { apiKey: string } }
    expect(healed.modelCredentials?.apiKey).toStartWith('duet_sk_')
    expect(healed.modelCredentials?.apiKey).not.toBe(minted.modelCredentials.apiKey)

    // A current-scope key stays quiet: no unprompted delivery on the next poll.
    const settled = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: false },
      now: 46_300,
    })) as { modelCredentials?: { apiKey: string } }
    expect(settled.modelCredentials).toBeUndefined()
  })

  test('a refreshed VM key supersedes its predecessor instead of stranding it', async () => {
    const registered = await registeredWorkspace('cred-overlap', 50_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const first = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: true },
      now: 51_000,
    })) as { modelCredentials: { apiKey: string; expiresAt: number } }

    // The VM asks a refresh window early, and an agent runner bakes whatever
    // key was current into its env at spawn for the whole turn. So the
    // predecessor has to keep working through the handover — revoking it here
    // 401s every model call of a turn already in flight.
    const refreshedAt = first.modelCredentials.expiresAt - VM_MODEL_CREDENTIAL_REFRESH_WINDOW_MS
    const second = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: true },
      now: refreshedAt,
    })) as { modelCredentials: { apiKey: string; expiresAt: number } }
    expect(second.modelCredentials.apiKey).not.toBe(first.modelCredentials.apiKey)

    expect(await vmKeyAuthenticates(first.modelCredentials.apiKey, refreshedAt + 1)).toBe(true)
    expect(await vmKeyAuthenticates(second.modelCredentials.apiKey, refreshedAt + 1)).toBe(true)

    // The overlap is bounded by the predecessor's own lifetime, not indefinite.
    expect(
      await vmKeyAuthenticates(first.modelCredentials.apiKey, first.modelCredentials.expiresAt + 1),
    ).toBe(false)
    expect(
      await vmKeyAuthenticates(
        second.modelCredentials.apiKey,
        first.modelCredentials.expiresAt + 1,
      ),
    ).toBe(true)
  })

  test('a retry after a lost refresh response preserves every key the VM may still hold', async () => {
    const registered = await registeredWorkspace('cred-lost-response', 60_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const firstPollAt = 61_000
    const deliver = async () => {
      const response = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
        internalKey: INTERNAL_KEY,
        vmTokenHash,
        observation: { ...idleObservation, needsModelCredentials: true },
        now: firstPollAt,
      })) as { modelCredentials: { apiKey: string } }
      return response.modelCredentials.apiKey
    }

    const vmHeldKey = await deliver()
    const lostResponseKey = await deliver()
    const retryKey = await deliver()
    const afterLastPoll = firstPollAt + 1

    // The VM may still hold the first key because the second response was lost,
    // while an already-running agent may hold either earlier key in its env.
    expect(await vmKeyAuthenticates(vmHeldKey, afterLastPoll)).toBe(true)
    expect(await vmKeyAuthenticates(lostResponseKey, afterLastPoll)).toBe(true)
    expect(await vmKeyAuthenticates(retryKey, afterLastPoll)).toBe(true)
  })

  test('credential retries preserve heartbeats at the bounded live-key ceiling and recover at expiry', async () => {
    const registered = await registeredWorkspace('cred-delivery-cap', 70_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const deliver = async (now: number) =>
      (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
        internalKey: INTERNAL_KEY,
        vmTokenHash,
        observation: { ...idleObservation, needsModelCredentials: true },
        now,
      })) as { modelCredentials: { apiKey: string; expiresAt: number } }

    let first: Awaited<ReturnType<typeof deliver>> | undefined
    for (let attempt = 0; attempt < MAX_UNREVOKED_VM_MODEL_KEYS_PER_WORKSPACE; attempt += 1) {
      const delivered = await deliver(71_000)
      first ??= delivered
    }

    const cappedAt = 72_000
    const capped = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: true },
      now: cappedAt,
    })) as { modelCredentials?: { apiKey: string }; modelCredentialsRetryAt?: number }
    expect(capped.modelCredentials).toBeUndefined()
    expect(capped.modelCredentialsRetryAt).toBe(first!.modelCredentials.expiresAt)
    expect(await rawWorkspace(registered.workspaceId)).toMatchObject({
      status: 'active',
      lastHeartbeatAt: cappedAt,
      vmModelCredentialRetryAt: first!.modelCredentials.expiresAt,
    })
    expect(await vmKeyAuthenticates(first!.modelCredentials.apiKey, 71_001)).toBe(true)

    const waiting = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: true },
      now: cappedAt + 1,
    })) as { modelCredentials?: { apiKey: string }; modelCredentialsRetryAt?: number }
    expect(waiting).toMatchObject({ modelCredentialsRetryAt: first!.modelCredentials.expiresAt })
    expect(waiting.modelCredentials).toBeUndefined()

    const recovered = await deliver(first!.modelCredentials.expiresAt)
    expect(recovered.modelCredentials.apiKey).toStartWith('duet_sk_')
    expect((await rawWorkspace(registered.workspaceId)).vmModelCredentialRetryAt).toBeUndefined()
  }, 60_000)

  test('an explicit model-key revocation clears a capacity retry boundary immediately', async () => {
    const registered = await registeredWorkspace('cred-cap-revoked', 80_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const deliver = async (now: number) =>
      (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
        internalKey: INTERNAL_KEY,
        vmTokenHash,
        observation: { ...idleObservation, needsModelCredentials: true },
        now,
      })) as { modelCredentials?: { apiKey: string; expiresAt: number } }

    for (let attempt = 0; attempt < MAX_UNREVOKED_VM_MODEL_KEYS_PER_WORKSPACE; attempt += 1) {
      await deliver(81_000)
    }
    await deliver(82_000)
    const retryAt = (await rawWorkspace(registered.workspaceId)).vmModelCredentialRetryAt as number
    expect(retryAt).toBeGreaterThan(82_000)

    await mutate(convex, 'domains/apiKeys/mutations:revokeVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      now: 82_001,
    })
    expect((await rawWorkspace(registered.workspaceId)).vmModelCredentialRetryAt).toBeUndefined()

    const recovered = await deliver(82_002)
    expect(recovered.modelCredentials?.apiKey).toStartWith('duet_sk_')
  }, 60_000)

  test('an explicit model-key rotation clears a capacity retry boundary immediately', async () => {
    const registered = await registeredWorkspace('cred-cap-rotated', 85_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const deliver = async (now: number) =>
      (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
        internalKey: INTERNAL_KEY,
        vmTokenHash,
        observation: { ...idleObservation, needsModelCredentials: true },
        now,
      })) as { modelCredentials?: { apiKey: string; expiresAt: number } }

    for (let attempt = 0; attempt < MAX_UNREVOKED_VM_MODEL_KEYS_PER_WORKSPACE; attempt += 1) {
      await deliver(86_000)
    }
    await deliver(87_000)
    expect((await rawWorkspace(registered.workspaceId)).vmModelCredentialRetryAt).toBeGreaterThan(
      87_000,
    )

    const rotated = (await mutate(convex, 'domains/apiKeys/mutations:rotateVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      now: 87_001,
    })) as { key: string | null }
    expect(rotated.key).toStartWith('duet_sk_')
    expect((await rawWorkspace(registered.workspaceId)).vmModelCredentialRetryAt).toBeUndefined()
  }, 60_000)

  test('a changed model scope set invalidates a capacity retry boundary immediately', async () => {
    const registered = await registeredWorkspace('cred-cap-scope-change', 90_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const deliver = async (now: number) =>
      (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
        internalKey: INTERNAL_KEY,
        vmTokenHash,
        observation: { ...idleObservation, needsModelCredentials: true },
        now,
      })) as { modelCredentials?: { apiKey: string; expiresAt: number } }

    const liveKeys: string[] = []
    for (let attempt = 0; attempt < MAX_UNREVOKED_VM_MODEL_KEYS_PER_WORKSPACE; attempt += 1) {
      const delivered = await deliver(91_000)
      liveKeys.push(delivered.modelCredentials!.apiKey)
    }
    await deliver(92_000)
    const retryAt = (await rawWorkspace(registered.workspaceId)).vmModelCredentialRetryAt as number
    expect(retryAt).toBeGreaterThan(92_000)

    const slug = (await rawWorkspace(registered.workspaceId)).slug as string
    for (const apiKey of liveKeys) {
      await mutate(convex, 'testing/apiKeys:replaceApiKeyScopesForTest', {
        internalKey: INTERNAL_KEY,
        keyPrefix: keyPrefix(apiKey),
        scopes: [`ws:${slug}:services`],
      })
    }
    await mutate(convex, 'testing/workspaces:setVmModelCredentialRetryForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      retryAt,
      scopeKey: 'stale-scope-set',
    })
    const recovered = await deliver(92_001)
    expect(recovered.modelCredentials?.apiKey).toStartWith('duet_sk_')
    expect((await rawWorkspace(registered.workspaceId)).vmModelCredentialRetryAt).toBeUndefined()
  }, 60_000)

  test('reactivation redelivers credentials the pause let expire, unprompted', async () => {
    const registered = await registeredWorkspace('reactivation-heal', 100_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const minted = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: true },
      now: 200_000,
    })) as { modelCredentials: { apiKey: string } }

    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      servicingStatus: 'paused',
      now: 300_000,
    })
    // A paused workspace keeps no spend authority, so even an asking VM is
    // refused — this is what lets the delivered key die of old age.
    const expired = 200_000 + VM_MODEL_KEY_EXPIRES_MS + 1
    const refused = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: true },
      now: expired,
    })) as { modelCredentials?: { apiKey: string } }
    expect(refused.modelCredentials).toBeUndefined()

    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      servicingStatus: 'active',
      now: expired + 1_000,
    })

    // The VM does not have to ask: the workspace holds no live key, so the
    // first poll after reactivation carries one.
    const healed = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: false },
      now: expired + 2_000,
    })) as { modelCredentials?: { apiKey: string } }
    expect(healed.modelCredentials?.apiKey).toStartWith('duet_sk_')
    expect(healed.modelCredentials?.apiKey).not.toBe(minted.modelCredentials.apiKey)

    // One delivery settles it: the next poll is quiet again.
    const settled = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsModelCredentials: false },
      now: expired + 3_000,
    })) as { modelCredentials?: { apiKey: string } }
    expect(settled.modelCredentials).toBeUndefined()
  })

  test('mints missing model credentials and supersedes ones that cannot be redelivered', async () => {
    const registered = await registeredWorkspace('credential-matrix', 40_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const observation = { ...idleObservation, needsModelCredentials: true }

    const minted = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation,
      now: 42_000,
    })) as { modelCredentials: { apiKey: string } }
    const rotated = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation,
      now: 43_000,
    })) as { modelCredentials: { apiKey: string } }

    expect(minted.modelCredentials.apiKey).toStartWith('duet_sk_')
    expect(rotated.modelCredentials.apiKey).toStartWith('duet_sk_')
    expect(rotated.modelCredentials.apiKey).not.toBe(minted.modelCredentials.apiKey)
    expect(
      (await auditEvents(registered.workspaceId))
        .map(event => event.event)
        .filter(event => event.startsWith('api_key.vm_model_key_')),
    ).toEqual(['api_key.vm_model_key_minted', 'api_key.vm_model_key_superseded'])
  })

  test('delivers a first app credential whose plaintext matches the persisted hash', async () => {
    const registered = await registeredWorkspace('app-credential-first', 44_000)
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'apps/credential-first',
      command: 'bun run start',
      apiScopes: ['sessions', 'members'],
      slug: 'credential-first',
      now: 44_100,
    })) as { id: string }

    const delivered = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      observation: { ...idleObservation, needsAppCredentials: [app.id] },
      now: 45_000,
    })) as {
      appCredentials: Array<{
        appId: string
        apiKey: string
        scopes: string[]
        expiresAt: number
      }>
    }

    expect(delivered.appCredentials).toEqual([
      {
        appId: app.id,
        apiKey: expect.stringContaining('duet_sk_'),
        scopes: ['members', 'sessions'],
        expiresAt: expect.any(Number),
      },
    ])
    const stored = (await rawApiKeys()).find(key => key.appId === app.id)
    expect(stored).toMatchObject({
      kind: 'app',
      workspaceId: registered.workspaceId,
      hashedKey: await sha256Hex(delivered.appCredentials[0]!.apiKey),
      // The stored key carries ws-serialized scopes; the envelope carries the
      // bare declared capabilities.
      scopes: [
        expect.stringMatching(/^ws:app-credential-first-.*:members$/),
        expect.stringMatching(/^ws:app-credential-first-.*:sessions$/),
      ],
      expiresAt: delivered.appCredentials[0]!.expiresAt,
    })
  })

  test('keeps app credential plaintext off quiet polls', async () => {
    const registered = await registeredWorkspace('app-credential-quiet', 45_100)
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'apps/credential-quiet',
      command: 'bun run start',
      apiScopes: ['members'],
      slug: 'credential-quiet',
      now: 45_200,
    })) as { id: string }
    const minted = (await mutate(convex, 'domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: app.id,
      now: 45_300,
    })) as { prefix: string }

    const result = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      observation: idleObservation,
      now: 45_400,
    })) as { appCredentials?: unknown[] }

    expect(result.appCredentials).toBeUndefined()
    expect(
      (await rawApiKeys()).find(key => key.prefix === minted.prefix)?.revokedAt,
    ).toBeUndefined()
  })

  test('deduplicates one ask and rotates exactly once when the gateway re-asks after losing it', async () => {
    const registered = await registeredWorkspace('app-cred-redelivery', 46_000)
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'apps/credential-redelivery',
      command: 'bun run start',
      apiScopes: ['members'],
      slug: 'credential-redelivery',
      now: 46_100,
    })) as { id: string }
    const caller = (await mutate(convex, 'domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      now: Date.now(),
    })) as { key: string; prefix: string }
    const exported = (await mutate(convex, 'domains/apiKeys/appExports:exportCredential', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      appSlug: 'credential-redelivery',
      caller: { hashedKey: await sha256Hex(caller.key), keyPrefix: caller.prefix },
      expiration: 'never',
    })) as { key: string; prefix: string }
    const vmTokenHash = await sha256Hex(registered.vmToken)

    const first = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: {
        ...idleObservation,
        needsAppCredentials: [app.id, app.id],
      },
      now: 47_000,
    })) as { appCredentials: Array<{ apiKey: string }> }
    const second = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: { ...idleObservation, needsAppCredentials: [app.id] },
      now: 48_000,
    })) as { appCredentials: Array<{ apiKey: string }> }

    expect(
      await query(convex, 'domains/apiKeys/api:resolveCredential', {
        internalKey: INTERNAL_KEY,
        hashedKey: await sha256Hex(exported.key),
        keyPrefix: exported.prefix,
        now: Date.now(),
      }),
    ).toMatchObject({ ok: true })
    expect(first.appCredentials).toHaveLength(1)
    expect(second.appCredentials).toHaveLength(1)
    expect(second.appCredentials[0]!.apiKey).not.toBe(first.appCredentials[0]!.apiKey)
    const rows = (await rawApiKeys()).filter(
      key => key.appId === app.id && key.appKeyPurpose === undefined,
    )
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.revokedAt === 48_000)?.hashedKey).toBe(
      await sha256Hex(first.appCredentials[0]!.apiKey),
    )
    expect(rows.find(row => row.revokedAt === undefined)?.hashedKey).toBe(
      await sha256Hex(second.appCredentials[0]!.apiKey),
    )
    expect(
      (await auditEvents(registered.workspaceId))
        .map(event => event.event)
        .filter(event => event.startsWith('api_key.app_key_')),
    ).toEqual(['api_key.app_key_minted', 'api_key.app_key_rotated', 'api_key.app_key_minted'])
  })

  test('delivers nothing for disabled, unknown, cross-workspace, or empty-declaration apps', async () => {
    const registered = await registeredWorkspace('app-cred-filter', 49_000)
    const other = await registeredWorkspace('app-cred-filter-other', 49_100)
    const register = async (workspaceId: string, slug: string, apiScopes: string[]) =>
      (await mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId,
        path: `apps/${slug}`,
        command: 'bun run start',
        apiScopes,
        slug,
        now: 49_200,
      })) as { id: string; slug: string }
    const disabled = await register(registered.workspaceId, 'disabled', ['members'])
    const empty = await register(registered.workspaceId, 'empty', [])
    const deleted = await register(registered.workspaceId, 'deleted', ['members'])
    const crossWorkspace = await register(other.workspaceId, 'cross-workspace', ['members'])
    await mutate(convex, 'testing/apps:forceDisabledAtForTest', {
      internalKey: INTERNAL_KEY,
      appId: disabled.id,
      disabledAt: 49_300,
    })
    await mutate(owner.client, 'domains/apps/model:deleteApp', {
      workspaceId: registered.workspaceId,
      slug: deleted.slug,
      now: 49_400,
    })

    const result = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      observation: {
        ...idleObservation,
        needsAppCredentials: [
          disabled.id,
          empty.id,
          deleted.id,
          crossWorkspace.id,
          'not-a-convex-id',
        ],
      },
      now: 50_000,
    })) as { appCredentials?: unknown[] }

    expect(result.appCredentials).toBeUndefined()
    expect(
      (await rawApiKeys()).filter(key =>
        [disabled.id, empty.id, deleted.id, crossWorkspace.id].includes(String(key.appId)),
      ),
    ).toEqual([])
  })

  test('delivers no app credentials while the workspace is quiesced', async () => {
    const registered = await registeredWorkspace('app-credential-quiesced', 51_000)
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'apps/quiesced',
      command: 'bun run start',
      apiScopes: ['members'],
      slug: 'quiesced',
      now: 51_100,
    })) as { id: string }
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      servicingStatus: 'paused',
      now: 51_200,
    })

    const result = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      observation: { ...idleObservation, needsAppCredentials: [app.id] },
      now: 52_000,
    })) as { appCredentials?: unknown[] }

    expect(result.appCredentials).toBeUndefined()
    expect((await rawApiKeys()).filter(key => key.appId === app.id)).toEqual([])
  })

  test('stores complete runtime and image observations without a telemetry write', async () => {
    const registered = await registeredWorkspace('runtime-observation', 50_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const persisted = (await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: idleObservation,
      now: 52_000,
    })) as { persisted: boolean }

    expect(persisted.persisted).toBe(true)
    expect(await rawWorkspace(registered.workspaceId)).toMatchObject({
      runtimeVersion: idleObservation.versions.runtime,
      imageVersion: idleObservation.versions.image,
      lastHeartbeatAt: 52_000,
    })
    expect(await rawTelemetrySamples(registered.workspaceId)).toEqual([])
  })

  test('clears the device id on reprovision and accepts the replacement VM identity', async () => {
    const registered = await registeredWorkspace('syncthing-device', 55_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)

    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: {
        ...idleObservation,
        syncthingDeviceId: SYNCTHING_DEVICE_ID_ONE,
      },
      now: 57_000,
    })
    await mutate(convex, 'domains/workspaces/provisioning:beginOperatorReprovision', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      now: 58_000,
    })
    expect((await rawWorkspace(registered.workspaceId)).syncthingDeviceId).toBeUndefined()

    // beginOperatorReprovision schedules the teardown->attach continuation,
    // whose own re-prepare would race the manual pair below (and can rotate
    // the vm token even after a successful registration). Settle it first so
    // the pair runs against a workspace with no live provisioning actors.
    await settleWorkspaceProvisioning(convex, {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
    })
    const replacementProvisioningToken = 'replacement-provisioning-token'
    await mutate(convex, 'testing/workspaces:prepareWorkspaceForRegistration', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: registered.workspaceId,
      slug: `replacement-${Date.now()}-${sequence}`,
      name: 'replacement workspace',
      imageRef: 'ttl.sh/duet-vm-sync-test:1h',
      provisioningTokenHash: await sha256Hex(replacementProvisioningToken),
      provisioningTokenExpiresAt: 120_000,
      now: 59_000,
    })
    const replacement = (await mutate(convex, 'domains/workspaces/provisioning:registerVm', {
      internalKey: INTERNAL_KEY,
      provisioningTokenHash: await sha256Hex(replacementProvisioningToken),
      workspaceHint: registered.workspaceId,
      runtimeVersion: idleObservation.versions.runtime,
      imageVersion: idleObservation.versions.image,
      now: 60_000,
    })) as { vmToken: string }
    expect(replacement.vmToken).not.toBe(registered.vmToken)
    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(replacement.vmToken),
      observation: {
        ...idleObservation,
        syncthingDeviceId: SYNCTHING_DEVICE_ID_TWO,
      },
      now: 61_000,
    })

    expect(await rawWorkspace(registered.workspaceId)).toMatchObject({
      syncthingDeviceId: SYNCTHING_DEVICE_ID_TWO,
      lastHeartbeatAt: 61_000,
    })
  })

  test('upserts realization reports per workspace and share without cross-workspace collision', async () => {
    const first = await registeredWorkspace('share-reports-first', 59_000)
    const second = await registeredWorkspace('share-reports-second', 59_500)
    const report = {
      shareId: 'share-1',
      generation: 'generation-1',
      state: 'applying' as const,
    }

    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(first.vmToken),
      observation: { ...idleObservation, shareSyncReports: [report] },
      now: 61_000,
    })
    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(first.vmToken),
      observation: {
        ...idleObservation,
        shareSyncReports: [{ ...report, state: 'paused' as const }],
      },
      now: 62_000,
    })
    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(first.vmToken),
      observation: {
        ...idleObservation,
        shareSyncReports: [{ ...report, state: 'paused' as const }],
      },
      now: 63_000,
    })
    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(second.vmToken),
      observation: { ...idleObservation, shareSyncReports: [report] },
      now: 64_000,
    })

    expect(await rawShareSyncReports(first.workspaceId)).toEqual([
      expect.objectContaining({
        workspaceId: first.workspaceId,
        shareId: 'share-1',
        generation: 'generation-1',
        state: 'paused',
        updatedAt: 62_000,
      }),
    ])
    expect(await rawShareSyncReports(second.workspaceId)).toEqual([
      expect.objectContaining({
        workspaceId: second.workspaceId,
        shareId: 'share-1',
        state: 'applying',
      }),
    ])
  })

  test('persists one complete active-share realization batch and rejects larger requests', async () => {
    const registered = await registeredWorkspace('share-report-bound', 65_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const reports = Array.from(
      { length: MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE + 1 },
      (_, index) => ({
        shareId: `share-${index}`,
        generation: 'generation-1',
        state: 'ready' as const,
      }),
    )

    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: {
        ...idleObservation,
        shareSyncReports: reports.slice(0, -1),
      },
      now: 66_000,
    })
    expect(await rawShareSyncReports(registered.workspaceId)).toHaveLength(
      MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE,
    )

    await expect(
      mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
        internalKey: INTERNAL_KEY,
        vmTokenHash,
        observation: {
          ...idleObservation,
          shareSyncReports: reports,
        },
        now: 67_000,
      }),
    ).rejects.toThrow('Too many share sync reports')
    expect(await rawShareSyncReports(registered.workspaceId)).toHaveLength(
      MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE,
    )
  })

  test('prunes obsolete realization history before enforcing the workspace cap', async () => {
    const registered = await registeredWorkspace('share-report-history', 68_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const historical = Array.from({ length: MAX_ACTIVE_SHARES_PER_WORKSPACE_SYNC }, (_, index) => ({
      shareId: `obsolete-share-${index}`,
      generation: 'generation-1',
      state: 'ready' as const,
    }))

    for (
      let offset = 0;
      offset < historical.length;
      offset += MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE
    ) {
      await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
        internalKey: INTERNAL_KEY,
        vmTokenHash,
        observation: {
          ...idleObservation,
          shareSyncReports: historical.slice(offset, offset + MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE),
        },
        now: 69_000 + offset,
      })
    }

    await mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      observation: {
        ...idleObservation,
        shareSyncReports: [
          {
            shareId: 'replacement-share',
            generation: 'generation-2',
            state: 'ready',
          },
        ],
      },
      now: 70_000,
    })

    expect(await rawShareSyncReports(registered.workspaceId)).toEqual([
      expect.objectContaining({
        shareId: 'replacement-share',
        generation: 'generation-2',
        state: 'ready',
      }),
    ])
  })

  test('serializes concurrent due observations into a single write', async () => {
    const registered = await registeredWorkspace('concurrent-due', 60_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    const clients = [0, 1].map(
      () =>
        new ConvexHttpClient(convex.url, {
          logger: false,
          skipConvexDeploymentUrlCheck: true,
        }),
    )
    const reference = makeFunctionReference(
      'domains/workspaces/vmSync:persistVmSyncObservation',
    ) as FunctionReference<'mutation'>

    const results = (await Promise.all(
      clients.map(client =>
        client.mutation(reference, {
          internalKey: INTERNAL_KEY,
          vmTokenHash,
          observation: idleObservation,
          now: 121_000,
        }),
      ),
    )) as Array<{ persisted: boolean }>

    expect(results.map(result => result.persisted).sort()).toEqual([false, true])
    expect(await rawWorkspace(registered.workspaceId)).toMatchObject({
      lastHeartbeatAt: 121_000,
    })
  })

  test('projects official subscriptions on the recurring sync rail', async () => {
    const { target, subscription } = await hubSubscription('official', 'research', 130_000)

    const projected = (await query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(target.vmToken),
      now: 132_000,
    })) as {
      marketplace: { subscriptions: Array<Record<string, unknown>> }
    }
    // No hubBaseUrl: every subscription now carries its OWN publisher origin,
    // derived per listing.
    expect(projected.marketplace.subscriptions).toEqual([
      {
        subscriptionId: subscription.id,
        listingId: expect.any(String),
        agentName: 'research',
        sourceUrl: expect.stringContaining('/official-agents/research?zip'),
        path: 'agents/research',
        anchorId: subscription.anchorId,
        mode: 'subscribe',
      },
    ])

    // Pull reports use their dedicated shielded owner; the strict
    // observation grammar no longer accepts the retired delivery path.
    await expect(
      mutate(convex, 'domains/workspaces/vmSync:persistVmSyncObservation', {
        internalKey: INTERNAL_KEY,
        vmTokenHash: await sha256Hex(target.vmToken),
        observation: {
          ...idleObservation,
          marketplacePullReports: [
            {
              subscriptionId: subscription.id,
              state: 'active',
              appliedEtag: 'etag-from-vm-sync',
              lastAppliedAt: 132_100,
            },
          ],
        },
        now: 132_100,
      }),
    ).rejects.toThrow()
    expect(
      await query(owner.client, 'domains/marketplace/model:listByWorkspace', {
        workspaceId: target.workspaceId,
      }),
    ).toContainEqual(expect.objectContaining({ id: subscription.id, state: 'installing' }))
  })

  test('the projection carries the listing’s content revision, and omits the key when there is none', async () => {
    /* The token is what lets a subscriber be told "you already have this"
       instead of asking the origin every half hour. It is projected on the
       rail the VM already polls, so it costs no request of its own. Absent is
       a real state — an unstamped listing must project the entry WITHOUT the
       key, because absence is what means "revalidate exactly as before". */
    const stamped = await hubSubscription('revision', 'research', 160_000, 'press-42')
    const desired = async (vmToken: string) => await marketplaceDesired(vmToken, 162_000)
    expect(await desired(stamped.target.vmToken)).toEqual([
      expect.objectContaining({
        subscriptionId: stamped.subscription.id,
        contentRevision: 'press-42',
      }),
    ])

    const unstamped = await hubSubscription('no-revision', 'research', 170_000)
    const projected = (await desired(unstamped.target.vmToken))[0]
    expect(projected).toMatchObject({ subscriptionId: unstamped.subscription.id })
    expect(Object.keys(projected!)).not.toContain('contentRevision')
  })

  test('a stamped subscription is told how long it may wait between revalidations', async () => {
    /* The interval is projected rather than compiled into the VM so that
       retuning "how stale may a hub agent be when its bytes changed without the
       sync button" is a deploy, not a fleet release. It rides only a stamped
       subscription: without a revision the subscriber can never decide it is in
       sync, so the number would describe a state it cannot reach. */
    const stamped = await hubSubscription('interval', 'research', 190_000, 'press-44')
    const unstamped = await hubSubscription('nointerval', 'research', 200_000)
    const projected = async (vmToken: string) => (await marketplaceDesired(vmToken, 202_000))[0]

    expect(await projected(stamped.target.vmToken)).toMatchObject({
      contentRevision: 'press-44',
      revalidateAfterMs: GATED_REVALIDATE_INTERVAL_MS,
    })
    expect(Object.keys((await projected(unstamped.target.vmToken))!)).not.toContain(
      'revalidateAfterMs',
    )
  })

  test('a paused publish withholds the content revision from its subscribers', async () => {
    /* A paused publish serves FROZEN bytes through the edge's freeze header,
       while any revision describes the live tree — so gating on it would tell
       a subscriber it already has bytes it has never seen. The backend owns
       `pausedAt`, so the backend is where this is settled; the VM never learns
       the word "frozen", it just sees the unknown state and polls. */
    const { golden, target, hubPublish, subscription } = await hubSubscription(
      'frozen',
      'research',
      180_000,
      'press-43',
    )
    await mutate(owner.client, 'domains/publishes/model:setPublishPaused', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: golden.workspaceId,
      publishId: hubPublish._id,
      slug: 'official-agents',
      paused: true,
      generation: 'freeze-1',
      now: 181_000,
    })

    const projected = (await marketplaceDesired(target.vmToken, 182_000))[0]
    // Still projected — a paused publish is not a takedown, and the subscriber
    // keeps revalidating. Only the "you already have this" claim is withdrawn.
    expect(projected).toMatchObject({ subscriptionId: subscription.id })
    expect(Object.keys(projected!)).not.toContain('contentRevision')
  })

  test('a listing whose source agent was deleted stops projecting to its subscribers', async () => {
    /* Retiring an agent deletes its folder, but the folder-level publish it
       was listed under keeps resolving, so nothing in the URL itself goes
       stale — it just names a subpath whose bytes are gone. A subscriber
       handed that URL re-probes it forever, one edge resolve per probe, and
       never converges. An ordinary publisher cannot reach this state: their
       publish is anchored ON the agent folder, so deleting the agent deletes
       the publish too. */
    const { golden, target, subscription } = await hubSubscription(
      'retired',
      'ux-researcher',
      150_000,
    )

    const desired = async () => await marketplaceDesired(target.vmToken, 152_000)
    expect(await desired()).toEqual([
      expect.objectContaining({
        subscriptionId: subscription.id,
        sourceUrl: expect.stringContaining('/official-agents/ux-researcher?zip'),
      }),
    ])

    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId: golden.workspaceId,
      slug: 'ux-researcher',
      now: 151_500,
    })

    // The subscriber keeps the files it already materialized — this is a stop,
    // not a remote delete — but it is handed nothing left to poll.
    expect(await desired()).toEqual([])
    expect(
      await query(owner.client, 'domains/marketplace/model:listByWorkspace', {
        workspaceId: target.workspaceId,
      }),
    ).toContainEqual(expect.objectContaining({ id: subscription.id }))
  })

  test('ingests connected-provider observations while preserving backend attribution', async () => {
    const registered = await registeredWorkspace('cp-observe', 140_000)
    await mutate(owner.client, 'domains/connectedProviders/model:completeConnect', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: registered.workspaceId,
      connection: {
        provider: 'openai-codex',
        state: 'connected',
        connectedAt: 140_100,
      },
    })

    await mutate(convex, 'domains/connectedProviders/model:applyObservation', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      connectedProviders: [
        {
          provider: 'openai-codex',
          state: 'connected',
          connectedAt: 140_200,
          eligibilityCheckedAt: 140_250,
        },
      ],
      now: 140_300,
    })

    expect(
      await query(owner.client, 'domains/connectedProviders/model:listForWorkspace', {
        workspaceId: registered.workspaceId,
      }),
    ).toEqual([
      expect.objectContaining({
        provider: 'openai-codex',
        state: 'connected',
        connectedAt: 140_200,
        connectedByUserId: owner.user._id,
        eligibilityCheckedAt: 140_250,
      }),
    ])
  })

  test('attributes a VM-observed connection to the member whose terminal poll was lost', async () => {
    const registered = await registeredWorkspace('cp-lost-poll', 145_000)
    await mutate(convex, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      userId: member.user._id,
      role: 'viewer',
    })
    await mutate(member.client, 'domains/connectedProviders/model:authorizeConnect', {
      internalKey: INTERNAL_KEY,
      actorId: member.user._id,
      workspaceId: registered.workspaceId,
      provider: 'github-copilot',
    })

    await mutate(convex, 'domains/connectedProviders/model:applyObservation', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      connectedProviders: [
        {
          provider: 'github-copilot',
          state: 'connected',
          connectedAt: 145_100,
        },
      ],
      now: 145_200,
    })

    expect(
      await query(member.client, 'domains/connectedProviders/model:listForWorkspace', {
        workspaceId: registered.workspaceId,
      }),
    ).toEqual([
      expect.objectContaining({
        provider: 'github-copilot',
        connectedByUserId: member.user._id,
        connectedByLabel: member.user.email,
        canDisconnect: true,
      }),
    ])
  })

  test('an absent VM report changes a previously connected provider to reconnect_needed', async () => {
    const registered = await registeredWorkspace('cp-absent', 150_000)
    await mutate(owner.client, 'domains/connectedProviders/model:completeConnect', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: registered.workspaceId,
      connection: {
        provider: 'github-copilot',
        state: 'connected',
        connectedAt: 150_100,
      },
    })

    await mutate(convex, 'domains/connectedProviders/model:applyObservation', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      connectedProviders: [],
      now: 150_200,
    })

    expect(
      await query(owner.client, 'domains/connectedProviders/model:listForWorkspace', {
        workspaceId: registered.workspaceId,
      }),
    ).toContainEqual(
      expect.objectContaining({
        provider: 'github-copilot',
        state: 'reconnect_needed',
      }),
    )
  })

  test('a backend disconnect directive remains until the VM reports the provider absent', async () => {
    const registered = await registeredWorkspace('cp-disc', 160_000)
    const vmTokenHash = await sha256Hex(registered.vmToken)
    await mutate(owner.client, 'domains/connectedProviders/model:completeConnect', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: registered.workspaceId,
      connection: {
        provider: 'openai-codex',
        state: 'connected',
        connectedAt: 160_100,
      },
    })
    await mutate(owner.client, 'domains/connectedProviders/model:requestDisconnect', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: registered.workspaceId,
      provider: 'openai-codex',
    })
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      servicingStatus: 'paused',
      now: 160_150,
    })

    const pending = (await query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      now: 160_200,
    })) as { disconnectConnectedProviders: string[] }
    expect(pending.disconnectConnectedProviders).toEqual(['openai-codex'])
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      servicingStatus: 'active',
      now: 160_250,
    })

    await mutate(convex, 'domains/connectedProviders/model:applyObservation', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      connectedProviders: [],
      now: 160_300,
    })
    const acknowledged = (await query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
      internalKey: INTERNAL_KEY,
      vmTokenHash,
      now: 160_400,
    })) as { disconnectConnectedProviders: string[] }
    expect(acknowledged.disconnectConnectedProviders).toEqual([])
  })
})

const idleObservation = {
  needsModelCredentials: false,
  versions: { runtime: '1.0.0', image: '2.0.0' },
}

/** The marketplace half of what a VM is told to want, as its own gateway reads it. */
async function marketplaceDesired(
  vmToken: string,
  now: number,
): Promise<Array<Record<string, unknown>>> {
  const state = (await query(convex, 'domains/workspaces/vmSync:readVmSyncState', {
    internalKey: INTERNAL_KEY,
    vmTokenHash: await sha256Hex(vmToken),
    now,
  })) as { marketplace: { subscriptions: Array<Record<string, unknown>> } | null }
  return state.marketplace?.subscriptions ?? []
}

/**
 * The official hub's layout, at the smallest scale that shows it: ONE
 * folder-level publish over `official/`, one agent in a folder below it, a
 * listing addressed by `agentSubpath`, and one workspace subscribed to it.
 * The publisher is marked verified because onboarding and campaigns resolve
 * bare names only through a verified publisher's listing; ordinary installs
 * are listing-keyed and do not need it.
 */
async function hubSubscription(
  prefix: string,
  agentName: string,
  now: number,
  contentRevision?: string,
) {
  const golden = await registeredWorkspace(`${prefix}-golden`, now)
  const target = await registeredWorkspace(`${prefix}-target`, now)
  await mutate(owner.client, 'domains/publishes/model:createPublish', {
    workspaceId: golden.workspaceId,
    path: 'official',
    kind: 'folder',
    slug: 'official-agents',
    now: now + 1_100,
  })
  await mutate(convex, 'testing/marketplace:markVerifiedPublisherForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: golden.workspaceId,
    now: now + 1_100,
  })
  const hubPublish = (await query(convex, 'testing/marketplace:publishBySlugForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: golden.workspaceId,
    slug: 'official-agents',
  })) as { _id: string }
  const goldenAgent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
    workspaceId: golden.workspaceId,
    path: `official/${agentName}`,
    slug: agentName,
    name: agentName,
  })) as { id: string; anchorId: string }
  const listingId = (await mutate(convex, 'testing/marketplace:insertListingForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: golden.workspaceId,
    agentId: goldenAgent.id,
    anchorId: goldenAgent.anchorId,
    publishId: hubPublish._id,
    agentName,
    agentSubpath: agentName,
    createdByUserId: owner.user._id,
    ...(contentRevision === undefined ? {} : { contentRevision }),
    now: now + 1_100,
  })) as string
  const subscription = (await mutate(owner.client, 'domains/marketplace/model:install', {
    workspaceId: target.workspaceId,
    listingId,
    now: now + 1_300,
  })) as { id: string; anchorId: string }
  return { golden, target, listingId, hubPublish, subscription }
}

async function registeredWorkspace(
  prefix: string,
  now: number,
): Promise<{
  workspaceId: string
  vmToken: string
}> {
  sequence += 1
  const token = `${prefix}-token`
  const prepared = (await mutate(convex, 'testing/workspaces:prepareWorkspaceForRegistration', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    slug: `${prefix}-${Date.now()}-${sequence}`,
    name: `${prefix} workspace`,
    imageRef: 'ttl.sh/duet-vm-sync-test:1h',
    provisioningTokenHash: await sha256Hex(token),
    provisioningTokenExpiresAt: now + 60_000,
    now,
  })) as { workspaceId: string }
  const registered = (await mutate(convex, 'domains/workspaces/provisioning:registerVm', {
    internalKey: INTERNAL_KEY,
    provisioningTokenHash: await sha256Hex(token),
    workspaceHint: prepared.workspaceId,
    runtimeVersion: idleObservation.versions.runtime,
    imageVersion: idleObservation.versions.image,
    now: now + 1_000,
  })) as { vmToken: string }
  return { workspaceId: prepared.workspaceId, vmToken: registered.vmToken }
}

async function sha256Hex(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function rawWorkspace(workspaceId: string): Promise<Record<string, unknown>> {
  return (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Record<string, unknown>
}

async function rawTelemetrySamples(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'testing/vmTelemetry:rawTelemetrySamplesForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
}

/**
 * Whether the model gateway still accepts this key, asked the way the proxy
 * asks it. `catalog` carries no model or billing decision, so a false here is
 * the credential itself being refused and nothing else.
 */
async function vmKeyAuthenticates(apiKey: string, now: number): Promise<boolean> {
  const preflight = (await mutate(convex, 'domains/modelGateway/model:gatewayPreflight', {
    internalKey: INTERNAL_KEY,
    hashedKey: await sha256Hex(apiKey),
    requestKind: 'catalog',
    modality: 'text',
    now,
  })) as { proceed: boolean }
  return preflight.proceed
}

async function rawApiKeys(): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'testing/apiKeys:rawApiKeysForTest', {
    internalKey: INTERNAL_KEY,
  })) as Array<Record<string, unknown>>
}

async function rawShareSyncReports(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'testing/workspaces:rawShareSyncReportsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
}

async function auditEvents(workspaceId: string): Promise<Array<{ event: string }>> {
  return (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as Array<{ event: string }>
}
