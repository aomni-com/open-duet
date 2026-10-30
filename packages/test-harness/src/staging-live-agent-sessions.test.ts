import { afterEach, expect, test } from 'bun:test'

import type { SessionSnapshot } from '@repo/contract'

import {
  deleteStagingSession,
  waitForJobProjection,
  waitForSessionSnapshot,
} from './staging-live-agent-sessions.ts'

interface RequestRecord {
  method: string
  pathname: string
  authorization: string | null
}

const servers: Bun.Server<unknown>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true)))
})

function serve(handler: (request: Request, requests: RequestRecord[]) => Response): {
  apiUrl: string
  requests: RequestRecord[]
} {
  const requests: RequestRecord[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push({
        method: request.method,
        pathname: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
      })
      return handler(request, requests)
    },
  })
  servers.push(server)
  return { apiUrl: server.url.origin, requests }
}

const snapshot: SessionSnapshot = {
  id: 'session_1',
  workspaceId: 'workspace_1',
  turnStatus: 'complete',
  bucket: 'done',
  title: 'Fixture',
  titleOrigin: 'excerpt',
  titleStatus: 'complete',
  lastEventSeq: 0,
  lastDeliveredInputSeq: 0,
  unread: false,
  audience: { kind: 'workspace' },
  archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
  permissions: {
    send: true,
    answer: true,
    interrupt: true,
    rename: true,
    manageAudience: true,
    personalArchive: false,
    globalArchive: true,
    delete: true,
  },
  createdAt: 1,
  updatedAt: 1,
}

test('session cleanup sends the public DELETE and accepts empty 204 or already-missing 404', async () => {
  const gone = serve(() => new Response(null, { status: 204 }))
  await deleteStagingSession({ apiUrl: gone.apiUrl }, 'workspace', 'session', 'token')
  expect(gone.requests).toEqual([
    {
      method: 'DELETE',
      pathname: '/v1/ws/workspace/agent/sessions/session',
      authorization: 'Bearer token',
    },
  ])

  const alreadyMissing = serve(() => Response.json({ error: 'not_found' }, { status: 404 }))
  await deleteStagingSession({ apiUrl: alreadyMissing.apiUrl }, 'workspace', 'session', 'token')
})

test('session cleanup rejects any other delete status', async () => {
  const accepted = serve(() => new Response(null, { status: 202 }))
  await expect(
    deleteStagingSession({ apiUrl: accepted.apiUrl }, 'workspace', 'session', 'token'),
  ).rejects.toThrow('session cleanup returned 202')

  const ok = serve(() => Response.json({ deleted: true }, { status: 200 }))
  await expect(
    deleteStagingSession({ apiUrl: ok.apiUrl }, 'workspace', 'session', 'token'),
  ).rejects.toThrow('session cleanup returned 200')
})

test('a snapshot wait can outlast the 404 an async create leaves behind', async () => {
  const eventually = serve((_request, requests) =>
    requests.length < 3 ? new Response(null, { status: 404 }) : Response.json(snapshot),
  )
  const settled = await waitForSessionSnapshot(
    { apiUrl: eventually.apiUrl },
    'workspace',
    'session_1',
    'token',
    candidate => candidate.bucket === 'done',
    10_000,
    { tolerateNotFound: true },
  )
  expect(settled).toEqual(snapshot)
  expect(eventually.requests).toHaveLength(3)
  expect(eventually.requests[0]).toEqual({
    method: 'GET',
    pathname: '/v1/ws/workspace/agent/sessions/session_1',
    authorization: 'Bearer token',
  })
})

test('a snapshot wait still refuses a 404 unless the caller tolerates one', async () => {
  const missing = serve(() => new Response(null, { status: 404 }))
  await expect(
    waitForSessionSnapshot(
      { apiUrl: missing.apiUrl },
      'workspace',
      'session_1',
      'token',
      () => true,
      10_000,
    ),
  ).rejects.toThrow('staging session snapshot expected HTTP 200, got 404')
  expect(missing.requests).toHaveLength(1)
})

test('a snapshot wait preserves caller context and cwd in timeout diagnostics', async () => {
  const readable = serve(() => Response.json({ ...snapshot, cwd: 'welcome/hello-app' }))
  await expect(
    waitForSessionSnapshot(
      { apiUrl: readable.apiUrl },
      'workspace',
      'session_1',
      'token',
      () => false,
      0,
      { timeoutLabel: 'session app pane moved snapshot' },
    ),
  ).rejects.toThrow(
    'Timed out waiting for session app pane moved snapshot: {"status":"complete","cwd":"welcome/hello-app"',
  )
})

test('job projection wait compares the public list machine with the point snapshot', async () => {
  let listedStep = 'verify'
  const snapshotMachine = {
    definitionName: 'deployment',
    currentState: 'verify',
    orderedPath: [{ key: 'verify', index: 0, name: 'Verify', phase: 'current' as const }],
    activity: 'running' as const,
  }
  const server = serve(request => {
    const path = new URL(request.url).pathname
    return Response.json(
      path.endsWith('/session_1')
        ? { ...snapshot, machine: snapshotMachine }
        : {
            items: [{ ...snapshot, machine: { step: listedStep, activity: 'running' } }],
            nextCursor: null,
          },
    )
  })
  const job = await waitForJobProjection(
    { apiUrl: server.apiUrl },
    'workspace',
    'session_1',
    'token',
    'finished',
    0,
  )
  expect(job.id).toBe('session_1')
  expect(job.machine).toEqual({ step: 'verify', activity: 'running' })

  listedStep = 'deploy'
  await expect(
    waitForJobProjection(
      { apiUrl: server.apiUrl },
      'workspace',
      'session_1',
      'token',
      'finished',
      0,
    ),
  ).rejects.toThrow('Timed out waiting for a finished projection')
})
