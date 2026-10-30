import assert from 'node:assert/strict'

import type { SessionSnapshot } from '@repo/contract'

import { provisionStagingAgent } from './staging-live-agent-fixture.ts'
import { deleteStagingSession } from './staging-live-agent-sessions.ts'
import {
  deterministicSessionWaitRequestId,
  submitWait,
} from './staging-live-foreground-session-waits.ts'
import { apiJson, bearerJson } from './staging-live-http.ts'
import { loadChronologicalSessionHistory } from './staging-live-pagination.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

/**
 * The definition of done for specs/done/agent-delegation (D14/D16): root delegates
 * to a child through the child's home chat, the child raises exactly one ask,
 * root answers it, and the whole loop completes inside one blocking wait.
 *
 * The callee's instructions make the ask leg deterministic — a real agent only
 * asks when it happens to need something, and a journey must not hope. The
 * marker proves the second turn ran; naming the sender's slug proves the
 * envelope identity (slice 02) on the live surface, because `agent_slug` is
 * composition-time model bytes that durable history never records.
 *
 * The kill-gate probe measured the full chain at ~112s against the 720s
 * ceiling; an earlier run saw the transport cut a silent wait at 268s. Keep
 * every leg one short turn.
 */
const CALLEE_SLUG = 'scout'
const CALLEE_INSTRUCTIONS = [
  'Always ask exactly one clarifying question before doing any task you are',
  'given, using your ask tool, and stop there — do not answer it yourself.',
  'After you receive the answer, do the work briefly. End your final message',
  'by naming the agent_slug of whoever sent you the task, then the marker',
  'DELEGATION-OK.',
].join(' ')

export interface AgentDelegationEvidence {
  rootSessionId: string
  calleeSessionId: string
  rosterListedSlugs: string
  rootTerminalType: string
  rootResultNamesCallee: boolean
  calleeAskSeq: number
  calleeAskQuestion: string
  calleePromptSender: { kind: string; sessionId?: string }
  calleeAnswerSender: { kind: string; sessionId?: string }
  calleeResultCarriesMarker: boolean
  calleeResultNamesRootSlug: boolean
  rootWaitDurationMs: number
  rootContinuations: number
}

export async function runAgentDelegationJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<AgentDelegationEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'agent-delegation',
    label: 'Agent Delegation',
    onProgress: options.onProgress,
    run: async context => await runAgentDelegationAcceptance(context),
  })
}

async function runAgentDelegationAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<AgentDelegationEvidence> {
  const { env, workspace, apiToken, runId, ledger, convex, artifacts, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`

  progress('agent-delegation:1-provision-agents')
  await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: CALLEE_SLUG,
    name: 'Scout',
    description: CALLEE_INSTRUCTIONS,
    ledger,
    convex,
    artifacts,
  })
  /* Registered only so the containment rule is exercised in anger: a grandchild
     must be absent from root's roster while its parent is present. Root has no
     parent and therefore no siblings, so opening the roster to peers left this
     leg's verdict exactly where it was — the nested agent is still the only
     place a real workspace tests what the roster refuses to show. */
  await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: 'scout-helper',
    name: 'Scout Helper',
    anchorPath: 'agents/scout/helper',
    ledger,
    convex,
    artifacts,
    description: 'Do what Scout asks.',
  })

  // Roster freshness is poll-bounded by design (the recorded alternative — a
  // synchronous roster push — was deliberately not taken). One sync interval
  // is plenty; the VM polls every ~5s when active.
  progress('agent-delegation:2-roster-settle')
  await new Promise(resolve => setTimeout(resolve, 20_000))

  progress('agent-delegation:3-delegate-through-root')
  const prompt = [
    'First: list the exact slugs from the "Your agents" section of your system',
    'prompt, comma-separated, between the markers ROSTER[ and ].',
    `Then hand the agent \`${CALLEE_SLUG}\` this task: "Summarise what a`,
    'deployment summary should contain, in two sentences." If it asks you',
    'anything, answer with the date range 1-7 August. When it completes, reply',
    "with ROSTER[...], then DELEGATED, then the callee's final text verbatim.",
  ].join(' ')
  const started = Date.now()
  const root = await submitWait(context, `${base}/agents/root/sessions/default/messages/wait`, {
    prompt,
    clientRequestId: deterministicSessionWaitRequestId(runId, 'delegate'),
  })
  recordSessionCleanup(context, root.response.sessionId, 'root-default')
  const rootTerminal = root.response.terminal.event as { type: string; result?: string }
  assert.equal(rootTerminal.type, 'complete', 'root did not complete its delegation turn')
  const rootResult = rootTerminal.result ?? ''

  // The roster leg: scout listed, its nested child invisible. The word-boundary
  // check matters — 'scout-helper' contains 'scout'.
  const rosterMatch = /ROSTER\[([^\]]*)\]/.exec(rootResult)
  assert(rosterMatch !== null, `root's reply carries no ROSTER[...] block: ${rootResult}`)
  const rosterListedSlugs = rosterMatch[1] ?? ''
  assert(
    /\bscout\b/.test(rosterListedSlugs),
    `root's roster is missing scout: ${rosterListedSlugs}`,
  )
  assert(
    !rosterListedSlugs.includes('scout-helper'),
    `root's roster leaks a grandchild: ${rosterListedSlugs}`,
  )

  progress('agent-delegation:4-inspect-callee-transcript')
  const calleeSnapshot = (await apiJson(
    `${base}/agents/${CALLEE_SLUG}/sessions/default`,
    { headers: bearerJson(apiToken) },
    200,
    'callee default session snapshot',
    artifacts,
  )) as SessionSnapshot
  recordSessionCleanup(context, calleeSnapshot.id, 'callee-default')
  const history = await loadChronologicalSessionHistory(
    `${base}/agents/${CALLEE_SLUG}/sessions/default/history`,
    apiToken,
    'callee default session history',
    artifacts,
  )
  /* The timeline union is wide and this journey only fishes for a handful of
     event types, so it reads rows through one loose shape rather than
     narrowing the whole union per assertion. */
  type AnyEvent = { type: string; [key: string]: unknown }
  const events = history.events.map(row => ({ seq: row.seq, event: row.event as AnyEvent }))
  const find = (predicate: (event: AnyEvent) => boolean) => events.find(row => predicate(row.event))

  const promptRow = find(event => event.type === 'prompt_submitted')
  assert(promptRow !== undefined, 'callee history has no delivered prompt')
  const promptSender = promptRow.event.sender as { kind: string; sessionId?: string }
  assert.equal(promptSender.kind, 'session', 'callee prompt was not session-attributed')
  assert.equal(
    promptSender.sessionId,
    root.response.sessionId,
    'callee prompt is attributed to a different session than the delegating root turn',
  )

  const askRow = find(event => event.type === 'ask')
  assert(askRow !== undefined, 'callee never raised its ask terminal')
  const askQuestions = askRow.event.questions as Array<{ question: string }>
  const answerRow = find(event => event.type === 'answer_submitted')
  assert(answerRow !== undefined, 'no answer reached the callee')
  const answerSender = answerRow.event.sender as { kind: string; sessionId?: string }
  assert.equal(
    answerSender.sessionId,
    root.response.sessionId,
    'the ask was answered by someone other than the delegating root turn',
  )

  const calleeComplete = [...events].reverse().find(row => row.event.type === 'complete')
  const calleeResult = calleeComplete?.event.result as string | undefined
  assert(calleeResult !== undefined, 'callee never completed')
  assert(calleeResult.includes('DELEGATION-OK'), `callee result lacks the marker: ${calleeResult}`)
  // Live proof of slice 02: `agent_slug` exists only in the composed model
  // bytes, never in durable history — the only witness is the callee itself.
  const calleeResultNamesRootSlug = /\broot\b/.test(calleeResult)
  assert(calleeResultNamesRootSlug, `callee could not name its sender: ${calleeResult}`)

  const evidence: AgentDelegationEvidence = {
    rootSessionId: root.response.sessionId,
    calleeSessionId: calleeSnapshot.id,
    rosterListedSlugs,
    rootTerminalType: rootTerminal.type,
    rootResultNamesCallee: rootResult.includes('DELEGATED'),
    calleeAskSeq: askRow.seq,
    calleeAskQuestion: askQuestions[0]?.question ?? '',
    calleePromptSender: promptSender,
    calleeAnswerSender: answerSender,
    calleeResultCarriesMarker: true,
    calleeResultNamesRootSlug,
    rootWaitDurationMs: Date.now() - started,
    rootContinuations: root.continuations,
  }
  await artifacts.writeJson('agent-delegation.json', evidence)
  return evidence
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
    label: `${runId}:agent-delegation:${role}:${sessionId}`,
    cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
}
