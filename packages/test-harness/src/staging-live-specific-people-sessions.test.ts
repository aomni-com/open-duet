import { expect, test } from 'bun:test'
import { join } from 'node:path'

import { BACKEND_SCHEMA_VERSION, WEB_CACHE_SCHEMA_VERSION } from '@repo/contract'

import { productionConvexDeployment, productionReleaseOrigin } from './release-target'
import {
  assertReleaseDeployment,
  assertSpecificPeopleDocsContract,
  verifyReleaseDeploymentTarget,
} from './staging-live-deployment'
import {
  assertNoLegacySessionWireFields,
  isRemovedMemberSessionDenial,
  isRemovedMemberSessionDenialBody,
  isSpecificSessionCreationResponse,
  specificPeopleBrowserExpectations,
  waitForStableSessionLinkAbsence,
  waitForRemovedSessionBrowserSurface,
} from './staging-live-specific-people-sessions'
import { runtimeManifestFixture } from './test-fixtures/runtime-manifest'

test('production release targets accept only canonical public origins and production Convex', () => {
  expect(productionReleaseOrigin('DUET_API_URL', 'https://ctl.duet.so/')).toBe(
    'https://ctl.duet.so',
  )
  expect(productionReleaseOrigin('DUET_APP_URL', 'https://app.duet.so')).toBe('https://app.duet.so')
  expect(productionReleaseOrigin('DUET_DOCS_URL', 'https://docs.duet.so')).toBe(
    'https://docs.duet.so',
  )
  for (const [name, value] of [
    ['DUET_API_URL', 'https://ctl.duet.so:444'],
    ['DUET_API_URL', 'https://ctl.duet.so:443'],
    ['DUET_API_URL', 'https://ctl.duet.so/%2e%2e'],
    ['DUET_APP_URL', 'https://app-staging.duet.so'],
    ['DUET_DOCS_URL', 'https://docs.duet.so/sessions'],
  ] as const) {
    expect(() => productionReleaseOrigin(name, value)).toThrow(
      `${name} must equal the canonical production origin`,
    )
  }
  expect(productionConvexDeployment('prod:live-deployment-123')).toBe('prod:live-deployment-123')
  expect(() => productionConvexDeployment('live-deployment-123')).toThrow(
    'CONVEX_DEPLOYMENT must select production',
  )
  expect(() => productionConvexDeployment('dev:preview-deployment-123')).toThrow(
    'CONVEX_DEPLOYMENT must select production',
  )
})

test('removed-session browser proof waits for the generic Jobs absence surface', async () => {
  let expected: RegExp | string | undefined
  const page = {
    getByText: (text: RegExp | string) => {
      expected = text
      return { waitFor: async () => undefined }
    },
  }

  await waitForRemovedSessionBrowserSurface(page as never)

  expect(expected).toEqual(
    /^(That job is not in this list\. Pick another from the list\.|Ese trabajo no está en esta lista\. Elige otro de la lista\.)$/,
  )
})

test('hidden-session browser proof requires stable absence after a transient row', async () => {
  const counts = [0, 1, 0, 0, 0]
  const observed: number[] = []
  let now = 0

  await waitForStableSessionLinkAbsence(
    async () => {
      const count = counts.shift() ?? 0
      observed.push(count)
      return count
    },
    {
      stableForMs: 20,
      timeoutMs: 100,
      pollMs: 10,
      now: () => now,
      delay: async milliseconds => {
        now += milliseconds
      },
    },
  )

  expect(observed).toEqual([0, 1, 0, 0, 0])
  expect(now).toBe(40)
})

test('hidden-session browser proof rejects a row that remains visible', async () => {
  let now = 0

  await expect(
    waitForStableSessionLinkAbsence(async () => 1, {
      stableForMs: 20,
      timeoutMs: 30,
      pollMs: 10,
      now: () => now,
      delay: async milliseconds => {
        now += milliseconds
      },
    }),
  ).rejects.toThrow('session link remained visible')
})

const revision = '0123456789abcdef0123456789abcdef01234567'

test('standalone release verifier fails closed without an explicit target', async () => {
  const command = Bun.spawn(
    ['bun', join(import.meta.dir, '../scripts/verify-release-deployment.ts')],
    {
      env: { ...process.env, CONVEX_DEPLOYMENT: '' },
      stderr: 'pipe',
    },
  )
  try {
    const [exitCode, stderr] = await Promise.all([
      command.exited,
      new Response(command.stderr).text(),
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toContain('CONVEX_DEPLOYMENT is required')
  } finally {
    command.kill()
    await command.exited
  }
})

test('release gate accepts independent deploy revisions and binds contract versions', () => {
  const manifest = runtimeManifestFixture('release')
  const deployed = {
    api: {
      revision,
      backend: { revision, schema: BACKEND_SCHEMA_VERSION },
      runtime: { version: manifest.version },
    },
    web: { revision: 'a'.repeat(40), cacheSchema: WEB_CACHE_SCHEMA_VERSION },
    docs: { revision: 'b'.repeat(40) },
    runtimeManifest: manifest,
    runtimeHealth: { runtimeVersion: manifest.version },
    workspace: { runtimeVersion: manifest.version },
  }

  expect(assertReleaseDeployment(deployed)).toEqual({
    backendSchema: BACKEND_SCHEMA_VERSION,
    cacheSchema: WEB_CACHE_SCHEMA_VERSION,
    runtimeVersion: manifest.version,
  })
  expect(() =>
    assertReleaseDeployment({
      ...deployed,
      api: {
        ...deployed.api,
        backend: { ...deployed.api.backend, schema: BACKEND_SCHEMA_VERSION + 1 },
      },
    }),
  ).toThrow('backend schema')
  expect(() =>
    assertReleaseDeployment({
      ...deployed,
      runtimeHealth: { runtimeVersion: 'stale-runtime' },
    }),
  ).toThrow('runtime health')
})

test('release verifier reads supplied owner endpoints and binds reported runtime identity', async () => {
  const manifest = runtimeManifestFixture('http')
  const runtimeVersion = manifest.version
  const responses = new Map<string, unknown>([
    [
      'https://ctl.example/deployment',
      {
        revision,
        backend: { revision, schema: BACKEND_SCHEMA_VERSION },
        runtime: { version: runtimeVersion },
      },
    ],
    ['https://app.example/api/version', { revision, cacheSchema: WEB_CACHE_SCHEMA_VERSION }],
    ['https://docs.example/deployment.json', { revision }],
    ['https://ctl.example/v1/vm/runtime-release/manifest', manifest],
    ['https://vm.example/health', { runtimeVersion }],
  ])
  const authHeaders: Array<string | null> = []
  const docsReads: string[] = []
  const sessionsDocs =
    'one list { items, nextCursor } Specific people memberUserIds personalArchive globalArchive id="sessions.audience" id="sessions.audience.update"'
  const eventsDocs = 'afterSeq Last-Event-ID'

  await expect(
    verifyReleaseDeploymentTarget(
      {
        apiUrl: 'https://ctl.example',
        appUrl: 'https://app.example',
        docsUrl: 'https://docs.example',
      },
      {
        resolveGateway: async () => ({
          vmToken: 'duet_vm_probe',
          httpsUrl: 'https://vm.example/',
          runtimeVersion: runtimeVersion,
        }),
        readJson: async (url, init) => {
          authHeaders.push(new Headers(init?.headers).get('authorization'))
          return responses.get(url)
        },
        readText: async url => {
          docsReads.push(url)
          return url.endsWith('/sessions/') ? sessionsDocs : eventsDocs
        },
      },
    ),
  ).resolves.toEqual({
    backendSchema: BACKEND_SCHEMA_VERSION,
    cacheSchema: WEB_CACHE_SCHEMA_VERSION,
    runtimeVersion,
  })
  expect(authHeaders.slice(-2)).toEqual(['Bearer duet_vm_probe', 'Bearer duet_vm_probe'])
  expect(docsReads).toEqual(['https://docs.example/sessions/', 'https://docs.example/events/'])
})

test('deployed wire and docs probes reject every old public shape', () => {
  const sessionsDocs =
    'one list { items, nextCursor } Specific people memberUserIds personalArchive globalArchive id="sessions.audience" id="sessions.audience.update"'
  const eventsDocs = 'afterSeq Last-Event-ID'
  expect(() => assertNoLegacySessionWireFields({ id: 'session', userId: 'leak' })).toThrow(
    'flat userId',
  )
  expect(() => assertNoLegacySessionWireFields({ id: 'session', archivedAt: 1 })).toThrow(
    'flat archivedAt',
  )
  expect(() =>
    assertSpecificPeopleDocsContract({
      sessions: `${sessionsDocs} /agent/jobs`,
      events: eventsDocs,
    }),
  ).toThrow('removed jobs route')
  expect(() =>
    assertSpecificPeopleDocsContract({ sessions: sessionsDocs, events: eventsDocs }),
  ).not.toThrow()
  expect(() =>
    assertSpecificPeopleDocsContract({
      sessions: `${sessionsDocs} owner { &quot;sessions&quot;: { &quot;type&quot;: &quot;array&quot; } }`,
      events: eventsDocs,
    }),
  ).not.toThrow()
  expect(() =>
    assertSpecificPeopleDocsContract({
      sessions:
        'one list { items, nextCursor } memberUserIds personalArchive globalArchive id="sessions.audience" id="sessions.audience.update"',
      events: eventsDocs,
    }),
  ).toThrow('Specific people')
  expect(() =>
    assertSpecificPeopleDocsContract({
      sessions: 'one list { items, nextCursor }',
      events: `${eventsDocs} ${sessionsDocs}`,
    }),
  ).toThrow('sessions docs omitted Specific people')
})

test('browser proof is bound to the exact created session identity and audience', () => {
  expect(
    specificPeopleBrowserExpectations({
      id: 'session_exact_21',
      workspaceId: 'workspace_21',
      turnStatus: 'complete',
      bucket: 'done',
      title: 'Exact rehearsal title',
      titleOrigin: 'excerpt',
      titleStatus: 'complete',
      lastEventSeq: 0,
      lastDeliveredInputSeq: 0,
      unread: false,
      audience: {
        kind: 'specific',
        count: 2,
        preview: [
          {
            memberId: 'member_creator',
            userId: 'user_creator',
            name: 'Creator',
            email: 'creator@example.test',
            role: 'editor',
          },
          {
            memberId: 'member_viewer',
            userId: 'user_viewer',
            name: 'Viewer',
            email: 'viewer@example.test',
            role: 'viewer',
          },
        ],
      },
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
    }),
  ).toEqual({
    detailSuffix: '/sessions/session_exact_21',
    linkSelector: 'a[href$="/sessions/session_exact_21"]',
    title: 'Exact rehearsal title',
    audienceCount: 2,
  })
})

test('the UI creation waiter observes the public side-session request', () => {
  expect(
    isSpecificSessionCreationResponse(
      {
        method: 'POST',
        url: 'https://app-staging.duet.so/api/duet/ws/acme/agent/sessions',
      },
      'acme',
    ),
  ).toBe(true)
  expect(
    isSpecificSessionCreationResponse(
      {
        method: 'POST',
        url: 'https://app-staging.duet.so/api/duet/ws/acme/agents/root/sessions/default/messages',
      },
      'acme',
    ),
  ).toBe(false)
  expect(
    isSpecificSessionCreationResponse(
      { method: 'GET', url: 'https://app.example/api/duet/ws/acme/agent/sessions' },
      'acme',
    ),
  ).toBe(false)
  expect(
    isSpecificSessionCreationResponse(
      { method: 'POST', url: 'https://app.example/api/duet/ws/other/agent/sessions' },
      'acme',
    ),
  ).toBe(false)
})

test('removed members are denied at either the workspace or hidden-session boundary', () => {
  expect(
    isRemovedMemberSessionDenial(
      403,
      {
        error: 'insufficient_scope',
        scope: 'ws:acme:sessions',
      },
      'acme',
    ),
  ).toBe(true)
  expect(isRemovedMemberSessionDenial(404, { error: 'not_found' }, 'acme')).toBe(true)
  expect(
    isRemovedMemberSessionDenial(
      403,
      {
        error: 'insufficient_scope',
        scope: 'ws:other:sessions',
      },
      'acme',
    ),
  ).toBe(false)
  expect(isRemovedMemberSessionDenial(200, { id: 'session_leak' }, 'acme')).toBe(false)
})

test('removed-member denial polling treats transient non-JSON responses as unsettled', () => {
  expect(isRemovedMemberSessionDenialBody(502, '<html>temporary edge failure</html>', 'acme')).toBe(
    false,
  )
  expect(isRemovedMemberSessionDenialBody(404, '{"error":"not_found"}', 'acme')).toBe(true)
})
