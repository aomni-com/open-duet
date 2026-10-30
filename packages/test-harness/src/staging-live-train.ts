import assert from 'node:assert/strict'

import type { ConvexHttpClient } from 'convex/browser'

import {
  SessionCreateResponseSchema,
  TrainRecordListResponseSchema,
  TrainRecordResponseSchema,
  TrainStartResponseSchema,
  type Agent,
  type TrainRecordSummary,
} from '@repo/contract'

import { BUSINESS_QUESTION, SEEDED_MEMORY } from './demo-60s.ts'
import { provisionStagingAgent } from './staging-live-agent-fixture.ts'
import { deleteStagingSession } from './staging-live-agent-sessions.ts'
import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import type { LiveEnv, Workspace } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson } from './staging-live-http.ts'
import { workspaceIsDeleted, type StagingResourceLedger } from './staging-live-resource-ledger.ts'
import {
  answerReferencesSeededDiscount,
  proveStreamingAndReconnect,
  waitForTrain,
} from './staging-live-streaming.ts'

const AGENT_TRAIN_MEMORY =
  'The child agent private operating signal is violet kestrel. This document covers only internal alert naming.'

export interface TrainFilesAcceptanceEvidence {
  rootJobId: string
  agent: Agent
  rootRecord: TrainRecordSummary
}

export async function runTrainFilesAcceptance(args: {
  env: LiveEnv
  workspace: Workspace
  apiToken: string
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
}): Promise<TrainFilesAcceptanceEvidence> {
  const { env, workspace, apiToken, runId, ledger, convex, artifacts } = args
  const runSuffix = runId.slice(-8)
  const trainAgentSlug = `e2e-train-${runSuffix}`
  const trainAgentName = `E2E Train ${runId}`
  const workspaceBase = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const trainAgent = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: trainAgentSlug,
    name: trainAgentName,
    description: `Staging train acceptance agent for ${runId}.`,
    ledger,
    convex,
    artifacts,
  })

  const [rootRecordsBeforeBody, agentRecordsBeforeBody] = await Promise.all([
    apiJson(
      `${workspaceBase}/train/records`,
      { headers: bearer(apiToken) },
      200,
      'root train record baseline',
    ),
    apiJson(
      `${workspaceBase}/agents/${trainAgent.slug}/train/records`,
      { headers: bearer(apiToken) },
      200,
      'agent train record baseline',
    ),
  ])
  const rootRecordsBefore = TrainRecordListResponseSchema.parse(rootRecordsBeforeBody)
  const agentRecordsBefore = TrainRecordListResponseSchema.parse(agentRecordsBeforeBody)
  const [rootTrainBody, agentTrainBody] = await Promise.all([
    apiJson(
      `${workspaceBase}/train`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          files: [{ filename: 'northstar-renewal.md', content: SEEDED_MEMORY }],
        }),
      },
      202,
      'root train start',
      artifacts,
    ),
    apiJson(
      `${workspaceBase}/agents/${trainAgent.slug}/train`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          files: [{ filename: 'child-operating-guide.md', content: AGENT_TRAIN_MEMORY }],
        }),
      },
      202,
      'agent train start',
      artifacts,
    ),
  ])
  const rootTrain = TrainStartResponseSchema.parse(rootTrainBody)
  const agentTrain = TrainStartResponseSchema.parse(agentTrainBody)
  for (const [scope, jobId] of [
    ['root', rootTrain.jobId],
    [trainAgent.slug, agentTrain.jobId],
  ] as const) {
    ledger.record({
      kind: 'train-job',
      id: jobId,
      label: `${runId}:train:${scope}:${jobId}`,
      cleanup: async () => undefined,
      verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
    })
  }
  await Promise.all([
    waitForTrain(env.apiUrl, workspace.slug, rootTrain.jobId, apiToken),
    waitForTrain(env.apiUrl, workspace.slug, agentTrain.jobId, apiToken, {
      agentSlug: trainAgent.slug,
    }),
  ])

  const [rootRecordsBody, agentRecordsBody] = await Promise.all([
    apiJson(
      `${workspaceBase}/train/records`,
      { headers: bearer(apiToken) },
      200,
      'root train records list',
    ),
    apiJson(
      `${workspaceBase}/agents/${trainAgent.slug}/train/records`,
      { headers: bearer(apiToken) },
      200,
      'agent train records list',
    ),
  ])
  const rootRecords = TrainRecordListResponseSchema.parse(rootRecordsBody)
  const agentRecords = TrainRecordListResponseSchema.parse(agentRecordsBody)
  const { rootRecord, agentRecord } = assertScopedTrainAcceptance({
    rootJobId: rootTrain.jobId,
    agentJobId: agentTrain.jobId,
    agentSlug: trainAgent.slug,
    rootRecordsBefore: rootRecordsBefore.items,
    agentRecordsBefore: agentRecordsBefore.items,
    rootRecords: rootRecords.items,
    agentRecords: agentRecords.items,
  })
  const [rootDetailBody, agentDetailBody] = await Promise.all([
    apiJson(
      `${workspaceBase}/train/records/${encodeURIComponent(rootRecord.slug)}`,
      { headers: bearer(apiToken) },
      200,
      'root train record detail',
    ),
    apiJson(
      `${workspaceBase}/agents/${trainAgent.slug}/train/records/${encodeURIComponent(agentRecord.slug)}`,
      { headers: bearer(apiToken) },
      200,
      'agent train record detail',
    ),
  ])
  const rootDetail = TrainRecordResponseSchema.parse(rootDetailBody)
  const agentDetail = TrainRecordResponseSchema.parse(agentDetailBody)
  assert(
    rootDetail.record.memoryId === rootRecord.memoryId &&
      rootDetail.record.content.includes('20 percent'),
    'root training record list/detail did not return matching file-backed content',
  )
  assert(
    agentDetail.record.memoryId === agentRecord.memoryId &&
      agentDetail.record.content.includes('violet kestrel'),
    'agent training record list/detail did not return matching owned content',
  )

  const childCreated = SessionCreateResponseSchema.parse(
    await apiJson(
      `${workspaceBase}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ prompt: BUSINESS_QUESTION, cwd: trainAgent.anchorPath }),
      },
      201,
      'child agent session create',
      artifacts,
    ),
  )
  assert.equal(
    childCreated.snapshot.cwd,
    trainAgent.anchorPath,
    'child session did not carry the agent anchor path',
  )
  assert.equal(
    childCreated.snapshot.agent?.id,
    trainAgent.id,
    'child session was not attributed to the train fixture agent',
  )
  ledger.record({
    kind: 'session',
    id: childCreated.session.sessionId,
    label: `${runId}:child-context-session:${childCreated.session.sessionId}`,
    cleanup: async () =>
      await deleteStagingSession(env, workspace.slug, childCreated.session.sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  // KNOWN LIMITATION (train-uploads 00a/00b, unbuilt): right after train
  // jobs complete, the background embedding worker can still hold the
  // agent's single-writer memory.db, leaving this child session's stream
  // silent past the SSE timeout. Retry once, loudly — the user's real
  // recourse — rather than failing the run on a separately-ticketed defect.
  let childStreamed: Awaited<ReturnType<typeof proveStreamingAndReconnect>>
  const childEventsUrl = `${workspaceBase}/agent/sessions/${childCreated.session.sessionId}/events`
  try {
    childStreamed = await proveStreamingAndReconnect(childEventsUrl, apiToken)
  } catch (error) {
    if (!String(error).includes('SSE timeout')) throw error
    console.log(
      'STAGING_LIVE_PROGRESS {"stage":"train:child-stream-retry"} (memory.db busy post-train — train-uploads 00a/00b)',
    )
    await new Promise(resolve => setTimeout(resolve, 45_000))
    childStreamed = await proveStreamingAndReconnect(childEventsUrl, apiToken)
  }
  assert(
    answerReferencesSeededDiscount(childStreamed.answer),
    'fresh child-agent answer did not reference the inherited root 20 percent fact',
  )

  return { rootJobId: rootTrain.jobId, agent: trainAgent, rootRecord }
}

export function assertScopedTrainAcceptance(args: {
  rootJobId: string
  agentJobId: string
  agentSlug: string
  rootRecordsBefore: TrainRecordSummary[]
  agentRecordsBefore: TrainRecordSummary[]
  rootRecords: TrainRecordSummary[]
  agentRecords: TrainRecordSummary[]
}): { rootRecord: TrainRecordSummary; agentRecord: TrainRecordSummary } {
  assert.notEqual(
    args.rootJobId,
    args.agentJobId,
    'root and agent training returned the same job id',
  )

  const rootRecord = findNewOwnedRecord(args.rootRecordsBefore, args.rootRecords)
  assert(rootRecord !== undefined, 'root training did not create a file-backed record')

  const agentRecord = findNewOwnedRecord(args.agentRecordsBefore, args.agentRecords)
  assert(agentRecord !== undefined, 'agent training did not create an owned file-backed record')

  const inheritedRoot = findInheritedRecord(args.agentRecords, rootRecord.memoryId)
  assert(inheritedRoot !== undefined, 'agent records did not inherit the root-trained record')
  assert.equal(
    inheritedRoot.ownerAgentSlug,
    undefined,
    'root-trained inheritance was attributed to an agent owner',
  )
  assert(
    !args.rootRecords.some(record => record.memoryId === agentRecord.memoryId),
    'root records exposed the child agent memory',
  )
  assert(
    !args.rootRecords.some(record => record.slug === agentRecord.slug),
    'root records exposed the child agent record slug',
  )
  assert(
    !args.rootRecords.some(record => record.ownerAgentSlug === args.agentSlug),
    'root records exposed the child agent owner slug',
  )

  return { rootRecord, agentRecord }
}

export function findNewOwnedRecord(
  before: readonly TrainRecordSummary[],
  after: readonly TrainRecordSummary[],
): TrainRecordSummary | undefined {
  const priorIds = new Set(before.map(record => record.memoryId))
  return after.find(record => record.inherited !== true && !priorIds.has(record.memoryId))
}

export function findInheritedRecord(
  records: readonly TrainRecordSummary[],
  memoryId: string,
): TrainRecordSummary | undefined {
  return records.find(record => record.inherited === true && record.memoryId === memoryId)
}
