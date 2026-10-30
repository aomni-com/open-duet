import assert from 'node:assert/strict'

import {
  isKnownTimelineEvent,
  SERVICING_ARCHIVE_AFTER_MS,
  SessionInputResponseSchema,
} from '@repo/contract'

import { provisionStagingAgent } from './staging-live-agent-fixture.ts'
import {
  loadSessionHistory,
  waitForSessionHistory,
  waitForSessionSnapshot,
} from './staging-live-agent-sessions.ts'
import { fnAction, fnMutation, fnQuery, type Workspace } from './staging-live-env.ts'
import { bearerJson, stagingFetch } from './staging-live-http.ts'
import { waitForWorkspace } from './staging-live-streaming.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

/* Derived, never restated: the journey backdates a pause to just past the
   window the sweep actually enforces, so a policy change moves both together. */
const ARCHIVE_AFTER_MS = SERVICING_ARCHIVE_AFTER_MS
const SESSION_WAIT_MS = 600_000

export function hasCompletedAfterCwdFallback(
  events: ReadonlyArray<{
    seq: number
    event: { type: string; metadata?: { code?: string } }
  }>,
): boolean {
  const warning = events.find(
    row => row.event.type === 'system' && row.event.metadata?.code === 'session_cwd_fallback',
  )
  return (
    warning !== undefined &&
    events.some(row => row.seq > warning.seq && row.event.type === 'complete')
  )
}

export interface TrialRecommissionEvidence {
  workspaceId: string
  workspaceSlug: string
  oldVmNonce: string
  newVmNonce: string
  rootSessionId: string
  boundSessionId: string
  teardownRunId?: string
  attachRunId?: string
  convergencePath: 'teardown_latched' | 'direct_attach'
  queuedDelivery: 'queued'
  archivedWithoutStorage: true
  prePurchaseHistoryReadable: true
  prePurchaseSendStatus: 402
  rootFallbackWarning: true
  boundAgentRootRemoved: true
  boundSessionStatus: 'interrupted'
}

export function runTrialRecommissionJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<TrialRecommissionEvidence>> {
  return runWorkspaceBrowserJourney({
    journey: 'trial-recommission',
    label: 'Trial Recommission',
    entitlement: 'trial',
    onProgress: options.onProgress,
    run: runTrialRecommissionAcceptance,
  })
}

async function runTrialRecommissionAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<TrialRecommissionEvidence> {
  const { env, workspace, apiToken, email, runId, ledger, convex, artifacts, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const initial = await waitForWorkspace(
    convex,
    env.internalKey,
    workspace._id,
    row => row.status === 'active' && row.vmTokenNonce !== undefined,
  )
  assert(initial.vmTokenNonce !== undefined, 'trial workspace omitted its initial VM nonce')
  const oldVmNonce = initial.vmTokenNonce
  const rootCwd = `trial-recommission/${runId}`

  progress('trial-recommission:seed')
  const cwdDirectory = await stagingFetch(`${base}/files/actions`, {
    method: 'POST',
    headers: bearerJson(apiToken),
    body: JSON.stringify({ operation: 'mkdir', path: rootCwd, recursive: true }),
  })
  assert.equal(cwdDirectory.status, 200, `cwd mkdir returned ${cwdDirectory.status}`)
  const agent = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: `trial-${runId.slice(-8)}`,
    name: 'Trial Recommission Agent',
    description: 'Bound-session recommission fixture.',
    anchorPath: `agents/trial-${runId.slice(-8)}`,
    ledger,
    convex,
    artifacts,
  })
  const user = (await convex.query(fnQuery('testing/workspaces:rawUserByEmailForTest'), {
    internalKey: env.internalKey,
    email,
  })) as { _id: string } | null
  assert(user !== null, 'trial journey user disappeared during setup')
  const root = (await convex.mutation(
    fnMutation('testing/agentSessions:createQueuedSessionForTest'),
    {
      internalKey: env.internalKey,
      actorId: user._id,
      workspaceId: workspace._id,
      prompt: `Old root session ${runId}`,
      cwd: rootCwd,
    },
  )) as { sessionId: string }
  const bound = (await convex.mutation(
    fnMutation('testing/agentSessions:createQueuedSessionForTest'),
    {
      internalKey: env.internalKey,
      actorId: user._id,
      workspaceId: workspace._id,
      prompt: `Old bound session ${runId}`,
      cwd: agent.anchorPath,
    },
  )) as { sessionId: string }
  const boundRow = (await convex.query(fnQuery('testing/agentSessions:rawSessionForTest'), {
    internalKey: env.internalKey,
    sessionId: bound.sessionId,
  })) as { agentId?: string } | null
  assert(boundRow?.agentId !== undefined, 'bound fixture was not durably attributed to its agent')
  progress('trial-recommission:decommission')
  const now = Date.now()
  await convex.mutation(fnMutation('testing/workspaces:setWorkspaceServicingForTest'), {
    internalKey: env.internalKey,
    workspaceId: workspace._id,
    servicingStatus: 'paused',
    now: now - ARCHIVE_AFTER_MS,
  })
  /* Scoped to the fixture workspace, and this is not politeness: this action
     is the fleet-wide reaper, running here against LIVE staging. Unscoped, it
     also destroys every real workspace whose row qualifies in that instant —
     which on 2026-08-12 was the difference between this journey testing a
     decommission and this journey performing one. */
  await convex.action(
    fnAction('domains/workspaces/provisioningActions:decommissionUnservicedWorkspaces'),
    { internalKey: env.internalKey, now, workspaceId: workspace._id },
  )
  const archived = await waitForWorkspace(
    convex,
    env.internalKey,
    workspace._id,
    row => row.status === 'archived',
  )
  assert(archived.archiveStorageId === undefined, 'trial decommission uploaded archive bytes')
  await loadSessionHistory(env, workspace.slug, root.sessionId, apiToken)
  const blocked = await stagingFetch(`${base}/agent/sessions/${root.sessionId}/messages`, {
    method: 'POST',
    headers: bearerJson(apiToken),
    body: JSON.stringify({ prompt: 'blocked before purchase', behavior: 'steer' }),
  })
  assert.equal(blocked.status, 402, 'archived trial send bypassed the subscription wall')

  progress('trial-recommission:reactivate')
  await convex.mutation(
    fnMutation('testing/workspaces:activateSyntheticSubscriptionByEmailForTest'),
    { internalKey: env.internalKey, email },
  )
  const provisioning = (await convex.query(fnQuery('testing/workspaces:rawWorkspaceByIdForTest'), {
    internalKey: env.internalKey,
    workspaceId: workspace._id,
  })) as Workspace | null
  assert(provisioning !== null, 'recommissioned workspace disappeared')
  assert.equal(provisioning.status, 'provisioning', 'entitlement did not enter provisioning')
  const convergencePath =
    provisioning.vmTeardownRunId === undefined ? 'direct_attach' : 'teardown_latched'
  if (convergencePath === 'teardown_latched') {
    assert.equal(
      provisioning.attachAfterVmTeardown,
      true,
      'purchase did not latch attach after teardown',
    )
  } else {
    assert(provisioning.vmAttachRunId !== undefined, 'purchase did not schedule a direct attach')
  }
  const queued = SessionInputResponseSchema.parse(
    await responseJson(
      `${base}/agent/sessions/${root.sessionId}/messages`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          prompt: 'Respond to confirm this old session is usable. Do not call tools.',
          behavior: 'steer',
        }),
      },
      202,
    ),
  )
  assert.equal(queued.delivery, 'queued', 'provisioning input was not durably queued')
  const active = await waitForWorkspace(
    convex,
    env.internalKey,
    workspace._id,
    row =>
      row.status === 'active' && row.vmTokenNonce !== undefined && row.vmTokenNonce !== oldVmNonce,
  )
  assert(active.vmTokenNonce !== undefined, 'recommissioned workspace omitted its VM nonce')

  const rootHistory = await waitForSessionHistory(
    env,
    workspace.slug,
    root.sessionId,
    apiToken,
    history => hasCompletedAfterCwdFallback(history.events),
    SESSION_WAIT_MS,
  )
  assert(rootHistory.events.length > 0)
  progress('trial-recommission:root-settled')

  const removedAgentRoot = await stagingFetch(`${base}/files/actions`, {
    method: 'POST',
    headers: bearerJson(apiToken),
    body: JSON.stringify({ operation: 'delete', path: agent.anchorPath, recursive: true }),
  })
  assert(
    [200, 404].includes(removedAgentRoot.status),
    `bound agent root delete returned ${removedAgentRoot.status}`,
  )

  const boundInput = SessionInputResponseSchema.parse(
    await responseJson(
      `${base}/agent/sessions/${bound.sessionId}/messages`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ prompt: 'Continue the old bound session.', behavior: 'steer' }),
      },
      202,
    ),
  )
  progress(`trial-recommission:bound-${boundInput.delivery}`)
  try {
    await waitForSessionSnapshot(
      env,
      workspace.slug,
      bound.sessionId,
      apiToken,
      snapshot => snapshot.turnStatus === 'interrupted',
      SESSION_WAIT_MS,
    )
  } catch (error) {
    const raw = (await convex.query(fnQuery('testing/agentSessions:rawSessionForTest'), {
      internalKey: env.internalKey,
      sessionId: bound.sessionId,
    })) as Record<string, unknown> | null
    const history = await loadSessionHistory(env, workspace.slug, bound.sessionId, apiToken)
    throw new Error(
      `Bound session did not settle: ${JSON.stringify({
        delivery: boundInput.delivery,
        raw:
          raw === null
            ? null
            : {
                status: raw.status,
                agentId: raw.agentId,
                lastEventSeq: raw.lastEventSeq,
                lastRunnerInputSeq: raw.lastRunnerInputSeq,
                lastDeliveredInputSeq: raw.lastDeliveredInputSeq,
                runnerInputPending: raw.runnerInputPending,
                deliveryAttempt: raw.deliveryAttempt,
              },
        events: history.events.map(row => ({
          seq: row.seq,
          type: row.event.type,
          code:
            isKnownTimelineEvent(row.event) && row.event.type === 'system'
              ? row.event.metadata?.code
              : undefined,
        })),
      })}`,
      { cause: error },
    )
  }
  const boundHistory = await waitForSessionHistory(
    env,
    workspace.slug,
    bound.sessionId,
    apiToken,
    history =>
      history.events.some(
        row =>
          isKnownTimelineEvent(row.event) &&
          row.event.type === 'system' &&
          row.event.metadata?.code === 'bound_agent_root_unavailable',
      ),
    SESSION_WAIT_MS,
  )
  assert(boundHistory.events.length > 0)

  return {
    workspaceId: workspace._id,
    workspaceSlug: workspace.slug,
    oldVmNonce,
    newVmNonce: active.vmTokenNonce,
    rootSessionId: root.sessionId,
    boundSessionId: bound.sessionId,
    ...(provisioning.vmTeardownRunId === undefined
      ? {}
      : { teardownRunId: provisioning.vmTeardownRunId }),
    ...(provisioning.vmAttachRunId === undefined
      ? {}
      : { attachRunId: provisioning.vmAttachRunId }),
    convergencePath,
    queuedDelivery: 'queued',
    archivedWithoutStorage: true,
    prePurchaseHistoryReadable: true,
    prePurchaseSendStatus: 402,
    rootFallbackWarning: true,
    boundAgentRootRemoved: true,
    boundSessionStatus: 'interrupted',
  }
}

async function responseJson(
  url: string,
  init: RequestInit,
  expectedStatus: number,
): Promise<unknown> {
  const response = await stagingFetch(url, init)
  const body = await response.json()
  assert.equal(
    response.status,
    expectedStatus,
    `${url} returned ${response.status}: ${JSON.stringify(body)}`,
  )
  return body
}
