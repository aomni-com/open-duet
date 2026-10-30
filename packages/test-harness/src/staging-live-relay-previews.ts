import assert from 'node:assert/strict'

import { isKnownTimelineEvent, SessionCreateResponseSchema } from '@repo/contract'

import {
  deleteStagingSession,
  waitForSessionHistory,
  waitForSessionSnapshot,
} from './staging-live-agent-sessions.ts'
import { apiJson, bearerJson } from './staging-live-http.ts'
import type { ChronologicalSessionHistory } from './staging-live-pagination.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import type { WorkspaceBrowserJourneyContext } from './staging-live-workspace-browser.ts'

const OUTPUT_STATE = 'emit_large_relay_output'
const DONE_STATE = 'relay_preview_completed'
const PREVIEW_BYTES = 1024
const COMPLETION_MS = 120_000

export function assertRelayPreviewHistory(history: ChronologicalSessionHistory): void {
  const started = history.events.find(
    row =>
      isKnownTimelineEvent(row.event) &&
      row.event.type === 'task_started' &&
      row.event.task.name === OUTPUT_STATE,
  )
  assert(
    started && isKnownTimelineEvent(started.event) && started.event.type === 'task_started',
    'large-output script task missing',
  )
  const taskId = started.event.task.id
  let outputMarked = false
  let settlementSeq: number | undefined
  let inputMarked = false
  for (const row of history.events) {
    const event = row.event
    if (!isKnownTimelineEvent(event)) continue
    const machine =
      event.type === 'state_machine'
        ? event.stateMachine
        : 'state' in event
          ? event.state?.stateMachine
          : undefined
    for (const entry of machine?.history ?? []) {
      if ('output' in entry && entry.output !== undefined)
        assertPreview(entry.output, 'machine history output')
      if ('error' in entry) assertPreview(entry.error, 'machine history error')
      if ('reason' in entry && entry.reason !== undefined)
        assertPreview(entry.reason, 'machine history reason')
    }
    if (event.type === 'task_output' && event.taskId === taskId) {
      assertPreview(event.chunk, 'task output')
      outputMarked ||= hasMarker(event.chunk)
    }
    if (event.type === 'task_settled' && event.settlement.id === taskId) {
      assert.equal(event.settlement.status, 'completed', 'large-output script failed')
      const settlement = event.settlement
      if ('result' in settlement) assertPreview(settlement.result, 'task result')
      if ('error' in settlement) assertPreview(settlement.error, 'task error')
      if ('reason' in settlement) assertPreview(settlement.reason, 'task reason')
      assert(hasMarker(settlement), 'task settlement lacks a truncation marker')
      settlementSeq = row.seq
    }
    if (
      event.type === 'step' &&
      (event.step.type === 'tool_call' || event.step.type === 'tool_call_start')
    ) {
      if (event.step.input !== undefined) assertPreview(event.step.input, 'tool input')
      if (event.step.type === 'tool_call' && event.step.output !== undefined) {
        assertPreview(event.step.output, 'tool output')
      }
      if (event.step.type === 'tool_call' && event.step.details !== undefined) {
        assertPreview(event.step.details, 'tool details')
      }
      if (event.step.toolName === 'create_state_machine_definition') {
        inputMarked ||= hasMarker(event.step.input)
      }
    }
  }
  assert(outputMarked, 'task output lacks a truncation marker')
  assert(inputMarked, 'definition input lacks a truncation marker')
  assert(settlementSeq !== undefined, 'large-output task never settled')
  const terminal = history.events.find(
    row => row.seq > settlementSeq && row.event.type === 'complete',
  )
  assert(terminal?.event.type === 'complete', 'completion did not follow large task settlement')
  assert.equal(terminal.event.status, 'completed', 'relay turn did not complete successfully')
  assert(
    terminal.createdAt - started.createdAt <= COMPLETION_MS,
    'large-output relay completion stalled',
  )
}

function assertPreview(value: unknown, label: string): void {
  assert(
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= PREVIEW_BYTES,
    `${label} exceeds 1 KiB`,
  )
}

function hasMarker(value: unknown): boolean {
  return /\[(?:truncated|[^\]]*omitted) —/.test(JSON.stringify(value) ?? '')
}

export async function runRelayPreviewAcceptance(context: WorkspaceBrowserJourneyContext) {
  const { env, workspace, apiToken, artifacts, ledger, convex, runId, progress } = context
  progress('relay-recovery:large-output:create')
  const definition = {
    name: `Relay preview ${runId}`,
    // The real tool input is deliberately larger than its display budget too.
    prompt: `Run the script and then finish. Diagnostic padding: ${'x'.repeat(2048)}`,
    states: [
      {
        name: OUTPUT_STATE,
        kind: 'script',
        command: `python3 -c 'import sys; sys.stdout.write("x" * (350 * 1024)); sys.stderr.write("e" * (8 * 1024))'`,
      },
      { name: DONE_STATE, kind: 'terminal', status: 'completed' },
    ],
  }
  const prompt = [
    'Call create_state_machine_definition with exactly these arguments, preserving the entire diagnostic padding:',
    JSON.stringify({ definition, firstState: OUTPUT_STATE }),
    'Let the script run once, then enter the terminal state. Do not echo its output or use todo_write.',
  ].join(' ')
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`,
      { method: 'POST', headers: bearerJson(apiToken), body: JSON.stringify({ prompt }) },
      201,
      'large-output relay create',
      artifacts,
    ),
  )
  const sessionId = created.session.sessionId
  ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${runId}:relay-preview:${sessionId}`,
    cleanup: async () => {
      await deleteStagingSession(env, workspace.slug, sessionId, apiToken)
    },
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  progress('relay-recovery:large-output:complete')
  const history = await waitForSessionHistory(
    env,
    workspace.slug,
    sessionId,
    apiToken,
    history => history.events.some(row => row.event.type === 'complete'),
    240_000,
  )
  assertRelayPreviewHistory(history)
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    apiToken,
    snapshot =>
      snapshot.machineState?.currentState === DONE_STATE &&
      snapshot.machineState.terminal?.status === 'completed',
  )
  return { sessionId, eventCount: history.events.length, previewBytes: PREVIEW_BYTES }
}
