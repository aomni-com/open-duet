import assert from 'node:assert/strict'

import { ConvexHttpClient } from 'convex/browser'

import { AppListResponseSchema, AppResponseSchema, hashApiKey } from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { fnMutation, fnQuery, type LiveEnv, type Workspace } from './staging-live-env.ts'
import {
  apiJson,
  apiText,
  assertResponse,
  bearer,
  bearerJson,
  retryOnce,
  stagingFetch,
  timedFetch,
} from './staging-live-http.ts'
import { loadAllSessionListItems } from './staging-live-pagination.ts'
import {
  recordWorkspaceCleanup,
  StagingResourceLedger,
  workspaceIsDeleted,
} from './staging-live-resource-ledger.ts'
import { waitForWorkspace } from './staging-live-streaming.ts'
import type { TimelineOutput } from './staging-live.ts'
export async function runProductApiAcceptance(args: {
  env: LiveEnv
  login: { token: string; userId: string }
  workspace: Workspace
  sessionId: string
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  output: TimelineOutput
  adminEmail: string
  adminName: string
}): Promise<{
  admin: { token: string; expiresAt: number; prefix: string }
  appSlug: string
  manualSessionTitle: string
  secondWorkspace: { id: string; slug: string }
  adminWorkspace: Workspace
}> {
  const {
    env,
    login,
    workspace,
    sessionId,
    runId,
    ledger,
    convex,
    artifacts,
    output,
    adminEmail,
    adminName,
  } = args
  const headers = bearer(login.token)
  const jsonHeaders = bearerJson(login.token)

  const filePath = `apps/${runId}/staging-app-api-key-service.ts`
  const fileContents = await Bun.file(
    new URL('../fixtures/staging-app-api-key-service.ts', import.meta.url),
  ).text()
  const appCommand = `bun staging-app-api-key-service.ts ${runId}`
  await apiText(
    `${env.apiUrl}/v1/ws/${workspace.slug}/files/${filePath}`,
    {
      method: 'PUT',
      headers: new Headers({ ...Object.fromEntries(headers), 'content-type': 'text/plain' }),
      body: fileContents,
    },
    200,
    'app fixture file write',
    artifacts,
  )
  ledger.record({
    kind: 'file',
    id: filePath,
    label: `${runId}:file:${filePath}`,
    cleanup: async () => {
      const response = await stagingFetch(
        `${env.apiUrl}/v1/ws/${workspace.slug}/files/${filePath}`,
        {
          method: 'DELETE',
          headers,
        },
      )
      assertResponse(response, 200, 'app fixture file cleanup')
    },
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  const range = await timedFetch(
    `${env.apiUrl}/v1/ws/${workspace.slug}/files/${filePath}`,
    { headers: new Headers({ ...Object.fromEntries(headers), range: 'bytes=0-14' }) },
    artifacts,
  )
  assert.equal(range.status, 206, 'files byte range was not preserved')
  assert((await range.text()).length > 0, 'files byte range was empty')

  const appSlug = `e2e-${runId.slice(-8)}`
  // The gateway-proxied register occasionally 502s on a transient VM hiccup
  // (observed twice across 22 live runs); one bounded retry keeps a flake
  // from burning a whole acceptance run.
  const registered = AppResponseSchema.parse(
    await retryOnce(() =>
      apiJson(
        `${env.apiUrl}/v1/ws/${workspace.slug}/apps`,
        {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            path: `apps/${runId}`,
            command: appCommand,
            apiScopes: ['services'],
            port: 4173,
            slug: appSlug,
          }),
        },
        201,
        'app register',
        artifacts,
      ),
    ),
  ).app
  assert.equal(registered.runtimeStatus, 'reconciled')
  assert.deepEqual(registered.apiScopes, ['services'])
  ledger.record({
    kind: 'app',
    id: registered.id,
    label: `${runId}:app:${appSlug}`,
    cleanup: async () => {
      const response = await stagingFetch(`${env.apiUrl}/v1/ws/${workspace.slug}/apps/${appSlug}`, {
        method: 'DELETE',
        headers,
      })
      assertResponse(response, 200, 'app cleanup')
    },
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  await retryOnce(() =>
    apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/apps/${appSlug}`,
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ command: appCommand, port: 4174 }),
      },
      200,
      'app update',
      artifacts,
    ),
  )
  const apps = AppListResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/apps`,
      { headers },
      200,
      'apps list',
      artifacts,
    ),
  )
  assert(
    apps.items.some(
      app =>
        app.id === registered.id &&
        app.slug === appSlug &&
        app.apiScopes.length === 1 &&
        app.apiScopes[0] === 'services',
    ),
    'registered app list entry did not retain its declared scope',
  )

  await waitForGeneratedTitle(env.apiUrl, workspace.slug, sessionId, login.token, artifacts)
  const manualTitle = `${runId} manual title`
  const renamed = await apiJson<{ id: string; title: string; titleOrigin: string }>(
    `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}`,
    {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ title: manualTitle }),
    },
    200,
    'session rename',
    artifacts,
  )
  assert.equal(renamed.title, manualTitle)
  assert.equal(renamed.titleOrigin, 'manual')
  for (const archived of [true, false]) {
    const result = await apiJson<{ archive: { globalArchivedAt: number | null } }>(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${sessionId}/archive`,
      {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ kind: 'global', archived }),
      },
      200,
      archived ? 'session archive' : 'session unarchive',
      artifacts,
    )
    assert.equal(result.archive.globalArchivedAt !== null, archived)
  }
  // No `archived` filter: the loop above left the session unarchived, so the
  // default bucket is the one holding it. `archived: 'include'` was removed from
  // the wire when the list became one bucketed query — the SPA's client was
  // corrected for that and this call was not, which is why the full run has been
  // failing here since.
  const search = await loadAllSessionListItems(
    `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions?search=${encodeURIComponent(runId)}`,
    login.token,
    'session search',
    artifacts,
  )
  assert(search.some(session => session.id === sessionId && session.title === manualTitle))

  const integrationCatalog = await apiJson<{ items?: unknown[]; integrations?: unknown[] }>(
    `${env.apiUrl}/v1/ws/${workspace.slug}/integrations/catalog`,
    { headers },
    200,
    'integration catalog',
    artifacts,
  )
  assert(
    Array.isArray(integrationCatalog.items) || Array.isArray(integrationCatalog.integrations),
    'integration catalog omitted its collection',
  )

  const denied = await timedFetch(
    `${env.apiUrl}/v1/internal-admin/search?q=${encodeURIComponent(runId)}`,
    { headers },
    artifacts,
  )
  assert.equal(denied.status, 403, 'ordinary owner key reached internal admin')

  const secondSlug = `e2e-${crypto.randomUUID().slice(0, 8)}`
  const second = await apiJson<{ workspaceId: string; slug: string }>(
    `${env.apiUrl}/v1/workspaces`,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ slug: secondSlug, name: `${runId} second workspace` }),
    },
    202,
    'workspace create',
    artifacts,
  )
  recordWorkspaceCleanup({
    ledger,
    convex,
    env,
    output,
    workspaceId: second.workspaceId,
    slug: second.slug,
  })

  await apiJson(
    `${env.apiUrl}/v1/ws/${workspace.slug}/billing/usage?period=monthly&group=workspace`,
    { headers },
    200,
    'workspace billing usage',
    artifacts,
  )

  const admin = await apiJson<{
    token: string
    expiresAt: number
    userId: string
    workspaceSlug: string
    created: boolean
  }>(
    `${env.apiUrl}/v1/admin/login-as`,
    {
      method: 'POST',
      headers: bearerJson(env.loginSecret),
      body: JSON.stringify({
        email: adminEmail,
        create: true,
        ephemeral: true,
        name: adminName,
        ttlSeconds: 900,
      }),
    },
    200,
    'admin login',
    artifacts,
  )
  assert.equal(admin.created, true, 'synthetic admin identity was unexpectedly reused')
  ledger.record({
    kind: 'user',
    id: admin.userId,
    label: `${runId}:admin:${adminEmail}`,
    cleanupPriority: -100,
    cleanup: async () => {
      await convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
        internalKey: env.internalKey,
        email: adminEmail,
      })
    },
    verify: async () =>
      (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
        internalKey: env.internalKey,
        email: adminEmail,
      })) === null,
  })
  const adminIdentity = await apiJson<{
    user: { id: string }
    workspaces: Array<{ id: string; slug: string }>
  }>(`${env.apiUrl}/v1/whoami`, { headers: bearer(admin.token) }, 200, 'admin whoami', artifacts)
  assert.equal(adminIdentity.user.id, admin.userId, 'synthetic admin identity changed after mint')
  const adminWorkspace = adminIdentity.workspaces.find(row => row.slug === admin.workspaceSlug)
  assert(adminWorkspace !== undefined, 'synthetic admin workspace was absent from whoami')
  recordWorkspaceCleanup({
    ledger,
    convex,
    env,
    output,
    workspaceId: adminWorkspace.id,
    slug: adminWorkspace.slug,
  })
  const activeAdminWorkspace = await waitForWorkspace(
    convex,
    env.internalKey,
    adminWorkspace.id,
    row => row.status === 'active' && row.servicingStatus === 'active',
  )
  const adminPrefix = admin.token.slice(0, 'duet_sk_'.length + 8)
  const adminHash = await hashApiKey(admin.token)
  ledger.record({
    kind: 'api-key',
    id: adminPrefix,
    label: `${runId}:admin-key:${adminPrefix}`,
    cleanup: async () => {
      await convex.mutation(fnMutation('testing/stagingE2e:revokeApiKeyByHashForTest'), {
        internalKey: env.internalKey,
        hashedKey: adminHash,
        expectedPrefix: adminPrefix,
        expectedOwnerEmail: adminEmail,
      })
    },
    verify: async () => {
      const response = await stagingFetch(`${env.apiUrl}/v1/whoami`, {
        headers: bearer(admin.token),
      })
      return response.status === 401
    },
  })
  return {
    admin: { ...admin, prefix: adminPrefix },
    appSlug,
    manualSessionTitle: manualTitle,
    secondWorkspace: { id: second.workspaceId, slug: second.slug },
    adminWorkspace: activeAdminWorkspace,
  }
}

async function waitForGeneratedTitle(
  apiUrl: string,
  workspaceSlug: string,
  sessionId: string,
  token: string,
  artifacts: StagingArtifactCollector,
): Promise<void> {
  const deadline = Date.now() + 90_000
  for (;;) {
    const session = await apiJson<{ title: string; titleStatus: string; titleOrigin: string }>(
      `${apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}`,
      { headers: bearer(token) },
      200,
      'session title',
      artifacts,
    )
    if (session.titleStatus === 'complete') {
      assert(session.title.trim().length > 0, 'generated session title was empty')
      assert.equal(session.titleOrigin, 'auto', 'session title did not come from the AI title job')
      return
    }
    if (session.titleStatus === 'failed') throw new Error('session title generation failed')
    if (Date.now() >= deadline) throw new Error('Timed out waiting for generated session title')
    await Bun.sleep(1_000)
  }
}
