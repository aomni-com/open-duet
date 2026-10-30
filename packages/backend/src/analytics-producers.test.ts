import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import { FILE_ACTIVITY_LIMITS } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-api-internal-key'
const T0 = 1_900_000_000_000

let convex: ConvexDevFixture
let owner: ConvexHttpClient
let ownerUserId: string
let onboardingWorkspaceId: string
let postHog: ReturnType<typeof Bun.serve>
let captured: unknown[] = []

describe('analytics producers', () => {
  beforeAll(async () => {
    postHog = Bun.serve({
      port: 0,
      async fetch(request) {
        captured.push(await request.json())
        return Response.json({ status: 'ok' })
      },
    })
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_FAKE_STRIPE: '1',
        POSTHOG_API_KEY: 'test-posthog-key',
        POSTHOG_HOST: postHog.url.href,
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    const signedIn = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      uniqueEmail('analytics-producers-owner'),
      'Analytics Producers Owner',
    )
    owner = signedIn.client
    ownerUserId = signedIn.user._id
    const workspaces = (await query(owner, 'domains/workspaces/queries:listMine', {})) as Array<{
      workspace: { _id: string }
    }>
    onboardingWorkspaceId = workspaces[0]!.workspace._id
    await verifyPaymentMethod(ownerUserId, onboardingWorkspaceId, signedIn.user.email)
    captured = []
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
    postHog?.stop(true)
  })

  test('a maximum-size attributed file batch durably records and emits every event', async () => {
    captured = []
    const workspaceId = (await mutate(owner, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: 'analytics-file-stress',
      name: 'Analytics file stress',
    })) as string

    const eventCount = FILE_ACTIVITY_LIMITS.maxEventsPerBatch
    const expectedPaths = Array.from(
      { length: eventCount },
      (_, index) => `stress-${index}/file.txt`,
    )
    const result = (await convex.mutation('domains/fileActivity/api:recordBatchFromApi', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      batch: {
        batchId: 'analytics-file-stress-batch',
        // One file per folder controls folding independently of batch size.
        events: expectedPaths.map((path, index) => ({
          kind: 'write',
          path,
          actor: `web:${ownerUserId}`,
          at: T0 + index,
        })),
        droppedReads: 0,
        overflow: 0,
      },
    })) as { appended: number; lastSeq: number }

    expect(result).toEqual(expect.objectContaining({ appended: eventCount, lastSeq: eventCount }))
    await waitForWorkspaceEventCount(workspaceId, 'file.written', eventCount)
    const stressEvents = capturedPostHogEvents('file.written', workspaceId)
    expect(stressEvents.map(event => (event.properties as { path: string }).path).sort()).toEqual(
      [...expectedPaths].sort(),
    )
    expect(
      stressEvents.find(
        event => (event.properties as { path?: unknown } | undefined)?.path === expectedPaths[0],
      ),
    ).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          path: expectedPaths[0],
          $insert_id: `file:${workspaceId}:1`,
        }),
      }),
    )
    expect(
      stressEvents.find(
        event =>
          (event.properties as { path?: unknown } | undefined)?.path === expectedPaths.at(-1),
      ),
    ).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          path: expectedPaths.at(-1),
          $insert_id: `file:${workspaceId}:${eventCount}`,
        }),
      }),
    )
  }, 60_000)

  test('file analytics preserve durable dedupe and source projections', async () => {
    const workspaceId = await createWorkspace('analytics-file-projection')
    captured = []
    const batch = {
      batchId: 'analytics-file-projection-batch',
      events: [
        {
          kind: 'create',
          entryKind: 'file',
          path: 'notes/plan.md',
          actor: `web:${ownerUserId}`,
          at: T0,
        },
        {
          kind: 'read',
          path: 'notes/plan.md',
          actor: `web:${ownerUserId}`,
          at: T0 + 1,
        },
        {
          kind: 'read',
          path: 'notes/plan.md',
          actor: `web:${ownerUserId}`,
          at: T0 + 1,
        },
        {
          kind: 'read',
          path: 'notes/plan.md',
          actor: 'mirror:missing-device',
          at: T0 + 3,
        },
        {
          kind: 'rename',
          entryKind: 'file',
          path: 'notes/final.md',
          fromPath: 'notes/plan.md',
          actor: `web:${ownerUserId}`,
          at: T0 + 4,
        },
        {
          kind: 'restore',
          actor: 'system',
          at: T0 + 5,
        },
      ],
      droppedReads: 0,
      overflow: 0,
    }

    const first = (await convex.mutation('domains/fileActivity/api:recordBatchFromApi', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      batch,
    })) as { deduped: boolean; appended: number; lastSeq: number }
    const retried = (await convex.mutation('domains/fileActivity/api:recordBatchFromApi', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      batch,
    })) as { deduped: boolean; appended: number; lastSeq: number }

    // The rename is the last attributable event in the batch; the whole batch
    // ships as one sink job, so its arrival settles the others.
    await waitForWorkspaceEventCount(workspaceId, 'file.renamed', 1)
    expect(first).toEqual({ deduped: false, appended: 4, lastSeq: 6 })
    expect(retried).toEqual({ deduped: true, appended: 0, lastSeq: 6 })
    const emitted = capturedPostHogEventsForWorkspace(workspaceId)
      .filter(payload => typeof payload.event === 'string' && payload.event.startsWith('file.'))
      .map(payload => ({
        event: payload.event,
        properties: payload.properties,
      }))
    // The `system` restore is durably recorded but never sunk: an event with no
    // person would have to invent a distinct ID, minting a throwaway PostHog
    // person per event. Its durable row is the record.
    expect(emitted).toHaveLength(3)
    expect(emitted).toEqual(
      expect.arrayContaining([
        {
          event: 'file.created',
          properties: expect.objectContaining({
            path: 'notes/plan.md',
            actorContext: `web:${ownerUserId}`,
            $insert_id: `file:${workspaceId}:1`,
          }),
        },
        {
          event: 'file.read',
          properties: expect.objectContaining({
            path: 'notes/plan.md',
            actorContext: `web:${ownerUserId}`,
            $insert_id: `file:${workspaceId}:2`,
          }),
        },
        {
          event: 'file.renamed',
          properties: expect.objectContaining({
            path: 'notes/final.md',
            fromPath: 'notes/plan.md',
            actorContext: `web:${ownerUserId}`,
            $insert_id: `file:${workspaceId}:5`,
          }),
        },
      ]),
    )
    expect(emitted.map(entry => entry.event)).not.toContain('file.restored')
  })

  test('one counted summary produces one counted analytics fact', async () => {
    const workspaceId = await createWorkspace('analytics-file-summary')
    captured = []
    await convex.mutation('domains/fileActivity/api:recordBatchFromApi', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      batch: {
        batchId: 'analytics-file-summary-batch',
        events: [
          {
            kind: 'changed-summary',
            path: 'node_modules',
            count: 4_321,
            actor: `web:${ownerUserId}`,
            at: T0,
          },
        ],
        droppedReads: 0,
        overflow: 0,
      },
    })

    await waitForWorkspaceEventCount(workspaceId, 'file.written', 1)
    expect(capturedPostHogEvents('file.written', workspaceId)).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          path: 'node_modules',
          count: 4_321,
          $insert_id: `file:${workspaceId}:1`,
        }),
      }),
    ])
  })

  test('a file batch attributed to an agent session is still attributed to its owner', async () => {
    const workspaceId = await createWorkspace('analytics-session-actor')
    captured = []
    const session = (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
      internalKey: INTERNAL_KEY,
      actorId: ownerUserId,
      workspaceId,
      prompt: 'attribute this batch',
      now: T0,
    })) as { sessionId: string }

    // relayRunnerEvent patches the agentSessions row on every non-ephemeral
    // turn event — the same document a `session:` actor batch joins to
    // attribute analytics. Firing one alongside the batch below exercises
    // that join under real concurrency; fileActivity/analytics.ts says why
    // it runs in its own transaction rather than the ingest's.
    const relay = convex.mutation('domains/agentSessions/model:relayRunnerEvent', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      sessionId: session.sessionId,
      relayId: crypto.randomUUID(),
      event: { type: 'todos', todos: [] },
    })

    const [result] = (await Promise.all([
      convex.mutation('domains/fileActivity/api:recordBatchFromApi', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        batch: {
          batchId: 'session-actor-batch',
          events: [
            {
              kind: 'write',
              path: 'agent/output.txt',
              actor: `session:${session.sessionId}`,
              at: T0,
            },
          ],
          droppedReads: 0,
          overflow: 0,
        },
      }),
      relay,
    ])) as [{ deduped: boolean; appended: number; lastSeq: number }, unknown]

    expect(result).toEqual({ deduped: false, appended: 1, lastSeq: 1 })
    await waitForWorkspaceEventCount(workspaceId, 'file.written', 1)
    const events = capturedPostHogEvents('file.written', workspaceId)
    expect(events).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          distinct_id: ownerUserId,
          path: 'agent/output.txt',
          actorContext: `session:${session.sessionId}`,
        }),
      }),
    ])
  }, 60_000)

  test('regular audit writes emit their row identity and projected properties', async () => {
    captured = []
    const workspaceId = (await mutate(owner, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: 'analytics-audit',
      name: 'Analytics audit',
    })) as string
    const auditRows = (await query(owner, 'domains/workspaces/queries:getAuditEvents', {
      workspaceId,
    })) as Array<{
      id: string
      event: string
      actorId: string
      provenance?: unknown
    }>

    await waitForCapture('workspace.created', workspaceId)
    const workspaceCreated = capturedPostHogEvent('workspace.created', workspaceId)
    const auditRow = auditRows.find(row => row.event === 'workspace.created')
    expect(auditRow).toEqual(
      expect.objectContaining({
        actorId: ownerUserId,
        provenance: { source: 'workspace_birth' },
      }),
    )
    expect(workspaceCreated).toEqual({
      api_key: 'test-posthog-key',
      event: 'workspace.created',
      timestamp: expect.any(String),
      properties: {
        source: 'workspace_birth',
        distinct_id: ownerUserId,
        $insert_id: auditRow?.id,
        event_version: 1,
        origin: 'product_backend',
        workspace_id: workspaceId,
      },
    })
  })

  test('an initial canonical user prompt emits one content-free message event', async () => {
    const workspaceId = await createWorkspace('analytics-initial-prompt')
    captured = []
    const session = (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
      internalKey: INTERNAL_KEY,
      actorId: ownerUserId,
      workspaceId,
      prompt: 'secret prompt content',
      now: T0,
    })) as { sessionId: string }

    await waitForCapture('agent_session.message_sent', workspaceId)
    const messageEvents = capturedPostHogEvents('agent_session.message_sent', workspaceId)
    expect(messageEvents).toEqual([
      {
        api_key: 'test-posthog-key',
        event: 'agent_session.message_sent',
        timestamp: new Date(T0).toISOString(),
        properties: {
          sessionId: session.sessionId,
          seq: 2,
          inputKind: 'initial',
          distinct_id: ownerUserId,
          $insert_id: `agent-session:${session.sessionId}:2`,
          event_version: 1,
          origin: 'product_backend',
          workspace_id: workspaceId,
        },
      },
    ])
    expect(JSON.stringify(messageEvents)).not.toContain('secret prompt content')
  })

  test('a deduplicated follow-up emits exactly one message event', async () => {
    const workspaceId = await createWorkspace('analytics-follow-up')
    const session = (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
      internalKey: INTERNAL_KEY,
      actorId: ownerUserId,
      workspaceId,
      prompt: 'initial prompt',
      now: T0,
    })) as { sessionId: string }
    await waitForCapture('agent_session.message_sent', workspaceId)
    captured = []
    const input = {
      kind: 'message' as const,
      prompt: 'private follow-up',
      behavior: 'steer' as const,
      sender: { kind: 'user' as const, userId: ownerUserId },
      clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b92',
    }

    for (const attemptId of ['first-follow-up', 'retried-follow-up']) {
      await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
        internalKey: INTERNAL_KEY,
        actorId: ownerUserId,
        identity: {
          principal: { kind: 'human', userId: ownerUserId },
          actorId: ownerUserId,
        },
        workspaceId,
        sessionId: session.sessionId,
        attemptId,
        input,
        now: T0 + 1,
      })
    }

    await waitForCapture('agent_session.message_sent', workspaceId)
    const messageEvents = capturedPostHogEvents('agent_session.message_sent', workspaceId)
    expect(messageEvents).toHaveLength(1)
    expect(messageEvents[0]).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          sessionId: session.sessionId,
          seq: 3,
          inputKind: 'message',
          $insert_id: `agent-session:${session.sessionId}:3`,
        }),
      }),
    )
    expect(JSON.stringify(messageEvents)).not.toContain('private follow-up')
  })

  test('onboarding completion emits only on the first transition', async () => {
    captured = []
    for (const now of [T0, T0 + 1]) {
      await convex.mutation('domains/workspaces/birth:completeWorkspaceOnboarding', {
        internalKey: INTERNAL_KEY,
        actorId: ownerUserId,
        workspaceId: onboardingWorkspaceId,
        duetName: 'My Duet',
        // Who the user hired, recorded at the moment they chose rather than
        // after the installs: an agent that fails to install was still picked,
        // and the picking is what the funnel asks about.
        selectedAgentNames: now === T0 ? ['research', 'writer'] : ['a-retry-cannot-rehire'],
        now,
      })
    }

    await waitForCapture('onboarding.completed', onboardingWorkspaceId)
    expect(capturedPostHogEvents('onboarding.completed', onboardingWorkspaceId)).toEqual([
      {
        api_key: 'test-posthog-key',
        event: 'onboarding.completed',
        timestamp: new Date(T0).toISOString(),
        properties: {
          duetName: 'My Duet',
          goal: 'none',
          selectedAgents: ['research', 'writer'],
          selectedAgentCount: 2,
          distinct_id: ownerUserId,
          $insert_id: `onboarding:${onboardingWorkspaceId}:${T0}`,
          event_version: 1,
          origin: 'product_backend',
          workspace_id: onboardingWorkspaceId,
        },
      },
    ])
    // A completion without a stated purpose leaves no purpose column behind.
    expect(
      await query(owner, 'testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: onboardingWorkspaceId,
      }),
    ).not.toMatchObject({ purpose: expect.anything() })
  })

  test('onboarding stores the stated purpose write-once and only its goal id reaches analytics', async () => {
    const signedIn = await signInWithMagicLink<{ _id: string; email: string }>(
      convex,
      uniqueEmail('analytics-producers-purpose'),
      'Analytics Producers Purpose',
    )
    const workspaces = (await query(
      signedIn.client,
      'domains/workspaces/queries:listMine',
      {},
    )) as Array<{ workspace: { _id: string } }>
    const workspaceId = workspaces[0]!.workspace._id
    await verifyPaymentMethod(signedIn.user._id, workspaceId, signedIn.user.email)
    captured = []

    const firstPurpose = 'Grow my bakery with better online marketing'
    const retriedPurpose = 'A retry must not repurpose the workspace'
    const completions = [
      { now: T0, purpose: `  ${firstPurpose}  `, goal: 'grow-business' },
      { now: T0 + 1, purpose: retriedPurpose, goal: 'launch-project' },
    ]
    for (const completion of completions) {
      await convex.mutation('domains/workspaces/birth:completeWorkspaceOnboarding', {
        internalKey: INTERNAL_KEY,
        actorId: signedIn.user._id,
        workspaceId,
        duetName: 'My Duet',
        ...completion,
      })
    }

    await waitForCapture('onboarding.completed', workspaceId)
    const events = capturedPostHogEvents('onboarding.completed', workspaceId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      properties: expect.objectContaining({ goal: 'grow-business' }),
    })
    // The purpose text itself is never an analytics property.
    expect(JSON.stringify(captured)).not.toContain(firstPurpose)
    expect(JSON.stringify(captured)).not.toContain(retriedPurpose)

    // Write-once, trimmed: the retried completion cannot overwrite it.
    expect(
      await query(owner, 'testing/workspaces:rawWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      }),
    ).toMatchObject({ purpose: firstPurpose })
  })
})

async function createWorkspace(slug: string): Promise<string> {
  return (await mutate(owner, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug,
    name: slug,
  })) as string
}

async function verifyPaymentMethod(
  actorId: string,
  workspaceId: string,
  email: string,
): Promise<void> {
  const attemptId = `analytics-onboarding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const created = (await convex.action(
    'domains/credits/billingActions:createOnboardingPaymentIntent',
    {
      internalKey: INTERNAL_KEY,
      actorId,
      workspaceId,
      attemptId,
      now: Date.now(),
    },
  )) as { paymentIntentId: string }
  await convex.action('domains/credits/billingActions:completeOnboardingPayment', {
    internalKey: INTERNAL_KEY,
    actorId,
    workspaceId,
    attemptId,
    paymentIntentId: created.paymentIntentId,
    billingDetails: {
      name: 'Analytics Producers Owner',
      email,
      address: {
        line1: '1 Test Street',
        city: 'San Francisco',
        postalCode: '94105',
        country: 'US',
      },
    },
    now: Date.now(),
  })
}

async function waitForCapture(event: string, workspaceId?: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (capturedPostHogEvent(event, workspaceId) === undefined && Date.now() < deadline) {
    await Bun.sleep(25)
  }
}

async function waitForWorkspaceEventCount(
  workspaceId: string,
  event: string,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (capturedPostHogEvents(event, workspaceId).length < count && Date.now() < deadline) {
    await Bun.sleep(25)
  }
}

function capturedPostHogEvent(
  event: string,
  workspaceId?: string,
): Record<string, unknown> | undefined {
  return captured.find(candidate => {
    if (typeof candidate !== 'object' || candidate === null) return false
    const payload = candidate as {
      event?: unknown
      properties?: { workspace_id?: unknown }
    }
    return (
      payload.event === event &&
      (workspaceId === undefined || payload.properties?.workspace_id === workspaceId)
    )
  }) as Record<string, unknown> | undefined
}

function capturedPostHogEvents(event: string, workspaceId?: string): Record<string, unknown>[] {
  return captured.filter(candidate => {
    if (typeof candidate !== 'object' || candidate === null) return false
    const payload = candidate as {
      event?: unknown
      properties?: { workspace_id?: unknown }
    }
    return (
      payload.event === event &&
      (workspaceId === undefined || payload.properties?.workspace_id === workspaceId)
    )
  }) as Record<string, unknown>[]
}

function capturedPostHogEventsForWorkspace(
  workspaceId: string,
): Array<{ event?: unknown; properties?: Record<string, unknown> }> {
  return captured.filter(
    candidate =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { properties?: { workspace_id?: unknown } }).properties?.workspace_id ===
        workspaceId,
  ) as Array<{ event?: unknown; properties?: Record<string, unknown> }>
}
