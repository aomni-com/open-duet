import assert from 'node:assert/strict'

import {
  AgentSessionTimelineEventSchema,
  isTranscriptEvent,
  SessionCreateResponseSchema,
  SessionHistoryPageSchema,
  type SessionHistoryPage,
} from '@repo/contract'

import {
  DEFAULT_SESSION_WAIT_MS,
  deleteStagingSession,
  waitForSessionSnapshot,
} from './staging-live-agent-sessions.ts'
import { apiJson, bearer, bearerJson } from './staging-live-http.ts'
import { collectOpaquePages } from './staging-live-pagination.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const CREATE_REQUEST_TIMEOUT_MS = 360_000

export type SessionTranscriptViewEvidence = {
  sessionId: string
  timelineRows: number
  transcriptRows: number
  taskRowsSkipped: number
  transcriptPages: number
  cursorBoundToView: true
}

/**
 * The history route's transcript view against a deployed API: a real turn
 * that ran a shell command has task rows the reader never sees, and the
 * transcript view pages exactly the rows the shared predicate keeps, through
 * cursors that stay bound to that view.
 */
export async function runSessionTranscriptViewJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<SessionTranscriptViewEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'session-transcript-view',
    label: 'Session Transcript View',
    onProgress: options.onProgress,
    run: runSessionTranscriptViewAcceptance,
  })
}

export async function runSessionTranscriptViewAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<SessionTranscriptViewEvidence> {
  const { env, workspace, apiToken, runId, artifacts, progress, ledger, convex } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`

  progress('session-transcript-view:create')
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      base,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          prompt:
            'Run the shell command `echo TRANSCRIPT-OK` with your bash tool, then reply with only its output.',
          clientRequestId: crypto.randomUUID(),
        }),
        signal: AbortSignal.timeout(CREATE_REQUEST_TIMEOUT_MS),
      },
      201,
      'transcript-view create',
      artifacts,
    ),
  )
  const sessionId = created.session.sessionId
  ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${runId}:session-transcript-view:${sessionId}`,
    cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  await waitForSessionSnapshot(
    env,
    workspace.slug,
    sessionId,
    apiToken,
    snapshot => snapshot.bucket === 'done',
    DEFAULT_SESSION_WAIT_MS,
    { tolerateNotFound: true, artifacts },
  )

  progress('session-transcript-view:pages')
  const historyPath = `${base}/${sessionId}/history`
  const readPage = async (query: string, label: string): Promise<SessionHistoryPage> =>
    SessionHistoryPageSchema.parse(
      await apiJson(
        `${historyPath}?${query}`,
        { headers: bearer(apiToken) },
        200,
        label,
        artifacts,
      ),
    )
  const timeline = await collectOpaquePages(async cursor =>
    readPage(
      `order=asc${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      'transcript-view full timeline',
    ),
  )
  let transcriptPages = 0
  const transcript = await collectOpaquePages(async cursor => {
    transcriptPages += 1
    return await readPage(
      `view=transcript&order=asc&limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      'transcript-view transcript page',
    )
  })

  const taskRows = timeline.filter(
    row => !isTranscriptEvent(AgentSessionTimelineEventSchema.parse(row.event)),
  )
  assert(taskRows.length > 0, 'the turn recorded no task rows, so the view had nothing to skip')
  assert.deepEqual(
    transcript.map(row => row.seq),
    timeline
      .filter(row => isTranscriptEvent(AgentSessionTimelineEventSchema.parse(row.event)))
      .map(row => row.seq),
    'transcript view did not page exactly the rows the shared predicate keeps',
  )
  assert(transcriptPages > 1, 'transcript view did not continue across pages')

  progress('session-transcript-view:cursor-binding')
  const firstTranscriptPage = await readPage('view=transcript&limit=1', 'transcript-view page one')
  assert(firstTranscriptPage.nextCursor !== null, 'transcript page one did not continue')
  await apiJson(
    `${historyPath}?cursor=${encodeURIComponent(firstTranscriptPage.nextCursor)}`,
    { headers: bearer(apiToken) },
    400,
    'transcript-view cursor rebound to the full timeline',
    artifacts,
  )

  return {
    sessionId,
    timelineRows: timeline.length,
    transcriptRows: transcript.length,
    taskRowsSkipped: taskRows.length,
    transcriptPages,
    cursorBoundToView: true,
  }
}
