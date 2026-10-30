import assert from 'node:assert/strict'
import path from 'node:path'

import { ConvexHttpClient } from 'convex/browser'

import { hashApiKey } from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts'
import { fnMutation, fnQuery } from './staging-live-env'
import { recordWorkspaceCleanup, StagingResourceLedger } from './staging-live-resource-ledger'
import { readWorkspaceJourneyEnv } from './staging-live-workspace-env'

export async function runBillingContentionJourney(
  options: { onProgress?: (stage: string) => void } = {},
) {
  const env = readWorkspaceJourneyEnv()
  assert(
    !process.env.CONVEX_DEPLOYMENT?.startsWith('prod:'),
    'Billing contention journey requires staging',
  )
  const runId = `staging-e2e-billing-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`
  const token = `duet_sk_${crypto.randomUUID()}`
  const hashedKey = await hashApiKey(token)
  const artifactDirectory = path.join(env.artifactRoot, runId)
  const artifacts = new StagingArtifactCollector(artifactDirectory, [env.internalKey, token])
  const ledger = new StagingResourceLedger(runId)
  const convex = new ConvexHttpClient(env.convexUrl)
  const progress = (stage: string) => options.onProgress?.(stage)
  const mutation = (name: string, args: Record<string, unknown>) =>
    convex.mutation(
      fnMutation(name),
      { internalKey: env.internalKey, ...args },
      { skipQueue: true },
    )
  const query = (name: string, args: Record<string, unknown>) =>
    convex.query(fnQuery(name), { internalKey: env.internalKey, ...args })
  let evidence
  let workspaceId: string | undefined
  let userId: string | undefined
  let outstanding: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([])
  try {
    progress('creating isolated accounting fixture')
    const fixture = (await mutation('testing/billingContention:createFixture', {
      runId,
      hashedKey,
    })) as {
      userId: string
      workspaceId: string
      workspaceSlug: string
      email: string
    }
    workspaceId = fixture.workspaceId
    userId = fixture.userId
    ledger.record({
      kind: 'user',
      id: fixture.userId,
      label: `${runId}:owner`,
      cleanupPriority: -100,
      cleanup: () =>
        mutation('testing/stagingE2e:retireUserByEmailForTest', { email: fixture.email }),
      verify: async () =>
        (await query('testing/stagingE2e:userByEmailForTest', { email: fixture.email })) === null,
    })
    recordWorkspaceCleanup({
      ledger,
      convex,
      env,
      output: { vmNames: [] },
      workspaceId: fixture.workspaceId,
      slug: fixture.workspaceSlug,
    })
    const wallet = async () =>
      (
        (await query('testing/credits:walletForTest', { workspaceId: fixture.workspaceId })) as {
          balanceMicroUsd: number
        }
      ).balanceMicroUsd
    const before = await wallet()
    const generationIds: string[] = []
    for (let index = 0; index < 16; index += 1) {
      const generation = (await mutation('testing/modelGateway:createPendingGeneration', {
        workspaceId: fixture.workspaceId,
        userId: fixture.userId,
        modality: 'text',
        model: 'fixture-contention',
        billingMode: 'post_response',
        chargeToWorkspace: true,
      })) as { generationId: string }
      await mutation('domains/modelGateway/model:recordUpstreamGenerationId', {
        generationId: generation.generationId,
        upstreamGenerationId: `${runId}:${index}`,
      })
      generationIds.push(generation.generationId)
    }
    const session = (await mutation('testing/agentSessions:createQueuedSessionForTest', {
      workspaceId: fixture.workspaceId,
      actorId: fixture.userId,
      prompt: 'Staging billing concurrency',
    })) as { sessionId: string }
    const now = Date.now()
    progress('submitting concurrent credential uses and charges')
    outstanding = Promise.allSettled([
      ...Array.from({ length: 64 }, () =>
        mutation('domains/apiKeys/api:recordCredentialUse', { hashedKey, now }),
      ),
      ...Array.from({ length: 16 }, (_, index) =>
        mutation('domains/serviceProxy/model:chargeServiceCall', {
          workspaceId: fixture.workspaceId,
          userId: fixture.userId,
          amountMicroUsd: 100,
          reference: `${runId}:service:${index}`,
          metadata: { service: 'fixture', path: '/', method: 'POST' },
          now,
        }),
      ),
      ...generationIds.map(generationId =>
        mutation('domains/modelGateway/model:settleGeneration', {
          generationId,
          upstreamCostMicroUsd: 100,
          now,
        }),
      ),
    ])
    for (let index = 0; index < 8; index += 1) {
      const responses = (await Promise.all([
        mutation('domains/serviceProxy/model:proxyPreflight', {
          workspaceId: fixture.workspaceId,
          auth: { userId: fixture.userId },
          service: 'fixture',
          metered: true,
        }),
        mutation('domains/modelGateway/model:gatewayPreflight', {
          hashedKey,
          requestKind: 'catalog',
          modality: 'text',
        }),
        mutation('domains/agentSessions/model:relayRunnerEvent', {
          workspaceId: fixture.workspaceId,
          sessionId: session.sessionId,
          relayId: `${runId}:${index}`,
          event: {
            type: 'step',
            step: {
              type: 'tool_call_start',
              toolName: 'read_file',
              toolCallId: `tool-${index}`,
              input: { path: `fixture/${index}.md` },
            },
          },
        }),
        mutation('domains/fileActivity/api:recordBatchFromApi', {
          workspaceId: fixture.workspaceId,
          batch: {
            batchId: `${runId}:files:${index}`,
            droppedReads: 0,
            overflow: 0,
            events: [
              { kind: 'write', path: `fixture/${index}.md`, actor: 'terminal', at: Date.now() },
            ],
          },
        }),
      ])) as Array<Record<string, unknown>>
      assert.equal(responses[0]?.proceed, true)
      assert.equal(responses[1]?.proceed, true)
      assert.equal(responses[2]?.accepted, true)
      assert.equal(responses[3]?.appended, 1)
    }
    const outcomes = await outstanding
    assert.deepEqual(
      outcomes.filter(result => result.status === 'rejected'),
      [],
    )
    const accepted = outcomes.map(result => {
      assert(result.status === 'fulfilled')
      return result.value as Record<string, unknown>
    })
    assert(
      accepted.every((result, index) =>
        index < 64 ? result.ok === true : result.accepted === true,
      ),
    )
    progress('verifying durable settlement')
    const deadline = Date.now() + 30_000
    while ((await wallet()) !== before - 3_200 && Date.now() < deadline) await Bun.sleep(100)
    assert.equal(await wallet(), before - 3_200)
    const transactions = (await query('testing/credits:listWorkspaceTransactionsForTest', {
      workspaceId: fixture.workspaceId,
    })) as Array<{ reference: string; amountMicroUsd: number }>
    const expectedReferences = Array.from({ length: 16 }, (_, index) => [
      `${runId}:service:${index}`,
      `ai_generation:${runId}:${index}`,
    ])
      .flat()
      .sort((a, b) => a.localeCompare(b))
    assert.deepEqual(
      transactions
        .filter(row => row.reference.includes(runId))
        .map(row => ({ reference: row.reference, amountMicroUsd: row.amountMicroUsd }))
        .sort((a, b) => a.reference.localeCompare(b.reference)),
      expectedReferences.map(reference => ({ reference, amountMicroUsd: -100 })),
    )
    evidence = { credentialUses: 64, settlements: 32, activityRounds: 8, debitedMicroUsd: 3_200 }
    await artifacts.writeJson('evidence.json', evidence)
  } finally {
    await outstanding
    if (workspaceId !== undefined && userId !== undefined) {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const pending = (await query('testing/credits:pendingSettlementsForTest', {
          userId,
        })) as unknown[]
        if (pending.length === 0) break
        await Bun.sleep(100)
      }
    }
    const cleanup = await ledger.cleanupAll()
    await artifacts.writeJson('cleanup.json', cleanup)
    assert.equal(cleanup.status, 'pass', 'Billing fixture cleanup failed')
  }
  return { journey: 'billing-contention', runId, artifactDirectory, evidence }
}
