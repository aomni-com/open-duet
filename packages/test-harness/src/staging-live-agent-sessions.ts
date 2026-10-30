import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'

import {
  DefaultSessionResponseSchema,
  isKnownTimelineEvent,
  projectSessionActivityMachine,
  type SessionListItem,
  SessionSnapshotSchema,
  SessionCreateResponseSchema,
  type AgentStartSessionRequestInput,
  type SessionSnapshot,
} from '@repo/contract'

import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import type { LiveEnv } from './staging-live-env.ts'
import {
  apiJson,
  assertResponse,
  bearer,
  bearerJson,
  stagingFetch,
  timedFetch,
} from './staging-live-http.ts'
import {
  loadAllSessionListItems,
  loadChronologicalSessionHistory,
  type ChronologicalSessionHistory,
} from './staging-live-pagination.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import type { WorkspaceBrowserJourneyContext } from './staging-live-workspace-browser.ts'

/** How long a session gets to reach the state a journey is waiting on. */
export const DEFAULT_SESSION_WAIT_MS = 240_000
/** How long the first message gets to mint the default chat. */
const DEFAULT_SESSION_CREATE_WAIT_MS = 60_000
const POLL_MS = 500

function sessionSnapshotUrl(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  sessionId: string,
): string {
  return `${env.apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}`
}

export async function loadSessionSnapshot(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  sessionId: string,
  token: string,
  options: {
    artifacts?: StagingArtifactCollector
    label?: string
  } = {},
): Promise<SessionSnapshot> {
  return SessionSnapshotSchema.parse(
    await apiJson(
      sessionSnapshotUrl(env, workspaceSlug, sessionId),
      { headers: bearer(token) },
      200,
      options.label ?? 'staging session snapshot',
      options.artifacts,
    ),
  )
}

export type SessionSnapshotWaitOptions = {
  /**
   * An async create acknowledges before the session is readable, so a wait
   * that starts straight after one may see 404 first. With this set, a 404 is
   * "not yet" rather than a failure; the deadline still bounds it.
   */
  tolerateNotFound?: boolean
  /** Record each poll's timing in the run's evidence. */
  artifacts?: StagingArtifactCollector
  /** Name the journey condition in timeout evidence. */
  timeoutLabel?: string
}

export async function waitForSessionSnapshot(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  sessionId: string,
  token: string,
  predicate: (snapshot: SessionSnapshot) => boolean,
  timeoutMs = DEFAULT_SESSION_WAIT_MS,
  options: SessionSnapshotWaitOptions = {},
): Promise<SessionSnapshot> {
  const url = sessionSnapshotUrl(env, workspaceSlug, sessionId)
  const init = { headers: bearer(token) }
  const deadline = Date.now() + timeoutMs
  let latest: SessionSnapshot | undefined
  for (;;) {
    const response =
      options.artifacts === undefined
        ? await stagingFetch(url, init)
        : await timedFetch(url, init, options.artifacts)
    if (!(options.tolerateNotFound === true && response.status === 404)) {
      assertResponse(response, 200, 'staging session snapshot')
      latest = SessionSnapshotSchema.parse(await response.json())
      if (predicate(latest)) return latest
    }
    if (Date.now() >= deadline) {
      const timeoutLabel = options.timeoutLabel ?? 'staging session snapshot'
      throw new Error(
        latest === undefined
          ? `Timed out waiting for staging session ${sessionId} to become readable`
          : `Timed out waiting for ${timeoutLabel}: ${JSON.stringify({
              status: latest.turnStatus,
              cwd: latest.cwd,
              bucket: latest.bucket,
              currentState: latest.machineState?.currentState,
              relay: latest.machine,
            })}`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}

/**
 * How much of the history a timeout gets to show, and how much of each row.
 *
 * A bare `{seq, type}` list is what this dump used to be, and it cost a whole
 * hour-long run to learn nothing: when a predicate ANDs two clauses together —
 * "the steer arrived" and "the follow-up was queued" — the type alone cannot
 * say which one is missing, and every event these legs care about is
 * distinguished by a field the dump was dropping. So each row now carries the
 * one thing that identifies it, and prompts are truncated rather than omitted
 * because the predicates match them exactly.
 */
const HISTORY_TIMEOUT_TAIL = 24
const HISTORY_TIMEOUT_TEXT = 80

function describeHistoryRow(
  row: ChronologicalSessionHistory['events'][number],
): Record<string, unknown> {
  const event = row.event
  const base = { seq: row.seq, type: event.type }
  if (!isKnownTimelineEvent(event)) return base
  switch (event.type) {
    case 'prompt_submitted':
      return {
        ...base,
        behavior: event.behavior,
        prompt: event.prompt.slice(0, HISTORY_TIMEOUT_TEXT),
      }
    case 'follow_up_queue':
      return {
        ...base,
        queue: event.followUpQueue.map(entry => entry.message.slice(0, HISTORY_TIMEOUT_TEXT)),
      }
    case 'task_started':
      return { ...base, task: event.task.name, kind: event.task.kind, status: event.task.status }
    case 'task_settled':
      return { ...base, task: event.settlement.id, status: event.settlement.status }
    case 'state_machine':
      return { ...base, currentState: event.stateMachine.currentState }
    // A turn's whole tool surface lives in `step`, so a bare `{seq, type}` for
    // it is the one omission that makes a timeout unreadable: "the tool was
    // never called", "it was called and failed", and "it answered something
    // else" all render identically. Say which.
    case 'step': {
      const step = event.step
      if (step.type === 'tool_call') {
        return {
          ...base,
          step: step.type,
          toolName: step.toolName,
          isError: step.isError,
          output: (step.output ?? [])
            .map(item =>
              item.type === 'text' ? item.text.slice(0, HISTORY_TIMEOUT_TEXT) : item.type,
            )
            .join(' | '),
        }
      }
      if (step.type === 'tool_call_start')
        return { ...base, step: step.type, toolName: step.toolName }
      if (step.type === 'text' || step.type === 'reasoning') {
        return { ...base, step: step.type, text: step.text.slice(0, HISTORY_TIMEOUT_TEXT) }
      }
      if (step.type === 'system') {
        return { ...base, step: step.type, message: step.message.slice(0, HISTORY_TIMEOUT_TEXT) }
      }
      return { ...base, step: step.type }
    }
    default:
      return base
  }
}

export async function loadSessionHistory(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  sessionId: string,
  token: string,
): Promise<ChronologicalSessionHistory> {
  return await loadChronologicalSessionHistory(
    `${env.apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}/history`,
    token,
    'staging session history',
  )
}

/**
 * Until the owner's default-chat alias points at a session — the first message
 * through the composer creates it, and the read is a separate query against a
 * deployed deployment, so the answer is polled rather than assumed.
 */
export async function waitForDefaultSession(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  agentSlug: string,
  token: string,
  options: { timeoutMs?: number; label?: string; artifacts?: StagingArtifactCollector } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_CREATE_WAIT_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { session } = DefaultSessionResponseSchema.parse(
      await apiJson<unknown>(
        `${env.apiUrl}/v1/ws/${workspaceSlug}/agents/${encodeURIComponent(agentSlug)}/sessions/default`,
        { headers: bearer(token) },
        200,
        options.label ?? 'default session',
        options.artifacts,
      ),
    )
    if (session !== null) return session.id
    assert.ok(
      Date.now() < deadline,
      `the first message never created ${agentSlug}'s default chat within ${timeoutMs / 1000}s`,
    )
    await Bun.sleep(POLL_MS)
  }
}

export async function waitForSessionHistory(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  sessionId: string,
  token: string,
  predicate: (history: ChronologicalSessionHistory) => boolean,
  timeoutMs = DEFAULT_SESSION_WAIT_MS,
): Promise<ChronologicalSessionHistory> {
  const deadline = Date.now() + timeoutMs
  let latest = await loadSessionHistory(env, workspaceSlug, sessionId, token)
  for (;;) {
    if (predicate(latest)) return latest
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for staging session history: ${JSON.stringify(
          latest.events.slice(-HISTORY_TIMEOUT_TAIL).map(describeHistoryRow),
        )}`,
      )
    }
    await Bun.sleep(POLL_MS)
    latest = await loadSessionHistory(env, workspaceSlug, sessionId, token)
  }
}

/**
 * Whether a session's work is over. What `JobView` used to say.
 *
 * Not a bucket. `active` was a *union* of `asking`, `running` and `scheduled`,
 * and the list pages by one bucket at a time — so asking for `bucket=running`
 * here would silently drop the other two and still pass. The unfiltered list
 * plus this predicate cannot.
 */
export type JobPhase = 'unfinished' | 'finished'

function sessionListMachineMatchesSnapshot(
  listed: SessionListItem['machine'],
  snapshot: SessionSnapshot['machine'],
): boolean {
  return isDeepStrictEqual(listed, projectSessionActivityMachine(snapshot))
}

export async function waitForJobProjection(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  sessionId: string,
  token: string,
  phase: JobPhase,
  timeoutMs = DEFAULT_SESSION_WAIT_MS,
): Promise<SessionListItem> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await loadSessionSnapshot(env, workspaceSlug, sessionId, token)
    /* Unfiltered on purpose. One list holds conversations and machine-backed
       jobs alike, and the row is found by id rather than by which bucket it
       landed in — then the bucket is *asserted*, which is the part a filtered
       query would have assumed. */
    const listed = await loadAllSessionListItems(
      `${env.apiUrl}/v1/ws/${workspaceSlug}/agent/sessions`,
      token,
      `staging ${phase} sessions`,
    )
    const job = listed.find(candidate => candidate.id === sessionId)
    const inPhase =
      job !== undefined && (phase === 'finished' ? job.bucket === 'done' : job.bucket !== 'done')
    if (inPhase && sessionListMachineMatchesSnapshot(job.machine, snapshot.machine)) {
      return job
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for a ${phase} projection: ${JSON.stringify({
          expectedMachine: projectSessionActivityMachine(snapshot.machine),
          observedMachine: job?.machine,
          observedBucket: job?.bucket,
        })}`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}

export async function deleteStagingSession(
  env: Pick<LiveEnv, 'apiUrl'>,
  workspaceSlug: string,
  sessionId: string,
  token: string,
): Promise<void> {
  const response = await stagingFetch(
    `${env.apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}`,
    { method: 'DELETE', headers: bearer(token) },
  )
  if (response.status === 404) return
  assert.equal(response.status, 204, `session cleanup returned ${response.status}`)
  assert.equal(await response.text(), '', 'session cleanup 204 returned a response body')
}

/** Exercise normal first-use package reconciliation before strict runtime certification. */
export async function warmWorkflowRuntime(context: WorkspaceBrowserJourneyContext): Promise<void> {
  const { env, workspace, apiToken, artifacts, ledger, runId, progress } = context
  progress('workflow:runtime-first-use')
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          tier: 'balanced',
          prompt: 'Reply with runtime-ready only.',
        } satisfies AgentStartSessionRequestInput),
      },
      201,
      'workflow runtime first use',
      artifacts,
    ),
  )
  const id = created.session.sessionId
  ledger.record({
    kind: 'session',
    id,
    label: `${runId}:runtime-first-use:${id}`,
    cleanup: () => deleteStagingSession(env, workspace.slug, id, apiToken),
    verify: () => workspaceIsDeleted(context.convex, env.internalKey, workspace._id),
  })
  const history = await waitForSessionHistory(env, workspace.slug, id, apiToken, history =>
    history.events.some(
      row =>
        row.event.type === 'complete' ||
        row.event.type === 'interrupted' ||
        row.event.type === 'ask',
    ),
  )
  await artifacts.writeJson('runtime-first-use-history.json', history)
  assert(
    history.events.some(row => row.event.type === 'complete'),
    'runtime first-use session did not complete',
  )
  await deleteStagingSession(env, workspace.slug, id, apiToken)
}
