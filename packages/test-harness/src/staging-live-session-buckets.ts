/* ============================================================================
   One list, four buckets, live.

   What this journey exists to prove is the thing no local test can: that the
   merged list is what a *deployed* Convex actually serves. The bucket is a
   materialised column and the index's leading key, so a schema that did not
   deploy, a backfill that did not run, or a stale function bundle all show up
   here as rows in the wrong bucket — and nowhere else.

   ---- what is deliberately not here ----
   Two members proving a read cursor does not leak between them. That is the
   sharpest claim slice 07 makes, and it is covered by three backend tests
   against a real Convex; putting it here would cost the full invite-and-mailbox
   flow, because a second workspace member on staging can only be made the way a
   human makes one. Recorded rather than dropped: see the spec's `choices.md`.
   ========================================================================= */
import assert from 'node:assert/strict'

import {
  SESSION_BUCKETS,
  SessionActivityResponseSchema,
  SessionListPageSchema,
  type SessionBucket,
} from '@repo/contract'

import { waitForSessionSnapshot } from './staging-live-agent-sessions.ts'
import { apiJson, bearer, bearerJson } from './staging-live-http.ts'
import { loadAllSessionListItems } from './staging-live-pagination.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const TURN_WAIT_MS = 180_000

export type SessionBucketsEvidence = {
  conversationId: string
  jobId: string
  /** every bucket the journey observed a row in, in the order it saw them */
  bucketsSeen: readonly SessionBucket[]
  unreadCleared: boolean
}

export async function runSessionBucketsJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<SessionBucketsEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'session-buckets',
    label: 'Session Buckets',
    onProgress: options.onProgress,
    run: async context => await runSessionBucketsAcceptance(context),
  })
}

export async function runSessionBucketsAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<SessionBucketsEvidence> {
  const { env, workspace, apiToken, artifacts, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const listPage = async (query: string, label: string) =>
    SessionListPageSchema.parse(
      await apiJson(
        `${base}/agent/sessions${query}`,
        { headers: bearer(apiToken) },
        200,
        label,
        artifacts,
      ),
    )
  const listAll = async (query: string, label: string) =>
    await loadAllSessionListItems(`${base}/agent/sessions${query}`, apiToken, label, artifacts)

  /* Two sessions that used to live in two different products: a plain
     conversation, and one that asks a question and therefore waits on a person.
     Both are ordinary sessions on the wire — which is the claim. */
  progress('session-buckets:create')
  const conversationId = await startSession(
    base,
    apiToken,
    artifacts,
    'Say the single word: ready.',
  )
  const jobId = await startSession(
    base,
    apiToken,
    artifacts,
    'Ask me one clarifying question and wait for my answer before doing anything else.',
  )

  progress('session-buckets:settle')
  const conversation = await waitForSessionSnapshot(
    env,
    workspace.slug,
    conversationId,
    apiToken,
    snapshot => snapshot.bucket !== 'running',
    TURN_WAIT_MS,
    { artifacts },
  )
  const job = await waitForSessionSnapshot(
    env,
    workspace.slug,
    jobId,
    apiToken,
    snapshot => snapshot.bucket !== 'running',
    TURN_WAIT_MS,
    { artifacts },
  )

  /* One list holds both. Before this feature these were two endpoints, and a
     session running a state machine was structurally absent from the one a
     person's list was drawn from. */
  progress('session-buckets:one-list')
  const everything = await listAll('', 'session buckets unified list')
  const ids = new Set(everything.map(row => row.id))
  assert(ids.has(conversationId), 'the conversation is missing from the one list')
  assert(ids.has(jobId), 'the question-asking session is missing from the one list')

  /* Every row the unfiltered list returns must reappear under its own bucket
     filter, and under no other. That is the materialised column and the index
     prefix agreeing with each other on a deployed Convex — the one thing a
     local suite cannot check, because locally they are the same process. */
  progress('session-buckets:filters-agree')
  const byBucket = new Map<SessionBucket, Set<string>>()
  for (const bucket of SESSION_BUCKETS) {
    const items = await listAll(`?bucket=${bucket}`, `session buckets ${bucket}`)
    for (const row of items) {
      assert.equal(row.bucket, bucket, `${bucket} filter returned a ${row.bucket} row`)
    }
    byBucket.set(bucket, new Set(items.map(row => row.id)))
  }
  for (const row of everything) {
    const inBucket = byBucket.get(row.bucket)
    assert(
      inBucket?.has(row.id),
      `${row.id} is a ${row.bucket} row the ${row.bucket} filter missed`,
    )
    for (const [bucket, members] of byBucket) {
      if (bucket === row.bucket) continue
      assert(!members.has(row.id), `${row.id} appeared in both ${row.bucket} and ${bucket}`)
    }
  }

  /* A cursor belongs to one bucket's index range, so paging must not walk out
     of it. A single-row page is the sharpest form of that: whatever comes back
     next, every row still carries the bucket that was asked for. */
  progress('session-buckets:paging-stays-in-range')
  const firstPage = await listPage('?bucket=done&limit=1', 'session buckets done page one')
  if (firstPage.nextCursor !== null) {
    const secondPage = await listPage(
      `?bucket=done&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      'session buckets done page two',
    )
    for (const row of secondPage.items) {
      assert.equal(row.bucket, 'done', 'a cursor walked out of its own bucket')
    }
    assert(
      !secondPage.items.some(row => firstPage.items.some(seen => seen.id === row.id)),
      'the second page repeated a row from the first',
    )
  }

  /* The ring's read, against the rows it summarises. It is a different query
     family — prioritized and bounded per owner rather than paged — so agreeing
     with the list is not automatic, including for completed history. */
  progress('session-buckets:activity-agrees')
  const activity = SessionActivityResponseSchema.parse(
    await apiJson(
      `${base}/agent/sessions/activity`,
      { headers: bearer(apiToken) },
      200,
      'session buckets activity',
      artifacts,
    ),
  )
  for (const owner of activity.owners) {
    for (const row of owner.sessions) {
      const listed = everything.find(seen => seen.id === row.id)
      assert(listed !== undefined, `activity returned ${row.id}, which the list does not have`)
      assert.equal(listed.bucket, row.bucket, `${row.id} buckets differently in the two reads`)
    }
  }

  /* Unread, end to end, against a deployed cursor table. Everything here is
     the owner's own — the two-member isolation is the backend's to prove. */
  progress('session-buckets:unread')
  const unreadBefore = everything.find(row => row.id === jobId)
  assert(unreadBefore !== undefined, 'the question-asking session vanished between reads')
  assert(unreadBefore.unread, 'a session nobody has opened came back already read')

  await apiJson(
    `${base}/agent/sessions/${jobId}/read`,
    {
      method: 'PUT',
      headers: bearerJson(apiToken),
      body: JSON.stringify({ seq: unreadBefore.lastEventSeq }),
    },
    200,
    'session buckets mark read',
    artifacts,
  )
  const afterRead = await listAll('', 'session buckets after read')
  const cleared = afterRead.find(row => row.id === jobId)
  assert(cleared !== undefined, 'the session vanished after being read')
  assert(!cleared.unread, 'the read cursor did not clear unread')
  /* The row must not have *moved*. The stamp writes a cursor, never the
     session — a list ordered by `updatedAt` that resorted when someone looked
     at a row would be unusable. */
  assert.equal(cleared.updatedAt, unreadBefore.updatedAt, 'reading a session moved it in the list')

  return {
    conversationId,
    jobId,
    bucketsSeen: [conversation.bucket, job.bucket],
    unreadCleared: true,
  }
}

async function startSession(
  base: string,
  apiToken: string,
  artifacts: WorkspaceBrowserJourneyContext['artifacts'],
  prompt: string,
): Promise<string> {
  const created = await apiJson<{ session: { sessionId: string } }>(
    `${base}/agent/sessions`,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({ prompt, clientRequestId: crypto.randomUUID() }),
    },
    201,
    'session buckets create',
    artifacts,
  )
  return created.session.sessionId
}
