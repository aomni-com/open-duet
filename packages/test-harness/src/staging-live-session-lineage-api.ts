import assert from 'node:assert/strict'

import {
  SessionCreateResponseSchema,
  SessionListPageSchema,
  SessionSummarySchema,
  type SessionBucket,
  type SessionListPage,
  type SessionSnapshot,
  type SessionSummary,
} from '@repo/contract'

import { provisionStagingAgent } from './staging-live-agent-fixture.ts'
import {
  DEFAULT_SESSION_WAIT_MS,
  deleteStagingSession,
  loadSessionSnapshot,
  waitForSessionSnapshot,
} from './staging-live-agent-sessions.ts'
import { fnQuery } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, timedFetch } from './staging-live-http.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

// A create is held open until the gateway has the prompt durably; without a
// ceiling a hung gateway would stall the whole run, so cap it at the same
// bound the deletion sweep gets.
const CREATE_REQUEST_TIMEOUT_MS = 360_000
const DELETE_WAIT_MS = 360_000
const POLL_MS = 2_000

type DeletionCensusEntry = {
  sessionId: string
  canonical: number
  deletionWork: number
  dependents: {
    events: number
    relayReceipts: number
    images: number
    reads: number
    memberStates: number
    discovery: number
    toolRouter: number
  }
}

type PublicAbsenceTransition = {
  at: number
  statusBySession: Record<string, number>
}

export type SessionLineageApiEvidence = {
  agents: {
    plain: { id: string; slug: string }
    machine: { id: string; slug: string }
  }
  sessions: {
    control: string
    parent: string
    plainChild: string
    machineChild: string
    grandchild: string
  }
  lineage: {
    topLevel: SessionListPage
    directChildren: SessionListPage
    grandchildren: SessionListPage
    limitOne: SessionListPage[]
    buckets: Record<'done' | 'scheduled', SessionListPage>
  }
  archive: {
    before: Record<string, SessionSnapshot['archive']>
    response: SessionSummary
    exclude: SessionListPage
    only: SessionListPage
    after: Record<string, SessionSnapshot['archive']>
  }
  deletion: {
    status: number
    body: string
    publicAbsenceTransitions: PublicAbsenceTransition[]
    censusBefore: DeletionCensusEntry[]
    censusTransitions: Array<{ at: number; rows: DeletionCensusEntry[] }>
    censusFinal: DeletionCensusEntry[]
  }
  controlSurvived: SessionSnapshot
}

export async function runSessionLineageApiJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<SessionLineageApiEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'session-lineage-api',
    label: 'Session Lineage API',
    onProgress: options.onProgress,
    run: runSessionLineageApiAcceptance,
  })
}

export async function runSessionLineageApiAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<SessionLineageApiEvidence> {
  const { env, workspace, apiToken, runId, artifacts, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`

  progress('session-lineage-api:agents')
  const plainAgent = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: 'lineage-plain',
    name: `Lineage Plain ${runId}`,
    description: 'Owns the plain direct child in the session-lineage acceptance tree.',
    ledger: context.ledger,
    convex: context.convex,
    artifacts,
  })
  const machineAgent = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: 'lineage-machine',
    name: `Lineage Machine ${runId}`,
    description: 'Owns the scheduled direct child in the session-lineage acceptance tree.',
    ledger: context.ledger,
    convex: context.convex,
    artifacts,
  })
  progress('session-lineage-api:create-tree')
  const control = await createSession(context, base, 'control', {
    prompt: 'Reply with CONTROL-OK and no other text.',
  })
  await waitForBucket(context, control, 'done')
  const parent = await createSession(context, base, 'parent', {
    prompt: 'Reply with PARENT-OK and no other text.',
  })
  await waitForBucket(context, parent, 'done')
  const plainChild = await createSession(context, `${base}/${parent}/sessions`, 'plain-child', {
    prompt: 'Reply with PLAIN-CHILD-OK and no other text.',
    cwd: plainAgent.anchorPath,
  })
  const plainSnapshot = await waitForBucket(context, plainChild, 'done')
  const machineChild = await createSession(context, `${base}/${parent}/sessions`, 'machine-child', {
    prompt: 'Start the supplied scheduled state machine.',
    cwd: machineAgent.anchorPath,
    mode: {
      name: `Lineage machine ${runId}`,
      prompt: 'Wait for the scheduled wake, then finish.',
      states: [
        { name: 'wait', kind: 'timer', wakeAfterMs: '1h' },
        { name: 'done', kind: 'terminal', status: 'completed' },
      ],
    },
  })
  // Async creation can return before the session is readable, so wait for the
  // public scheduled state before using this child as the next parent.
  const machineSnapshot = await waitForBucket(context, machineChild, 'scheduled')
  const grandchild = await createSession(
    context,
    `${base}/${machineChild}/sessions`,
    'grandchild',
    {
      prompt: 'Reply with GRANDCHILD-OK and no other text.',
      cwd: plainAgent.anchorPath,
    },
  )
  const sessions = { control, parent, plainChild, machineChild, grandchild }

  assert.equal(plainSnapshot.createdBySessionId, parent, 'plain child lost its parent')
  assert.equal(machineSnapshot.createdBySessionId, parent, 'machine child lost its parent')
  assert.equal(plainSnapshot.agent?.id, plainAgent.id, 'plain child has the wrong owner')
  assert.equal(machineSnapshot.agent?.id, machineAgent.id, 'machine child has the wrong owner')

  progress('session-lineage-api:lineage-reads')
  const topLevel = await loadPage(context, `${base}?topLevel=true`, 'lineage top-level page')
  assertIds(topLevel, [control, parent], 'top-level page')
  const directChildren = await loadPage(
    context,
    `${base}/${parent}/sessions`,
    'lineage direct children',
  )
  assertIds(directChildren, [plainChild, machineChild], 'direct-child page')
  const grandchildren = await loadPage(
    context,
    `${base}/${machineChild}/sessions`,
    'lineage grandchildren',
  )
  assertIds(grandchildren, [grandchild], 'grandchild page')

  const limitOneFirst = await loadPage(
    context,
    `${base}/${parent}/sessions?limit=1`,
    'lineage limit-one page one',
  )
  assert.equal(limitOneFirst.items.length, 1, 'first limit-one page did not contain one row')
  assert(limitOneFirst.nextCursor !== null, 'first limit-one page did not continue')
  const limitOneSecond = await loadPage(
    context,
    `${base}/${parent}/sessions?limit=1&cursor=${encodeURIComponent(limitOneFirst.nextCursor)}`,
    'lineage limit-one page two',
  )
  assert.equal(limitOneSecond.items.length, 1, 'second limit-one page did not contain one row')
  assert.equal(limitOneSecond.nextCursor, null, 'second limit-one page unexpectedly continued')
  assertIds(
    { items: [...limitOneFirst.items, ...limitOneSecond.items], nextCursor: null },
    [plainChild, machineChild],
    'combined limit-one pages',
  )

  const doneBucket = await loadPage(
    context,
    `${base}/${parent}/sessions?bucket=done`,
    'lineage done children',
  )
  assertBucket(doneBucket, 'done')
  assertIds(doneBucket, [plainChild], 'done child bucket')
  const scheduledBucket = await loadPage(
    context,
    `${base}/${parent}/sessions?bucket=scheduled`,
    'lineage scheduled children',
  )
  assertBucket(scheduledBucket, 'scheduled')
  assertIds(scheduledBucket, [machineChild], 'scheduled child bucket')

  progress('session-lineage-api:archive')
  const beforeArchive = await loadSnapshots(context, [parent, plainChild, machineChild, grandchild])
  const archived = SessionSummarySchema.parse(
    await apiJson(
      `${base}/${plainChild}/archive`,
      {
        method: 'PUT',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ kind: 'global', archived: true }),
      },
      200,
      'lineage archive child',
      artifacts,
    ),
  )
  assert(archived.archive.globalArchivedAt !== null, 'archived child has no global archive cause')
  const archiveExclude = await loadPage(
    context,
    `${base}/${parent}/sessions?archived=exclude`,
    'lineage active children after archive',
  )
  assertIds(archiveExclude, [machineChild], 'active children after archive')
  const archiveOnly = await loadPage(
    context,
    `${base}/${parent}/sessions?archived=only`,
    'lineage archived children',
  )
  assertIds(archiveOnly, [plainChild], 'archived children')
  const afterArchive = await loadSnapshots(context, [parent, plainChild, machineChild, grandchild])
  for (const unchangedId of [parent, machineChild, grandchild]) {
    assert.deepEqual(
      afterArchive[unchangedId]!.archive,
      beforeArchive[unchangedId]!.archive,
      `archiving the child changed ${unchangedId}`,
    )
  }

  progress('session-lineage-api:seed-read-cursors')
  for (const sessionId of [parent, plainChild, machineChild, grandchild]) {
    const snapshot = afterArchive[sessionId]!
    await apiJson(
      `${base}/${sessionId}/read`,
      {
        method: 'PUT',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ seq: snapshot.lastEventSeq }),
      },
      200,
      'lineage seed read cursor',
      artifacts,
    )
  }

  const subtreeIds = [parent, plainChild, machineChild, grandchild]
  const censusBefore = await loadDeletionCensus(context, subtreeIds)
  for (const row of censusBefore) {
    assert.equal(row.canonical, 1, `pre-delete census missed canonical ${row.sessionId}`)
    assert.equal(row.deletionWork, 0, `pre-delete census found stale work for ${row.sessionId}`)
    assert(row.dependents.events > 0, `pre-delete census missed events for ${row.sessionId}`)
    assert(row.dependents.reads > 0, `pre-delete census missed read cursor for ${row.sessionId}`)
  }

  progress('session-lineage-api:delete')
  const deleteResponse = await timedFetch(
    `${base}/${parent}`,
    { method: 'DELETE', headers: bearer(apiToken) },
    artifacts,
  )
  const deleteBody = await deleteResponse.text()
  assert.equal(deleteResponse.status, 204, 'recursive delete did not return 204')
  assert.equal(deleteBody, '', 'recursive delete 204 returned a body')

  const publicAbsenceTransitions = await waitForPublicAbsence(context, subtreeIds)
  const { transitions: censusTransitions, final: censusFinal } = await waitForPhysicalAbsence(
    context,
    subtreeIds,
  )

  const controlSurvived = await loadSessionSnapshot(env, workspace.slug, control, apiToken)
  assert.equal(controlSurvived.id, control, 'unrelated control session did not survive')

  const evidence: SessionLineageApiEvidence = {
    agents: {
      plain: { id: plainAgent.id, slug: plainAgent.slug },
      machine: { id: machineAgent.id, slug: machineAgent.slug },
    },
    sessions,
    lineage: {
      topLevel,
      directChildren,
      grandchildren,
      limitOne: [limitOneFirst, limitOneSecond],
      buckets: { done: doneBucket, scheduled: scheduledBucket },
    },
    archive: {
      before: archivesById(beforeArchive),
      response: archived,
      exclude: archiveExclude,
      only: archiveOnly,
      after: archivesById(afterArchive),
    },
    deletion: {
      status: deleteResponse.status,
      body: deleteBody,
      publicAbsenceTransitions,
      censusBefore,
      censusTransitions,
      censusFinal,
    },
    controlSurvived,
  }
  await artifacts.writeJson('session-lineage-api-transcript.json', evidence)
  return evidence
}

async function createSession(
  context: WorkspaceBrowserJourneyContext,
  url: string,
  role: string,
  body: Record<string, unknown>,
): Promise<string> {
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      url,
      {
        method: 'POST',
        headers: bearerJson(context.apiToken),
        body: JSON.stringify({ ...body, clientRequestId: crypto.randomUUID() }),
        signal: AbortSignal.timeout(CREATE_REQUEST_TIMEOUT_MS),
      },
      201,
      `lineage create ${role}`,
      context.artifacts,
    ),
  )
  const sessionId = created.session.sessionId
  recordSessionCleanup(context, sessionId, role)
  return sessionId
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
    label: `${runId}:session-lineage-api:${role}:${sessionId}`,
    cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
}

async function loadPage(
  context: WorkspaceBrowserJourneyContext,
  url: string,
  label: string,
): Promise<SessionListPage> {
  return SessionListPageSchema.parse(
    await apiJson(url, { headers: bearer(context.apiToken) }, 200, label, context.artifacts),
  )
}

function assertIds(page: SessionListPage, expected: string[], label: string): void {
  assert.deepEqual(
    page.items.map(row => row.id).sort(),
    [...expected].sort(),
    `${label} returned the wrong sessions`,
  )
}

function assertBucket(page: SessionListPage, bucket: SessionBucket): void {
  for (const row of page.items) {
    assert.equal(row.bucket, bucket, `${bucket} child page returned a ${row.bucket} row`)
  }
}

async function waitForBucket(
  context: WorkspaceBrowserJourneyContext,
  sessionId: string,
  bucket: SessionBucket,
): Promise<SessionSnapshot> {
  return await waitForSessionSnapshot(
    context.env,
    context.workspace.slug,
    sessionId,
    context.apiToken,
    snapshot =>
      snapshot.bucket === bucket && (bucket !== 'scheduled' || snapshot.machine !== undefined),
    DEFAULT_SESSION_WAIT_MS,
    { tolerateNotFound: true, artifacts: context.artifacts },
  )
}

async function loadSnapshots(
  context: WorkspaceBrowserJourneyContext,
  sessionIds: string[],
): Promise<Record<string, SessionSnapshot>> {
  return Object.fromEntries(
    await Promise.all(
      sessionIds.map(async sessionId => [
        sessionId,
        await loadSessionSnapshot(context.env, context.workspace.slug, sessionId, context.apiToken),
      ]),
    ),
  )
}

function archivesById(
  snapshots: Record<string, SessionSnapshot>,
): Record<string, SessionSnapshot['archive']> {
  return Object.fromEntries(
    Object.entries(snapshots).map(([sessionId, snapshot]) => [sessionId, snapshot.archive]),
  )
}

async function waitForPublicAbsence(
  context: WorkspaceBrowserJourneyContext,
  sessionIds: string[],
): Promise<PublicAbsenceTransition[]> {
  const deadline = Date.now() + DELETE_WAIT_MS
  const transitions: PublicAbsenceTransition[] = []
  let previous = ''
  for (;;) {
    const statusBySession = Object.fromEntries(
      await Promise.all(
        sessionIds.map(async sessionId => {
          const response = await timedFetch(
            `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/agent/sessions/${sessionId}`,
            { headers: bearer(context.apiToken) },
            context.artifacts,
          )
          assert(
            response.status === 200 || response.status === 404,
            `session absence poll returned ${response.status} for ${sessionId}`,
          )
          return [sessionId, response.status] as const
        }),
      ),
    )
    const serialized = JSON.stringify(statusBySession)
    if (serialized !== previous) {
      transitions.push({ at: Date.now(), statusBySession })
      previous = serialized
    }
    if (Object.values(statusBySession).every(status => status === 404)) return transitions
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for public subtree absence: ${serialized}`)
    }
    await Bun.sleep(POLL_MS)
  }
}

async function loadDeletionCensus(
  context: WorkspaceBrowserJourneyContext,
  sessionIds: string[],
): Promise<DeletionCensusEntry[]> {
  const rows = (await context.convex.query(
    fnQuery('testing/agentSessions:sessionDeletionCensusForTest'),
    {
      internalKey: context.env.internalKey,
      workspaceId: context.workspace._id,
      sessionIds,
    },
  )) as DeletionCensusEntry[]
  assert.deepEqual(
    rows.map(row => row.sessionId).sort(),
    [...sessionIds].sort(),
    'physical deletion census omitted or invented a session',
  )
  return rows
}

function censusIsEmpty(rows: DeletionCensusEntry[]): boolean {
  return rows.every(
    row =>
      row.canonical === 0 &&
      row.deletionWork === 0 &&
      Object.values(row.dependents).every(count => count === 0),
  )
}

async function waitForPhysicalAbsence(
  context: WorkspaceBrowserJourneyContext,
  sessionIds: string[],
): Promise<{
  transitions: Array<{ at: number; rows: DeletionCensusEntry[] }>
  final: DeletionCensusEntry[]
}> {
  const deadline = Date.now() + DELETE_WAIT_MS
  const transitions: Array<{ at: number; rows: DeletionCensusEntry[] }> = []
  let previous = ''
  for (;;) {
    const rows = await loadDeletionCensus(context, sessionIds)
    const serialized = JSON.stringify(rows)
    if (serialized !== previous) {
      transitions.push({ at: Date.now(), rows })
      previous = serialized
    }
    if (censusIsEmpty(rows)) return { transitions, final: rows }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for physical subtree cleanup: ${serialized}`)
    }
    await Bun.sleep(POLL_MS)
  }
}
