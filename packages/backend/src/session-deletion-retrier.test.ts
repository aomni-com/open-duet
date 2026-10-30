import { afterAll, beforeAll, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-session-deletion-retrier-key'

let convex: ConvexDevFixture
let callback: ReturnType<typeof Bun.serve>
let callbackRequests: Array<{ authorization: string | null; body: string; pathname: string }>

beforeAll(async () => {
  callbackRequests = []
  callback = Bun.serve({
    port: 0,
    async fetch(request) {
      callbackRequests.push({
        authorization: request.headers.get('authorization'),
        body: await request.text(),
        pathname: new URL(request.url).pathname,
      })
      if (callbackRequests.length === 1)
        return new Response('acknowledgement lost', { status: 503 })
      return Response.json({
        status: 'disposed',
        runner: 'absent',
        providerAttempted: false,
      })
    },
  })
  convex = await convexDev(BACKEND_DIR, {
    env: {
      ...generateAuthKeys(),
      ACTION_RETRIER_LOG_LEVEL: 'ERROR',
      DUET_API_INTERNAL_KEY: INTERNAL_KEY,
      DUET_API_URL: callback.url.href,
      DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
      DUET_TEST_AUTH_EMAIL: '1',
      DUET_APP_URL: 'http://localhost:3000',
    },
    reset: true,
  })
}, 240_000)

afterAll(async () => {
  await convex?.stop()
  callback?.stop(true)
})

test('a lost disposal acknowledgement retries the work-id-only callback and converges', async () => {
  const owner = await signInWithMagicLink<{ _id: string }>(
    convex,
    uniqueEmail('session-deletion-retrier'),
    'Session Deletion Retrier',
  )
  const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: `session-deletion-retrier-${Date.now()}`,
    name: 'Session deletion retrier',
  })) as string
  const session = (await convex.mutation('testing/agentSessions:createQueuedSessionForTest', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    workspaceId,
    prompt: 'Dispose me durably',
    now: 100,
  })) as { sessionId: string }

  await convex.mutation('domains/agentSessions/model:beginSessionSubtreeDeletion', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    sessionId: session.sessionId,
    now: 200,
  })

  const activeWork = await waitForExternalRun(session.sessionId)
  await convex.mutation('domains/agentSessions/model:beginSessionSubtreeDeletion', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    sessionId: session.sessionId,
    now: 201,
  })
  expect(
    (await query(convex, 'testing/agentSessions:sessionDeletionWorkForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
    })) as DeletionWork,
  ).toMatchObject({ _id: activeWork._id, externalRunId: activeWork.externalRunId })

  await waitForPhysicalAbsence(session.sessionId)
  const disposeCallback = {
    authorization: `Bearer ${INTERNAL_KEY}`,
    body: '',
    pathname: `/v1/internal/session-deletions/${activeWork._id}/dispose`,
  }
  expect(callbackRequests).toEqual([disposeCallback, disposeCallback])
  expect(
    await query(convex, 'testing/agentSessions:sessionExistsForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
    }),
  ).toBe(false)
  expect(
    await query(convex, 'testing/agentSessions:sessionDeletionWorkForTest', {
      internalKey: INTERNAL_KEY,
      sessionId: session.sessionId,
    }),
  ).toBeNull()
}, 60_000)

async function waitForPhysicalAbsence(sessionId: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const [exists, work] = await Promise.all([
      query(convex, 'testing/agentSessions:sessionExistsForTest', {
        internalKey: INTERNAL_KEY,
        sessionId,
      }),
      query(convex, 'testing/agentSessions:sessionDeletionWorkForTest', {
        internalKey: INTERNAL_KEY,
        sessionId,
      }),
    ])
    if (exists === false && work === null) return
    await Bun.sleep(50)
  }
  throw new Error('Timed out waiting for session physical deletion')
}

interface DeletionWork {
  _id: string
  childScanComplete: boolean
  externalRunId?: string
  externalState: 'pending' | 'running' | 'complete'
  sessionId: string
}

async function waitForExternalRun(sessionId: string): Promise<DeletionWork> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const work = (await query(convex, 'testing/agentSessions:sessionDeletionWorkForTest', {
      internalKey: INTERNAL_KEY,
      sessionId,
    })) as DeletionWork | null
    if (work?.externalRunId !== undefined) return work
    await Bun.sleep(25)
  }
  throw new Error('Timed out waiting for active session disposal run')
}
