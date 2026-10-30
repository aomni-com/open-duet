import { describe, expect, spyOn, test } from 'bun:test'

import {
  AgentSchema,
  MIN_SCHEDULE_INTERVAL_MS,
  SessionInitialHistorySnapshotSchema,
} from '@repo/contract'

import {
  waitForArchivedPausedAdminProjection,
  waitForActiveAdminWorkspace,
  waitForBrowserQueryData,
} from './staging-live-admin.ts'
import {
  assertStoppedSessionHistory,
  AGENT_CONTINUITY_REACTIVATION_DELAY_SECONDS,
  AGENT_CONTINUITY_REMINDER_DELAY_SECONDS,
  findActiveRestartHoldTask,
  findFollowUpQueueEvidence,
  findLiveContinuityHoldTask,
  findPostRestartTerminal,
  historyHasInterruptedContinuity,
  isDurablySleepingReactivation,
  jobPhaseForStateMachine,
  waitForGatewayInstance,
  waitForCertifiedRuntimeRelease,
} from './staging-live-agent-continuity.ts'
import {
  agentCardInRoster,
  attributionMatchesAgent,
  findRunningHoldTask,
  interruptedByAgentDeletion,
  runnerProcessPresent,
} from './staging-live-agents.ts'
import { assertBrowserResponseFinished } from './staging-live-browser-response.ts'
import {
  browserRequestFailureKind,
  browserRequestFailureKindWithExpectedAbort,
  configureStagingBrowserContext,
  consumeExpectedBrowserResponse,
  forEachBounded,
  isActionableBrowserError,
  isExplicitBrowserPrefetch,
  isLaterExactBrowserReplacement,
  evaluateThroughClientNavigations,
  navigationEpochAfterCommit,
  navigateDeployedPage,
  waitForPendingRequestsToSettle,
} from './staging-live-browser.ts'
import {
  AGENT_CONTINUITY_LEG,
  AGENT_LIFECYCLE_LEG,
  APP_API_KEYS_LEG,
  CONNECTED_PROVIDERS_PAGE_LEG,
  CONNECTED_PROVIDERS_STAGING_LEGS,
  DRIVE_DEEP_LINKS_LEG,
  requiredStagingLegFailures,
  SHARE_JOURNEY_LEGS,
  STORAGE_TIER_RESIZE_LEG,
  SUBSCRIPTION_LIFECYCLE_LEGS,
  stagingLiveLegsPassed,
} from './staging-live-env.ts'
import { runtimeManifestFixture } from './test-fixtures/runtime-manifest'

test('subscription lifecycle legs are required by the default staging gate', () => {
  const failures = requiredStagingLegFailures({})
  expect(SUBSCRIPTION_LIFECYCLE_LEGS.every(leg => failures.includes(leg))).toBe(true)
})

test('storage tier resize is required by the complete staging gate', () => {
  expect(requiredStagingLegFailures({})).toContain(STORAGE_TIER_RESIZE_LEG)
})

test('agent continuity timers satisfy the duet-agent production scheduling floor', () => {
  const productionFloorSeconds = MIN_SCHEDULE_INTERVAL_MS / 1_000

  expect(AGENT_CONTINUITY_REMINDER_DELAY_SECONDS).toBeGreaterThanOrEqual(productionFloorSeconds)
  expect(AGENT_CONTINUITY_REACTIVATION_DELAY_SECONDS).toBeGreaterThanOrEqual(productionFloorSeconds)
})

test('active restart waits for an unsettled long-turn task before rebooting', () => {
  const started = {
    seq: 7,
    createdAt: 7,
    event: {
      type: 'task_started',
      task: {
        id: 't7',
        kind: 'tool',
        name: 'hold_open_across_vm_restart',
        label: 'hold open',
        ownerScopeId: 'turn-1',
        status: 'running',
        startedAt: 7,
      },
    },
  }
  const active = SessionInitialHistorySnapshotSchema.parse({ events: [started] })
  expect(findActiveRestartHoldTask(active)).toEqual({ taskId: 't7', seq: 7 })

  const settled = SessionInitialHistorySnapshotSchema.parse({
    events: [
      started,
      {
        seq: 8,
        createdAt: 8,
        event: {
          type: 'task_settled',
          settlement: {
            id: 't7',
            status: 'completed',
            settledAt: 8,
            result: null,
          },
        },
      },
    ],
  })
  expect(findActiveRestartHoldTask(settled)).toBeUndefined()
})

test('active restart accepts either safe terminal after the observed live task', () => {
  for (const type of ['interrupted', 'complete'] as const) {
    const history = SessionInitialHistorySnapshotSchema.parse({
      events: [
        {
          seq: 7,
          createdAt: 7,
          event: {
            type: 'task_started',
            task: {
              id: 't7',
              kind: 'tool',
              name: 'hold_open_across_vm_restart',
              label: 'hold open',
              ownerScopeId: 'turn-1',
              status: 'running',
              startedAt: 7,
            },
          },
        },
        { seq: 8, createdAt: 8, event: { type } },
      ],
    })
    expect(findPostRestartTerminal(history, 7)).toEqual({ seq: 8, type })
    expect(findPostRestartTerminal(history, 8)).toBeUndefined()
  }

  const nonterminal = SessionInitialHistorySnapshotSchema.parse({
    events: [{ seq: 8, createdAt: 8, event: { type: 'sleep', wakeAt: 9 } }],
  })
  expect(findPostRestartTerminal(nonterminal, 7)).toBeUndefined()

  expect(jobPhaseForStateMachine({ currentState: 'hold' })).toBe('unfinished')
  expect(jobPhaseForStateMachine({ currentState: 'done', terminal: {} })).toBe('finished')
  expect(jobPhaseForStateMachine({ currentState: 'interrupted' })).toBe('finished')
})

test('reactivation waits for a durable sleep checkpoint before cleanup interrupt', () => {
  const base = {
    machineState: { currentState: 'wait_for_reminder' },
    machine: { nextWakeAt: 123_456 },
  }

  expect(isDurablySleepingReactivation({ ...base, turnStatus: 'running' })).toBe(false)
  expect(
    isDurablySleepingReactivation({
      ...base,
      turnStatus: 'sleep',
      machine: {},
    }),
  ).toBe(false)
  expect(
    isDurablySleepingReactivation({
      ...base,
      turnStatus: 'sleep',
      machineState: { currentState: 'other' },
    }),
  ).toBe(false)
  expect(isDurablySleepingReactivation({ ...base, turnStatus: 'sleep' })).toBe(true)
})

test('agent continuity accepts only an unsettled post-restart hold task as live', () => {
  const started = {
    seq: 11,
    createdAt: 11,
    event: {
      type: 'task_started',
      task: {
        id: 't2',
        kind: 'tool',
        name: 'hold_open_for_live_input',
        label: 'Run state hold_open_for_live_input',
        ownerScopeId: 'turn-1',
        status: 'running',
        startedAt: 11,
      },
    },
  }
  const live = SessionInitialHistorySnapshotSchema.parse({ events: [started] })
  expect(findLiveContinuityHoldTask(live, 10)).toEqual({ taskId: 't2', seq: 11 })
  expect(findLiveContinuityHoldTask(live, 11)).toBeUndefined()

  const settled = SessionInitialHistorySnapshotSchema.parse({
    events: [
      started,
      {
        seq: 12,
        createdAt: 12,
        event: {
          type: 'task_settled',
          settlement: { id: 't2', status: 'completed', settledAt: 12, result: null },
        },
      },
    ],
  })
  expect(findLiveContinuityHoldTask(settled, 10)).toBeUndefined()
})

test('agent continuity requires the exact queued follow-up and a stopped hold before interrupt', () => {
  const prompt = 'Mention the continuity token.'
  const history = SessionInitialHistorySnapshotSchema.parse({
    events: [
      {
        seq: 11,
        createdAt: 11,
        event: {
          type: 'task_started',
          task: {
            id: 't2',
            kind: 'tool',
            name: 'hold_open_for_live_input',
            label: 'Run state hold_open_for_live_input',
            ownerScopeId: 'turn-1',
            status: 'running',
            startedAt: 11,
          },
        },
      },
      {
        seq: 12,
        createdAt: 12,
        event: {
          type: 'prompt_submitted',
          inputKind: 'message',
          behavior: 'follow_up',
          prompt,
          sender: { kind: 'user', userId: 'user_fixture' },
        },
      },
      {
        seq: 13,
        createdAt: 13,
        event: { type: 'follow_up_queue', followUpQueue: [{ message: 'unrelated prompt' }] },
      },
      {
        seq: 14,
        createdAt: 14,
        // What the runner actually holds: the attributed envelope Duet delivers,
        // not the bare prompt. This fixture used to carry `{ message: prompt }`,
        // which is why an exact-match finder stayed green here for as long as it
        // was failing on live staging.
        event: {
          type: 'follow_up_queue',
          followUpQueue: [
            {
              message: `<user_message seq="12" timestamp="2026-08-12T06:09:31.482Z" user_full_name="Staging Runner" user_email="runner@duet.so">${prompt}</user_message>`,
            },
          ],
        },
      },
      {
        seq: 15,
        createdAt: 15,
        event: {
          type: 'task_settled',
          settlement: { id: 't2', status: 'stopped', settledAt: 15, reason: 'interrupted' },
        },
      },
      {
        seq: 16,
        createdAt: 16,
        event: { type: 'follow_up_queue', followUpQueue: [] },
      },
      { seq: 17, createdAt: 17, event: { type: 'interrupted' } },
    ],
  })

  const beforeInterrupt = SessionInitialHistorySnapshotSchema.parse({
    events: history.events.slice(0, 4),
  })
  const hold = findLiveContinuityHoldTask(beforeInterrupt, 10)
  expect(hold).toEqual({ taskId: 't2', seq: 11 })
  const queue = findFollowUpQueueEvidence(beforeInterrupt, prompt, hold!.seq)
  expect(queue).toEqual({ promptSeq: 12, queuedSeq: 14 })
  expect(historyHasInterruptedContinuity(history, hold!.taskId, queue!.queuedSeq)).toBe(true)
  expect(findFollowUpQueueEvidence(history, 'missing prompt', hold!.seq)).toBeUndefined()
  expect(historyHasInterruptedContinuity(history, 't3', queue!.queuedSeq)).toBe(false)
})

test('agent lifecycle leg is required by the default staging gate', () => {
  expect(requiredStagingLegFailures({})).toContain(AGENT_LIFECYCLE_LEG)
})

test('roster lookup and attribution helpers key off slug and agent id', () => {
  const agents = [
    { slug: 'other', id: 'a1' },
    { slug: 'target', id: 'a2' },
  ].map(row =>
    AgentSchema.parse({
      ...row,
      workspaceId: 'workspace-fixture',
      anchorId: `anchor-${row.id}`,
      anchorPath: `agents/${row.slug}`,
      anchorState: 'active',
      createdAt: 1,
      updatedAt: 1,
    }),
  )
  expect(agentCardInRoster(agents, 'target')?.id).toBe('a2')
  expect(agentCardInRoster(agents, 'missing')).toBeUndefined()

  expect(attributionMatchesAgent({ agent: { id: 'a2', name: 'Target' } }, 'a2')).toBe(true)
  expect(attributionMatchesAgent({ agent: { id: 'a2', name: '' } }, 'a2')).toBe(false)
  expect(attributionMatchesAgent({ agent: { id: 'a1', name: 'Other' } }, 'a2')).toBe(false)
  expect(attributionMatchesAgent({ agent: undefined }, 'a2')).toBe(false)
})

test('agent_deleted terminalization is read from the interrupted timeline event', () => {
  const deleted = SessionInitialHistorySnapshotSchema.parse({
    events: [
      {
        seq: 9,
        createdAt: 9,
        event: { type: 'interrupted', status: 'interrupted', error: 'agent_deleted' },
      },
    ],
  })
  const paused = SessionInitialHistorySnapshotSchema.parse({
    events: [
      {
        seq: 9,
        createdAt: 9,
        event: { type: 'interrupted', status: 'interrupted', error: 'workspace_paused' },
      },
    ],
  })
  expect(interruptedByAgentDeletion(deleted)).toBe(true)
  expect(interruptedByAgentDeletion(paused)).toBe(false)
})

test('the running hold task is only live while unsettled', () => {
  const started = {
    seq: 11,
    createdAt: 11,
    event: {
      type: 'task_started',
      task: {
        id: 't1',
        kind: 'tool',
        name: 'hold_running_for_delete',
        label: 'Run state hold_running_for_delete',
        ownerScopeId: 'turn-1',
        status: 'running',
        startedAt: 11,
      },
    },
  }
  const running = SessionInitialHistorySnapshotSchema.parse({ events: [started] })
  expect(findRunningHoldTask(running)).toEqual({ taskId: 't1', seq: 11 })

  const settled = SessionInitialHistorySnapshotSchema.parse({
    events: [
      started,
      {
        seq: 12,
        createdAt: 12,
        event: {
          type: 'task_settled',
          settlement: { id: 't1', status: 'stopped', settledAt: 12, reason: 'interrupted' },
        },
      },
    ],
  })
  expect(findRunningHoldTask(settled)).toBeUndefined()
})

test('runner presence is detected by the session id in the VM process list', () => {
  const sessionId = 'sess_abc123'
  expect(
    runnerProcessPresent(`4711 duet --rpc --session ${sessionId} --workdir agents/x`, sessionId),
  ).toBe(true)
  expect(runnerProcessPresent('', sessionId)).toBe(false)
  expect(runnerProcessPresent('4711 duet --rpc --session sess_other', sessionId)).toBe(false)
})

test('waits until the supplied admin projection is archived and paused', async () => {
  const projections = [
    { status: 'active' as const, servicingStatus: 'active' as const },
    { status: 'archived' as const, servicingStatus: 'paused' as const },
  ]

  await expect(
    waitForArchivedPausedAdminProjection(async () => projections.shift()!, {
      timeoutMs: 100,
      pollMs: 1,
    }),
  ).resolves.toEqual({ status: 'archived', servicingStatus: 'paused' })
})

test('accepts rendered query data during an interval refetch', async () => {
  const query = {
    getAttribute: async (name: string) => {
      if (name === 'data-query-status') return 'success'
      if (name === 'data-fetch-status') return 'fetching'
      return null
    },
    isVisible: async () => true,
    textContent: async () => 'Rendered admin data',
  }

  await expect(
    waitForBrowserQueryData(query, undefined, { timeoutMs: 20, pollMs: 1 }),
  ).resolves.toBeUndefined()
})

test('rejects an admin query error during refetching', async () => {
  const query = {
    getAttribute: async (name: string) => {
      if (name === 'data-query-status') return 'error'
      if (name === 'data-fetch-status') return 'fetching'
      return null
    },
    isVisible: async () => true,
    textContent: async () => 'Stale admin data',
  }

  await expect(waitForBrowserQueryData(query)).rejects.toThrow(
    'Browser query entered an error state',
  )
})

test('waits for the supplied workspace to be active and servicing', async () => {
  const workspaces: Array<{
    id: string
    status: 'provisioning' | 'active'
    servicingStatus: 'active'
  }> = [
    { id: 'workspace_1', status: 'provisioning', servicingStatus: 'active' },
    { id: 'workspace_1', status: 'active', servicingStatus: 'active' },
  ]

  await expect(
    waitForActiveAdminWorkspace('workspace_1', async () => workspaces.shift()!, {
      timeoutMs: 100,
      pollMs: 1,
    }),
  ).resolves.toEqual({ id: 'workspace_1', status: 'active', servicingStatus: 'active' })
})
import { assertApiCredentialRevoked } from './staging-live-http.ts'
import {
  logoutAndAssertCurrentBrowserSessionRevoked,
  waitForInviteSessionDestination,
} from './staging-live-invite.ts'
import { assertPostHogJourney } from './staging-live-public-site.ts'
import {
  assertCanonicalResponseUrl,
  assertDeployedPublicHtml,
  assertDocsSitemapCoverage,
  assertIndexableSitemapHtml,
  assertLanderSitemapCoverage,
  assertProductRouteArtifact,
  assertPublicLanderRouteArtifact,
  assertSitemapRouteCacheability,
} from './staging-live-route-contracts.ts'
import {
  answerPreview,
  answerReferencesSeededDiscount,
  assertDurableRefetch,
  assertWorkspaceCanBecomeActive,
  parseSseFrames,
  reconnectChunkDecision,
  workspaceWaitSummary,
} from './staging-live-streaming.ts'

test('deployed browser navigation stops at interactive DOM readiness with a finite bound', async () => {
  let accepted = false
  const page = {
    goto: async (_url: string, options?: { waitUntil?: string; timeout?: number }) => {
      if (
        options?.waitUntil !== 'domcontentloaded' ||
        options.timeout === undefined ||
        !Number.isFinite(options.timeout) ||
        options.timeout <= 0
      ) {
        throw new Error('navigation remained coupled to an unbounded full-page load')
      }
      accepted = true
      return null
    },
  }

  await navigateDeployedPage(page, 'https://lander-staging.duet.so')
  expect(accepted).toBe(true)
})

test('every staging browser context gives actions and transitions a finite bound', () => {
  const accepted = new Set<string>()
  const acceptFinite = (kind: string, timeout: number) => {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(`${kind} remained unbounded`)
    accepted.add(kind)
  }

  configureStagingBrowserContext({
    setDefaultTimeout: timeout => acceptFinite('actions', timeout),
    setDefaultNavigationTimeout: timeout => acceptFinite('transitions', timeout),
  })

  expect(accepted).toEqual(new Set(['actions', 'transitions']))
})

test('browser response completion cannot outlive its acceptance boundary', async () => {
  await expect(
    assertBrowserResponseFinished(
      { finished: async () => null, status: () => 200 },
      'completed response',
      5,
    ),
  ).resolves.toBeUndefined()
  await expect(
    assertBrowserResponseFinished(
      {
        finished: async () => await new Promise<null>(() => undefined),
        status: () => 200,
      },
      'stalled',
      5,
    ),
  ).rejects.toThrow('Timed out waiting for stalled response body')
  await expect(
    assertBrowserResponseFinished(
      {
        finished: async () => await new Promise<null>(() => undefined),
        status: () => 204,
      },
      'bodyless response',
      5,
    ),
  ).resolves.toBeUndefined()
})

describe('evaluate through client navigations', () => {
  test('retries a destroyed execution context until the page settles', async () => {
    let attempts = 0
    const result = await evaluateThroughClientNavigations(
      async () => {
        attempts += 1
        if (attempts < 3) {
          throw new Error('Execution context was destroyed, most likely because of a navigation')
        }
        return 204
      },
      { delayMs: 0 },
    )
    expect(result).toBe(204)
    expect(attempts).toBe(3)
  })

  test('rethrows non-navigation failures immediately', async () => {
    let attempts = 0
    await expect(
      evaluateThroughClientNavigations(
        async () => {
          attempts += 1
          throw new Error('boom')
        },
        { delayMs: 0 },
      ),
    ).rejects.toThrow('boom')
    expect(attempts).toBe(1)
  })

  test('gives up after bounded attempts on a page that never settles', async () => {
    let attempts = 0
    await expect(
      evaluateThroughClientNavigations(
        async () => {
          attempts += 1
          throw new Error('Execution context was destroyed, most likely because of a navigation')
        },
        { delayMs: 0 },
      ),
    ).rejects.toThrow('Execution context was destroyed')
    expect(attempts).toBeGreaterThan(1)
  })
})

describe('staging workspace wait diagnostics', () => {
  test('fails immediately when provisioning reaches an impossible terminal state', () => {
    expect(() =>
      assertWorkspaceCanBecomeActive({ _id: 'workspace_1', status: 'provisioning' }),
    ).not.toThrow()
    expect(() =>
      assertWorkspaceCanBecomeActive({ _id: 'workspace_1', status: 'active' }),
    ).not.toThrow()
    for (const status of ['unhealthy', 'retired', 'deleted']) {
      expect(() => assertWorkspaceCanBecomeActive({ _id: 'workspace_1', status })).toThrow(
        `Workspace workspace_1 cannot become active after entering ${status}`,
      )
    }
  })

  test('reports only the safe workspace fields used to diagnose a wait', () => {
    const raw = {
      _id: 'workspace_1',
      slug: 'acme',
      status: 'unhealthy',
      vmName: 'duet-ws-1',
      provisioningTokenHash: 'must-not-appear',
      vmTokenNonce: 'must-not-appear',
    }
    expect(workspaceWaitSummary(raw)).toEqual({
      _id: 'workspace_1',
      slug: 'acme',
      status: 'unhealthy',
      vmName: 'duet-ws-1',
    })
  })
})

describe('staging live SSE evidence', () => {
  test('ignores only aborts proven canceled at the time they fail', () => {
    expect(
      isActionableBrowserError({
        kind: 'navigation-canceled',
        message: 'GET https://app-staging.duet.so/w/acme/sessions: net::ERR_ABORTED',
      }),
    ).toBe(false)
    expect(
      isActionableBrowserError({
        kind: browserRequestFailureKind('net::ERR_ABORTED', 4, 4),
        message: 'GET https://app-staging.duet.so/api/duet/whoami: net::ERR_ABORTED',
      }),
    ).toBe(true)
    expect(browserRequestFailureKind('net::ERR_ABORTED', 3, 4)).toBe('navigation-canceled')
    expect(browserRequestFailureKind('net::ERR_ABORTED', 4, 4)).toBe('request')
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        requestPageUrl: 'https://app-staging.duet.so/settings/profile',
        pageUrlAtFailure: 'https://app-staging.duet.so/settings/billing',
      }),
    ).toBe('navigation-canceled')
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        pageUrlAtFailure: 'https://app-staging.duet.so/settings/billing',
      }),
    ).toBe('request')
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, { frameDetachedAtFailure: true }),
    ).toBe('navigation-canceled')
    expect(browserRequestFailureKind('net::ERR_FAILED', 3, 4)).toBe('request')
    expect(browserRequestFailureKind('net::ERR_ABORTED', 4, 4, { responseStatus: 204 })).toBe(
      'navigation-canceled',
    )
    expect(browserRequestFailureKind('net::ERR_ABORTED', 4, 4, { responseStatus: 200 })).toBe(
      'request',
    )
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        methodAtFailure: 'POST',
        responseStatus: 202,
      }),
    ).toBe('request')
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        methodAtFailure: 'HEAD',
        responseStatus: 200,
      }),
    ).toBe('navigation-canceled')
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        methodAtFailure: 'HEAD',
        responseStatus: 404,
      }),
    ).toBe('request')
    expect(browserRequestFailureKind('net::ERR_ABORTED', 4, 4, { responseStatus: 404 })).toBe(
      'request',
    )
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        explicitPrefetchAtFailure: true,
      }),
    ).toBe('navigation-canceled')
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, { replacementCompleted: true }),
    ).toBe('navigation-canceled')
    expect(browserRequestFailureKind('net::ERR_ABORTED', 4, 4)).toBe('request')
    expect(
      isActionableBrowserError({
        kind: 'response',
        message: 'GET https://app-staging.duet.so/api/duet/whoami: HTTP 500',
      }),
    ).toBe(true)
    expect(isActionableBrowserError({ kind: 'console', message: 'render failed' })).toBe(true)
  })

  test('recognizes only explicit browser and framework prefetch headers', () => {
    expect(isExplicitBrowserPrefetch({ 'next-router-prefetch': '1' })).toBe(true)
    expect(isExplicitBrowserPrefetch({ purpose: 'prefetch' })).toBe(true)
    expect(isExplicitBrowserPrefetch({ 'sec-purpose': 'prefetch;prerender' })).toBe(true)
    expect(isExplicitBrowserPrefetch({ purpose: 'navigate' })).toBe(false)
    expect(isExplicitBrowserPrefetch({})).toBe(false)
  })

  test('excuses only responsive resources superseded by a marked viewport change', () => {
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        requestViewportEpoch: 2,
        viewportEpochAtFailure: 3,
        resourceTypeAtFailure: 'image',
      }),
    ).toBe('navigation-canceled')
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        requestViewportEpoch: 2,
        viewportEpochAtFailure: 3,
        resourceTypeAtFailure: 'media',
      }),
    ).toBe('navigation-canceled')
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        requestViewportEpoch: 2,
        viewportEpochAtFailure: 3,
        resourceTypeAtFailure: 'fetch',
      }),
    ).toBe('request')
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        requestViewportEpoch: 3,
        viewportEpochAtFailure: 3,
        resourceTypeAtFailure: 'image',
      }),
    ).toBe('request')
  })

  test('excuses an old-page request aborted while a main navigation is pending', () => {
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        mainNavigationPendingAtFailure: true,
      }),
    ).toBe('navigation-canceled')
    expect(browserRequestFailureKind('net::ERR_ABORTED', 4, 4)).toBe('request')
  })

  test('excuses an abort only when its exact subframe later detaches', () => {
    expect(
      browserRequestFailureKind('net::ERR_ABORTED', 4, 4, {
        frameDetachedAfterFailure: true,
      }),
    ).toBe('navigation-canceled')
    expect(browserRequestFailureKind('net::ERR_ABORTED', 4, 4)).toBe('request')
  })

  test('accepts only a successful exact replacement ordered after the failed request', () => {
    const failed = {
      key: 'GET https://app-staging.duet.so/api/duet/ws/acme/sessions?search=',
      startedOrder: 4,
      failureOrder: 6,
    }
    expect(
      isLaterExactBrowserReplacement(failed, {
        key: failed.key,
        startedOrder: 2,
        finishedOrder: 7,
      }),
    ).toBe(false)
    expect(
      isLaterExactBrowserReplacement(failed, {
        key: 'GET https://app-staging.duet.so/api/duet/ws/acme/sessions?search=next',
        startedOrder: 7,
        finishedOrder: 8,
      }),
    ).toBe(false)
    expect(
      isLaterExactBrowserReplacement(failed, {
        key: failed.key,
        startedOrder: 7,
        finishedOrder: 8,
      }),
    ).toBe(true)
  })

  test('does not count a document commit as superseding its own navigation request', () => {
    expect(
      navigationEpochAfterCommit(
        4,
        'https://app-staging.duet.so/settings/profile',
        'https://app-staging.duet.so/settings/profile',
      ),
    ).toBe(4)
    expect(
      navigationEpochAfterCommit(4, undefined, 'https://app-staging.duet.so/settings/billing'),
    ).toBe(5)
  })

  test('waits for first-party route requests to finish and remain quiet', async () => {
    const pending = new Set<unknown>(['request'])
    const quietMs = 20
    let now = 0
    let completedAt: number | undefined
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    const delay = spyOn(Bun, 'sleep').mockImplementation(async milliseconds => {
      if (typeof milliseconds !== 'number') throw new Error('expected a duration')
      now += milliseconds
      if (pending.has('request')) {
        completedAt = now
        pending.delete('request')
      }
    })
    try {
      await waitForPendingRequestsToSettle(pending, quietMs, 1_000)
      expect([...pending]).toEqual([])
      expect(completedAt).toBeDefined()
      expect(now - completedAt!).toBeGreaterThanOrEqual(quietMs)
    } finally {
      delay.mockRestore()
      clock.mockRestore()
    }
  })

  test('fails when first-party route requests never finish', async () => {
    await expect(
      waitForPendingRequestsToSettle(new Set<unknown>(['request']), 1, 5),
    ).rejects.toThrow('Timed out waiting for first-party browser requests')
  })

  test('consumes only the explicitly budgeted invite rejection response', () => {
    const expected = [{ method: 'POST', pathname: '/api/duet/session', status: 400, remaining: 1 }]
    const response = { method: 'POST', pathname: '/api/duet/session', status: 400 }
    expect(consumeExpectedBrowserResponse(expected, response)).toBe(true)
    expect(consumeExpectedBrowserResponse(expected, response)).toBe(false)
  })

  test('budgets a hosted-provider failure by exact origin as well as path', () => {
    const expected = [
      {
        method: 'GET',
        origin: 'https://apay-us.amazon.com',
        pathname: '/amazonpayMerchantId',
        status: 500,
        remaining: 1,
      },
    ]
    expect(
      consumeExpectedBrowserResponse(expected, {
        method: 'GET',
        origin: 'https://app-staging.duet.so',
        pathname: '/amazonpayMerchantId',
        status: 500,
      }),
    ).toBe(false)
    expect(
      consumeExpectedBrowserResponse(expected, {
        method: 'GET',
        origin: 'https://apay-us.amazon.com',
        pathname: '/amazonpayMerchantId',
        status: 500,
      }),
    ).toBe(true)
  })

  test('budgets only the exact number of known response-body aborts', () => {
    const expected = [
      {
        method: 'POST',
        origin: 'https://bzr.openai.com',
        pathname: '/v1/sdk/events',
        status: 202,
        remaining: 2,
      },
    ]
    const exact = {
      method: 'POST',
      origin: 'https://bzr.openai.com',
      pathname: '/v1/sdk/events',
      status: 202,
    }
    expect(consumeExpectedBrowserResponse(expected, exact)).toBe(true)
    expect(consumeExpectedBrowserResponse(expected, exact)).toBe(true)
    expect(consumeExpectedBrowserResponse(expected, exact)).toBe(false)
    expect(
      consumeExpectedBrowserResponse(
        [
          {
            ...expected[0]!,
            remaining: 1,
          },
        ],
        { ...exact, origin: 'https://app-staging.duet.so' },
      ),
    ).toBe(false)
  })

  test('spends an expected-abort budget only after causal evidence is exhausted', () => {
    const expected = [
      {
        method: 'POST',
        origin: 'https://bzr.openai.com',
        pathname: '/v1/sdk/events',
        status: 202,
        remaining: 1,
      },
    ]
    const actual = {
      method: 'POST',
      origin: 'https://bzr.openai.com',
      pathname: '/v1/sdk/events',
      status: 202,
    }
    expect(
      browserRequestFailureKindWithExpectedAbort(
        'net::ERR_ABORTED',
        4,
        4,
        { explicitPrefetchAtFailure: true },
        expected,
        actual,
      ),
    ).toBe('navigation-canceled')
    expect(expected[0]!.remaining).toBe(1)
    expect(
      browserRequestFailureKindWithExpectedAbort('net::ERR_ABORTED', 4, 4, {}, expected, actual),
    ).toBe('navigation-canceled')
    expect(expected[0]!.remaining).toBe(0)
  })

  test('allows CI to isolate unavailable Google OAuth without masking another skip or failure', () => {
    const shareJourney = Object.fromEntries(
      SHARE_JOURNEY_LEGS.map(name => [name, { status: 'pass' as const }]),
    )
    const subscriptionLifecycle = Object.fromEntries(
      SUBSCRIPTION_LIFECYCLE_LEGS.map(name => [name, { status: 'pass' as const }]),
    )
    const googleUnavailable = {
      hosts: { status: 'pass' as const },
      [AGENT_CONTINUITY_LEG]: { status: 'pass' as const },
      [AGENT_LIFECYCLE_LEG]: { status: 'pass' as const },
      [APP_API_KEYS_LEG]: { status: 'pass' as const },
      'share-byte-arrival': { status: 'pass' as const },
      'apps-in-file-view': { status: 'pass' as const },
      'build-app': { status: 'pass' as const },
      [DRIVE_DEEP_LINKS_LEG]: { status: 'pass' as const },
      [STORAGE_TIER_RESIZE_LEG]: { status: 'pass' as const },
      [CONNECTED_PROVIDERS_PAGE_LEG]: { status: 'pass' as const },
      ...shareJourney,
      ...subscriptionLifecycle,
      ...Object.fromEntries(
        CONNECTED_PROVIDERS_STAGING_LEGS.map(name => [name, { status: 'pass' as const }]),
      ),
      'google-oauth': { status: 'skipped' as const, reason: 'not configured' },
    }
    expect(stagingLiveLegsPassed(googleUnavailable)).toBe(false)
    expect(stagingLiveLegsPassed(googleUnavailable, true)).toBe(true)
    expect(
      stagingLiveLegsPassed(
        { ...googleUnavailable, 'public-forms': { status: 'skipped', reason: 'not configured' } },
        true,
      ),
    ).toBe(false)
    expect(
      stagingLiveLegsPassed(
        { ...googleUnavailable, routes: { status: 'fail', reason: 'route missing' } },
        true,
      ),
    ).toBe(false)
    expect(requiredStagingLegFailures(googleUnavailable)).toEqual([])
    expect(
      requiredStagingLegFailures({
        ...googleUnavailable,
        'public-forms': { status: 'skipped', reason: 'not configured' },
      }),
    ).toEqual(['public-forms'])
  })

  test('requires the share and fresh-workspace apps-in-files legs even when every recorded leg passed', () => {
    const recorded = {
      hosts: { status: 'pass' as const },
      overall: { status: 'pass' as const },
    }

    expect(stagingLiveLegsPassed(recorded, true)).toBe(false)
    expect(
      requiredStagingLegFailures(recorded, {
        fakeOAuthIssuerUrl: 'https://connected-provider-issuer-staging.duet.so',
      }),
    ).toEqual([
      AGENT_CONTINUITY_LEG,
      AGENT_LIFECYCLE_LEG,
      APP_API_KEYS_LEG,
      'share-byte-arrival',
      'apps-in-file-view',
      'build-app',
      DRIVE_DEEP_LINKS_LEG,
      STORAGE_TIER_RESIZE_LEG,
      CONNECTED_PROVIDERS_PAGE_LEG,
      ...SUBSCRIPTION_LIFECYCLE_LEGS,
      ...SHARE_JOURNEY_LEGS,
      ...CONNECTED_PROVIDERS_STAGING_LEGS,
    ])
  })

  test('runs complete route sweeps without exceeding their concurrency bound', async () => {
    let active = 0
    let maximum = 0
    const visited: number[] = []
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const sweep = forEachBounded([1, 2, 3], 2, async value => {
      active += 1
      maximum = Math.max(maximum, active)
      if (active === 2) started.resolve()
      await gate.promise
      visited.push(value)
      active -= 1
    })
    try {
      await started.promise
      expect(active).toBe(2)
      expect(visited).toEqual([])
    } finally {
      gate.resolve()
      await sweep
    }
    expect(maximum).toBe(2)
    expect(visited.sort((left, right) => left - right)).toEqual([1, 2, 3])
  })

  test('requires the deployed public-route artifact to cover every sitemap member', () => {
    const required = ['/', '/es', '/blog', '/es/blog', '/guides', '/es/guides']
    const generated = ['/generated-0']
    const paths = [...required, ...generated]
    const routes = paths.map(path => ({ path, kind: 'marketing' as const, status: 200 as const }))
    const artifact = { schemaVersion: 2, routes }

    expect(assertPublicLanderRouteArtifact(artifact, ['/blog', '/generated-0'])).toEqual(routes)
    expect(() =>
      assertPublicLanderRouteArtifact(artifact, ['/missing-from-public-artifact']),
    ).toThrow('was missing from public route artifact')
    expect(() =>
      assertPublicLanderRouteArtifact({ schemaVersion: 2, routes: [...routes, routes[0]] }, [
        '/blog',
      ]),
    ).toThrow('duplicate paths')
  })

  test('requires deployed redirects to target owned HTML outside the sitemap', () => {
    const generated = Array.from({ length: 1 }, (_, index) => ({
      path: `/generated-${index}`,
      kind: 'editorial' as const,
      status: 200 as const,
    }))
    const routes = [
      { path: '/', kind: 'marketing' as const, status: 200 as const },
      ...generated,
      {
        path: '/es/generated-0',
        kind: 'editorial' as const,
        status: 308 as const,
        redirectTo: '/generated-0',
      },
    ]

    expect(assertPublicLanderRouteArtifact({ schemaVersion: 2, routes }, ['/'])).toEqual(routes)
    expect(() =>
      assertPublicLanderRouteArtifact({ schemaVersion: 2, routes }, ['/es/generated-0']),
    ).toThrow('was missing from public route artifact')
    expect(() =>
      assertPublicLanderRouteArtifact(
        {
          schemaVersion: 2,
          routes: routes.map(route =>
            route.path === '/es/generated-0' ? { ...route, redirectTo: '/missing' } : route,
          ),
        },
        ['/'],
      ),
    ).toThrow('did not redirect to an owned HTML route')
  })

  test('resolves the deployed product route inventory with real fixture ids', () => {
    const fixed = Array.from({ length: 1 }, (_, index) => ({
      template: `/settings/fixture-${index}`,
      destination: 'userSettings',
    }))
    const artifact = {
      schemaVersion: 1,
      routes: [
        ...fixed,
        {
          template: '/w/:workspaceSlug/sessions/:sessionId',
          destination: 'sessions',
        },
      ],
    }

    expect(
      assertProductRouteArtifact(artifact, {
        workspaceSlug: 'acme',
        sessionId: 'session_1',
      }),
    ).toEqual([
      { path: '/settings/fixture-0', destination: 'userSettings' },
      { path: '/w/acme/sessions/session_1', destination: 'sessions' },
    ])
    expect(() =>
      assertProductRouteArtifact(
        {
          schemaVersion: 1,
          routes: [...fixed, { template: '//attacker.example', destination: 'sessions' }],
        },
        { workspaceSlug: 'acme', sessionId: 'session_1' },
      ),
    ).toThrow('invalid template')
  })

  test('rejects manifest paths that escape or normalize before fetching', () => {
    for (const unsafePath of [
      '//attacker.example/collect',
      '/safe/../collect',
      '/safe/%2e%2e/collect',
    ]) {
      const routes = [
        ...Array.from({ length: 1 }, (_, index) => ({
          path: `/generated-${index}`,
          kind: 'marketing' as const,
          status: 200 as const,
        })),
        { path: unsafePath, kind: 'marketing' as const, status: 200 as const },
      ]

      expect(() => assertPublicLanderRouteArtifact({ schemaVersion: 2, routes }, [])).toThrow(
        'invalid path',
      )
    }
  })

  test('checks the exact logged-out browser credential against whoami', async () => {
    const requests: Request[] = []
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return new Response(null, { status: 401 })
    }

    await expect(
      assertApiCredentialRevoked('https://ctl-staging.duet.so', 'duet_sk_browser', fetchImpl),
    ).resolves.toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://ctl-staging.duet.so/v1/whoami')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer duet_sk_browser')
  })

  test('probes the logout-time credential after a browser session rotates', async () => {
    const rotatedCredential = 'duet_sk_rotated_session'
    const encode = (token: string) =>
      Buffer.from(JSON.stringify({ token, expiresAt: Date.now() + 900_000 })).toString('base64url')
    let probedCredential: string | undefined
    const order: string[] = []

    const result = await logoutAndAssertCurrentBrowserSessionRevoked({
      getCookies: async () => {
        expect(order).toEqual([])
        order.push('current-cookie')
        return [{ name: 'duet_session', value: encode(rotatedCredential) }]
      },
      logout: async () => {
        expect(order).toEqual(['current-cookie'])
        order.push('logout')
        return 'posthog-reset'
      },
      assertRevoked: async credential => {
        expect(order).toEqual(['current-cookie', 'logout'])
        order.push('revocation-probe')
        probedCredential = credential
      },
    })

    expect(order).toEqual(['current-cookie', 'logout', 'revocation-probe'])
    expect(probedCredential).toBe(rotatedCredential)
    expect(result).toBe('posthog-reset')
  })

  test('accepts an invite destination without assuming the user has session capability', async () => {
    const selectors: string[] = []
    let timeout: number | undefined
    const page = {
      locator: (selector: string) => {
        selectors.push(selector)
        return {
          waitFor: async (options: { timeout: number }) => {
            timeout = options.timeout
          },
        }
      },
    }

    await waitForInviteSessionDestination(page as never)

    expect(selectors).toEqual(['[data-destination-content]'])
    expect(timeout).toBeGreaterThan(0)
    expect(Number.isFinite(timeout)).toBe(true)
  })

  test('requires one anonymous PostHog journey through identify, reset, and return', () => {
    const anonymous = {
      distinctId: 'anonymous-a',
      deviceId: 'device-a',
      sessionId: 'session-a',
      userState: 'anonymous',
    }
    const authenticated = {
      distinctId: 'user-1',
      deviceId: 'device-a',
      sessionId: 'session-a',
      userState: 'identified',
    }
    const reset = {
      distinctId: 'anonymous-b',
      deviceId: 'device-b',
      sessionId: 'session-b',
      userState: 'anonymous',
    }

    expect(() =>
      assertPostHogJourney({
        landerAnonymous: anonymous,
        productAnonymous: anonymous,
        productAuthenticated: authenticated,
        productReset: reset,
        landerReturned: reset,
        userId: 'user-1',
      }),
    ).not.toThrow()
    const valid = {
      landerAnonymous: anonymous,
      productAnonymous: anonymous,
      productAuthenticated: authenticated,
      productReset: reset,
      landerReturned: reset,
      userId: 'user-1',
    }
    for (const [changed, diagnostic] of [
      [
        { productAnonymous: { ...anonymous, deviceId: 'forked-device' } },
        'forked between lander and product',
      ],
      [
        { productAuthenticated: { ...authenticated, distinctId: 'wrong-user' } },
        'did not identify',
      ],
      [
        { productAuthenticated: { ...authenticated, deviceId: 'new-device' } },
        'identify replaced the anonymous device',
      ],
      [
        { productAuthenticated: { ...authenticated, sessionId: 'new-session' } },
        'identify replaced the anonymous session',
      ],
      [{ productReset: { ...reset, distinctId: 'user-1' } }, 'logout retained the user id'],
      [{ productReset: { ...reset, deviceId: 'device-a' } }, 'logout retained the pre-auth device'],
      [
        { productReset: { ...reset, sessionId: 'session-a' } },
        'logout retained the pre-auth session',
      ],
      [{ landerReturned: anonymous }, 'reset identity forked'],
    ] as const) {
      expect(() => assertPostHogJourney({ ...valid, ...changed })).toThrow(diagnostic)
    }
  })

  test('fails logout acceptance while the browser credential remains usable', async () => {
    await expect(
      assertApiCredentialRevoked(
        'https://ctl-staging.duet.so',
        'duet_sk_still_valid',
        async () => new Response(null, { status: 200 }),
      ),
    ).rejects.toThrow('logout did not revoke browser session credential')
  })

  test('accepts natural variants of the seeded 20 percent fact', () => {
    expect(answerReferencesSeededDiscount('Offer 20 percent.')).toBe(true)
    expect(answerReferencesSeededDiscount('Offer 20%.')).toBe(true)
    expect(answerReferencesSeededDiscount('Offer 20 %.')).toBe(true)
    expect(answerReferencesSeededDiscount('Offer twenty percent.')).toBe(false)
    expect(answerReferencesSeededDiscount('Offer 25%.')).toBe(false)
    expect(answerReferencesSeededDiscount('The total is 120%.')).toBe(false)
  })

  test('keeps short answers and a bounded readable prefix of long answers in diagnostics', () => {
    expect(answerPreview('short answer')).toBe('short answer')
    const answer = 'A useful diagnostic sentence. '.repeat(1_000)
    const preview = answerPreview(answer)
    expect(preview.length).toBeGreaterThan(0)
    expect(preview.length).toBeLessThan(answer.length)
    expect(answer.startsWith(preview)).toBe(true)
  })

  test('parses id-less ephemeral and id-bearing canonical frames', () => {
    const ephemeral = parseSseFrames(
      'event: step\ndata: {"event":{"type":"step","step":{"type":"text_delta","delta":"hi"}}}',
      100,
      1,
    )
    const canonical = parseSseFrames(
      'id: 2\nevent: step\ndata: {"seq":2,"event":{"type":"step","step":{"type":"text","text":"hi"}}}',
      200,
      2,
    )

    expect(ephemeral).toEqual([
      {
        event: { type: 'step', step: { type: 'text_delta', delta: 'hi' } },
        receivedAt: 100,
        chunkIndex: 1,
        connectionIndex: 1,
      },
    ])
    expect(canonical).toEqual([
      {
        id: 2,
        event: { type: 'step', step: { type: 'text', text: 'hi' } },
        receivedAt: 200,
        chunkIndex: 2,
        connectionIndex: 1,
      },
    ])
  })

  test('durability accepts canonical timeline and rejects persisted deltas', () => {
    const frame = (id: number, event: Record<string, unknown>) => ({
      id,
      event,
      receivedAt: id,
      chunkIndex: id,
      connectionIndex: 1,
    })
    const durable = [
      frame(1, { type: 'turn_started' }),
      frame(2, { type: 'step', step: { type: 'text', text: '20 percent' } }),
      frame(3, { type: 'complete', result: '20 percent' }),
    ]
    expect(() => assertDurableRefetch(durable)).not.toThrow()
    expect(() =>
      assertDurableRefetch([
        durable[0]!,
        frame(2, { type: 'step', step: { type: 'text_delta', delta: 'bad' } }),
        durable[1]!,
        durable[2]!,
      ]),
    ).toThrow('ephemeral')
  })

  test('forces reconnect only after a terminal-free chunk has durable progress and a live delta', () => {
    const canonical = {
      id: 1,
      event: { type: 'turn_started' },
      receivedAt: 100,
      chunkIndex: 1,
      connectionIndex: 1,
    }
    const delta = {
      event: { type: 'step', step: { type: 'text_delta', delta: 'hi' } },
      receivedAt: 200,
      chunkIndex: 2,
      connectionIndex: 1,
    }
    const terminal = {
      id: 2,
      event: { type: 'complete', result: 'hi' },
      receivedAt: 200,
      chunkIndex: 2,
      connectionIndex: 1,
    }

    expect(reconnectChunkDecision([canonical])).toBe('continue')
    expect(reconnectChunkDecision([delta])).toBe('continue')
    expect(reconnectChunkDecision([canonical, delta])).toBe('reconnect')
    expect(reconnectChunkDecision([canonical, delta, terminal])).toBe('terminal')
  })

  test('accepts the intentional sharded bilingual sitemap corpus', () => {
    const routes = [
      '/',
      '/es',
      '/blog',
      '/es/blog',
      '/guides',
      '/es/guides',
      '/use-cases',
      '/blog/canonical-0',
    ]
    const sitemapPaths = [
      '/sitemap.xml',
      '/sitemap/blog-en.xml',
      '/sitemap/blog-es.xml',
      '/sitemap/core.xml',
      '/sitemap/guides-en.xml',
      '/sitemap/guides-es.xml',
      '/sitemap/use-cases.xml',
    ]
    expect(() => assertLanderSitemapCoverage({ routes, sitemapPaths })).not.toThrow()
    expect(() =>
      assertLanderSitemapCoverage({ routes, sitemapPaths: sitemapPaths.slice(0, -1) }),
    ).toThrow('lander sitemap shard topology changed')
    expect(() =>
      assertLanderSitemapCoverage({
        routes,
        sitemapPaths: [...sitemapPaths.slice(0, -1), '/sitemap/unexpected.xml'],
      }),
    ).toThrow('lander sitemap shard topology changed')
    expect(() =>
      assertLanderSitemapCoverage({
        routes: routes.filter(route => route !== '/'),
        sitemapPaths,
      }),
    ).toThrow('omitted canonical route /')
    expect(() =>
      assertLanderSitemapCoverage({
        routes: routes.filter(route => route !== '/es/guides'),
        sitemapPaths,
      }),
    ).toThrow('omitted canonical route /es/guides')
    expect(() =>
      assertLanderSitemapCoverage({ routes: [...routes, '/blog/tag/ai'], sitemapPaths }),
    ).toThrow('included noindex taxonomy route')
    expect(() =>
      assertLanderSitemapCoverage({ routes: [...routes, '/vs/competitor'], sitemapPaths }),
    ).toThrow('included noindex comparison route')
    expect(() =>
      assertLanderSitemapCoverage({ routes: [...routes, '/es/use-cases/agencies'], sitemapPaths }),
    ).toThrow('included discontinued Spanish route')
    expect(() =>
      assertLanderSitemapCoverage({ routes: [...routes, '/es/for/accountants'], sitemapPaths }),
    ).toThrow('included discontinued Spanish route')
  })

  test('requires sitemap members to remain canonical and indexable', () => {
    const route = 'https://lander-staging.duet.so/blog'
    const canonical = '<link rel="canonical" href="https://duet.so/blog">'
    expect(() =>
      assertIndexableSitemapHtml(
        route,
        `${canonical}<meta name="robots" content="index, follow">`,
        undefined,
        'https://duet.so',
      ),
    ).not.toThrow()
    expect(() =>
      assertIndexableSitemapHtml(
        route,
        `${canonical}<meta name="robots" content="noindex, follow">`,
        undefined,
        'https://duet.so',
      ),
    ).toThrow('declared robots noindex')
    expect(() =>
      assertIndexableSitemapHtml(
        route,
        `${canonical}<meta content='follow, NOINDEX' name='googlebot'>`,
        undefined,
        'https://duet.so',
      ),
    ).toThrow('declared googlebot noindex')
    expect(() =>
      assertIndexableSitemapHtml(route, canonical, 'googlebot: noindex', 'https://duet.so'),
    ).toThrow('declared X-Robots-Tag noindex')
    expect(() =>
      assertIndexableSitemapHtml(
        route,
        `${canonical}<meta name="bingbot" content="none">`,
        undefined,
        'https://duet.so',
      ),
    ).toThrow('declared bingbot noindex')
    expect(() =>
      assertIndexableSitemapHtml(
        route,
        '<link href="https://duet.so/guides" rel="canonical">',
        undefined,
        'https://duet.so',
      ),
    ).toThrow('canonical link disagreed with its public route')
  })

  test('validates deployed static HTML and returns same-origin links and assets', () => {
    const route = 'https://lander-staging.duet.so/es/blog'
    const html = `<html lang="en"><head>
      <script>document.documentElement.lang="es-419"</script>
      <link rel="canonical" href="https://lander-staging.duet.so/es/blog">
      <link rel="stylesheet" href="/_next/static/app.css">
      <meta name="robots" content="index, follow">
    </head><body>
      <main>${'Contenido público útil. '.repeat(12)}</main>
      <a href="/es/pricing">Precios</a>
      <a href="https://app-staging.duet.so/">Entrar</a>
      <img src="/hero.png" srcset="/hero-small.png?tr=w-32,c-at_max 32w, /hero-large.png?tr=w-64,c-at_max 64w" alt="Duet">
    </body></html>`

    expect(
      assertDeployedPublicHtml({
        route,
        html,
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'public, max-age=0, must-revalidate',
        xRobotsTag: undefined,
        canonicalOrigin: 'https://lander-staging.duet.so',
        kind: 'editorial',
        sitemapMember: true,
      }),
    ).toEqual([
      'https://lander-staging.duet.so/_next/static/app.css',
      'https://lander-staging.duet.so/es/blog',
      'https://lander-staging.duet.so/es/pricing',
      'https://lander-staging.duet.so/hero-large.png?tr=w-64,c-at_max',
      'https://lander-staging.duet.so/hero-small.png?tr=w-32,c-at_max',
      'https://lander-staging.duet.so/hero.png',
    ])

    expect(() =>
      assertDeployedPublicHtml({
        route,
        html: '<html lang="en"><script>document.documentElement.lang="es-419"</script><body>Hydration-only shell</body></html>',
        contentType: 'text/html',
        cacheControl: 'public, max-age=0',
        xRobotsTag: undefined,
        canonicalOrigin: 'https://lander-staging.duet.so',
        kind: 'editorial',
        sitemapMember: true,
      }),
    ).toThrow('meaningful no-JavaScript HTML')
  })

  test('pins every deployed docs sitemap route', () => {
    const routes = [
      '/',
      '/agents/',
      '/api-keys/',
      '/apps/',
      '/billing/',
      '/device-flow/',
      '/errors/',
      '/events/',
      '/file-activity/',
      '/files/',
      '/getting-started/',
      '/integrations/',
      '/mirror-devices/',
      '/pagination/',
      '/reference/',
      '/reliability/',
      '/sessions/',
      '/shares-publishes/',
      '/sync/',
      '/train/',
      '/workspaces/',
    ]
    expect(() => assertDocsSitemapCoverage(routes)).not.toThrow()
    expect(() => assertDocsSitemapCoverage(routes.slice(0, -1))).toThrow(
      'docs sitemap route set changed',
    )
    expect(() => assertDocsSitemapCoverage([...routes, '/stale/'])).toThrow(
      'docs sitemap route set changed',
    )
  })

  test('accepts Playwright request-context relative response URLs without accepting another route', () => {
    expect(() =>
      assertCanonicalResponseUrl(
        'https://lander-staging.duet.so/',
        '/',
        'https://lander-staging.duet.so',
      ),
    ).not.toThrow()
    expect(() =>
      assertCanonicalResponseUrl(
        'https://lander-staging.duet.so/blog',
        '/guides',
        'https://lander-staging.duet.so',
      ),
    ).toThrow('did not resolve canonically')
  })

  test('keeps static sitemap members cacheable while allowing the request-aware sign-in route', () => {
    const privateCache = 'private, no-cache, no-store, max-age=0, must-revalidate'
    expect(() =>
      assertSitemapRouteCacheability('https://lander-staging.duet.so/sign-in', privateCache, [
        '/sign-in',
      ]),
    ).not.toThrow()
    expect(() =>
      assertSitemapRouteCacheability('https://lander-staging.duet.so/blog', privateCache, [
        '/sign-in',
      ]),
    ).toThrow('was not publicly cacheable')
    expect(() =>
      assertSitemapRouteCacheability(
        'https://lander-staging.duet.so/blog',
        'public, max-age=0, s-maxage=31536000',
        ['/sign-in'],
      ),
    ).not.toThrow()
  })
})


test('reboot observation survives a temporary unavailable gateway and rejects the old process', async () => {
  let requests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      requests += 1
      if (requests === 1) return new Response('rebooting', { status: 502 })
      return Response.json({
        workspaceId: 'workspace',
        controlStatus: 'running',
        auditId: 'audit',
        gateway: { reachable: true, instanceId: requests === 2 ? 'before' : 'after' },
      })
    },
  })
  try {
    expect(
      await waitForGatewayInstance(
        { apiUrl: server.url.origin, internalKey: 'test' },
        'workspace',
        'test',
        'before',
      ),
    ).toBe('after')
  } finally {
    await server.stop(true)
  }
})

test('reboot journeys wait for the announced release to finish health probation', async () => {
  const manifest = runtimeManifestFixture('certification')
  let healthReads = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      if (new URL(request.url).pathname.endsWith('/manifest')) {
        return Response.json(manifest)
      }
      healthReads++
      return Response.json({
        runtimeVersion: healthReads === 1 ? 'old-release' : manifest.version,
        instanceId: healthReads < 3 ? 'not-ready' : 'certified-process',
        diagnostics: { bootHealthCertified: healthReads !== 2 },
      })
    },
  })
  try {
    expect(
      await waitForCertifiedRuntimeRelease(server.url.origin, server.url.origin, 'token'),
    ).toEqual({ runtimeVersion: manifest.version, instanceId: 'certified-process' })
  } finally {
    await server.stop(true)
  }
}, 15_000)

test('stopped-session journey proof rejects renewed execution but permits stop bookkeeping', () => {
  const history = (events: unknown[]) => SessionInitialHistorySnapshotSchema.parse({ events })
  const stopped = {
    seq: 10,
    createdAt: 10,
    event: { type: 'system', level: 'info', message: 'Stopped' },
  }
  expect(() => assertStoppedSessionHistory(history([stopped]), 9)).not.toThrow()
  const started = {
    seq: 11,
    createdAt: 11,
    event: {
      type: 'turn_started',
      state: {
        status: 'running',
        mode: 'agent',
        agent: { status: 'running', messages: [] },
      },
    },
  }
  expect(() => assertStoppedSessionHistory(history([started]), 10)).toThrow('restarted execution')
  expect(() => assertStoppedSessionHistory(history([started, stopped]), 11)).not.toThrow()
  const task = {
    seq: 12,
    createdAt: 12,
    event: {
      type: 'task_started',
      task: {
        id: 'stopped-session-task',
        kind: 'tool',
        name: 'cleanup',
        label: 'Cleanup',
        ownerScopeId: 'turn-1',
        status: 'running',
        startedAt: 12,
      },
    },
  }
  expect(() => assertStoppedSessionHistory(history([task]), 10)).toThrow('restarted execution')
})
