import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import {
  MAX_SLUG_LENGTH,
  type AttributionTierId,
  MODEL_TIERS,
  dollarsToMicroUsd,
  hashApiKey,
  priceTierUsageMicroUsd,
} from '@repo/contract'
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

import { AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD } from '../convex/domains/credits/subscriptions'
import { STRANDED_FORWARDING_THRESHOLD_MS } from '../convex/domains/modelGateway/settlement'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-model-gateway-internal-key'

let convex: ConvexDevFixture
let owner: SignedInUser
let sequence = 0
const workspaceForKey = new Map<string, string>()

describe('model gateway ledger reconciliation', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_MODEL_GATEWAY_WORKSPACE_CATALOG_RATE_LIMIT: '2',
        DUET_MODEL_GATEWAY_WORKSPACE_GENERATION_RATE_LIMIT: '2',
        DUET_MODEL_GATEWAY_WORKSPACE_RATE_LIMIT_WINDOW_MS: '60000',
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('modelgw-owner'),
      'Model Gateway Owner',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('one human key settles each generation in its explicitly selected workspace', async () => {
    const first = await createWorkspace('modelgw-human-first')
    const second = await createWorkspace('modelgw-human-second')
    const firstWorkspace = await workspaceById(first)
    const secondWorkspace = await workspaceById(second)
    const issued = await issueAiKey(firstWorkspace.slug)
    const firstGeneration = (await gatewayPreflight(issued.key, {
      workspaceSlug: firstWorkspace.slug,
      requestKind: 'generation',
      modality: 'text',
      model: 'test-text',
    })) as { proceed: true; generationId: string }
    expect(firstGeneration.proceed).toBe(true)
    // A changed CLI default only affects the next request; existing generations
    // retain the workspace accepted at preflight.
    workspaceForKey.set(issued.key, secondWorkspace.slug)
    const secondGeneration = (await gatewayPreflight(issued.key, {
      workspaceSlug: secondWorkspace.slug,
      requestKind: 'generation',
      modality: 'text',
      model: 'test-text',
    })) as { proceed: true; generationId: string }
    expect(secondGeneration.proceed).toBe(true)
    await recordUpstreamGenerationId(firstGeneration.generationId, 'human-first')
    await recordUpstreamGenerationId(secondGeneration.generationId, 'human-second')
    await settleGeneration(firstGeneration.generationId, 101, {})
    await settleGeneration(secondGeneration.generationId, 202, {})
    expect(await getGeneration(firstGeneration.generationId)).toMatchObject({
      workspaceId: first,
      status: 'settled',
    })
    expect(await getGeneration(secondGeneration.generationId)).toMatchObject({
      workspaceId: second,
      status: 'settled',
    })
    expect(
      (await listTransactions(first)).find(row => row.reference === 'ai_generation:human-first'),
    ).toMatchObject({ workspaceId: first, amountMicroUsd: -101 })
    expect(
      (await listTransactions(second)).find(row => row.reference === 'ai_generation:human-second'),
    ).toMatchObject({ workspaceId: second, amountMicroUsd: -202 })
  }, 60_000)

  test('accepted costs survive late timeout and failure reports while the worker is stopped', async () => {
    const workspaceId = await createWorkspace('modelgw-accepted-cost')
    const warm = await createPendingGeneration(workspaceId, 'text', 'post_response')
    await recordUpstreamGenerationId(warm, 'accepted-cost-warm')
    await settleGeneration(warm, 1, {})
    const before = await balance(workspaceId)
    await mutate(convex, 'testing/credits:setBillingWorkerStoppedForTest', {
      internalKey: INTERNAL_KEY,
      userId: owner.user._id,
      stopped: true,
    })
    const generationId = await createPendingGeneration(workspaceId, 'text', 'post_response')
    await recordUpstreamGenerationId(generationId, 'accepted-cost-late-timeout')
    await mutate(convex, 'domains/modelGateway/model:settleGeneration', {
      internalKey: INTERNAL_KEY,
      generationId,
      upstreamCostMicroUsd: 100,
    })
    try {
      expect(
        await mutate(convex, 'domains/modelGateway/model:releaseGeneration', {
          internalKey: INTERNAL_KEY,
          generationId,
          reason: 'reconcile_timeout',
        }),
      ).toMatchObject({ released: false })
      await mutate(convex, 'domains/modelGateway/model:recordUpstreamFailure', {
        internalKey: INTERNAL_KEY,
        generationId,
        error: 'late-failure',
      })
      expect(await getGeneration(generationId)).toMatchObject({ status: 'reconciling' })
    } finally {
      await mutate(convex, 'testing/credits:setBillingWorkerStoppedForTest', {
        internalKey: INTERNAL_KEY,
        userId: owner.user._id,
        stopped: false,
      })
    }
    await waitForGenerationSettlement(generationId)
    expect(await getGeneration(generationId)).toMatchObject({
      status: 'settled',
      billedCostMicroUsd: 100,
    })
    expect(await balance(workspaceId)).toBe(before - 100)
  })

  test('late terminal reports cannot replace an already committed settlement', async () => {
    const workspaceId = await createWorkspace('modelgw-late-release')
    const start = await balance(workspaceId)
    const generationId = await createPendingGeneration(workspaceId, 'text', 'post_response')
    await recordUpstreamGenerationId(generationId, 'late-release')
    await settleGeneration(generationId, 100, {})
    expect(
      await mutate(convex, 'domains/modelGateway/model:releaseGeneration', {
        internalKey: INTERNAL_KEY,
        generationId,
        reason: 'late-upstream-failure',
      }),
    ).toMatchObject({ released: false })
    expect(await getGeneration(generationId)).toMatchObject({
      status: 'settled',
      billedCostMicroUsd: 100,
    })
    await mutate(convex, 'domains/modelGateway/model:recordUpstreamFailure', {
      internalKey: INTERNAL_KEY,
      generationId,
      error: 'late-stream-failure',
    })
    expect(await getGeneration(generationId)).toMatchObject({
      status: 'settled',
      billedCostMicroUsd: 100,
    })
    expect(await balance(workspaceId)).toBe(start - 100)
  })

  test('tier-less legacy generation settles once from upstream cost', async () => {
    const workspaceId = await createWorkspace('modelgw-text')
    const start = await balance(workspaceId)
    const generationId = await createPendingGeneration(workspaceId, 'text', 'post_response')
    await recordUpstreamGenerationId(generationId, 'upstream_text_1')

    const settled = await settleGeneration(generationId, dollarsToMicroUsd(0.42), {
      provider: 'fake',
    })

    expect(settled).toEqual({ accepted: true })
    expect(await balance(workspaceId)).toBe(start - dollarsToMicroUsd(0.42))
    const generation = await getGeneration(generationId)
    expect(generation).toMatchObject({
      status: 'settled',
      upstreamGenerationId: 'upstream_text_1',
      billedCostMicroUsd: dollarsToMicroUsd(0.42),
      upstreamCostMicroUsd: dollarsToMicroUsd(0.42),
      userId: owner.user._id,
    })
    const usage = (await listTransactions(workspaceId)).find(
      row => row.reference === 'ai_generation:upstream_text_1',
    )
    expect(usage).toMatchObject({
      amountMicroUsd: -dollarsToMicroUsd(0.42),
      type: 'usage',
      userId: owner.user._id,
      metadata: {
        context: {
          upstreamGenerationId: 'upstream_text_1',
          generationId,
          modality: 'text',
        },
      },
    })
  })

  test('tiered generations debit exact tier rates instead of their upstream cost', async () => {
    const cases = ['frontier', 'balanced'] as const

    for (const tier of cases) {
      const billedCostMicroUsd = priceTierUsageMicroUsd(tier, {
        uncachedInputTokens: 1_000,
        cachedInputTokens: 2_000,
        outputTokens: 300,
      })
      const workspaceId = await createWorkspace(`modelgw-${tier}-settlement`)
      const generationId = await createPendingGeneration(
        workspaceId,
        'text',
        'post_response',
        undefined,
        tier,
      )
      const upstreamGenerationId = `upstream_${tier}_rate`
      await recordUpstreamGenerationId(generationId, upstreamGenerationId)

      const settlementArgs = {
        internalKey: INTERNAL_KEY,
        generationId,
        upstreamCostMicroUsd: 91_337,
        upstreamMetadata: {
          provider: 'fixture-provider',
          usage: {
            uncachedInputTokens: 1_000,
            cachedInputTokens: 2_000,
            outputTokens: 300,
          },
        },
      }
      const first = (await mutate(
        convex,
        'domains/modelGateway/model:settleGeneration',
        settlementArgs,
      )) as { accepted: true }
      const duplicate = (await mutate(
        convex,
        'domains/modelGateway/model:settleGeneration',
        settlementArgs,
      )) as { accepted: true }

      expect(first).toEqual({ accepted: true })
      expect(duplicate).toEqual({ accepted: true })
      await waitForGenerationSettlement(generationId)

      const generation = await getGeneration(generationId)
      expect(generation).toMatchObject({
        status: 'settled',
        tier,
        billedCostMicroUsd,
        upstreamCostMicroUsd: 91_337,
      })
      const usages = (await listTransactions(workspaceId)).filter(
        row => row.reference === `ai_generation:${upstreamGenerationId}`,
      )
      expect(usages).toHaveLength(1)
      const usage = usages[0]
      expect(usage).toMatchObject({
        amountMicroUsd: -billedCostMicroUsd,
        metadata: {
          tier,
          context: {
            model: MODEL_TIERS[tier].closure[0],
            upstreamCostMicroUsd: 91_337,
            provider: 'fixture-provider',
          },
        },
      })
      const memberLedger = (await query(owner.client, 'domains/credits/internal:workspaceLedger', {
        workspaceId,
        paginationOpts: { cursor: null, numItems: 100 },
      })) as { page: Array<Record<string, unknown>> }
      expect(memberLedger.page.find(entry => entry.id === usage?._id)).toEqual({
        id: usage?._id,
        amountMicroUsd: -billedCostMicroUsd,
        type: 'usage',
        actorUserId: owner.user._id,
        tier,
        createdAt: usage?.createdAt,
      })
    }
  })

  test('tiered generations with missing token telemetry park and recover from a corrected report', async () => {
    const workspaceId = await createWorkspace('modelgw-missing-tier-usage')
    const start = await balance(workspaceId)
    const generationId = await createPendingGeneration(
      workspaceId,
      'text',
      'post_response',
      undefined,
      'balanced',
    )
    await recordUpstreamGenerationId(generationId, 'upstream_missing_tier_usage')

    const result = await settleGeneration(generationId, 44_000, {
      provider: 'fixture-provider',
    })

    expect(result).toEqual({ accepted: true })
    expect(await balance(workspaceId)).toBe(start)
    const generation = await getGeneration(generationId)
    expect(generation).toMatchObject({
      status: 'charge_failed',
      upstreamCostMicroUsd: 44_000,
      error: 'tiered generation is missing token telemetry',
    })
    expect('billedCostMicroUsd' in generation).toBe(false)
    expect(
      (await listTransactions(workspaceId)).some(
        row => row.reference === 'ai_generation:upstream_missing_tier_usage',
      ),
    ).toBe(false)
    await mutate(convex, 'domains/modelGateway/model:sweepMissedCharges', {
      internalKey: INTERNAL_KEY,
    })
    expect(await getGeneration(generationId)).toMatchObject({ status: 'charge_failed' })
    const usage = { uncachedInputTokens: 1_000, cachedInputTokens: 0, outputTokens: 50 }
    await settleGeneration(generationId, 44_000, { provider: 'fixture-provider', usage })
    const billedCostMicroUsd = priceTierUsageMicroUsd('balanced', usage)
    expect(await getGeneration(generationId)).toMatchObject({
      status: 'settled',
      billedCostMicroUsd,
    })
    expect(await balance(workspaceId)).toBe(start - billedCostMicroUsd)
  })

  test('a cache-heavy generation bills its disjoint input, cached and output legs', async () => {
    // Shaped like the live capture (PROBE.md probe (a)): prompt and cache
    // counts are disjoint, so a cache-read turn has a large cached leg and a
    // tiny uncached one, and cache writes join the uncached leg.
    const workspaceId = await createWorkspace('modelgw-cache-heavy-tier-usage')
    const start = await balance(workspaceId)
    const generationId = await createPendingGeneration(
      workspaceId,
      'text',
      'post_response',
      undefined,
      'balanced',
    )
    await recordUpstreamGenerationId(generationId, 'upstream_cache_heavy_tier_usage')

    const result = await settleGeneration(generationId, 2_439, {
      provider: 'fixture-provider',
      usage: { uncachedInputTokens: 2, cachedInputTokens: 11_974, outputTokens: 4 },
      cacheCreationInputTokens: 0,
    })

    const billedCostMicroUsd = priceTierUsageMicroUsd('balanced', {
      uncachedInputTokens: 2,
      cachedInputTokens: 11_974,
      outputTokens: 4,
    })
    expect(result).toEqual({ accepted: true })
    expect(await getGeneration(generationId)).toMatchObject({
      status: 'settled',
      upstreamCostMicroUsd: 2_439,
      billedCostMicroUsd,
    })
    expect(await balance(workspaceId)).toBe(start - billedCostMicroUsd)
  })

  // OPEN PRICING QUESTION, deliberately pinned rather than silently assumed:
  // positive upstream cost with all-zero token counts is INCOHERENT telemetry —
  // a call that cost money must have spent tokens. Today it settles at a zero
  // customer charge, so we absorb the upstream cost. The alternatives are to
  // treat it like missing telemetry (which parks the generation and retries
  // forever, the failure mode fixed in the cached-token normalizer) or to fall
  // back to upstream cost (which prices outside the tier's rate card). Neither
  // is obviously right, and it is barely reachable: the normalizer only emits
  // `usage` when prompt and completion both parse, so a real completion
  // reporting 0/0/0 essentially cannot happen. Left as-is pending a pricing
  // call; this comment exists so the assertion stops reading as settled fact.
  test('complete zero-token telemetry settles a tiered generation at zero', async () => {
    const workspaceId = await createWorkspace('modelgw-zero-tier-usage')
    const start = await balance(workspaceId)
    const generationId = await createPendingGeneration(
      workspaceId,
      'text',
      'post_response',
      undefined,
      'balanced',
    )
    await recordUpstreamGenerationId(generationId, 'upstream_zero_tier_usage')

    const result = await settleGeneration(generationId, 66_000, {
      usage: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    })

    expect(result).toEqual({ accepted: true })
    expect(await balance(workspaceId)).toBe(start)
    expect(await getGeneration(generationId)).toMatchObject({
      status: 'settled',
      billedCostMicroUsd: 0,
      upstreamCostMicroUsd: 66_000,
    })
    expect(
      (await listTransactions(workspaceId)).find(
        row => row.reference === 'ai_generation:upstream_zero_tier_usage',
      ),
    ).toMatchObject({ amountMicroUsd: 0, type: 'usage' })
  })

  test('member activity debits the designated payer, preserves actor attribution, and follows reassignment', async () => {
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('modelgw-billing-member'),
      'Billing Member',
    )
    // The reassignment below makes this member fund a second drive, which a
    // Starter payer may not do.
    await mutate(
      member.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY, plan: 'pro' },
    )
    const workspaceId = await createWorkspace('modelgw-designated-payer')
    const workspace = await workspaceById(workspaceId)
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: member.user._id,
      role: 'editor',
    })
    const issued = await issueAiKey(workspace.slug, member.client)
    const ownerStart = await userBalance(owner.client)
    const memberStart = await userBalance(member.client)

    const first = (await gatewayPreflight(issued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: 'test-designated-payer',
      billingMode: 'post_response',
      estimateMicroUsd: dollarsToMicroUsd(0.1),
    })) as { proceed: true; generationId: string }
    await recordUpstreamGenerationId(first.generationId, `payer-a-${workspaceId}`)
    await settleGeneration(first.generationId, dollarsToMicroUsd(0.4), {})

    expect(await userBalance(owner.client)).toBe(ownerStart - dollarsToMicroUsd(0.4))
    expect(await userBalance(member.client)).toBe(memberStart)
    expect(
      (await listTransactions(workspaceId)).find(
        row => row.reference === `ai_generation:payer-a-${workspaceId}`,
      ),
    ).toMatchObject({ userId: owner.user._id, actorUserId: member.user._id })
    expect(await getGeneration(first.generationId)).toMatchObject({ userId: member.user._id })

    await mutate(owner.client, 'domains/workspaces/mutations:setMemberRole', {
      workspaceId,
      userId: member.user._id,
      role: 'owner',
    })
    await mutate(owner.client, 'domains/workspaces/mutations:setBillingUser', {
      workspaceId,
      newBillingUserId: member.user._id,
    })
    const second = (await gatewayPreflight(issued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: 'test-reassigned-payer',
      billingMode: 'post_response',
      estimateMicroUsd: dollarsToMicroUsd(0.1),
      now: 10_001,
    })) as { proceed: true; generationId: string }
    await recordUpstreamGenerationId(second.generationId, `payer-b-${workspaceId}`)
    await settleGeneration(second.generationId, dollarsToMicroUsd(0.3), {})

    expect(await userBalance(owner.client)).toBe(ownerStart - dollarsToMicroUsd(0.4))
    expect(await userBalance(member.client)).toBe(memberStart - dollarsToMicroUsd(0.3))
    expect(
      (await listTransactions(workspaceId)).find(
        row => row.reference === `ai_generation:payer-b-${workspaceId}`,
      ),
    ).toMatchObject({ userId: member.user._id, actorUserId: member.user._id })
    expect(await getGeneration(second.generationId)).toMatchObject({ userId: member.user._id })
  })

  test('gateway preflight blocks an empty workspace with the 402 gateway envelope', async () => {
    const workspaceId = await createWorkspace('modelgw-preflight-empty')
    const workspace = await workspaceById(workspaceId)
    await drainWorkspace(workspaceId)
    const issued = await issueAiKey(workspace.slug)

    const preflight = await gatewayPreflight(issued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: 'test-text',
      billingMode: 'post_response',
      estimateMicroUsd: dollarsToMicroUsd(0.01),
    })

    expect(preflight).toEqual({
      proceed: false,
      block: {
        status: 402,
        body: {
          error: 'insufficient_credits',
          code: 'insufficient_credits',
          tier: 'account',
          balanceMicroUsd: 0,
          autoTopupScheduled: false,
          billingUrl: 'http://localhost:3000/settings/billing',
        },
      },
    })
  })

  test('each billing mode rejects a lapsed subscription and reconciles workspace servicing', async () => {
    for (const billingMode of ['reservation', 'post_response'] as const) {
      // Each mode needs active servicing: the preceding request schedules a pause.
      const workspaceId = await createWorkspace('modelgw-sub-required')
      const workspace = await workspaceById(workspaceId)
      const issued = await issueAiKey(workspace.slug)
      await mutate(
        owner.client,
        'testing/workspaces:lapseCurrentUserSyntheticSubscriptionForTest',
        {
          internalKey: INTERNAL_KEY,
        },
      )

      expect(
        await gatewayPreflight(issued.key, {
          requestKind: 'generation',
          modality: 'text',
          model: `test-subscription-required-${billingMode}`,
          billingMode,
          estimateMicroUsd: dollarsToMicroUsd(0.01),
          now: Date.now(),
        }),
      ).toEqual({
        proceed: false,
        block: {
          status: 402,
          body: {
            error: 'subscription_required',
            code: 'subscription_required',
            billingUrl: 'http://localhost:3000/settings/billing',
          },
        },
      })

      const deadline = Date.now() + 10_000
      let reconciled = await workspaceById(workspaceId)
      while (reconciled.servicingStatus !== 'paused' && Date.now() < deadline) {
        await Bun.sleep(50)
        reconciled = await workspaceById(workspaceId)
      }
      expect(reconciled.servicingStatus).toBe('paused')
    }
  })

  test('gateway preflight servicing status blocks before credit balance checks', async () => {
    const internalAdmin = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('modelgw-admin').replace(/@[^@]+$/, '@aomni.com'),
      'Model Gateway Admin',
    )
    const pausedWorkspaceId = await createWorkspace('modelgw-paused-funded')
    const pausedWorkspace = await workspaceById(pausedWorkspaceId)
    await recordInvoicePaymentFailures(pausedWorkspaceId, AUTO_TOPUP_FAILURE_BACKOFF_THRESHOLD)
    const pausedIssued = await issueAiKey(pausedWorkspace.slug)

    const pausedPreflight = await gatewayPreflight(pausedIssued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: 'test-text',
      billingMode: 'post_response',
    })

    expect(pausedPreflight).toEqual({
      proceed: false,
      block: {
        status: 402,
        body: {
          error: 'subscription_inactive',
          code: 'subscription_inactive',
          billingUrl: 'http://localhost:3000/settings/billing',
        },
      },
    })
    await mutate(convex, 'domains/credits/internal:clearTopupError', {
      internalKey: INTERNAL_KEY,
      workspaceId: pausedWorkspaceId,
      userId: owner.user._id,
      now: Date.now(),
    })

    const activeBrokeWorkspaceId = await createWorkspace('modelgw-active-broke')
    const activeBrokeWorkspace = await workspaceById(activeBrokeWorkspaceId)
    await drainWorkspace(activeBrokeWorkspaceId)
    const activeBrokeIssued = await issueAiKey(activeBrokeWorkspace.slug)
    const activeBrokePreflight = await gatewayPreflight(activeBrokeIssued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: 'test-text',
      billingMode: 'post_response',
    })
    expect(activeBrokePreflight).toMatchObject({
      proceed: false,
      block: { status: 402, body: { error: 'insufficient_credits', code: 'insufficient_credits' } },
    })

    const bannedWorkspaceId = await createWorkspace('modelgw-banned-funded')
    const bannedWorkspace = await workspaceById(bannedWorkspaceId)
    await mutate(convex, 'domains/internalAdmin/model:mutateWorkspace', {
      internalKey: INTERNAL_KEY,
      workspaceId: bannedWorkspaceId,
      actorId: internalAdmin.user._id,
      requestId: crypto.randomUUID(),
      reason: 'terms review',
      now: Date.now(),
      operation: 'ban',
    })
    const bannedIssued = await issueAiKey(bannedWorkspace.slug)
    const bannedPreflight = await gatewayPreflight(bannedIssued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: 'test-text',
      billingMode: 'post_response',
    })
    expect(bannedPreflight).toEqual({
      proceed: false,
      block: {
        status: 402,
        body: {
          error: 'payment_required',
          code: 'payment_required',
          billingUrl: 'http://localhost:3000/settings/billing',
        },
      },
    })

    await expect(
      mutate(convex, 'domains/internalAdmin/model:mutateWorkspace', {
        internalKey: INTERNAL_KEY,
        workspaceId: bannedWorkspaceId,
        actorId: internalAdmin.user._id,
        requestId: crypto.randomUUID(),
        reason: 'manual servicing is forbidden',
        now: Date.now(),
        operation: 'servicing',
        servicingStatus: 'active',
      }),
    ).rejects.toThrow()
  })

  test('gateway preflight reports the workspace tier locally and the account tier globally', async () => {
    const workspaceAId = await createWorkspace('modelgw-two-tier-a')
    const workspaceBId = await createWorkspace('modelgw-two-tier-b')
    const workspaceA = await workspaceById(workspaceAId)
    const workspaceB = await workspaceById(workspaceBId)
    const keyA = await issueAiKey(workspaceA.slug)
    const keyB = await issueAiKey(workspaceB.slug)

    await mutate(convex, 'domains/credits/internal:setMonthlyCap', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspaceAId,
      maxMonthlySpendMicroUsd: 0,
    })
    expect(await generationPreflight(keyA.key, 10_000)).toMatchObject({
      proceed: false,
      block: { status: 402, body: { code: 'monthly_cap', tier: 'workspace' } },
    })
    expect(await generationPreflight(keyB.key, 10_000)).toMatchObject({ proceed: true })

    await mutate(convex, 'domains/credits/internal:setTopupConfig', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: workspaceAId,
      maxMonthlySpendMicroUsd: 0,
    })
    expect(await generationPreflight(keyA.key, 20_000)).toMatchObject({
      proceed: false,
      block: { status: 402, body: { code: 'monthly_cap', tier: 'account' } },
    })
    expect(await generationPreflight(keyB.key, 20_000)).toMatchObject({
      proceed: false,
      block: { status: 402, body: { code: 'monthly_cap', tier: 'account' } },
    })

    await mutate(convex, 'domains/credits/internal:setTopupConfig', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: workspaceAId,
      maxMonthlySpendMicroUsd: dollarsToMicroUsd(1_000),
    })
  })

  test('catalog preflight authenticates and checks scope without minting a generation', async () => {
    const workspaceId = await createWorkspace('modelgw-catalog')
    const workspace = await workspaceById(workspaceId)
    const issued = await issueAiKey(workspace.slug)

    const preflight = (await gatewayPreflight(issued.key, {
      requestKind: 'catalog',
      modality: 'text',
    })) as { proceed: true; generationId?: string; workspaceSlug: string; userId: string }

    expect(preflight).toMatchObject({
      proceed: true,
      workspaceSlug: workspace.slug,
      userId: owner.user._id,
    })
    expect(preflight.generationId).toBeUndefined()
    expect(await listGenerations(workspaceId)).toEqual([])
  })

  // Only a workspace that is gone for good blocks preflight. Liveness states
  // pass — `unhealthy` is stamped by the health sweep on a late heartbeat,
  // which happens precisely when the VM is busy running a turn. Seen live in
  // prod: preflight rejected that busy turn's own model calls as
  // invalid_api_key, killing the turn over a late heartbeat.
  test('gateway preflight blocks only workspaces that are gone for good', async () => {
    const workspaceId = await createWorkspace('modelgw-status-gate')
    const workspace = await workspaceById(workspaceId)
    const issued = (await mutate(convex, 'domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: 10_000,
    })) as { key: string }
    // Each probe gets its own rate-limit window; the subject is the status
    // gate, not the per-workspace catalog rate limit.
    let probeNow = 10_000
    const preflightNow = async () => {
      probeNow += 10 * 60_000
      return gatewayPreflight(issued.key, {
        requestKind: 'catalog',
        modality: 'text',
        now: probeNow,
      })
    }
    const setStatus = async (status: string) =>
      mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        status,
      })

    for (const status of ['unhealthy', 'provisioning', 'active'] as const) {
      await setStatus(status)
      expect(await preflightNow()).toMatchObject({
        proceed: true,
        workspaceSlug: workspace.slug,
      })
    }

    for (const status of ['archived', 'retired', 'deleted'] as const) {
      await setStatus(status)
      expect(await preflightNow()).toEqual({
        proceed: false,
        block: {
          status: 401,
          body: { error: 'unauthorized', code: 'invalid_api_key' },
        },
      })
    }
  })

  test('gateway preflight accepts oauth keys until their shared expiry boundary', async () => {
    const workspaceId = await createWorkspace('modelgw-oauth')
    const workspace = await workspaceById(workspaceId)
    const token = 'duet_sk_oauth_gateway_fixture'
    const expiresAt = 20_000
    await mutate(convex, 'testing/apiKeys:insertOAuthApiKeyForTest', {
      internalKey: INTERNAL_KEY,
      userId: owner.user._id,
      workspaceId,
      hashedKey: await hashApiKey(token),
      prefix: token.slice(0, 'duet_sk_'.length + 8),
      scopes: [`ws:${workspace.slug}:services`],
      audience: 'https://mcp.duet.so/',
      expiresAt,
    })

    expect(await catalogPreflight(token, expiresAt - 1)).toMatchObject({
      proceed: true,
      workspaceId,
    })
    expect(await catalogPreflight(token, expiresAt)).toEqual({
      proceed: false,
      block: {
        status: 401,
        body: { error: 'unauthorized', code: 'expired_api_key' },
      },
    })
  })

  test('uncatalogued unattributed requests use both billing branches and settle at upstream cost', async () => {
    const workspaceId = await createWorkspace('modelgw-uncatalogued')
    const workspace = await workspaceById(workspaceId)
    const issued = await issueAiKey(workspace.slug)
    const start = await balance(workspaceId)

    for (const billingMode of ['post_response', 'reservation'] as const) {
      const before = await balance(workspaceId)
      const model = `uncatalogued-${crypto.randomUUID()}`
      const preflight = (await gatewayPreflight(issued.key, {
        requestKind: 'generation',
        modality: billingMode === 'reservation' ? 'image' : 'text',
        model,
        billingMode,
        estimateMicroUsd: dollarsToMicroUsd(2),
        fixturePolicy: 'uncatalogued',
      })) as { proceed: true; generationId: string; reservationId?: string }

      expect(preflight).toMatchObject({ proceed: true })
      expect(await getGeneration(preflight.generationId)).toMatchObject({
        model,
        billingMode,
        chargeToWorkspace: true,
      })
      expect((await getGeneration(preflight.generationId)).tier).toBeUndefined()
      expect(await balance(workspaceId)).toBe(
        before - dollarsToMicroUsd(billingMode === 'reservation' ? 2 : 0),
      )
      await recordUpstreamGenerationId(preflight.generationId, `uncatalogued-${billingMode}`)
      await settleGeneration(preflight.generationId, dollarsToMicroUsd(0.3), {})
      expect(await getGeneration(preflight.generationId)).toMatchObject({
        status: 'settled',
        upstreamCostMicroUsd: dollarsToMicroUsd(0.3),
        billedCostMicroUsd: dollarsToMicroUsd(0.3),
      })
    }

    expect(await balance(workspaceId)).toBe(start - dollarsToMicroUsd(0.6))
  })

  /* A model the catalog has never heard of — say one released upstream this
     morning — still runs under a tier claim. Nothing gates it on the plan or
     the catalog; settlement bills it at its upstream cost. */
  test('a tier-attributed model missing from the catalog preflights and charges the workspace', async () => {
    const workspaceId = await createWorkspace('modelgw-uncatalogued-tier')
    const workspace = await workspaceById(workspaceId)
    const issued = await issueAiKey(workspace.slug)

    const allowed = (await gatewayPreflight(issued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: `uncatalogued-${crypto.randomUUID()}`,
      tier: 'balanced',
      billingMode: 'post_response',
      fixturePolicy: 'uncatalogued',
    })) as { proceed: true; generationId: string }

    expect(allowed).toMatchObject({ proceed: true })
    expect(await getGeneration(allowed.generationId)).toMatchObject({
      tier: 'balanced',
      chargeToWorkspace: true,
    })
  })

  test('persists an attributed tier on the generation row', async () => {
    const workspaceId = await createWorkspace('modelgw-tier-attribution')
    const workspace = await workspaceById(workspaceId)
    const issued = await issueAiKey(workspace.slug)
    const allowed = (await gatewayPreflight(issued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: `fixture-tier-${crypto.randomUUID()}`,
      tier: 'balanced',
      billingMode: 'post_response',
    })) as { proceed: true; generationId: string }

    expect(allowed).toMatchObject({ proceed: true })
    expect(await getGeneration(allowed.generationId)).toMatchObject({
      tier: 'balanced',
    })
  })

  /* No tier requires a subscription. An app spends under the `services` grant
     during onboarding, before anyone has paid, and a person on a trial picks
     any tier from the ladder. */
  test('a paid tier and the services tier preflight without a subscription, and record themselves on the generation', async () => {
    const workspaceId = await createWorkspace('modelgw-services-tier')
    const workspace = await workspaceById(workspaceId)
    const issued = await issueAiKey(workspace.slug)
    /* A trial account: never subscribed, inside its window, with credit — which
       is precisely the state a workspace is in while its agents are being
       onboarded. Spend entitlement is the gate a plain non-subscriber fails;
       putting the user in trial leaves the tier as the only thing a refusal
       below could be about. */
    await mutate(owner.client, 'testing/workspaces:activateCurrentUserTrialForTest', {
      internalKey: INTERNAL_KEY,
      now: 9_000,
    })
    await mutate(owner.client, 'testing/credits:applyAccountAdjustmentForTest', {
      internalKey: INTERNAL_KEY,
      userId: owner.user._id,
      amountMicroUsd: 5_000_000,
      reference: `services-tier-${crypto.randomUUID()}`,
      now: 9_000,
    })

    const paidTier = (await gatewayPreflight(issued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: MODEL_TIERS.frontier.closure[0]!,
      tier: 'frontier',
      billingMode: 'post_response',
    })) as { proceed: true; generationId: string }
    expect(paidTier).toMatchObject({ proceed: true })
    expect(await getGeneration(paidTier.generationId)).toMatchObject({ tier: 'frontier' })

    const allowed = (await gatewayPreflight(issued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: `fixture-services-${crypto.randomUUID()}`,
      tier: 'services',
      billingMode: 'post_response',
    })) as { proceed: true; generationId: string }

    expect(allowed).toMatchObject({ proceed: true })
    expect(await getGeneration(allowed.generationId)).toMatchObject({ tier: 'services' })
  })

  /* The whole point of the attribution: a user tier charges a flat
     cost-covering rate against its most expensive route, which would overbill a
     cheap model an app pinned deliberately. Services work bills what the model
     actually cost. */
  test('a services generation settles at the model cost, not a tier rate', async () => {
    const workspaceId = await createWorkspace('modelgw-services-settle')
    const workspace = await workspaceById(workspaceId)
    const issued = await issueAiKey(workspace.slug)

    const usage = { uncachedInputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }
    const upstreamCostMicroUsd = 1_234

    const services = (await gatewayPreflight(issued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: `fixture-services-settle-${crypto.randomUUID()}`,
      tier: 'services',
      billingMode: 'post_response',
    })) as { proceed: true; generationId: string }
    await recordUpstreamGenerationId(services.generationId, 'upstream_services_cost')
    await settleGeneration(services.generationId, upstreamCostMicroUsd, { usage })
    expect(await getGeneration(services.generationId)).toMatchObject({
      billedCostMicroUsd: upstreamCostMicroUsd,
    })

    // Identical usage under a covered user-tier model follows the public tariff.
    const balanced = (await gatewayPreflight(issued.key, {
      requestKind: 'generation',
      modality: 'text',
      model: MODEL_TIERS.balanced.closure[0]!,
      tier: 'balanced',
      billingMode: 'post_response',
    })) as { proceed: true; generationId: string }
    await recordUpstreamGenerationId(balanced.generationId, 'upstream_balanced_cost')
    await settleGeneration(balanced.generationId, upstreamCostMicroUsd, { usage })
    expect(await getGeneration(balanced.generationId)).toMatchObject({
      billedCostMicroUsd: priceTierUsageMicroUsd('balanced', usage),
    })
  })

  /* A user tier running a model its rate was never priced against bills what
     that model cost, so a cheap tier claim cannot buy an expensive model and a
     model the agent starts routing to is served before any list learns of it. */
  test.each(['balanced', 'openai-frontier'] as const)(
    '%s support generation outside its closure settles at the model cost',
    async tier => {
      const workspaceId = await createWorkspace('modelgw-out-of-tier-settle')
      const workspace = await workspaceById(workspaceId)
      const issued = await issueAiKey(workspace.slug)
      const usage = {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      }
      const upstreamCostMicroUsd = 1_234

      const outOfTier = (await gatewayPreflight(issued.key, {
        requestKind: 'generation',
        modality: 'text',
        model: `fixture-out-of-tier-${crypto.randomUUID()}`,
        tier,
        billingMode: 'post_response',
      })) as { proceed: true; generationId: string }
      await recordUpstreamGenerationId(outOfTier.generationId, 'upstream_out_of_tier_cost')
      await settleGeneration(outOfTier.generationId, upstreamCostMicroUsd, { usage })

      expect(await getGeneration(outOfTier.generationId)).toMatchObject({
        tier,
        billedCostMicroUsd: upstreamCostMicroUsd,
      })
    },
  )

  test('free-model settlement records upstream cost without ledger or usage changes', async () => {
    const workspaceId = await createWorkspace('modelgw-free')
    const workspace = await workspaceById(workspaceId)
    const issued = await issueAiKey(workspace.slug)
    const startBalance = await balance(workspaceId)
    const transactionsBefore = await listTransactions(workspaceId)
    const usageBefore = await workspaceUsageSnapshot(workspaceId)
    const preflight = (await gatewayPreflight(issued.key, {
      requestKind: 'generation',
      modality: 'image',
      model: `fixture-free-${crypto.randomUUID()}`,
      billingMode: 'reservation',
      estimateMicroUsd: dollarsToMicroUsd(2),
      fixturePolicy: 'free',
    })) as { proceed: true; generationId: string; reservationId?: string }

    expect(preflight.reservationId).toBeUndefined()
    expect(await getGeneration(preflight.generationId)).toMatchObject({
      billingMode: 'reservation',
      chargeToWorkspace: false,
    })
    expect(await balance(workspaceId)).toBe(startBalance)
    expect(await listTransactions(workspaceId)).toEqual(transactionsBefore)

    const upstreamCost = dollarsToMicroUsd(0.73)
    await recordUpstreamGenerationId(preflight.generationId, `free-${workspaceId}`)
    const first = await settleGeneration(preflight.generationId, upstreamCost, {
      provider: 'fixture',
    })
    const duplicate = await settleGeneration(preflight.generationId, upstreamCost, {
      provider: 'fixture',
    })

    expect(first).toEqual({ accepted: true })
    expect(duplicate).toEqual({ accepted: true })
    expect(await getGeneration(preflight.generationId)).toMatchObject({
      status: 'settled',
      billedCostMicroUsd: 0,
      upstreamCostMicroUsd: upstreamCost,
      upstreamMetadata: { provider: 'fixture' },
    })
    expect(await balance(workspaceId)).toBe(startBalance)
    expect(await listTransactions(workspaceId)).toEqual(transactionsBefore)
    expect(await workspaceUsageSnapshot(workspaceId)).toEqual(usageBefore)
  })

  test('app-key identity attributes every billing branch and its charged usage rollups', async () => {
    const workspaceId = await createWorkspace('modelgw-app-attribution')
    const workspace = await workspaceById(workspaceId)
    const vmKey = (await mutate(convex, 'domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: Date.now(),
    })) as { key: string; prefix: string }
    const appKey = await issueExportedAppAiKey(workspaceId, vmKey)

    const free = (await gatewayPreflight(appKey.key, {
      requestKind: 'generation',
      modality: 'text',
      model: `fixture-app-free-${crypto.randomUUID()}`,
      billingMode: 'reservation',
      estimateMicroUsd: dollarsToMicroUsd(1),
      fixturePolicy: 'free',
      now: 10_000,
    })) as { proceed: true; generationId: string }
    expect(await getGeneration(free.generationId)).toMatchObject({
      appId: appKey.appId,
      appSlug: appKey.appSlug,
      chargeToWorkspace: false,
    })

    const reservation = (await gatewayPreflight(appKey.key, {
      requestKind: 'generation',
      modality: 'image',
      model: `fixture-app-reservation-${crypto.randomUUID()}`,
      billingMode: 'reservation',
      estimateMicroUsd: dollarsToMicroUsd(1),
      now: 70_000,
    })) as { proceed: true; generationId: string }
    expect(await getGeneration(reservation.generationId)).toMatchObject({
      appId: appKey.appId,
      appSlug: appKey.appSlug,
      chargeToWorkspace: true,
    })
    await recordUpstreamGenerationId(reservation.generationId, `app-reservation-${workspaceId}`)
    await settleGeneration(reservation.generationId, dollarsToMicroUsd(0.21), {})

    const postResponse = (await gatewayPreflight(appKey.key, {
      requestKind: 'generation',
      modality: 'text',
      model: `fixture-app-post-${crypto.randomUUID()}`,
      billingMode: 'post_response',
      estimateMicroUsd: dollarsToMicroUsd(0.1),
      now: 130_000,
    })) as { proceed: true; generationId: string }
    expect(await getGeneration(postResponse.generationId)).toMatchObject({
      appId: appKey.appId,
      appSlug: appKey.appSlug,
      chargeToWorkspace: true,
    })
    await recordUpstreamGenerationId(postResponse.generationId, `app-post-${workspaceId}`)
    await settleGeneration(postResponse.generationId, dollarsToMicroUsd(0.31), {})

    const appUsage = await waitForAppUsage(workspaceId, dollarsToMicroUsd(0.52))
    expect(appUsage).not.toHaveLength(0)
    expect(
      appUsage.every(row => row.appId === appKey.appId && row.appSlug === appKey.appSlug),
    ).toBeTrue()
    expect(appUsage.reduce((sum, row) => sum + (row.spendMicroUsd as number), 0)).toBe(
      dollarsToMicroUsd(0.52),
    )

    const userKey = await issueAiKey(workspace.slug)
    const userGeneration = (await gatewayPreflight(userKey.key, {
      requestKind: 'generation',
      modality: 'text',
      model: `fixture-user-${crypto.randomUUID()}`,
      billingMode: 'post_response',
      now: 190_000,
    })) as { proceed: true; generationId: string }
    expect(await getGeneration(userGeneration.generationId)).not.toHaveProperty('appId')

    const vmGeneration = (await gatewayPreflight(vmKey.key, {
      requestKind: 'generation',
      modality: 'text',
      model: `fixture-vm-${crypto.randomUUID()}`,
      billingMode: 'post_response',
      now: 250_000,
    })) as { proceed: true; generationId: string }
    expect(vmGeneration).toMatchObject({ proceed: true })
    expect(await getGeneration(vmGeneration.generationId)).not.toHaveProperty('appId')
  }, 60_000)

  test('gateway preflight rate-limits a workspace before creating another generation', async () => {
    const workspaceId = await createWorkspace('modelgw-rate-limit')
    const workspace = await workspaceById(workspaceId)
    const issued = await issueAiKey(workspace.slug)

    expect(await generationPreflight(issued.key, 10_000)).toMatchObject({ proceed: true })
    expect(await generationPreflight(issued.key, 10_000)).toMatchObject({ proceed: true })
    const blocked = await generationPreflight(issued.key, 10_000)

    expect(blocked).toEqual({
      proceed: false,
      block: {
        status: 429,
        body: { error: 'rate_limited', code: 'rate_limited', retryAfterSeconds: 50 },
      },
    })
    expect(await listGenerations(workspaceId)).toHaveLength(2)
  })

  test('gateway preflight rate-limit windows reset on rollover', async () => {
    const workspaceId = await createWorkspace('modelgw-rate-rollover')
    const workspace = await workspaceById(workspaceId)
    const issued = await issueAiKey(workspace.slug)

    expect(await generationPreflight(issued.key, 10_000)).toMatchObject({ proceed: true })
    expect(await generationPreflight(issued.key, 10_000)).toMatchObject({ proceed: true })
    expect(await generationPreflight(issued.key, 10_000)).toMatchObject({
      proceed: false,
      block: { status: 429 },
    })
    expect(await generationPreflight(issued.key, 60_000)).toMatchObject({ proceed: true })
  })

  test('gateway preflight rate limits workspaces independently', async () => {
    const firstWorkspaceId = await createWorkspace('modelgw-rate-first')
    const secondWorkspaceId = await createWorkspace('modelgw-rate-second')
    const firstWorkspace = await workspaceById(firstWorkspaceId)
    const secondWorkspace = await workspaceById(secondWorkspaceId)
    const firstKey = await issueAiKey(firstWorkspace.slug)
    const secondKey = await issueAiKey(secondWorkspace.slug)

    expect(await generationPreflight(firstKey.key, 10_000)).toMatchObject({ proceed: true })
    expect(await generationPreflight(firstKey.key, 10_000)).toMatchObject({ proceed: true })
    expect(await generationPreflight(firstKey.key, 10_000)).toMatchObject({
      proceed: false,
      block: { status: 429 },
    })
    expect(await generationPreflight(secondKey.key, 10_000)).toMatchObject({
      proceed: true,
      workspaceSlug: secondWorkspace.slug,
    })
  })

  test('catalog and generation endpoints are counted separately', async () => {
    const workspaceId = await createWorkspace('modelgw-rate-endpoints')
    const workspace = await workspaceById(workspaceId)
    const issued = await issueAiKey(workspace.slug)

    expect(await catalogPreflight(issued.key, 10_000)).toMatchObject({ proceed: true })
    expect(await catalogPreflight(issued.key, 10_000)).toMatchObject({ proceed: true })
    expect(await catalogPreflight(issued.key, 10_000)).toMatchObject({
      proceed: false,
      block: { status: 429 },
    })
    expect(await listGenerations(workspaceId)).toEqual([])
    expect(await generationPreflight(issued.key, 10_000)).toMatchObject({ proceed: true })
    expect(await listGenerations(workspaceId)).toHaveLength(1)
  })

  test('async reconcile settlement charges exactly once when re-delivered', async () => {
    const workspaceId = await createWorkspace('modelgw-reconcile-once')
    const start = await balance(workspaceId)
    const generationId = await createPendingGeneration(workspaceId, 'text', 'post_response')
    await recordUpstreamGenerationId(generationId, 'gen_reconcile_once')

    const first = await settleGeneration(generationId, dollarsToMicroUsd(0.19), {
      provider: 'fake',
    })
    const second = await settleGeneration(generationId, dollarsToMicroUsd(0.19), {
      provider: 'fake',
    })

    expect(first).toEqual({ accepted: true })
    expect(second).toEqual({ accepted: true })
    expect(await balance(workspaceId)).toBe(start - dollarsToMicroUsd(0.19))
    const usage = (await listTransactions(workspaceId)).filter(
      row => row.reference === 'ai_generation:gen_reconcile_once',
    )
    expect(usage).toEqual([
      expect.objectContaining({
        amountMicroUsd: -dollarsToMicroUsd(0.19),
        type: 'usage',
        reference: 'ai_generation:gen_reconcile_once',
      }),
    ])
    expect(await getGeneration(generationId)).toMatchObject({
      status: 'settled',
      upstreamGenerationId: 'gen_reconcile_once',
      billedCostMicroUsd: dollarsToMicroUsd(0.19),
      upstreamCostMicroUsd: dollarsToMicroUsd(0.19),
    })
    await expectLedgerBalanceReconciles(workspaceId)
  })

  test('reconcile timeout release stays unbilled if cost arrives late', async () => {
    const workspaceId = await createWorkspace('mgw-timeout')
    const start = await balance(workspaceId)
    const generationId = await createPendingGeneration(workspaceId, 'text', 'post_response')
    await recordUpstreamGenerationId(generationId, 'gen_reconcile_timeout')

    const released = (await mutate(convex, 'domains/modelGateway/model:releaseGeneration', {
      internalKey: INTERNAL_KEY,
      generationId,
      reason: 'reconcile_timeout',
    })) as { released: boolean; balanceMicroUsd: number }
    const lateSettle = await settleGeneration(generationId, dollarsToMicroUsd(0.31), {})

    expect(released).toMatchObject({ released: true, balanceMicroUsd: start })
    expect(lateSettle).toEqual({ accepted: true })
    expect(await balance(workspaceId)).toBe(start)
    expect(await getGeneration(generationId)).toMatchObject({ status: 'released' })
    expect(
      (await listTransactions(workspaceId)).some(
        row => row.reference === 'ai_generation:gen_reconcile_timeout',
      ),
    ).toBe(false)
    await expectLedgerBalanceReconciles(workspaceId)
  })

  test('media reservation hold settles to actual cost and releases on upstream failure', async () => {
    const settledWorkspaceId = await createWorkspace('modelgw-media-settle')
    const settledStart = await balance(settledWorkspaceId)
    await reserve(settledWorkspaceId, 'media:settle')
    expect(await balance(settledWorkspaceId)).toBe(settledStart - dollarsToMicroUsd(2))
    const settledGenerationId = await createPendingGeneration(
      settledWorkspaceId,
      'image',
      'reservation',
      'media:settle',
    )
    await recordUpstreamGenerationId(settledGenerationId, 'upstream_image_1')
    await settleGeneration(settledGenerationId, dollarsToMicroUsd(0.37), { provider: 'fake' })
    expect(await balance(settledWorkspaceId)).toBe(settledStart - dollarsToMicroUsd(0.37))

    const releasedWorkspaceId = await createWorkspace('modelgw-media-release')
    const releasedStart = await balance(releasedWorkspaceId)
    await reserve(releasedWorkspaceId, 'media:release')
    const releasedGenerationId = await createPendingGeneration(
      releasedWorkspaceId,
      'video',
      'reservation',
      'media:release',
    )
    await mutate(convex, 'domains/modelGateway/model:recordUpstreamFailure', {
      internalKey: INTERNAL_KEY,
      generationId: releasedGenerationId,
      error: 'upstream_failed',
    })
    await mutate(convex, 'domains/modelGateway/model:releaseGeneration', {
      internalKey: INTERNAL_KEY,
      generationId: releasedGenerationId,
      reason: 'upstream_failed',
    })

    expect(await balance(releasedWorkspaceId)).toBe(releasedStart)
    expect(await getGeneration(releasedGenerationId)).toMatchObject({ status: 'released' })
  })

  test('gateway media reservations settle true-up in both directions', async () => {
    const refundWorkspaceId = await createWorkspace('modelgw-media-refund')
    const refundWorkspace = await workspaceById(refundWorkspaceId)
    const refundStart = await balance(refundWorkspaceId)
    const refundKey = await issueAiKey(refundWorkspace.slug)
    const refundPreflight = (await gatewayPreflight(refundKey.key, {
      requestKind: 'generation',
      modality: 'image',
      model: 'test-image',
      billingMode: 'reservation',
      estimateMicroUsd: dollarsToMicroUsd(2),
    })) as { proceed: true; generationId: string; reservationId: string }
    expect(await balance(refundWorkspaceId)).toBe(refundStart - dollarsToMicroUsd(2))
    await recordUpstreamGenerationId(refundPreflight.generationId, 'gen_media_refund')
    await settleGeneration(refundPreflight.generationId, dollarsToMicroUsd(0.25), {})
    expect(await balance(refundWorkspaceId)).toBe(refundStart - dollarsToMicroUsd(0.25))
    await expectLedgerBalanceReconciles(refundWorkspaceId)

    const extraWorkspaceId = await createWorkspace('modelgw-media-extra')
    const extraWorkspace = await workspaceById(extraWorkspaceId)
    const extraStart = await balance(extraWorkspaceId)
    const extraKey = await issueAiKey(extraWorkspace.slug)
    const extraPreflight = (await gatewayPreflight(extraKey.key, {
      requestKind: 'generation',
      modality: 'video',
      model: 'test-video',
      billingMode: 'reservation',
      estimateMicroUsd: dollarsToMicroUsd(2),
    })) as { proceed: true; generationId: string; reservationId: string }
    expect(await balance(extraWorkspaceId)).toBe(extraStart - dollarsToMicroUsd(2))
    await recordUpstreamGenerationId(extraPreflight.generationId, 'gen_media_extra')
    await settleGeneration(extraPreflight.generationId, dollarsToMicroUsd(2.75), {})
    expect(await balance(extraWorkspaceId)).toBe(extraStart - dollarsToMicroUsd(2.75))
    await expectLedgerBalanceReconciles(extraWorkspaceId)
  })

  test('missed-charge sweep releases failed media holds', async () => {
    const mediaWorkspaceId = await createWorkspace('modelgw-sweep-media')
    const mediaStart = await balance(mediaWorkspaceId)
    await reserve(mediaWorkspaceId, 'media:sweep-release')
    const mediaGenerationId = await createPendingGeneration(
      mediaWorkspaceId,
      'audio',
      'reservation',
      'media:sweep-release',
    )
    await mutate(convex, 'domains/modelGateway/model:recordUpstreamFailure', {
      internalKey: INTERNAL_KEY,
      generationId: mediaGenerationId,
      error: 'upstream_failed_after_hold',
    })
    expect(await balance(mediaWorkspaceId)).toBe(mediaStart - dollarsToMicroUsd(2))

    const swept = (await mutate(convex, 'domains/modelGateway/model:sweepMissedCharges', {
      internalKey: INTERNAL_KEY,
    })) as { settlementQueued: number; released: number; failed: number }

    // The sweep is deployment-global: sibling tests' stranded forwarding
    // strays (harness rows born at the fixed now:10_000 epoch) may release in
    // the same pass, so pin this test's own row rather than a global count.
    expect(swept.failed).toBe(0)
    expect(swept.released).toBeGreaterThanOrEqual(1)
    expect(await balance(mediaWorkspaceId)).toBe(mediaStart)
    expect(await getGeneration(mediaGenerationId)).toMatchObject({ status: 'released' })
  })

  test('settlement voids the charge when the workspace is deleted and its billing membership was purged', async () => {
    const ghostEmail = `staging-e2e-modelgw-ghost-${Date.now()}@agentmail.to`
    const ghost = await signInWithMagicLink<UserRow>(convex, ghostEmail, 'Ghost Owner')
    await mutate(
      ghost.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const workspaceId = (await mutate(ghost.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: uniqueSlug('modelgw-ghost'),
      name: 'Ghost workspace',
    })) as string
    const created = (await mutate(convex, 'testing/modelGateway:createPendingGeneration', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: ghost.user._id,
      modality: 'text',
      model: 'test-text',
      billingMode: 'post_response',
      chargeToWorkspace: true,
    })) as { generationId: string }
    await recordUpstreamGenerationId(created.generationId, 'gen_ghost_billing_purged')
    const ghostWorkspaces = (await query(
      ghost.client,
      'domains/workspaces/queries:listMine',
      {},
    )) as Array<{
      workspace: { _id: string }
    }>
    for (const row of ghostWorkspaces) {
      await mutate(convex, 'testing/workspaces:deleteWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: row.workspace._id,
      })
    }
    await mutate(convex, 'testing/stagingE2e:retireUserByEmailForTest', {
      internalKey: INTERNAL_KEY,
      email: ghostEmail,
    })

    const settled = await settleGeneration(created.generationId, dollarsToMicroUsd(0.5), {})

    expect(settled).toEqual({ accepted: true })
    expect(await getGeneration(created.generationId)).toMatchObject({
      status: 'released',
      error: 'billing_unresolvable',
    })
    expect(
      (await listTransactions(workspaceId)).some(
        row => row.reference === 'ai_generation:gen_ghost_billing_purged',
      ),
    ).toBe(false)
  })

  test('a charge-failed generation stays charge_failed through sweeps and records the workspace id in its error', async () => {
    const ghostEmail = `staging-e2e-modelgw-resghost-${Date.now()}@agentmail.to`
    const ghost = await signInWithMagicLink<UserRow>(convex, ghostEmail, 'Reservation Ghost')
    await mutate(
      ghost.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const workspaceId = (await mutate(ghost.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: uniqueSlug('modelgw-resghost'),
      name: 'Reservation ghost workspace',
    })) as string
    await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      amountMicroUsd: dollarsToMicroUsd(10),
      type: 'grant',
      reference: `grant:resghost:${workspaceId}`,
      actorId: ghost.user._id,
    })
    await mutate(convex, 'domains/credits/internal:reserveCredits', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      estimateMicroUsd: dollarsToMicroUsd(2),
      reference: 'media:ghost-hold',
      userId: ghost.user._id,
    })
    const created = (await mutate(convex, 'testing/modelGateway:createPendingGeneration', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: ghost.user._id,
      modality: 'audio',
      model: 'test-audio',
      billingMode: 'reservation',
      chargeToWorkspace: true,
      reservationId: 'media:ghost-hold',
    })) as { generationId: string }
    await recordUpstreamGenerationId(created.generationId, 'gen_ghost_reservation')
    const ghostWorkspaces = (await query(
      ghost.client,
      'domains/workspaces/queries:listMine',
      {},
    )) as Array<{
      workspace: { _id: string }
    }>
    for (const row of ghostWorkspaces) {
      await mutate(convex, 'testing/workspaces:deleteWorkspaceByIdForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: row.workspace._id,
      })
    }
    await mutate(convex, 'testing/stagingE2e:retireUserByEmailForTest', {
      internalKey: INTERNAL_KEY,
      email: ghostEmail,
    })

    await mutate(convex, 'domains/modelGateway/model:markGenerationChargeFailed', {
      internalKey: INTERNAL_KEY,
      generationId: created.generationId,
      error: 'settlement failed in reconcile',
      upstreamCostMicroUsd: dollarsToMicroUsd(1.5),
      upstreamMetadata: {},
    })

    const swept = (await mutate(convex, 'domains/modelGateway/model:sweepMissedCharges', {
      internalKey: INTERNAL_KEY,
      limit: 50,
    })) as { settlementQueued: number; released: number; failed: number }

    expect(swept.settlementQueued).toBeGreaterThanOrEqual(1)
    await waitForGenerationSettlement(created.generationId)
    const generation = await getGeneration(created.generationId)
    expect(generation).toMatchObject({ status: 'charge_failed' })
    expect(String(generation.error)).toContain(workspaceId)
  })

  test('sweep settles a charge-failed generation from its persisted cost without refetching upstream', async () => {
    const workspaceId = await createWorkspace('modelgw-chargefail-heal')
    const start = await balance(workspaceId)
    const generationId = await createPendingGeneration(workspaceId, 'text', 'post_response')
    await recordUpstreamGenerationId(generationId, 'gen_chargefail_heal')
    await mutate(convex, 'domains/modelGateway/model:markGenerationChargeFailed', {
      internalKey: INTERNAL_KEY,
      generationId,
      error: 'transient settlement failure',
      upstreamCostMicroUsd: dollarsToMicroUsd(0.6),
      upstreamMetadata: {},
    })
    expect(await getGeneration(generationId)).toMatchObject({ status: 'charge_failed' })

    const swept = (await mutate(convex, 'domains/modelGateway/model:sweepMissedCharges', {
      internalKey: INTERNAL_KEY,
      limit: 50,
    })) as { settlementQueued: number }

    expect(swept.settlementQueued).toBeGreaterThanOrEqual(1)
    await waitForGenerationSettlement(generationId)
    expect(await getGeneration(generationId)).toMatchObject({ status: 'settled' })
    expect(await balance(workspaceId)).toBe(start - dollarsToMicroUsd(0.6))
    const usage = (await listTransactions(workspaceId)).find(
      row => row.reference === 'ai_generation:gen_chargefail_heal',
    )
    expect(usage).toMatchObject({ amountMicroUsd: -dollarsToMicroUsd(0.6), type: 'usage' })
    await expectLedgerBalanceReconciles(workspaceId)
  })

  test('sweep releases a generation stranded in forwarding, and never bills it', async () => {
    // A transient failure recording the upstream generation id leaves a row in
    // 'forwarding' with no id to reconcile cost against — it cannot be billed
    // honestly. The sweep releases stale ones outright (David, 2026-07-31:
    // simplest possible, no weird states) while leaving fresh in-flight rows
    // alone.
    const workspaceId = await createWorkspace('modelgw-forwarding-stranded')
    const start = await balance(workspaceId)
    // Born beyond the canonical forwarding grace window.
    const staleId = await createPendingGeneration(
      workspaceId,
      'text',
      'post_response',
      undefined,
      undefined,
      Date.now() - STRANDED_FORWARDING_THRESHOLD_MS - 1,
    )
    const freshId = await createPendingGeneration(workspaceId, 'text', 'post_response')
    expect(await getGeneration(staleId)).toMatchObject({ status: 'forwarding' })

    const swept = (await mutate(convex, 'domains/modelGateway/model:sweepMissedCharges', {
      internalKey: INTERNAL_KEY,
      limit: 50,
    })) as { released: number }

    expect(swept.released).toBeGreaterThanOrEqual(1)
    expect(await getGeneration(staleId)).toMatchObject({
      status: 'released',
      error: 'upstream_id_never_recorded',
    })
    // The fresh in-flight row was swept in the same pass and must survive.
    expect(await getGeneration(freshId)).toMatchObject({ status: 'forwarding' })
    expect(await balance(workspaceId)).toBe(start)
  })

  test('sweep leaves a cost-less reconciling generation unbilled', async () => {
    const workspaceId = await createWorkspace('modelgw-sweep-reconcile')
    const start = await balance(workspaceId)
    const generationId = await createPendingGeneration(workspaceId, 'text', 'post_response')
    await recordUpstreamGenerationId(generationId, 'gen_sweep_waiting')

    await mutate(convex, 'domains/modelGateway/model:sweepMissedCharges', {
      internalKey: INTERNAL_KEY,
      limit: 10,
    })

    expect(await balance(workspaceId)).toBe(start)
    const generation = await getGeneration(generationId)
    expect(generation).toMatchObject({ status: 'reconciling' })
    expect('upstreamCostMicroUsd' in generation).toBe(false)
    expect('billedCostMicroUsd' in generation).toBe(false)
    expect(
      (await listTransactions(workspaceId)).some(
        row => row.reference === 'ai_generation:gen_sweep_waiting',
      ),
    ).toBe(false)
    await expectLedgerBalanceReconciles(workspaceId)
  })
})

async function createWorkspace(prefix: string): Promise<string> {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const slug = uniqueSlug(prefix)
  const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug,
    name: `${prefix} workspace`,
  })) as string
  const now = Date.now()
  const provisioningTokenHash = await hashApiKey(`provisioning-${workspaceId}`)
  await mutate(convex, 'testing/workspaces:prepareWorkspaceForRegistration', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    workspaceId,
    slug,
    name: `${prefix} workspace`,
    imageRef: 'ttl.sh/duet-model-gateway-test:1h',
    provisioningTokenHash,
    provisioningTokenExpiresAt: now + 60_000,
    now,
  })
  await mutate(convex, 'domains/workspaces/provisioning:registerVm', {
    internalKey: INTERNAL_KEY,
    provisioningTokenHash,
    workspaceHint: workspaceId,
    now: now + 1,
  })
  const currentBalance = await balance(workspaceId)
  await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    amountMicroUsd: dollarsToMicroUsd(10) - currentBalance,
    type: 'adjustment',
    reference: `balance:${workspaceId}:model-gateway-test`,
  })
  return workspaceId
}

async function createPendingGeneration(
  workspaceId: string,
  modality: 'text' | 'image' | 'video' | 'audio',
  billingMode: 'post_response' | 'reservation',
  reservationId?: string,
  tier?: 'frontier' | 'balanced',
  createdNow?: number,
): Promise<string> {
  const created = (await mutate(convex, 'testing/modelGateway:createPendingGeneration', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    userId: owner.user._id,
    modality,
    // A tiered generation names a model its tier's flat rate covers; any other
    // model bills at upstream cost.
    model: tier === undefined ? `test-${modality}` : MODEL_TIERS[tier].closure[0]!,
    ...(tier === undefined ? {} : { tier }),
    billingMode,
    chargeToWorkspace: true,
    ...(reservationId === undefined ? {} : { reservationId }),
    ...(createdNow === undefined ? {} : { now: createdNow }),
  })) as { generationId: string }
  return created.generationId
}

async function gatewayPreflight(
  key: string,
  args: {
    requestKind: 'catalog' | 'generation'
    modality: 'text' | 'image' | 'video' | 'audio'
    model?: string
    tier?: AttributionTierId
    billingMode?: 'post_response' | 'reservation'
    estimateMicroUsd?: number
    now?: number
    workspaceSlug?: string
    fixturePolicy?: 'standard' | 'free' | 'uncatalogued'
  },
): Promise<unknown> {
  const preflightArgs = {
    internalKey: INTERNAL_KEY,
    hashedKey: await hashApiKey(key),
    now: args.now ?? 10_000,
    requestKind: args.requestKind,
    modality: args.modality,
    ...((args.workspaceSlug ?? workspaceForKey.get(key))
      ? { workspaceSlug: args.workspaceSlug ?? workspaceForKey.get(key) }
      : {}),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.tier === undefined ? {} : { tier: args.tier }),
    ...(args.billingMode === undefined ? {} : { billingMode: args.billingMode }),
    ...(args.estimateMicroUsd === undefined ? {} : { estimateMicroUsd: args.estimateMicroUsd }),
  }
  if (args.requestKind === 'catalog') {
    return await mutate(convex, 'domains/modelGateway/model:gatewayPreflight', preflightArgs)
  }
  return await mutate(convex, 'testing/modelGateway:gatewayPreflightWithFixtureCatalog', {
    preflight: preflightArgs,
    fixturePolicy: args.fixturePolicy ?? 'standard',
  })
}

async function generationPreflight(key: string, now: number): Promise<unknown> {
  return await gatewayPreflight(key, {
    requestKind: 'generation',
    modality: 'text',
    model: 'test-text',
    billingMode: 'post_response',
    now,
  })
}

async function catalogPreflight(key: string, now: number): Promise<unknown> {
  return await gatewayPreflight(key, {
    requestKind: 'catalog',
    modality: 'text',
    now,
  })
}

async function recordUpstreamGenerationId(
  generationId: string,
  upstreamGenerationId: string,
): Promise<void> {
  await mutate(convex, 'domains/modelGateway/model:recordUpstreamGenerationId', {
    internalKey: INTERNAL_KEY,
    generationId,
    upstreamGenerationId,
  })
}

async function settleGeneration(
  generationId: string,
  upstreamCostMicroUsd: number,
  upstreamMetadata: Record<string, unknown>,
): Promise<{ accepted: true }> {
  const accepted = (await mutate(convex, 'domains/modelGateway/model:settleGeneration', {
    internalKey: INTERNAL_KEY,
    generationId,
    upstreamCostMicroUsd,
    upstreamMetadata,
  })) as { accepted: true }
  await waitForGenerationSettlement(generationId)
  return accepted
}

async function waitForGenerationSettlement(generationId: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const generation = await getGeneration(generationId)
    if (
      ['settled', 'released', 'upstream_failed', 'charge_failed'].includes(
        String(generation.status),
      )
    )
      return
    await Bun.sleep(100)
  }
  throw new Error(
    `Generation ${generationId} did not finish settlement: ${JSON.stringify(await getGeneration(generationId))}`,
  )
}

async function issueAiKey(
  workspaceSlug: string,
  client: ConvexHttpClient = owner.client,
): Promise<{ key: string }> {
  const actor = (await query(client, 'domains/users/queries:current', {})) as UserRow
  const issued = (await mutate(convex, 'domains/apiKeys/userApi:issue', {
    internalKey: INTERNAL_KEY,
    actorId: actor._id,
    name: 'Model test key',
    now: Date.now(),
  })) as { key: string }
  workspaceForKey.set(issued.key, workspaceSlug)
  return issued
}

async function issueExportedAppAiKey(
  workspaceId: string,
  builder: { key: string; prefix: string },
): Promise<{ key: string; appId: string; appSlug: string }> {
  const appSlug = 'billing-app'
  const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
    workspaceId,
    path: `apps/${appSlug}`,
    command: 'bun run start',
    apiScopes: ['services'],
    slug: appSlug,
    now: 1_000,
  })) as { id: string }
  const minted = (await mutate(convex, 'domains/apiKeys/appExports:exportCredential', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    appSlug,
    caller: { hashedKey: await hashApiKey(builder.key), keyPrefix: builder.prefix },
    expiration: 'never',
  })) as { key: string }
  return { key: minted.key, appId: app.id, appSlug }
}

async function waitForAppUsage(
  workspaceId: string,
  expectedSpendMicroUsd: number,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const rows = (await query(convex, 'domains/credits/internal:listUsageReport', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      period: 'monthly',
      group: 'app',
    })) as Array<Record<string, unknown>>
    const total = rows.reduce((sum, row) => sum + (row.spendMicroUsd as number), 0)
    if (total === expectedSpendMicroUsd) return rows
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return (await query(convex, 'domains/credits/internal:listUsageReport', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    period: 'monthly',
    group: 'app',
  })) as Array<Record<string, unknown>>
}

async function userBalance(client: ConvexHttpClient): Promise<number> {
  const user = (await query(client, 'domains/users/queries:current', {})) as {
    paidCreditBalanceMicroUsd: number
    monthlyCreditBalanceMicroUsd: number
  }
  return user.paidCreditBalanceMicroUsd + user.monthlyCreditBalanceMicroUsd
}

async function reserve(workspaceId: string, reference: string): Promise<void> {
  await mutate(convex, 'domains/credits/internal:reserveCredits', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    estimateMicroUsd: dollarsToMicroUsd(2),
    reference,
    userId: owner.user._id,
  })
}

async function drainWorkspace(workspaceId: string): Promise<void> {
  const current = await balance(workspaceId)
  if (current === 0) return
  await mutate(convex, 'domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    amountMicroUsd: -current,
    type: 'adjustment',
    reference: `drain:${workspaceId}:model-gateway-test`,
  })
}

async function recordInvoicePaymentFailures(workspaceId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await mutate(convex, 'domains/credits/internal:recordInvoicePaymentFailure', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: owner.user._id,
      error: {
        code: 'card_declined',
        message: 'Your payment method was declined.',
        at: Date.now() + index,
      },
    })
  }
}

async function balance(workspaceId: string): Promise<number> {
  const decision = (await query(convex, 'testing/credits:walletForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as { balanceMicroUsd: number }
  return decision.balanceMicroUsd
}

async function workspaceById(
  workspaceId: string,
): Promise<{ _id: string; slug: string; servicingStatus?: string }> {
  const rows = (await query(owner.client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: { _id: string; slug: string; servicingStatus?: string }
  }>
  const workspace = rows.find(row => row.workspace._id === workspaceId)?.workspace
  if (workspace === undefined) throw new Error(`Workspace not found in test list: ${workspaceId}`)
  return workspace
}

async function getGeneration(generationId: string): Promise<Record<string, unknown>> {
  return (await query(convex, 'domains/modelGateway/model:getGeneration', {
    internalKey: INTERNAL_KEY,
    generationId,
  })) as Record<string, unknown>
}

async function listGenerations(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'testing/modelGateway:listGenerationsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
}

async function workspaceUsageSnapshot(workspaceId: string): Promise<Record<string, unknown>> {
  return (await query(convex, 'testing/modelGateway:workspaceUsageSnapshotForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Record<string, unknown>
}

async function listTransactions(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'testing/credits:listWorkspaceTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
}

async function expectLedgerBalanceReconciles(workspaceId: string): Promise<void> {
  const transactions = (await query(convex, 'testing/credits:listAccountTransactionsForTest', {
    internalKey: INTERNAL_KEY,
    userId: owner.user._id,
  })) as Array<Record<string, unknown>>
  const ledgerSum = transactions.reduce((sum, row) => sum + (row.amountMicroUsd as number), 0)
  expect(await balance(workspaceId)).toBe(ledgerSum)
}

// The uniqueness suffix is 15+ characters, so a descriptive prefix silently
// pushed slugs past MAX_SLUG_LENGTH once the sequence reached two digits —
// which made ADDING a test fail unrelated tests. Trim the prefix to whatever
// the limit leaves rather than rationing prefix length by hand.
function uniqueSlug(prefix: string): string {
  sequence += 1
  const suffix = `-${Date.now()}-${sequence}`
  return `${prefix.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

interface UserRow {
  _id: string
  email: string
}
