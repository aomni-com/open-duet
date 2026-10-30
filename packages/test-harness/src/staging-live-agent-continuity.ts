import assert from 'node:assert/strict'

import type { ConvexHttpClient } from 'convex/browser'

import {
  AdminLoginAsResponseSchema,
  WhoamiResponseSchema,
  InternalAdminVmStatusSchema,
  isKnownTimelineEvent,
  SessionCreateResponseSchema,
  SessionInputResponseSchema,
  SessionInterruptResponseSchema,
  type SessionSnapshot,
} from '@repo/contract'

import {
  deleteStagingSession,
  loadSessionHistory,
  waitForJobProjection,
  type JobPhase,
  waitForSessionHistory,
  waitForSessionSnapshot,
} from './staging-live-agent-sessions.ts'
import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { fnMutation, fnQuery, type LiveEnv, type Workspace } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import type { ChronologicalSessionHistory } from './staging-live-pagination.ts'
import { runRelayPreviewAcceptance } from './staging-live-relay-previews.ts'
import { recordWorkspaceCleanup, workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import type { StagingResourceLedger } from './staging-live-resource-ledger.ts'
import { parseRuntimeReleaseManifest } from './staging-live-runtime'
import { waitForWorkspace } from './staging-live-streaming.ts'
import {
  runWorkspaceBrowserJourney,
  workspaceBrowserJourneyEmail,
} from './staging-live-workspace-browser.ts'

export const AGENT_CONTINUITY_REMINDER_DELAY_SECONDS = 120
export const AGENT_CONTINUITY_REACTIVATION_DELAY_SECONDS = 60
const LIVE_INPUT_HOLD_SECONDS = 120
const TIMER_STATE = 'wait_for_reminder'
const LIVE_INPUT_HOLD_STATE = 'hold_open_for_live_input'
const COMPLETED_STATE = 'continuity_completed'
const ACTIVE_RESTART_HOLD_STATE = 'hold_open_across_vm_restart'
const ACTIVE_RESTART_DONE_STATE = 'active_restart_completed'
const MIN_RESTART_WAKE_HEADROOM_MS = 60_000
const SESSION_WAIT_MS = 240_000
const POLL_MS = 500
type ContinuityEnv = Pick<LiveEnv, 'apiUrl' | 'internalKey'>

export interface AgentContinuityEvidence {
  sessionId: string
  sleepWakeAt: number
  rebootObservedAt: number
  gatewayInstanceBefore: string
  gatewayInstanceAfter: string
  steerDelivery: 'accepted' | 'queued'
  followUpDelivery: 'accepted' | 'queued'
  interruptedCurrentState: string
  reactivatedView: JobPhase
  activeRestartSessionId: string
  activeRestartGatewayBefore: string
  activeRestartGatewayAfter: string
  activeRestartTerminal: 'interrupted' | 'complete'
  freshPromptDelivery: 'accepted'
  freshPromptTerminal: 'complete'
}

export function buildAgentContinuityInitialPrompt(token: string): string {
  const toolArguments = {
    definition: {
      name: `Live continuity ${token}`,
      prompt: [
        `This machine owns the durable reminder for ${token}.`,
        `When ${TIMER_STATE} completes, select ${LIVE_INPUT_HOLD_STATE} immediately.`,
        `When ${LIVE_INPUT_HOLD_STATE} completes, select ${COMPLETED_STATE}.`,
      ].join(' '),
      states: [
        {
          name: TIMER_STATE,
          kind: 'timer',
          wakeAfterMs: AGENT_CONTINUITY_REMINDER_DELAY_SECONDS * 1_000,
        },
        {
          name: LIVE_INPUT_HOLD_STATE,
          kind: 'script',
          command: `sleep ${LIVE_INPUT_HOLD_SECONDS}`,
        },
        { name: COMPLETED_STATE, kind: 'terminal', status: 'completed' },
      ],
    },
    firstState: TIMER_STATE,
  }

  return [
    `Create the durable reminder for "${token}" by calling create_state_machine_definition with exactly these arguments:`,
    JSON.stringify(toolArguments),
    'Do not use todo_write and do not answer normally instead of making the tool call.',
    'Once the tool accepts the definition, stop this turn so the session sleeps until the timer wakes.',
  ].join(' ')
}

export function buildAgentContinuityReactivationPrompt(token: string): string {
  const toolArguments = {
    decision: {
      state: TIMER_STATE,
      override: {
        kind: 'timer',
        state: { wakeAfterMs: AGENT_CONTINUITY_REACTIVATION_DELAY_SECONDS * 1_000 },
      },
    },
  }

  return [
    `Reactivate the interrupted durable reminder for "${token}" by calling select_state_machine_state with exactly these arguments:`,
    JSON.stringify(toolArguments),
    'Do not create a replacement state machine and do not answer normally instead of making the tool call.',
    'Once the tool accepts the transition, stop this turn so the session sleeps until the timer wakes.',
  ].join(' ')
}

export function buildActiveRestartPrompt(token: string): string {
  const toolArguments = {
    definition: {
      name: `Active restart ${token}`,
      prompt: `Prove an active turn survives the VM restart for ${token}.`,
      states: [
        {
          name: ACTIVE_RESTART_HOLD_STATE,
          kind: 'script',
          command: `sleep ${LIVE_INPUT_HOLD_SECONDS}`,
        },
        { name: ACTIVE_RESTART_DONE_STATE, kind: 'terminal', status: 'completed' },
      ],
    },
    firstState: ACTIVE_RESTART_HOLD_STATE,
  }

  return [
    `Start the deliberately long active turn for "${token}" by calling create_state_machine_definition with exactly these arguments:`,
    JSON.stringify(toolArguments),
    'Do not use todo_write and do not answer normally instead of making the tool call.',
    'Once the tool accepts the definition, let the script state keep this turn active.',
  ].join(' ')
}

export function isDurablySleepingReactivation(snapshot: {
  turnStatus: SessionSnapshot['turnStatus']
  machineState?: { currentState?: string }
  machine?: { nextWakeAt?: number }
}): boolean {
  return (
    snapshot.turnStatus === 'sleep' &&
    snapshot.machineState?.currentState === TIMER_STATE &&
    snapshot.machine?.nextWakeAt !== undefined
  )
}

export async function runAgentContinuityAcceptance(args: {
  env: ContinuityEnv
  login: { token: string }
  admin: { token: string }
  workspace: Workspace
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  progress: (stage: string) => void
}): Promise<AgentContinuityEvidence> {
  const { env, login, admin, workspace, runId, ledger, convex, artifacts, progress } = args
  progress('agent-continuity:certify-release')
  const connection = (await convex.query(
    fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
    { internalKey: env.internalKey, slug: workspace.slug },
  )) as { vmToken: string; httpsUrl: string } | { refusal: 'paused' } | null
  assert(connection !== null && !('refusal' in connection), 'recovery gateway unavailable')
  await artifacts.writeJson(
    'certified-gateway.json',
    await waitForCertifiedRuntimeRelease(env.apiUrl, connection.httpsUrl, connection.vmToken),
  )
  const token = `agent-continuity-${runId}`
  const initialPrompt = buildAgentContinuityInitialPrompt(token)
  progress('agent-continuity:create')
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({
          prompt: initialPrompt,
        }),
      },
      201,
      'agent continuity session create',
      artifacts,
    ),
  )
  const sessionId = created.session.sessionId
  ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${runId}:agent-continuity:${sessionId}`,
    cleanup: async () => {
      await deleteStagingSession(env, workspace.slug, sessionId, login.token)
    },
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })

  const sleeping = await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    login.token,
    snapshot =>
      snapshot.turnStatus === 'sleep' &&
      snapshot.machineState !== undefined &&
      snapshot.machine?.activity === 'sleeping' &&
      snapshot.machine.nextWakeAt !== undefined,
  )
  assert(sleeping.machineState !== undefined, 'sleeping reminder omitted its state machine')
  assert(sleeping.machine?.nextWakeAt !== undefined, 'sleeping reminder omitted its wake time')
  assert(
    sleeping.machine.nextWakeAt - Date.now() >= MIN_RESTART_WAKE_HEADROOM_MS,
    'sleeping reminder did not leave enough pre-wake time to prove a restarted gateway owned it',
  )
  await waitForJobProjection(env, workspace.slug, sessionId, login.token, 'unfinished')
  const beforeRestart = await loadSessionHistory(env, workspace.slug, sessionId, login.token)
  assert(
    beforeRestart.events.some(
      row =>
        row.event.type === 'prompt_submitted' &&
        row.event.inputKind === 'initial' &&
        row.event.behavior === 'steer' &&
        row.event.prompt === initialPrompt,
    ),
    'omitted initial behavior did not resolve to steer',
  )
  progress('agent-continuity:reboot')
  const sleepingRestart = await restartWorkspaceVm({
    env,
    adminToken: admin.token,
    workspace,
    artifacts,
    reason: `Staging agent continuity restart ${runId}`,
    evidenceLabel: 'agent continuity VM reboot',
  })
  assert(
    Date.now() < sleeping.machine.nextWakeAt,
    'restarted gateway was not observed before the durable wake became due',
  )
  const afterRestart = await loadSessionHistory(env, workspace.slug, sessionId, login.token)
  const afterRestartSeq = Math.max(0, ...afterRestart.events.map(row => row.seq))

  progress('agent-continuity:wake')
  const liveHistory = await waitForSessionHistory(
    env,
    workspace.slug,
    sessionId,
    login.token,
    history => findLiveContinuityHoldTask(history, afterRestartSeq) !== undefined,
    AGENT_CONTINUITY_REMINDER_DELAY_SECONDS * 1_000 + SESSION_WAIT_MS,
  )
  const holdTask = findLiveContinuityHoldTask(liveHistory, afterRestartSeq)
  assert(holdTask !== undefined, 'restarted gateway did not start the named live hold task')
  assert(
    Date.now() >= sleeping.machine.nextWakeAt,
    'durable reminder woke before its scheduled time',
  )

  progress('agent-continuity:steer')
  const steerPrompt = `Keep processing the ${token} reminder and include the current time.`
  const steer = SessionInputResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({
          behavior: 'steer',
          prompt: steerPrompt,
        }),
      },
      202,
      'agent continuity live steer',
      artifacts,
    ),
  )
  assert.equal(steer.delivery, 'accepted', 'restarted runner did not accept the live steer')
  const followUpPrompt = `Also mention that ${token} survived a gateway restart.`
  const followUp = SessionInputResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({
          behavior: 'follow_up',
          prompt: followUpPrompt,
        }),
      },
      202,
      'agent continuity live follow-up',
      artifacts,
    ),
  )
  assert.equal(followUp.delivery, 'accepted', 'restarted runner did not accept the live follow-up')
  // Its own stage: this wait and the wake wait above both used to report as
  // `wake`, so a timeout here read as "the durable reminder never woke" when the
  // reminder had woken fine and the queue was the thing that never arrived.
  progress('agent-continuity:queue')
  const queuedHistory = await waitForSessionHistory(
    env,
    workspace.slug,
    sessionId,
    login.token,
    history =>
      history.events.some(
        row =>
          row.seq > holdTask.seq &&
          row.event.type === 'prompt_submitted' &&
          row.event.behavior === 'steer' &&
          row.event.prompt === steerPrompt,
      ) && findFollowUpQueueEvidence(history, followUpPrompt, holdTask.seq) !== undefined,
  )
  const queueEvidence = findFollowUpQueueEvidence(queuedHistory, followUpPrompt, holdTask.seq)
  assert(queueEvidence !== undefined, 'runner did not queue the exact accepted follow-up')
  SessionInterruptResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}/interrupt`,
      { method: 'POST', headers: bearerJson(login.token), body: '{}' },
      200,
      'agent continuity interrupt',
      artifacts,
    ),
  )

  const interrupted = await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    login.token,
    snapshot =>
      snapshot.turnStatus === 'interrupted' &&
      snapshot.machineState !== undefined &&
      snapshot.machineState?.currentState === 'interrupted' &&
      snapshot.machineState.terminal === undefined &&
      (snapshot.followUpQueue?.length ?? 0) === 0,
  )
  assert.equal(interrupted.machineState?.currentState, 'interrupted')
  const interruptedHistory = await waitForSessionHistory(
    env,
    workspace.slug,
    sessionId,
    login.token,
    history => historyHasInterruptedContinuity(history, holdTask.taskId, queueEvidence.queuedSeq),
  )
  assert(
    historyHasInterruptedContinuity(interruptedHistory, holdTask.taskId, queueEvidence.queuedSeq),
    'native interrupt did not stop the hold task, empty the queue, then emit interrupted',
  )
  await waitForJobProjection(env, workspace.slug, sessionId, login.token, 'finished')

  // Reproduce a lost terminal projection using the normal VM event boundary.
  // The native interrupted checkpoint stays untouched on the disposable VM.
  progress('agent-continuity:interrupted-checkpoint:stale-projection')
  const acceptedThroughSeq = Math.max(
    ...interruptedHistory.events
      .filter(row => row.event.type === 'prompt_submitted')
      .map(row => row.seq),
  )
  assert(Number.isSafeInteger(acceptedThroughSeq), 'recovery fixture has no input cursor')
  await apiJson(
    `${env.apiUrl}/v1/vm/agent/sessions/${sessionId}/events`,
    {
      method: 'POST',
      headers: bearerJson(connection.vmToken),
      body: JSON.stringify({
        relayId: `staging-interrupted-checkpoint-${runId}`,
        acceptedThroughSeq,
        event: {
          type: 'turn_started',
          state: {
            status: 'running',
            mode: 'agent',
            agent: { status: 'running', messages: [] },
          },
        },
      }),
    },
    200,
    'recovery stale running projection',
    artifacts,
  )
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    login.token,
    snapshot => snapshot.turnStatus === 'running' && snapshot.bucket === 'running',
  )
  const staleHistory = await loadSessionHistory(env, workspace.slug, sessionId, login.token)
  const staleSeq = Math.max(...staleHistory.events.map(row => row.seq))
  await restartWorkspaceVm({
    env,
    adminToken: admin.token,
    workspace,
    artifacts,
    reason: `Staging interrupted checkpoint recovery ${runId}`,
    evidenceLabel: 'interrupted checkpoint VM reboot',
  })
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    login.token,
    snapshot =>
      snapshot.turnStatus === 'interrupted' &&
      snapshot.bucket === 'done' &&
      snapshot.machine?.nextWakeAt === undefined,
  )
  await waitForJobProjection(env, workspace.slug, sessionId, login.token, 'finished')
  assertStoppedSessionHistory(
    await loadSessionHistory(env, workspace.slug, sessionId, login.token),
    staleSeq,
  )

  progress('agent-continuity:reactivate')
  SessionInputResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({
          behavior: 'steer',
          prompt: buildAgentContinuityReactivationPrompt(token),
        }),
      },
      202,
      'agent continuity reactivation',
      artifacts,
    ),
  )
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    login.token,
    isDurablySleepingReactivation,
  )
  await waitForJobProjection(env, workspace.slug, sessionId, login.token, 'unfinished')

  const beforeSleeperStop = await loadSessionHistory(env, workspace.slug, sessionId, login.token)
  const sleeperStopSeq = Math.max(...beforeSleeperStop.events.map(row => row.seq))
  SessionInterruptResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}/interrupt`,
      { method: 'POST', headers: bearerJson(login.token), body: '{}' },
      200,
      'agent continuity final interrupt',
      artifacts,
    ),
  )
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    login.token,
    snapshot =>
      snapshot.turnStatus === 'interrupted' &&
      snapshot.bucket === 'done' &&
      snapshot.machine?.nextWakeAt === undefined,
  )
  const activeRestart = await runActiveTurnRestartAcceptance({
    env,
    login,
    admin,
    workspace,
    runId,
    ledger,
    convex,
    artifacts,
    progress,
  })

  // The other session's reboot also proves this stopped sleeper stayed stopped.
  SessionInterruptResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}/interrupt`,
      { method: 'POST', headers: bearerJson(login.token), body: '{}' },
      200,
      'agent continuity repeated sleeper interrupt',
      artifacts,
    ),
  )
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    login.token,
    snapshot =>
      snapshot.turnStatus === 'interrupted' &&
      snapshot.bucket === 'done' &&
      snapshot.machine?.nextWakeAt === undefined,
  )
  const stoppedHistory = await loadSessionHistory(env, workspace.slug, sessionId, login.token)
  await artifacts.writeJson('stopped-sleeper-history.json', {
    beforeStopSeq: sleeperStopSeq,
    events: stoppedHistory.events.map(row => ({
      seq: row.seq,
      createdAt: row.createdAt,
      type: row.event.type,
    })),
  })
  assertStoppedSessionHistory(stoppedHistory, sleeperStopSeq)

  return {
    sessionId,
    sleepWakeAt: sleeping.machine.nextWakeAt,
    rebootObservedAt: sleepingRestart.rebootObservedAt,
    gatewayInstanceBefore: sleepingRestart.gatewayBefore,
    gatewayInstanceAfter: sleepingRestart.gatewayAfter,
    steerDelivery: steer.delivery,
    followUpDelivery: followUp.delivery,
    interruptedCurrentState: interrupted.machineState.currentState,
    reactivatedView: 'unfinished',
    ...activeRestart,
  }
}

/** A bounded live closeout for recovery, without running the full staging suite. */
export async function runRelayRecoveryJourney(
  options: { onProgress?: (stage: string) => void } = {},
) {
  return runWorkspaceBrowserJourney({
    journey: 'relay-recovery',
    label: 'Relay Recovery',
    onProgress: options.onProgress,
    run: async context => {
      const { env, convex, ledger, artifacts, runId } = context
      const email = workspaceBrowserJourneyEmail(`${runId}-operator`)
      const admin = AdminLoginAsResponseSchema.parse(
        await apiJson(
          `${env.apiUrl}/v1/admin/login-as`,
          {
            method: 'POST',
            headers: bearerJson(env.loginSecret),
            body: JSON.stringify({
              email,
              name: `Recovery operator ${runId}`,
              create: true,
              ephemeral: true,
              ttlSeconds: 900,
            }),
          },
          200,
          'relay recovery operator login',
          artifacts,
        ),
      )
      ledger.record({
        kind: 'user',
        id: admin.userId,
        label: `${runId}:operator:${email}`,
        cleanupPriority: -100,
        cleanup: async () => {
          await convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
            internalKey: env.internalKey,
            email,
          })
        },
        verify: async () =>
          (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
            internalKey: env.internalKey,
            email,
          })) === null,
      })
      const identity = WhoamiResponseSchema.parse(
        await apiJson(
          `${env.apiUrl}/v1/whoami`,
          { headers: bearer(admin.token) },
          200,
          'recovery operator identity',
          artifacts,
        ),
      )
      assert(identity.internalAdmin, 'recovery operator lacks internal-admin access')
      const owned = identity.workspaces.find(row => row.slug === admin.workspaceSlug)
      assert(owned, 'operator workspace missing')
      recordWorkspaceCleanup({
        ledger,
        convex,
        env,
        output: context,
        workspaceId: owned.id,
        slug: owned.slug,
      })
      await waitForWorkspace(
        convex,
        env.internalKey,
        owned.id,
        row => row.status === 'active' && row.vmName !== undefined,
      )
      const continuity = await runAgentContinuityAcceptance({
        ...context,
        login: { token: context.apiToken },
        admin,
      })
      const previews = await runRelayPreviewAcceptance(context)
      return { ...continuity, previews }
    },
  })
}

async function runActiveTurnRestartAcceptance(args: {
  env: ContinuityEnv
  login: { token: string }
  admin: { token: string }
  workspace: Workspace
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  progress: (stage: string) => void
}): Promise<
  Pick<
    AgentContinuityEvidence,
    | 'activeRestartSessionId'
    | 'activeRestartGatewayBefore'
    | 'activeRestartGatewayAfter'
    | 'activeRestartTerminal'
    | 'freshPromptDelivery'
    | 'freshPromptTerminal'
  >
> {
  const { env, login, admin, workspace, runId, ledger, convex, artifacts, progress } = args
  const token = `agent-active-restart-${runId}`
  const longPrompt = buildActiveRestartPrompt(token)
  progress('agent-continuity:active-restart:create')
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({ prompt: longPrompt }),
      },
      201,
      'active-turn restart session create',
      artifacts,
    ),
  )
  const sessionId = created.session.sessionId
  ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${runId}:agent-active-restart:${sessionId}`,
    cleanup: async () => {
      await deleteStagingSession(env, workspace.slug, sessionId, login.token)
    },
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })

  const activeHistory = await waitForSessionHistory(
    env,
    workspace.slug,
    sessionId,
    login.token,
    history => findActiveRestartHoldTask(history) !== undefined,
  )
  const holdTask = findActiveRestartHoldTask(activeHistory)
  assert(holdTask !== undefined, 'long-turn restart fixture never became observably active')
  progress('agent-continuity:active-restart:reboot')
  const activeRestart = await restartWorkspaceVm({
    env,
    adminToken: admin.token,
    workspace,
    artifacts,
    reason: `Staging active agent turn restart ${runId}`,
    evidenceLabel: 'active-turn VM reboot',
  })

  const terminalHistory = await waitForSessionHistory(
    env,
    workspace.slug,
    sessionId,
    login.token,
    history => findPostRestartTerminal(history, holdTask.seq) !== undefined,
  )
  const terminal = findPostRestartTerminal(terminalHistory, holdTask.seq)
  assert(terminal !== undefined, 'active-turn restart never reached a safe terminal state')
  const terminalSnapshot = await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    login.token,
    snapshot => snapshot.turnStatus === terminal.type,
  )
  assert(
    terminalSnapshot.machineState !== undefined,
    'active-turn restart lost its durable state-machine projection',
  )
  assert.equal(
    terminalSnapshot.machineState.terminal?.status,
    'completed',
    'rebooted relay did not finish its work; a safe or empty turn terminal is insufficient',
  )
  assert.equal(terminalSnapshot.machineState.currentState, ACTIVE_RESTART_DONE_STATE)
  await waitForJobProjection(
    env,
    workspace.slug,
    sessionId,
    login.token,
    jobPhaseForStateMachine(terminalSnapshot.machineState),
  )

  const freshPrompt = `Reply exactly "${token} recovered" and do not call tools.`
  progress('agent-continuity:active-restart:fresh-prompt')
  const fresh = SessionInputResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({ behavior: 'steer', prompt: freshPrompt }),
      },
      202,
      'active-turn restart fresh prompt',
      artifacts,
    ),
  )
  assert.equal(fresh.delivery, 'accepted', 'fresh prompt remained locked after active-turn reboot')
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    login.token,
    snapshot => snapshot.turnStatus === 'complete',
  )

  return {
    activeRestartSessionId: sessionId,
    activeRestartGatewayBefore: activeRestart.gatewayBefore,
    activeRestartGatewayAfter: activeRestart.gatewayAfter,
    activeRestartTerminal: terminal.type,
    freshPromptDelivery: 'accepted',
    freshPromptTerminal: 'complete',
  }
}

export function findLiveContinuityHoldTask(
  history: ChronologicalSessionHistory,
  afterSeq: number,
): { taskId: string; seq: number } | undefined {
  return findUnsettledRunningToolTask(history, LIVE_INPUT_HOLD_STATE, afterSeq)
}

export function findActiveRestartHoldTask(
  history: ChronologicalSessionHistory,
): { taskId: string; seq: number } | undefined {
  return findUnsettledRunningToolTask(history, ACTIVE_RESTART_HOLD_STATE, 0)
}

export function findPostRestartTerminal(
  history: ChronologicalSessionHistory,
  afterSeq: number,
): { seq: number; type: 'interrupted' | 'complete' } | undefined {
  const terminal = history.events.find(
    row =>
      row.seq > afterSeq && (row.event.type === 'interrupted' || row.event.type === 'complete'),
  )
  if (terminal?.event.type !== 'interrupted' && terminal?.event.type !== 'complete') {
    return undefined
  }
  return { seq: terminal.seq, type: terminal.event.type }
}

/**
 * Whether a machine's own state says its work is over.
 *
 * `active`/`history` were view names on a list that no longer exists; the
 * question they stood for is unchanged, so this now answers it in the merged
 * list's terms.
 */
export function jobPhaseForStateMachine(stateMachine: {
  currentState?: string
  terminal?: unknown
}): JobPhase {
  return stateMachine.terminal === undefined && stateMachine.currentState !== 'interrupted'
    ? 'unfinished'
    : 'finished'
}

function findUnsettledRunningToolTask(
  history: ChronologicalSessionHistory,
  stateName: string,
  afterSeq: number,
): { taskId: string; seq: number } | undefined {
  const started = history.events.find(
    row =>
      row.seq > afterSeq &&
      isKnownTimelineEvent(row.event) &&
      row.event.type === 'task_started' &&
      row.event.task.name === stateName &&
      row.event.task.kind === 'tool' &&
      row.event.task.status === 'running',
  )
  if (started === undefined) return undefined
  if (!isKnownTimelineEvent(started.event) || started.event.type !== 'task_started') {
    return undefined
  }
  const taskId = started.event.task.id
  if (
    history.events.some(
      row =>
        isKnownTimelineEvent(row.event) &&
        row.event.type === 'task_settled' &&
        row.event.settlement.id === taskId,
    )
  ) {
    return undefined
  }
  return { taskId, seq: started.seq }
}

/**
 * Whether a queued entry is the follow-up we submitted.
 *
 * The queue holds what the runner was handed, and Duet hands it an attributed
 * envelope — `<user_message seq=".." timestamp=".." user_full_name="..">text
 * </user_message>` — so the prompt is the envelope's body, never the whole
 * entry. Asking for equality here asked the queue to have forgotten who sent
 * the message, which is the one thing the envelope exists to remember.
 *
 * Containment is the honest test, and it stays a real assertion: the token in
 * every continuity prompt is unique to the run. The envelope XML-escapes its
 * body, so this holds only while these prompts stay free of `&<>"'` — they are
 * literals a few lines up, so that is a constraint on this file, not a guess
 * about production. Whether the envelope names its sender correctly belongs to
 * the agent-delegation journey, which owns that contract.
 */
function queueEntryCarriesPrompt(entry: string, prompt: string): boolean {
  return entry.includes(prompt)
}

export function findFollowUpQueueEvidence(
  history: ChronologicalSessionHistory,
  prompt: string,
  afterSeq: number,
): { promptSeq: number; queuedSeq: number } | undefined {
  const userPrompt = history.events.find(
    row =>
      row.seq > afterSeq &&
      isKnownTimelineEvent(row.event) &&
      row.event.type === 'prompt_submitted' &&
      row.event.behavior === 'follow_up' &&
      row.event.prompt === prompt,
  )
  if (userPrompt === undefined) return undefined
  const queued = history.events.find(
    row =>
      row.seq > userPrompt.seq &&
      isKnownTimelineEvent(row.event) &&
      row.event.type === 'follow_up_queue' &&
      row.event.followUpQueue.some(entry => queueEntryCarriesPrompt(entry.message, prompt)),
  )
  return queued === undefined ? undefined : { promptSeq: userPrompt.seq, queuedSeq: queued.seq }
}

export function historyHasInterruptedContinuity(
  history: ChronologicalSessionHistory,
  taskId: string,
  afterQueuedSeq: number,
): boolean {
  const stopped = history.events.find(
    row =>
      row.seq > afterQueuedSeq &&
      isKnownTimelineEvent(row.event) &&
      row.event.type === 'task_settled' &&
      row.event.settlement.id === taskId &&
      row.event.settlement.status === 'stopped',
  )
  const emptied = history.events.find(
    row =>
      row.seq > afterQueuedSeq &&
      isKnownTimelineEvent(row.event) &&
      row.event.type === 'follow_up_queue' &&
      row.event.followUpQueue.length === 0,
  )
  if (stopped === undefined || emptied === undefined) return false
  const finalEvidenceSeq = Math.max(stopped.seq, emptied.seq)
  return history.events.some(row => row.seq > finalEvidenceSeq && row.event.type === 'interrupted')
}

async function restartWorkspaceVm(args: {
  env: ContinuityEnv
  adminToken: string
  workspace: Workspace
  artifacts: StagingArtifactCollector
  reason: string
  evidenceLabel: string
}): Promise<{ rebootObservedAt: number; gatewayBefore: string; gatewayAfter: string }> {
  const { env, adminToken, workspace, artifacts, reason, evidenceLabel } = args
  const gatewayBefore = await waitForGatewayInstance(env, workspace._id, adminToken)
  await apiJson(
    `${env.apiUrl}/v1/internal-admin/workspaces/${workspace._id}/vm/reboot`,
    {
      method: 'POST',
      headers: bearerJson(adminToken),
      body: JSON.stringify({ confirmation: workspace.slug, reason }),
    },
    200,
    evidenceLabel,
    artifacts,
  )
  // A healthy new process proves reboot recovery. The metadata heartbeat can
  // be coalesced for longer than the timer whose restoration this test proves.
  const gatewayAfter = await waitForGatewayInstance(env, workspace._id, adminToken, gatewayBefore)
  assert.notEqual(gatewayAfter, gatewayBefore, 'VM reboot reused the prior gateway process')
  return { rebootObservedAt: Date.now(), gatewayBefore, gatewayAfter }
}

export async function waitForGatewayInstance(
  env: ContinuityEnv,
  workspaceId: string,
  token: string,
  previousInstanceId?: string,
): Promise<string> {
  const deadline = Date.now() + SESSION_WAIT_MS
  let latest: string | undefined
  for (;;) {
    const response = await stagingFetch(
      `${env.apiUrl}/v1/internal-admin/workspaces/${workspaceId}/vm`,
      { headers: bearer(token), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) },
    ).catch(() => undefined)
    if (response !== undefined) {
      if ([502, 503, 504].includes(response.status)) {
        await response.body?.cancel()
      } else {
        assert.equal(response.status, 200, 'gateway process status request failed')
        const status = InternalAdminVmStatusSchema.parse(await response.json())
        latest = status.gateway?.reachable === true ? status.gateway.instanceId : undefined
        if (latest !== undefined && latest !== previousInstanceId) return latest
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for gateway process identity: ${JSON.stringify({ latest })}`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}

export async function waitForCertifiedRuntimeRelease(
  apiUrl: string,
  gatewayUrl: string,
  token: string,
): Promise<{ runtimeVersion: string; instanceId: string }> {
  // Certification needs multiple successful syncs; an idle VM can poll every
  // five minutes, independently of the much shorter session recovery budget.
  const deadline = Date.now() + 15 * 60_000
  for (;;) {
    const responses = await Promise.all(
      [`${apiUrl}/v1/vm/runtime-release/manifest`, `${gatewayUrl}/health`].map(url =>
        stagingFetch(url, {
          headers: bearer(token),
          signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - Date.now()))),
        }).catch(() => undefined),
      ),
    )
    const [manifestResponse, healthResponse] = responses
    if (manifestResponse?.ok && healthResponse?.ok) {
      const manifest = parseRuntimeReleaseManifest(await manifestResponse.json())
      const health = (await healthResponse.json()) as {
        runtimeVersion: string
        instanceId: string
        diagnostics?: { bootHealthCertified?: boolean }
      }
      // Repeated intentional reboots during probation otherwise exercise the
      // crash-loop rollback guard, replacing the release whose recovery we test.
      if (
        typeof manifest.version === 'string' &&
        health.runtimeVersion === manifest.version &&
        health.diagnostics?.bootHealthCertified === true
      ) {
        return { runtimeVersion: health.runtimeVersion, instanceId: health.instanceId }
      }
    } else {
      await Promise.all(responses.map(response => response?.body?.cancel()))
    }
    assert(
      Date.now() < deadline,
      'Runtime release did not finish health probation before reboot tests',
    )
    await Bun.sleep(5_000)
  }
}

export function assertStoppedSessionHistory(
  history: ChronologicalSessionHistory,
  afterSeq: number,
): void {
  assert(
    !history.events.some(
      row =>
        row.seq > afterSeq &&
        (row.event.type === 'turn_started' || row.event.type === 'task_started'),
    ),
    'Stopping or restoring an inactive session restarted execution',
  )
}
