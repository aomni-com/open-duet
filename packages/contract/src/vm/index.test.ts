import { describe, expect, test } from 'bun:test'

import { MAX_AGENTS_PER_WORKSPACE } from '../agents/index'
import { MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE, type GatewayAnchor } from '../anchors/index'
import { MAX_APP_RECONCILIATION_ERROR_UTF8_BYTES, MAX_APPS_PER_WORKSPACE } from '../apps/index'
import { ConnectedProviderIdSchema } from '../connected-providers/index'
import { MAX_MARKETPLACE_AGENT_PULL_REPORTS_PER_WORKSPACE } from '../marketplace/index'
import { MAX_TRAIN_REPORTS_PER_SYNC } from '../train/index'
import {
  DeliveredModelCredentialsSchema,
  GatewayAnchorSchema,
  GatewayAnchorsReconcileRequestSchema,
  RuntimeReleaseEnvelopeSchema,
  RUNTIME_RELEASE_ARTIFACT_NAMES,
  type RuntimeReleaseDescriptor,
  MAX_VM_RESPONSE_CREDENTIAL_UTF8_BYTES,
  MAX_VM_PROVIDER_NAME_UTF8_BYTES,
  MAX_VM_PROVIDER_SSH_DEST_UTF8_BYTES,
  MAX_VM_PROVIDER_HTTPS_URL_UTF8_BYTES,
  MAX_VM_VERSION_METADATA_UTF8_BYTES,
  MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE,
  MAX_VM_RESPONSE_ID_UTF8_BYTES,
  MAX_VM_RESPONSE_URL_UTF8_BYTES,
  ShareSyncReportSchema,
  VmDesiredShareSyncSchema,
  VmSyncResponseSchema,
  VmModelCredentialsSchema,
  VmRegisterRequestSchema,
  VmRegisterResponseSchema,
  VmSyncRequestSchema,
  VmTelemetryHistoryQuerySchema,
  VmTelemetryHistoryResponseSchema,
  type VmSyncResponse,
} from './index'

const SYNCTHING_DEVICE_ID = 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'

describe('VM control-plane wire schemas', () => {
  test('bounds provider-authored VM identity fields before workspace storage', () => {
    const base = { provisioningToken: 'token', workspaceHint: 'workspace' }
    expect(
      VmRegisterRequestSchema.safeParse({
        ...base,
        vmName: 'v'.repeat(MAX_VM_PROVIDER_NAME_UTF8_BYTES),
      }).success,
    ).toBe(true)
    expect(
      VmRegisterRequestSchema.safeParse({
        ...base,
        vmName: 'v'.repeat(MAX_VM_PROVIDER_NAME_UTF8_BYTES + 1),
      }).success,
    ).toBe(false)
    expect(
      VmRegisterRequestSchema.safeParse({
        ...base,
        sshDest: 's'.repeat(MAX_VM_PROVIDER_SSH_DEST_UTF8_BYTES + 1),
      }).success,
    ).toBe(false)
    expect(
      VmRegisterRequestSchema.safeParse({
        ...base,
        httpsUrl: `https://x.test/${'u'.repeat(MAX_VM_PROVIDER_HTTPS_URL_UTF8_BYTES)}`,
      }).success,
    ).toBe(false)
    expect(
      VmRegisterRequestSchema.safeParse({
        ...base,
        runtimeVersion: 'v'.repeat(MAX_VM_VERSION_METADATA_UTF8_BYTES + 1),
      }).success,
    ).toBe(false)
    expect(
      VmSyncRequestSchema.safeParse({
        needsModelCredentials: false,
        versions: {
          runtime: '1.2.3',
          gateway: '1.2.3',
          image: 'i'.repeat(MAX_VM_VERSION_METADATA_UTF8_BYTES + 1),
        },
      }).success,
    ).toBe(false)
  })

  test('bounds every variable-width public sync and registration envelope field', () => {
    const sync = {
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true as const },
    }
    expect(
      VmSyncResponseSchema.safeParse({
        ...sync,
        modelCredentials: {
          apiKey: 'k'.repeat(MAX_VM_RESPONSE_CREDENTIAL_UTF8_BYTES + 1),
          gatewayBaseUrl: 'https://model.test',
          expiresAt: 1,
        },
      }).success,
    ).toBe(false)
    expect(
      VmSyncResponseSchema.safeParse({
        ...sync,
        skills: {
          hash: 'hash',
          url: `https://skills.test/${'u'.repeat(MAX_VM_RESPONSE_URL_UTF8_BYTES)}`,
        },
      }).success,
    ).toBe(false)
    expect(
      VmSyncResponseSchema.safeParse({
        ...sync,
        acceptedTrainReportGenerations: ['g'.repeat(MAX_VM_RESPONSE_ID_UTF8_BYTES + 1)],
      }).success,
    ).toBe(false)
    expect(
      VmRegisterResponseSchema.safeParse({
        vmToken: 'token',
        restore: {
          kind: 'birth-seed',
          sha256: 'a'.repeat(64),
          url: `https://restore.test/${'u'.repeat(MAX_VM_RESPONSE_URL_UTF8_BYTES)}`,
        },
        syncIntervalSeconds: 5,
        sync,
      }).success,
    ).toBe(false)
  })

  test('rejects a VM snapshot with more apps than one workspace can own', () => {
    const app = {
      appId: 'app_1',
      slug: 'reporting',
      command: 'bun run start',
      port: 4173,
      anchorPath: 'apps/reporting',
      apiScopes: [],
    }
    expect(
      VmSyncResponseSchema.safeParse({
        pollAfterMs: 5_000,
        anchors: [],
        mirrorMachineIds: [],
        apps: Array(MAX_APPS_PER_WORKSPACE + 1).fill(app),
        updates: { paused: true },
      }).success,
    ).toBe(false)
  })

  test('rejects more provider disconnect directives than the provider vocabulary', () => {
    expect(
      VmSyncResponseSchema.safeParse({
        pollAfterMs: 5_000,
        anchors: [],
        mirrorMachineIds: [],
        updates: { paused: true },
        disconnectConnectedProviders: Array(ConnectedProviderIdSchema.options.length + 1).fill(
          ConnectedProviderIdSchema.options[0],
        ),
      }).success,
    ).toBe(false)
  })

  test('keeps the full-replacement anchor protocol inside one workspace ceiling', () => {
    const anchor = {
      id: 'anchor',
      workspaceId: 'workspace',
      path: 'apps/example',
      kind: 'app' as const,
      settings: {},
      state: 'active' as const,
      markerNonce: 'nonce',
      createdAt: 1,
      updatedAt: 1,
    }
    expect(
      GatewayAnchorsReconcileRequestSchema.safeParse({
        anchors: Array(MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE + 1).fill(anchor),
      }).success,
    ).toBe(false)
  })
  test('bounds a train report batch on the public sync request', () => {
    const report = {
      generation: '1',
      jobId: 'job',
      creatorUserId: 'user',
      state: 'running' as const,
      phase: 'preparing' as const,
      createdAt: 1,
      updatedAt: 1,
    }
    const request = {
      versions: { runtime: '1.2.3', image: 'image' },
      needsModelCredentials: false,
      trainReports: Array.from({ length: MAX_TRAIN_REPORTS_PER_SYNC }, () => report),
    }
    expect(VmSyncRequestSchema.parse(request)).toEqual(request)
    const overflow = VmSyncRequestSchema.safeParse({
      ...request,
      trainReports: [...request.trainReports, report],
    })
    expect(overflow.success).toBe(false)
    expect(overflow.error?.issues).toContainEqual(
      expect.objectContaining({ code: 'too_big', path: ['trainReports'] }),
    )
  })
  test('round-trips connected-provider disconnect directives to the VM', () => {
    const response = {
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true as const },
      disconnectConnectedProviders: ['github-copilot' as const],
    }

    expect(VmSyncResponseSchema.parse(response)).toEqual(response)
  })

  test('carries the agent roster beside the anchors, and survives its absence', () => {
    const response = {
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      agents: [
        { kind: 'root' as const, slug: 'root' as const, name: 'Duet' },
        {
          kind: 'agent' as const,
          agentId: 'agent-1',
          anchorId: 'anchor-1',
          anchorPath: 'agents/research',
          slug: 'research',
          name: 'Research',
          onboardedAt: 1_753_000_000_000,
        },
      ],
      updates: { paused: true as const },
    }
    expect(VmSyncResponseSchema.parse(response)).toEqual(response)

    // An older API that has never heard of the roster still parses — absent is
    // a legal state the gateway must treat as "keep what you have".
    const withoutAgents = {
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true as const },
    }
    expect(VmSyncResponseSchema.parse(withoutAgents)).toEqual(withoutAgents)

    // A row from a newer producer is stripped of its unknown fields, not
    // rejected — the same anti-brick rule as every other field here.
    const parsed = VmSyncResponseSchema.parse({
      ...withoutAgents,
      agents: [{ kind: 'root', slug: 'root', name: 'Duet', futureField: 1 }],
    })
    expect(parsed.agents).toEqual([{ kind: 'root', slug: 'root', name: 'Duet' }])
  })

  // The gateway parses this payload whole (`sync-client.ts`), so a row that
  // rejected the array would take anchors, updates and credentials down with
  // it — every colleague blanked in every prompt over one unreadable row. One
  // bad row never costs the other rows.
  test('drops an unreadable roster row instead of failing the whole sync payload', () => {
    const root = { kind: 'root' as const, slug: 'root' as const, name: 'Duet' }
    const research = {
      kind: 'agent' as const,
      agentId: 'agent-1',
      anchorId: 'anchor-1',
      anchorPath: 'agents/research',
      slug: 'research',
      name: 'Research',
    }
    const parsed = VmSyncResponseSchema.parse({
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true as const },
      agents: [
        root,
        // Structurally unreadable: a row this parser cannot make sense of.
        { kind: 'agent', agentId: 'agent-2', slug: 'legacy' },
        // The realistic case: a name stored before the markup-safety rule.
        {
          kind: 'agent',
          agentId: 'agent-3',
          anchorId: 'anchor-3',
          anchorPath: 'agents/legacy',
          slug: 'legacy',
          name: 'Legacy <name>',
        },
        research,
      ],
    })
    expect(parsed.agents).toEqual([root, research])

    // Tolerance is per row, not per payload: a roster longer than the
    // workspace can legally hold (+1 for root) is a producer fault, and
    // silently keeping the first fifty-one would hide it.
    expect(
      VmSyncResponseSchema.safeParse({
        pollAfterMs: 5_000,
        anchors: [],
        mirrorMachineIds: [],
        updates: { paused: true as const },
        agents: Array.from({ length: MAX_AGENTS_PER_WORKSPACE + 2 }, () => research),
      }).success,
    ).toBe(false)
  })

  test('keeps pre-connected-provider VM sync payloads compatible', () => {
    const oldRequest = {
      needsModelCredentials: false,
      versions: { runtime: '1.2.3', image: 'image-ref' },
    }
    const responseWithNewDirective = {
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true as const },
      disconnectConnectedProviders: ['openai-codex' as const],
    }
    const PreviousVmSyncResponseSchema = VmSyncResponseSchema.omit({
      disconnectConnectedProviders: true,
    })

    expect(VmSyncRequestSchema.parse(oldRequest)).toEqual(oldRequest)
    expect(PreviousVmSyncResponseSchema.parse(responseWithNewDirective)).toEqual({
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true },
    })
  })

  test('carries folder pause as structural desired state and accepts paused realization reports', () => {
    const desired = {
      shares: [
        {
          shareId: 'share-1',
          generation: 'a'.repeat(64),
          folder: {
            id: 'share-share-1',
            path: 'projects/demo',
            mode: 'write' as const,
            role: 'origin' as const,
            peerDeviceId: SYNCTHING_DEVICE_ID,
            ignorePatterns: [],
            paused: true,
          },
          accept: {
            acceptId: 'accept-1',
            targetPort: 22_000,
            tokenDigest: 'b'.repeat(64),
            expiresAt: 2_000,
          },
        },
      ],
    }

    expect(VmDesiredShareSyncSchema.parse(desired)).toEqual(desired)
    expect(
      ShareSyncReportSchema.parse({
        shareId: 'share-1',
        generation: 'a'.repeat(64),
        state: 'paused',
      }),
    ).toMatchObject({ state: 'paused' })
  })

  test('SUBS-IMPL-07 preserves the per-workspace quiesce directive', () => {
    const response = {
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true as const },
      quiesce: true,
    }
    expect(VmSyncResponseSchema.parse(response)).toEqual(response)
  })

  const listForVmFixture = [
    {
      id: 'jd7f3xtr9w0sv8k8p4n2y6ma7h6z5q1c',
      agentId: 'agent_1',
      workspaceId: 'k57c3m9apw8m7gq31h1d2v8x6n5f4r0b',
      path: 'apps/calendar',
      kind: 'app',
      settings: {},
      state: 'active',
      createdAt: 1_721_029_845_000,
      updatedAt: 1_721_030_120_000,
      markerNonce: '6d61726b65722d6e6f6e63652d303031',
    },
    {
      id: 'm97v4b2ztx6c1q8d5j0k3n7h9s2w1f4a',
      workspaceId: 'k57c3m9apw8m7gq31h1d2v8x6n5f4r0b',
      path: 'publishes/roadmap',
      kind: 'publish',
      settings: { kind: 'folder' },
      state: 'active',
      createdAt: 1_721_040_000_000,
      updatedAt: 1_721_040_000_000,
      markerNonce: '6d61726b65722d6e6f6e63652d303032',
    },
  ] satisfies GatewayAnchor[]

  test('round-trips a VM sync request', () => {
    const request = {
      workspaceHint: 'ws_1',
      needsModelCredentials: true,
      needsAppCredentials: ['app_calendar'],
      versions: {
        runtime: '2.3.4-beta.1',
        image: '4.5.6',
      },
    }

    expect(VmSyncRequestSchema.parse(request)).toEqual({
      ...request,
      versions: { runtime: request.versions.runtime, image: request.versions.image },
    })
  })

  test('round-trips bounded official-agent reports and desired subscriptions', () => {
    const report = {
      subscriptionId: 'subscription-1',
      state: 'active' as const,
      appliedEtag: 'etag-1',
      lastAppliedAt: 123,
    }
    const request = {
      needsModelCredentials: false,
      versions: { runtime: '1.2.3', gateway: '1.2.3', image: 'image-1' },
      marketplacePullReports: [report],
    }
    expect(VmSyncRequestSchema.parse(request)).toEqual({
      ...request,
      versions: { runtime: request.versions.runtime, image: request.versions.image },
    })
    expect(
      VmSyncRequestSchema.safeParse({
        ...request,
        marketplacePullReports: Array.from(
          { length: MAX_MARKETPLACE_AGENT_PULL_REPORTS_PER_WORKSPACE + 1 },
          () => report,
        ),
      }).success,
    ).toBe(false)

    const response = {
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true as const },
      marketplace: {
        subscriptions: [
          {
            subscriptionId: 'subscription-1',
            listingId: 'listing-1',
            sourceUrl: 'https://edge.duet.so/hub/official-agents/research?zip',
            agentName: 'research',
            path: 'agents/research',
            anchorId: 'anchor-1',
            mode: 'subscribe' as const,
          },
        ],
      },
    }
    expect(VmSyncResponseSchema.parse(response)).toEqual(response)
  })

  test('parses telemetry history query parameters and sample responses', () => {
    expect(VmTelemetryHistoryQuerySchema.parse({ sinceAt: '123' })).toEqual({
      sinceAt: 123,
    })
    expect(
      VmTelemetryHistoryResponseSchema.parse({
        samples: [
          {
            at: 123,
            cpuPct: 42.5,
            memUsedMb: 512,
            memTotalMb: 1024,
            diskUsedMb: 2048,
            diskTotalMb: 4096,
          },
        ],
      }),
    ).toEqual({
      samples: [
        {
          at: 123,
          cpuPct: 42.5,
          memUsedMb: 512,
          memTotalMb: 1024,
          diskUsedMb: 2048,
          diskTotalMb: 4096,
        },
      ],
    })
  })

  test('round-trips train report delivery and acknowledgement generations', () => {
    const trainReport = {
      generation: 'train_1:4',
      jobId: 'train_1',
      creatorUserId: 'user_1',
      state: 'running' as const,
      phase: 'training' as const,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_005_000,
      startedAt: 1_700_000_001_000,
    }
    const request = {
      needsModelCredentials: false,
      versions: { runtime: '1.2.3', image: 'image-ref' },
      trainReports: [trainReport],
    }
    const response = {
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true as const },
      acceptedTrainReportGenerations: ['train_1:4'],
    }

    expect(VmSyncRequestSchema.parse(request)).toEqual({
      ...request,
      versions: { runtime: request.versions.runtime, image: request.versions.image },
    })
    expect(VmSyncResponseSchema.parse(response)).toEqual(response)
  })

  test('round-trips Syncthing identity and bounded per-share realization reports', () => {
    const request = {
      needsModelCredentials: false,
      versions: { runtime: '1.2.3', image: 'image-ref' },
      syncthingDeviceId: SYNCTHING_DEVICE_ID,
      shareSyncReports: [
        {
          shareId: 'share-1',
          generation: 'generation-1',
          state: 'applying' as const,
        },
        {
          shareId: 'share-2',
          generation: 'generation-2',
          state: 'error' as const,
          errorCode: 'folder_path_missing',
        },
      ],
    }

    expect(VmSyncRequestSchema.parse(request)).toEqual({
      ...request,
      versions: { runtime: request.versions.runtime, image: request.versions.image },
    })
    expect(
      VmSyncRequestSchema.safeParse({
        ...request,
        shareSyncReports: Array.from(
          { length: MAX_SHARE_SYNC_REPORTS_PER_WORKSPACE + 1 },
          (_, index) => ({
            shareId: `share-${index}`,
            generation: 'generation',
            state: 'ready',
          }),
        ),
      }).success,
    ).toBe(false)
  })

  test('round-trips stale-safe app reconciliation reports', () => {
    const request = {
      needsModelCredentials: false,
      versions: { runtime: '1.2.3', image: 'image-ref' },
      appReconciliationReports: [
        {
          appId: 'app_hello',
          slug: 'hello',
          command: 'bun run start',
          installCommand: 'bun install',
          port: 41_000,
          anchorPath: 'welcome/hello-app',
          apiScopes: [],
          status: 'reconciled' as const,
        },
        {
          appId: 'app_broken',
          slug: 'broken',
          command: 'bun run start',
          port: 41_001,
          anchorPath: 'apps/broken',
          apiScopes: [],
          status: 'reconcile_failed' as const,
          error: 'Install command exited with status 1',
        },
      ],
    }

    expect(VmSyncRequestSchema.parse(request)).toEqual({
      ...request,
      versions: { runtime: request.versions.runtime, image: request.versions.image },
    })
    expect(
      VmSyncRequestSchema.safeParse({
        ...request,
        appReconciliationReports: Array.from({ length: MAX_APPS_PER_WORKSPACE + 1 }, () => ({
          ...request.appReconciliationReports[0],
        })),
      }).success,
    ).toBe(false)
    expect(
      VmSyncRequestSchema.safeParse({
        ...request,
        appReconciliationReports: [
          {
            appId: 'app_broken',
            slug: 'broken',
            command: 'bun run start',
            port: 41_001,
            anchorPath: 'apps/broken',
            apiScopes: [],
            status: 'reconcile_failed',
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      VmSyncRequestSchema.safeParse({
        ...request,
        appReconciliationReports: [
          {
            ...request.appReconciliationReports[1],
            error: `${'x'.repeat(MAX_APP_RECONCILIATION_ERROR_UTF8_BYTES - 3)}🚀`,
          },
        ],
      }).success,
    ).toBe(false)
  })

  test('keeps pre-visibility app reports valid inside VM sync requests', () => {
    const previousRequest = {
      needsModelCredentials: false,
      versions: { runtime: '1.2.3', image: 'image-ref' },
      appReconciliationReports: [
        {
          appId: 'app_hello',
          slug: 'hello',
          command: 'bun run start',
          port: 41_000,
          anchorPath: 'welcome/hello-app',
          apiScopes: [],
          status: 'reconciled' as const,
        },
      ],
    }

    expect(VmSyncRequestSchema.parse(previousRequest)).toEqual({
      ...previousRequest,
      versions: {
        runtime: previousRequest.versions.runtime,
        image: previousRequest.versions.image,
      },
    })
  })

  test('strips unknown VM sync request fields and rejects bad known-field types', () => {
    const request = {
      needsModelCredentials: false,
      versions: { runtime: '1.2.3', gateway: '1.2.3', image: '4.5.6' },
    }

    // Unknown keys strip (never brick a skewed sender); the parsed value
    // must not carry them through.
    const stripped = VmSyncRequestSchema.safeParse({
      ...request,
      protocolVersion: 1,
    })
    expect(stripped.success).toBe(true)
    if (stripped.success) expect('protocolVersion' in stripped.data).toBe(false)
    const versionsStripped = VmSyncRequestSchema.safeParse({
      ...request,
      versions: { ...request.versions, browser: '7.8.9' },
    })
    expect(versionsStripped.success).toBe(true)
    if (versionsStripped.success) expect('browser' in versionsStripped.data.versions).toBe(false)
    expect(
      VmSyncRequestSchema.safeParse({
        ...request,
        syncthingDeviceId: 'not-a-device-id',
      }).success,
    ).toBe(false)
    expect(
      VmSyncRequestSchema.parse({
        ...request,
        shareSyncReports: [
          {
            shareId: 'share-1',
            generation: 'generation-1',
            state: 'ready',
            future: true,
          },
        ],
      }).shareSyncReports,
    ).toEqual([{ shareId: 'share-1', generation: 'generation-1', state: 'ready' }])
  })

  test('round-trips the complete actionable VM sync response', () => {
    const response: VmSyncResponse = {
      mirrorMachineIds: [],
      pollAfterMs: 5_000,
      anchors: [
        {
          id: 'anchor_1',
          workspaceId: 'workspace_1',
          path: 'apps/calendar',
          kind: 'app',
          settings: {},
          state: 'active',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_001_000,
          markerNonce: '6d61726b65722d6e6f6e63652d303031',
        },
      ],
      runtimeRelease: runtimeRelease('1.2.3'),
      skills: {
        hash: 'c'.repeat(64),
        url: `https://ctl.test/v1/vm/skills/${'c'.repeat(64)}`,
      },
      updates: {
        paused: false,
      },
      apps: [
        {
          appId: 'app_calendar',
          slug: 'calendar',
          command: 'bun run start',
          installCommand: 'bun install',
          port: 41_000,
          anchorPath: 'apps/calendar',
          apiScopes: [],
        },
      ],
      modelCredentials: {
        apiKey: 'duet_sk_test',
        expiresAt: 1_800_000_000_000,
        gatewayBaseUrl: 'https://gateway.test',
      },
      appCredentials: [
        {
          appId: 'app_calendar',
          apiKey: 'duet_sk_app_test',
          scopes: ['sessions'],
          expiresAt: 1_800_000_000_000,
        },
      ],
      shareSync: {
        shares: [
          {
            shareId: 'share-1',
            generation: 'd'.repeat(64),
            folder: {
              id: 'share-share-1',
              path: 'projects/demo',
              mode: 'read',
              role: 'origin',
              peerDeviceId: SYNCTHING_DEVICE_ID,
              ignorePatterns: ['**/.git', '(?d)**/node_modules'],
              paused: false,
            },
            accept: {
              acceptId: 'share-share-1-target-to-source',
              targetPort: 22_000,
              tokenDigest: 'e'.repeat(64),
              expiresAt: 1_800_000_000_000,
            },
            bridge: {
              peerDeviceId: SYNCTHING_DEVICE_ID,
              peerUrl: 'wss://peer.example/v1/tunnel/accept/share-share-1-source-to-target',
              tunnelToken: 'duet_tt_test',
              acceptId: 'share-share-1-source-to-target',
            },
          },
        ],
      },
    }

    expect(VmSyncResponseSchema.parse(response)).toEqual(response)
  })

  test('accepts responses without apps and strips unknown response fields', () => {
    const parsed = VmSyncResponseSchema.parse({
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true },
    })

    expect(parsed).toEqual({
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true },
    })
    expect(parsed.apps).toBeUndefined()
    expect(parsed.appCredentials).toBeUndefined()
    expect(parsed.skills).toBeUndefined()
    expect('mcpServers' in parsed).toBe(false)

    // Consumer-tolerant (slice 08): a field added by a later feature is
    // stripped, not rejected — the gateway keeps syncing and self-updating
    // instead of bricking on an unrecognized key.
    const withUnknown = VmSyncResponseSchema.safeParse({
      pollAfterMs: 5_000,
      anchors: [],
      mirrorMachineIds: [],
      updates: { paused: true },
      mcpServers: {
        integrations: {
          type: 'http',
          url: 'https://api.test/v1/ws/acme/agent/sessions/session-1/integrations/mcp',
        },
      },
      futurePayload: { convergedReplica: 'replica-1' },
    })
    expect(withUnknown.success).toBe(true)
    expect('mcpServers' in withUnknown.data!).toBe(false)
    expect('futurePayload' in withUnknown.data!).toBe(false)
  })

  test('RuntimeReleaseEnvelopeSchema rescues the release from an otherwise-unparseable response', () => {
    // A known field is malformed (pollAfterMs is a string), so the full schema
    // rejects it — but the rescue envelope still extracts runtimeRelease.
    const broken = {
      pollAfterMs: 'not-a-number',
      anchors: 'wrong',
      updates: { paused: true },
      runtimeRelease: runtimeRelease('0.0.0+abc'),
    }
    expect(VmSyncResponseSchema.safeParse(broken).success).toBe(false)
    const rescued = RuntimeReleaseEnvelopeSchema.safeParse(broken)
    expect(rescued.success).toBe(true)
    expect(rescued.data!.runtimeRelease?.version).toBe('0.0.0+abc')
  })

  test('strips update targets from a paused snapshot', () => {
    expect(
      VmSyncResponseSchema.parse({
        pollAfterMs: 5_000,
        anchors: [],
        mirrorMachineIds: [],
        updates: {
          paused: true,
          agent: { package: '@duetso/agent', version: '1.2.3' },
          duetfs: { package: 'duetfs', version: '2.3.4' },
        },
      }).updates,
    ).toEqual({ paused: true })
  })

  test('rejects ranges for runtime identity while preserving the actual image reference', () => {
    for (const invalid of ['^1.2.3', 'latest']) {
      for (const field of ['runtime']) {
        expect(
          VmSyncRequestSchema.safeParse({
            needsModelCredentials: false,
            versions: { runtime: '1.2.3', gateway: '1.2.3', image: 'image', [field]: invalid },
          }).success,
        ).toBe(false)
      }
      expect(
        VmSyncResponseSchema.safeParse({
          pollAfterMs: 5000,
          anchors: [],
          mirrorMachineIds: [],
          updates: { paused: false },
          runtimeRelease: runtimeRelease(invalid),
        }).success,
      ).toBe(false)
    }
    const image = 'ghcr.io/aomni-com/duet-vm-image@sha256:' + 'c'.repeat(64)
    expect(
      VmSyncRequestSchema.parse({
        needsModelCredentials: false,
        versions: { runtime: '1.2.3', gateway: '1.2.3', image },
      }).versions.image,
    ).toBe(image)
  })

  test('rejects runtime artifact path traversal', () => {
    const release = runtimeRelease('1.2.3')
    expect(
      VmSyncResponseSchema.safeParse({
        pollAfterMs: 5000,
        anchors: [],
        mirrorMachineIds: [],
        updates: { paused: true },
        runtimeRelease: {
          ...release,
          artifacts: release.artifacts.map((artifact, index) =>
            index === 0 ? { ...artifact, name: '../duet' } : artifact,
          ),
        },
      }).success,
    ).toBe(false)
  })

  test('accepts an anchors list shaped like the listForVm response', () => {
    expect(listForVmFixture.map(anchor => GatewayAnchorSchema.parse(anchor))).toEqual(
      listForVmFixture,
    )
  })

  test('keeps the direct anchor reconcile payload a complete-set envelope and strips unknowns', () => {
    expect(GatewayAnchorsReconcileRequestSchema.parse({ anchors: listForVmFixture })).toEqual({
      anchors: listForVmFixture,
    })
    expect(
      GatewayAnchorsReconcileRequestSchema.parse({
        anchors: listForVmFixture,
        partial: true,
      }),
    ).toEqual({ anchors: listForVmFixture })
  })

  test('round-trips registration with its initial sync snapshot', () => {
    const response = {
      vmToken: 'duet_vm_test',
      syncIntervalSeconds: 5,
      restore: null,
      sync: {
        pollAfterMs: 5_000,
        anchors: [],
        mirrorMachineIds: [],
        updates: { paused: true as const },
      },
    }

    expect(VmRegisterResponseSchema.parse(response)).toEqual(response)
  })

  test('requires register identity', () => {
    expect(
      VmRegisterRequestSchema.safeParse({
        provisioningToken: 'token',
        workspaceHint: 'ws_1',
      }).success,
    ).toBe(true)
    expect(VmRegisterRequestSchema.safeParse({ provisioningToken: 'token' }).success).toBe(false)
    expect(
      VmRegisterRequestSchema.safeParse({
        provisioningToken: '',
        workspaceHint: 'ws_1',
      }).success,
    ).toBe(false)
  })

  test('distinguishes delivered credentials from gateway-ready credentials', () => {
    const delivered = { apiKey: 'duet_sk_test', expiresAt: 1 }
    expect(DeliveredModelCredentialsSchema.safeParse(delivered).success).toBe(true)
    expect(VmModelCredentialsSchema.safeParse(delivered).success).toBe(false)
    expect(
      VmModelCredentialsSchema.safeParse({
        ...delivered,
        gatewayBaseUrl: 'https://gateway.test',
      }).success,
    ).toBe(true)
  })
})

test('strips retired anchor and telemetry diagnostics from transition runtime reports', () => {
  const legacy = {
    workspaceHint: 'ws',
    activityGeneration: '1',
    needsModelCredentials: true,
    versions: {
      runtime: '0.0.0+legacy',
      gateway: '0.0.0+legacy',
      agent: '0.2.6',
      duetfs: '0.1.0',
      image: 'sha256:x',
    },
    trainReports: [],
    shareSyncReports: [],
    appReconciliationReports: [],
    anchors: [{ kind: 'agent', path: 'agents/x' }],
    telemetry: { cpu: 1, memMb: 2, diskMb: 3 },
  }
  const parsed = VmSyncRequestSchema.safeParse(legacy)
  expect(parsed.success).toBe(true)

  /* `telemetry` is gone from the schema too — the VM no longer measures itself.
     A gateway older than that release still sends the pre-slim shape
     (cpu/memMb/diskMb), and strict rejection here bricked the fleet once
     already (sync 400 -> no self-update), so it must parse and be dropped. */
  expect(parsed.success && 'telemetry' in parsed.data).toBe(false)

  /* `activityGeneration` is gone from the schema, so it is now *ignored* rather
     than coerced — but a gateway baked into an older image still sends it, as a
     string or a number, and neither may fail the parse. */
  const numericGeneration = VmSyncRequestSchema.safeParse({
    ...legacy,
    activityGeneration: 5,
  })
  expect(numericGeneration.success).toBe(true)
  expect(parsed.success && 'activityGeneration' in parsed.data).toBe(false)
})

function runtimeRelease(version: string): RuntimeReleaseDescriptor {
  return {
    formatVersion: 1,
    version,
    artifacts: RUNTIME_RELEASE_ARTIFACT_NAMES.map(name => ({
      name,
      sha256: 'a'.repeat(64),
      byteLength: 10,
      mode: name === 'duet' ? 0o755 : 0o644,
      href: `https://ctl.test/v1/vm/runtime-release/artifacts/${name}`,
    })),
  }
}
