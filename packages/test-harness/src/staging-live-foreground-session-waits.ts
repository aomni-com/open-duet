import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  SessionCreateResponseSchema,
  SessionWaitResponseSchema,
  type SessionWaitCompletedResponse,
} from '@repo/contract'

import { deleteStagingSession, loadSessionSnapshot } from './staging-live-agent-sessions.ts'
import { bearerJson, timedFetch } from './staging-live-http.ts'
import { loadChronologicalSessionHistory } from './staging-live-pagination.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const WAIT_REQUEST_TIMEOUT_MS = 780_000
const MAX_CONTINUATIONS = 2

export interface ForegroundSessionWaitsEvidence {
  root: WaitEvidence
  child: WaitEvidence
  parentFollowUp: WaitEvidence
  ask: WaitEvidence
  answer: WaitEvidence
  abortRecovery: WaitEvidence & { observerAborted: true; matchingPromptCount: number }
  background: {
    sessionId: string
    responseDurationMs: number
    dispatched: false
    statusObservedAfterResponse: 'running'
  }
  liveCoverageGap: 'no-safe-transient-outage-control;720-second-timeout-unit-tested'
}

interface WaitEvidence {
  sessionId: string
  inputSeq: number
  terminalSeq: number
  terminalType: string
  requestDurationMs: number
  continuations: number
}

export function deterministicSessionWaitRequestId(runId: string, label: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(`${runId}:${label}`).digest().subarray(0, 16),
  )
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export async function runForegroundSessionWaitsJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<ForegroundSessionWaitsEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'foreground-session-waits',
    label: 'Foreground Session Waits',
    onProgress: options.onProgress,
    run: async context => await runForegroundSessionWaitsAcceptance(context),
  })
}

export async function runForegroundSessionWaitsAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<ForegroundSessionWaitsEvidence> {
  const { env, workspace, apiToken, runId, progress, artifacts } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`

  progress('foreground-session-waits:1-root')
  const rootPrompt = `Reply with FOREGROUND-ROOT-${runId} and no other text.`
  const root = await submitWait(context, `${base}/wait`, {
    prompt: rootPrompt,
    clientRequestId: deterministicSessionWaitRequestId(runId, 'root'),
  })
  recordSessionCleanup(context, root.response.sessionId, 'root')
  await assertTerminalInHistory(context, root.response)

  progress('foreground-session-waits:2-child')
  const child = await submitWait(context, `${base}/${root.response.sessionId}/sessions/wait`, {
    prompt: `Reply with FOREGROUND-CHILD-${runId} and no other text.`,
    clientRequestId: deterministicSessionWaitRequestId(runId, 'child'),
  })
  recordSessionCleanup(context, child.response.sessionId, 'child')
  const childSnapshot = await loadSessionSnapshot(
    env,
    workspace.slug,
    child.response.sessionId,
    apiToken,
  )
  assert.equal(
    childSnapshot.createdBySessionId,
    root.response.sessionId,
    'foreground child did not preserve parent lineage',
  )
  await assertTerminalInHistory(context, child.response)

  progress('foreground-session-waits:3-parent-follow-up')
  const parentFollowUp = await submitWait(
    context,
    `${base}/${root.response.sessionId}/messages/wait`,
    {
      prompt: `Reply with PARENT-FOLLOW-UP-${runId} and no other text.`,
      behavior: 'follow_up',
      sourceSessionId: child.response.sessionId,
      clientRequestId: deterministicSessionWaitRequestId(runId, 'parent-follow-up'),
    },
  )
  assert.equal(
    parentFollowUp.response.sessionId,
    root.response.sessionId,
    'parent follow-up changed canonical session identity',
  )

  progress('foreground-session-waits:4-ask-answer')
  const ask = await submitWait(context, `${base}/wait`, {
    prompt:
      'Ask the user exactly one question using ask_user_question: "What code word should I repeat?" Do not answer it yourself.',
    clientRequestId: deterministicSessionWaitRequestId(runId, 'ask'),
  })
  recordSessionCleanup(context, ask.response.sessionId, 'ask')
  assert.equal(ask.response.terminal.event.type, 'ask', 'ask fixture did not stop at an ask')
  const answer = await submitWait(context, `${base}/${ask.response.sessionId}/answer/wait`, {
    answer: 'ORCHID',
    clientRequestId: deterministicSessionWaitRequestId(runId, 'answer'),
  })
  assert.equal(answer.response.sessionId, ask.response.sessionId, 'answer changed session identity')

  progress('foreground-session-waits:5-abort-recovery')
  const abortPrompt = `Before replying with ABORT-RECOVERED-${runId}, inspect the current time twice.`
  const abortRequest = {
    prompt: abortPrompt,
    behavior: 'follow_up' as const,
    clientRequestId: deterministicSessionWaitRequestId(runId, 'abort-recovery'),
  }
  const abortController = new AbortController()
  const aborted = timedFetch(
    `${base}/${root.response.sessionId}/messages/wait`,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify(abortRequest),
      signal: abortController.signal,
    },
    artifacts,
  )
  await waitForPromptDurable(context, root.response.sessionId, root.response.inputSeq, abortPrompt)
  abortController.abort(new Error('intentional observer disconnect'))
  await assert.rejects(aborted, 'foreground observer completed before the intentional disconnect')

  const abortRecovery = await submitWait(
    context,
    `${base}/${root.response.sessionId}/messages/wait`,
    abortRequest,
  )
  const abortHistory = await historyAfter(context, root.response.sessionId, root.response.inputSeq)
  const matchingPromptCount = abortHistory.events.filter(
    row => row.event.type === 'prompt_submitted' && row.event.prompt === abortPrompt,
  ).length
  assert.equal(matchingPromptCount, 1, 'same-id recovery duplicated the durable input')

  progress('foreground-session-waits:6-background')
  const backgroundStartedAt = Date.now()
  const backgroundResponse = await timedFetch(
    base,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({
        prompt: `Run the shell command \`sleep 30\`. Only after it finishes, reply with BACKGROUND-${runId}.`,
      }),
      signal: AbortSignal.timeout(360_000),
    },
    artifacts,
  )
  const backgroundResponseDurationMs = Date.now() - backgroundStartedAt
  assert.equal(backgroundResponse.status, 201, 'background create did not retain HTTP 201')
  const background = SessionCreateResponseSchema.parse(await backgroundResponse.json())
  recordSessionCleanup(context, background.session.sessionId, 'background')
  const backgroundSnapshotObservedAfterResponse = await loadSessionSnapshot(
    env,
    workspace.slug,
    background.session.sessionId,
    apiToken,
  )
  assert.equal(
    backgroundSnapshotObservedAfterResponse.turnStatus,
    'running',
    'background create waited for the session terminal before returning',
  )

  const evidence: ForegroundSessionWaitsEvidence = {
    root: waitEvidence(root),
    child: waitEvidence(child),
    parentFollowUp: waitEvidence(parentFollowUp),
    ask: waitEvidence(ask),
    answer: waitEvidence(answer),
    abortRecovery: {
      ...waitEvidence(abortRecovery),
      observerAborted: true,
      matchingPromptCount,
    },
    background: {
      sessionId: background.session.sessionId,
      responseDurationMs: backgroundResponseDurationMs,
      dispatched: background.dispatched,
      statusObservedAfterResponse: backgroundSnapshotObservedAfterResponse.turnStatus,
    },
    liveCoverageGap: 'no-safe-transient-outage-control;720-second-timeout-unit-tested',
  }
  await artifacts.writeJson('foreground-session-waits.json', evidence)
  return evidence
}

export async function submitWait(
  context: WorkspaceBrowserJourneyContext,
  path: string,
  initialBody: Record<string, unknown>,
): Promise<{
  response: SessionWaitCompletedResponse
  requestDurationMs: number
  continuations: number
}> {
  const startedAt = Date.now()
  for (let continuations = 0; continuations <= MAX_CONTINUATIONS; continuations += 1) {
    const response = await timedFetch(
      path,
      {
        method: 'POST',
        headers: bearerJson(context.apiToken),
        body: JSON.stringify(initialBody),
        signal: AbortSignal.timeout(WAIT_REQUEST_TIMEOUT_MS),
      },
      context.artifacts,
    )
    const parsed = await parseForegroundSessionWaitResponse(response)
    if ('terminal' in parsed) {
      return { response: parsed, requestDurationMs: Date.now() - startedAt, continuations }
    }
  }
  throw new Error('Foreground wait exhausted bounded continuation attempts')
}

export async function parseForegroundSessionWaitResponse(response: Response) {
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`foreground wait returned HTTP ${response.status}: ${await response.text()}`)
  }
  return SessionWaitResponseSchema.parse(await response.json())
}

async function assertTerminalInHistory(
  context: WorkspaceBrowserJourneyContext,
  wait: SessionWaitCompletedResponse,
): Promise<void> {
  const history = await historyAfter(context, wait.sessionId, wait.inputSeq)
  assert(
    history.events.some(
      row => row.seq === wait.terminal.seq && row.event.type === wait.terminal.event.type,
    ),
    'history after inputSeq omitted the foreground terminal',
  )
}

async function historyAfter(
  context: WorkspaceBrowserJourneyContext,
  sessionId: string,
  inputSeq: number,
) {
  return await loadChronologicalSessionHistory(
    `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/agent/sessions/${sessionId}/history?afterSeq=${inputSeq}`,
    context.apiToken,
    'history after input sequence',
    context.artifacts,
  )
}

async function waitForPromptDurable(
  context: WorkspaceBrowserJourneyContext,
  sessionId: string,
  afterSeq: number,
  prompt: string,
): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const history = await historyAfter(context, sessionId, afterSeq)
    if (
      history.events.some(
        row => row.event.type === 'prompt_submitted' && row.event.prompt === prompt,
      )
    ) {
      return
    }
    if (Date.now() >= deadline) throw new Error('aborted wait input did not become durable')
    await Bun.sleep(250)
  }
}

function waitEvidence(result: Awaited<ReturnType<typeof submitWait>>): WaitEvidence {
  return {
    sessionId: result.response.sessionId,
    inputSeq: result.response.inputSeq,
    terminalSeq: result.response.terminal.seq,
    terminalType: result.response.terminal.event.type,
    requestDurationMs: result.requestDurationMs,
    continuations: result.continuations,
  }
}

function recordSessionCleanup(
  context: WorkspaceBrowserJourneyContext,
  sessionId: string,
  role: string,
): void {
  const { env, workspace, apiToken, runId, ledger, convex } = context
  ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${runId}:foreground-session-waits:${role}:${sessionId}`,
    cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
}
