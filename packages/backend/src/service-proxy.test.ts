import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'

import { HARD_BLOCK_FLOOR_MICRO_USD, TRIAL_WINDOW_MS, hashApiKey } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  issueKey,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-service-proxy-internal-key'

let convex: ConvexDevFixture
let sequence = 0

describe('service proxy policy and ledger', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
        DUET_SERVICE_PROXY_WORKSPACE_RATE_LIMIT: '2',
        DUET_SERVICE_PROXY_WORKSPACE_PAID_RATE_LIMIT: '3',
        DUET_SERVICE_PROXY_WORKSPACE_RATE_LIMIT_WINDOW_MS: '1000',
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('service vault API adapter is public but still requires the internal key', async () => {
    expect(
      await query(convex, 'domains/serviceVault/api:getServiceCredential', {
        internalKey: INTERNAL_KEY,
        serviceId: 'missing-service',
        name: 'apiKey',
      }),
    ).toBeNull()
    await expect(
      query(convex, 'domains/serviceVault/api:getServiceCredential', {
        internalKey: 'wrong-key',
        serviceId: 'missing-service',
        name: 'apiKey',
      }),
    ).rejects.toThrow()
  }, 60_000)

  test('concurrent service charges all commit exactly once', async () => {
    const fixture = await workspaceFixture('concurrent-charge', true)
    const before = await balance(fixture.workspaceId)
    const charge = makeFunctionReference<'mutation'>('domains/serviceProxy/model:chargeServiceCall')
    const now = Date.now()
    const outcomes = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        convex.client.mutation(
          charge,
          {
            internalKey: INTERNAL_KEY,
            workspaceId: fixture.workspaceId,
            userId: fixture.user.user._id,
            amountMicroUsd: 100,
            reference: `service:concurrent:${index}:final`,
            metadata: { service: 'firecrawl', path: '/v2/crawl', method: 'POST' },
            now,
          },
          { skipQueue: true },
        ),
      ),
    )
    expect(outcomes.filter(result => result.status === 'rejected')).toEqual([])
    await waitForBalance(fixture.workspaceId, before - 3_200)
  }, 60_000)

  test('model and service settlements share one account writer', async () => {
    const fixture = await workspaceFixture('mixed-charge', true)
    const generationIds: string[] = []
    for (let index = 0; index < 16; index += 1) {
      const result = (await mutate(convex, 'testing/modelGateway:createPendingGeneration', {
        internalKey: INTERNAL_KEY,
        workspaceId: fixture.workspaceId,
        userId: fixture.user.user._id,
        modality: 'text',
        model: 'test-mixed',
        billingMode: 'post_response',
        chargeToWorkspace: true,
      })) as { generationId: string }
      await mutate(convex, 'domains/modelGateway/model:recordUpstreamGenerationId', {
        internalKey: INTERNAL_KEY,
        generationId: result.generationId,
        upstreamGenerationId: `mixed-${result.generationId}`,
      })
      generationIds.push(result.generationId)
    }
    const before = await balance(fixture.workspaceId)
    const now = Date.now()
    const outcomes = await Promise.allSettled([
      ...generationIds.map(generationId =>
        convex.client.mutation(
          makeFunctionReference<'mutation'>('domains/modelGateway/model:settleGeneration'),
          { internalKey: INTERNAL_KEY, generationId, upstreamCostMicroUsd: 100, now },
          { skipQueue: true },
        ),
      ),
      ...Array.from({ length: 16 }, (_, index) =>
        convex.client.mutation(
          makeFunctionReference<'mutation'>('domains/serviceProxy/model:chargeServiceCall'),
          {
            internalKey: INTERNAL_KEY,
            workspaceId: fixture.workspaceId,
            userId: fixture.user.user._id,
            amountMicroUsd: 100,
            reference: `service:mixed:${index}:final`,
            metadata: { service: 'firecrawl', path: '/v2/crawl', method: 'POST' },
            now,
          },
          { skipQueue: true },
        ),
      ),
    ])
    expect(outcomes.filter(result => result.status === 'rejected')).toEqual([])
    await waitForBalance(fixture.workspaceId, before - 3_200)
  }, 60_000)

  test('billing bursts preserve preflights, runner events and file activity', async () => {
    const fixture = await workspaceFixture('activity-under-billing', true)
    const issued = await issueKey(fixture.user.client)
    const hashedKey = await hashApiKey(issued.key)
    const session = (await mutate(convex, 'testing/agentSessions:createQueuedSessionForTest', {
      internalKey: INTERNAL_KEY,
      actorId: fixture.user.user._id,
      workspaceId: fixture.workspaceId,
      prompt: 'Concurrency fixture',
    })) as { sessionId: string }
    const start = await balance(fixture.workspaceId)
    const now = Date.now()
    const chargeWork = Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        concurrentMutation('domains/serviceProxy/model:chargeServiceCall', {
          workspaceId: fixture.workspaceId,
          userId: fixture.user.user._id,
          amountMicroUsd: 100,
          reference: `service:activity:${index}:final`,
          metadata: { service: 'firecrawl', path: '/v2/crawl', method: 'POST' },
          now,
        }),
      ),
    )
    for (let index = 0; index < 8; index += 1) {
      const at = now + index * 1_001
      const results = await Promise.all([
        concurrentMutation('domains/serviceProxy/model:proxyPreflight', {
          workspaceId: fixture.workspaceId,
          auth: { userId: fixture.user.user._id },
          service: 'firecrawl',
          metered: true,
          now: at,
        }),
        concurrentMutation(
          'testing/modelGateway:gatewayPreflightWithFixtureCatalog',
          {
            preflight: {
              internalKey: INTERNAL_KEY,
              hashedKey,
              workspaceSlug: fixture.workspaceSlug,
              requestKind: 'generation',
              modality: 'text',
              model: 'fixture-mixed',
              now: at,
            },
            fixturePolicy: 'standard',
          },
          false,
        ),
        concurrentMutation('domains/agentSessions/model:relayRunnerEvent', {
          workspaceId: fixture.workspaceId,
          sessionId: session.sessionId,
          relayId: `mixed-relay-${index}`,
          event: {
            type: 'step',
            step: {
              type: 'tool_call_start',
              toolName: 'read_file',
              toolCallId: `mixed-tool-${index}`,
              input: { path: `notes/${index}.md` },
            },
          },
          now: at,
        }),
        concurrentMutation('domains/fileActivity/api:recordBatchFromApi', {
          workspaceId: fixture.workspaceId,
          now: at,
          batch: {
            batchId: `mixed-file-${index}`,
            droppedReads: 0,
            overflow: 0,
            events: [{ kind: 'write', path: `notes/${index}.md`, actor: 'terminal', at }],
          },
        }),
      ])
      expect(results[0]).toMatchObject({ proceed: true })
      expect(results[1]).toMatchObject({ proceed: true })
      expect(results[2]).toMatchObject({ accepted: true })
      expect(results[3]).toMatchObject({ appended: 1 })
    }
    expect((await chargeWork).filter(result => result.status === 'rejected')).toEqual([])
    await waitForBalance(fixture.workspaceId, start - 3_200)
    const files = (await query(convex, 'testing/fileActivity:rawFileEventsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: fixture.workspaceId,
    })) as Array<{ path: string }>
    expect(files.map(row => row.path).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `notes/${index}.md`),
    )
    const events = (await query(convex, 'domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: fixture.workspaceId,
      sessionId: session.sessionId,
    })) as Array<{ event: { type: string; step?: { toolCallId?: string } } }>
    expect(
      events.flatMap(row => (row.event.step?.toolCallId ? [row.event.step.toolCallId] : [])),
    ).toEqual(Array.from({ length: 8 }, (_, index) => `mixed-tool-${index}`))
  }, 60_000)

  test('accepted charges survive a paused worker and duplicate delivery across sibling workspaces', async () => {
    const fixture = await workspaceFixture('resume-billing', true)
    const siblingId = await createWorkspaceFor(fixture.user.client, 'resume-sibling')
    const before = await balance(fixture.workspaceId)
    const now = Date.now()
    const chargeArgs = {
      workspaceId: fixture.workspaceId,
      userId: fixture.user.user._id,
      amountMicroUsd: 100,
      metadata: { service: 'firecrawl', path: '/v2/crawl', method: 'POST' },
      now,
    }
    await concurrentMutation('domains/serviceProxy/model:chargeServiceCall', {
      ...chargeArgs,
      reference: 'service:warm-worker:final',
    })
    await waitForBalance(fixture.workspaceId, before - 100)
    await mutate(convex, 'testing/credits:setBillingWorkerStoppedForTest', {
      internalKey: INTERNAL_KEY,
      userId: fixture.user.user._id,
      stopped: true,
    })
    const references = [...Array.from({ length: 32 }, (_, index) => index), 0]
    await Promise.all(
      references.map(index =>
        concurrentMutation('domains/serviceProxy/model:chargeServiceCall', {
          ...chargeArgs,
          workspaceId: index % 2 === 0 ? fixture.workspaceId : siblingId,
          reference: `service:resume:${index}:final`,
        }),
      ),
    )
    expect(await balance(fixture.workspaceId)).toBe(before - 100)
    const pending = (await query(convex, 'testing/credits:pendingSettlementsForTest', {
      internalKey: INTERNAL_KEY,
      userId: fixture.user.user._id,
    })) as Array<{ operation: { reference: string } }>
    expect(pending.map(row => row.operation.reference).sort()).toEqual(
      references.map(index => `service:resume:${index}:final`).sort(),
    )

    const independent = await workspaceFixture('independent-billing', true)
    const independentBefore = await balance(independent.workspaceId)
    await concurrentMutation('domains/serviceProxy/model:chargeServiceCall', {
      ...chargeArgs,
      workspaceId: independent.workspaceId,
      userId: independent.user.user._id,
      reference: 'service:independent:final',
    })
    await waitForBalance(independent.workspaceId, independentBefore - 100)
    expect(await balance(fixture.workspaceId)).toBe(before - 100)

    await mutate(convex, 'testing/credits:setBillingWorkerStoppedForTest', {
      internalKey: INTERNAL_KEY,
      userId: fixture.user.user._id,
      stopped: false,
    })
    await waitForBalance(fixture.workspaceId, before - 3_300)
    const all = [
      ...(await transactions(fixture.workspaceId)),
      ...(await transactions(siblingId)),
    ].filter(row => row.reference.startsWith('service:resume:'))
    expect(
      all
        .map(row => ({ reference: row.reference, amount: row.amountMicroUsd }))
        .sort((a, b) => a.reference.localeCompare(b.reference)),
    ).toEqual(
      Array.from({ length: 32 }, (_, index) => ({
        reference: `service:resume:${index}:final`,
        amount: -100,
      })).sort((a, b) => a.reference.localeCompare(b.reference)),
    )
  }, 60_000)

  test('preflight is internal-only and orders servicing before entitlement before rate before credit', async () => {
    const fixture = await workspaceFixture('ordering')
    // The logical clock must track real time: the subscription-expiry cron in
    // the local deployment compares period ends against real now, so an
    // epoch-based fixture window expires mid-suite.
    const t0 = Date.now()
    await expect(
      mutate(convex, 'domains/serviceProxy/model:proxyPreflight', {
        internalKey: 'wrong',
        auth: { userId: fixture.user.user._id },
        workspaceId: fixture.workspaceId,
        service: 'firecrawl',
        metered: true,
        now: t0,
      }),
    ).rejects.toThrow('Unauthorized')

    await setServicing(fixture.workspaceId, 'paused')
    expect(await preflight(fixture, true, t0)).toMatchObject({
      proceed: false,
      block: { status: 402, body: { code: 'subscription_inactive' } },
    })
    expect(await preflight(fixture, true, t0)).toMatchObject({
      proceed: false,
      block: { status: 402, body: { code: 'subscription_inactive' } },
    })

    await setServicing(fixture.workspaceId, 'active')
    await mutate(fixture.user.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: t0,
    })
    const afterTrial = t0 + TRIAL_WINDOW_MS
    expect(await preflight(fixture, false, afterTrial)).toMatchObject({ proceed: true })
    expect(await preflight(fixture, false, afterTrial)).toMatchObject({ proceed: true })
    expect(await preflight(fixture, true, afterTrial)).toMatchObject({
      proceed: false,
      block: { status: 402, body: { code: 'subscription_required' } },
    })

    await mutate(
      fixture.user.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, now: afterTrial },
    )
    await setBalance(fixture.workspaceId, HARD_BLOCK_FLOOR_MICRO_USD)
    const activeWindow = afterTrial + 1_001
    expect(await preflight(fixture, false, activeWindow)).toMatchObject({ proceed: true })
    expect(await preflight(fixture, false, activeWindow)).toMatchObject({ proceed: true })
    expect(await preflight(fixture, false, activeWindow)).toMatchObject({ proceed: true })
    expect(await preflight(fixture, true, activeWindow)).toMatchObject({
      proceed: false,
      block: { status: 429, body: { code: 'rate_limited', retryAfterSeconds: 1 } },
    })
    expect(await preflight(fixture, true, activeWindow + 1_000)).toMatchObject({
      proceed: false,
      block: { status: 402, body: { code: 'insufficient_credits' } },
    })

    await setServicing(fixture.workspaceId, 'banned')
    expect(await preflight(fixture, false, activeWindow + 1_000)).toMatchObject({
      proceed: false,
      block: { status: 402, body: { code: 'payment_required' } },
    })
  })

  test('uses the billing user paid flag for tier limits and isolates workspace windows', async () => {
    const free = await workspaceFixture('free')
    const paid = await workspaceFixture('paid', true)
    // A second workspace can only exist under a paid billing user, so window
    // isolation across sibling workspaces is exercised on the paid tier.
    const isolated = await createWorkspaceFor(paid.user.client, 'isolated')

    // Free tier: the billing user's unpaid flag caps the window at 2.
    for (let count = 0; count < 2; count += 1) {
      expect(await preflight(free, false, 10_000)).toMatchObject({ proceed: true })
    }
    expect(await preflight(free, false, 10_000)).toMatchObject({
      proceed: false,
      block: { body: { code: 'rate_limited' } },
    })

    // Paid tier: window of 3, and exhausting the primary workspace does not
    // touch a sibling workspace's independent window.
    for (let count = 0; count < 3; count += 1) {
      expect(await preflight(paid, false, 10_000)).toMatchObject({ proceed: true })
    }
    expect(await preflight(paid, false, 10_000)).toMatchObject({
      proceed: false,
      block: { body: { code: 'rate_limited' } },
    })
    expect(
      await preflight({ user: paid.user, workspaceId: isolated }, false, 10_000),
    ).toMatchObject({ proceed: true, workspaceId: isolated })
    expect(await preflight(paid, false, 11_000)).toMatchObject({ proceed: true })
  })

  test('charges negative usage exactly once for a repeated terminal reference', async () => {
    const fixture = await workspaceFixture('charge')
    const before = await balance(fixture.workspaceId)
    const args = {
      internalKey: INTERNAL_KEY,
      workspaceId: fixture.workspaceId,
      userId: fixture.user.user._id,
      amountMicroUsd: 20_000,
      reference: 'service:firecrawl:crawl:job-1:final',
      metadata: { service: 'firecrawl', path: '/v2/crawl/job-1', method: 'GET' },
      now: 20_000,
    }
    expect(
      await mutate(convex, 'domains/serviceProxy/model:chargeServiceCall', args),
    ).toMatchObject({ accepted: true })
    expect(
      await mutate(convex, 'domains/serviceProxy/model:chargeServiceCall', args),
    ).toMatchObject({ accepted: true })
    await waitForBalance(fixture.workspaceId, before - 20_000)
    const rows = await transactions(fixture.workspaceId)
    expect(rows.filter(row => row.reference === args.reference)).toEqual([
      expect.objectContaining({
        amountMicroUsd: -20_000,
        type: 'usage',
        metadata: { context: args.metadata },
      }),
    ])
  })
})

async function workspaceFixture(prefix: string, paid = false) {
  const user = await signInWithMagicLink<UserRow>(
    convex,
    uniqueEmail(`service-${prefix}`),
    `Service ${prefix}`,
  )
  if (paid) {
    await mutate(
      user.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
        now: Date.now(),
      },
    )
  }
  const rows = (await query(user.client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: { _id: string; slug: string }
  }>
  await mutate(user.client, 'testing/workspaces:markWorkspaceOnboardedForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: rows[0]!.workspace._id,
    now: Date.now(),
  })
  return { user, workspaceId: rows[0]!.workspace._id, workspaceSlug: rows[0]!.workspace.slug }
}

async function concurrentMutation(name: string, args: Record<string, unknown>, includeKey = true) {
  return await convex.client.mutation(
    makeFunctionReference<'mutation'>(name),
    {
      ...(includeKey ? { internalKey: INTERNAL_KEY } : {}),
      ...args,
    },
    { skipQueue: true },
  )
}

async function createWorkspaceFor(client: ConvexHttpClient, prefix: string): Promise<string> {
  sequence += 1
  return (await mutate(client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `${prefix}-${Date.now()}-${sequence}`,
    name: prefix,
  })) as string
}

async function preflight(
  fixture: { user: SignedInUser; workspaceId: string },
  metered: boolean,
  now: number,
) {
  return await mutate(convex, 'domains/serviceProxy/model:proxyPreflight', {
    internalKey: INTERNAL_KEY,
    auth: { userId: fixture.user.user._id },
    workspaceId: fixture.workspaceId,
    service: 'firecrawl',
    metered,
    now,
  })
}

async function setServicing(
  workspaceId: string,
  servicingStatus: 'active' | 'paused' | 'banned',
): Promise<void> {
  await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: Date.now(),
    servicingStatus,
  })
}

async function balance(workspaceId: string): Promise<number> {
  const result = (await query(convex, 'testing/credits:walletForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as { balanceMicroUsd: number }
  return result.balanceMicroUsd
}

async function waitForBalance(workspaceId: string, expected: number): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((await balance(workspaceId)) === expected) return
    await Bun.sleep(100)
  }
  expect(await balance(workspaceId)).toBe(expected)
}

async function setBalance(workspaceId: string, targetMicroUsd: number): Promise<void> {
  const current = await balance(workspaceId)
  await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    amountMicroUsd: targetMicroUsd - current,
    type: 'adjustment',
    reference: `adjustment:service-proxy:${crypto.randomUUID()}`,
  })
}

async function transactions(workspaceId: string) {
  return (await query(convex, 'testing/credits:listWorkspaceTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<{
    reference: string
    amountMicroUsd: number
    type: string
    metadata?: unknown
  }>
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

interface UserRow {
  _id: string
}
