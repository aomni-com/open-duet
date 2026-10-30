import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { SessionSnapshotSchema } from '@repo/contract'

import {
  APPROVED_MODELS,
  INTERNAL_KEY,
  ROOT_AGENT_SCOPE,
  SESSION_WAIT_TIMEOUT_MS,
  SessionActivityResponseSchema,
  SessionCreateResponseSchema,
  SessionReadResponseSchema,
  SessionSummarySchema,
  X_DUET_GATEWAY_CODE_HEADER,
  X_DUET_GATEWAY_HEADER,
  apiStateMachineFixture,
  appendAgentNote,
  authedWith,
  bootApiSuite,
  completedTurnState,
  completeWorkspaceForTest,
  convex,
  createAgentSession,
  createApiApp,
  createBackendAgentSession,
  expectedRunnerAnswer,
  expectedRunnerInput,
  grantCredits,
  issueKey,
  humanWorkspaceFixture,
  listMine,
  liveGatewaySse,
  mintBrowserSession,
  mutate,
  owner,
  primaryEnvelopeBody,
  prepareWorkspaceForHttpRegistration,
  provisionRegisteredWorkspace,
  query,
  readSseEvents,
  relayAgentEvent,
  resetApiSuiteBetweenTests,
  runnerInputReceipt,
  runningTurnState,
  sessionIdFromGatewayEventsUrl,
  sessionIdFromGatewayInputUrl,
  setCredits,
  signInWithMagicLink,
  stopApiSuite,
  uniqueEmail,
  uniqueSlug,
  vmSyncRequest,
  waitForRegisteredGateway,
  waitUntilCollector,
  waitingTurnState,
  workspace,
} from './index-suite'
import type {
  GatewayRunnerInputRequest,
  RunnerDeliveryAttempt,
  SessionListPage,
  SessionHistoryPage,
  SessionTimelineEntry,
  UserRow,
} from './index-suite'

// Session creation and dispatch, notes and images, waits, cwd, aliases, agents CRUD.
// One topic slice of the api v1 suite; each slice file boots its own
// deployment through the shared kit in index-suite.ts.
describe('api v1: agent sessions', () => {
  beforeAll(bootApiSuite, 240_000)
  afterAll(stopApiSuite)
  afterEach(resetApiSuiteBetweenTests)

  test('mints a direct drive upload grant for the folder the caller names', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('attachment-upload-session'))
    const filesWriteKey = await issueKey(owner.client)
    const gatewayRequests: Array<{ url: string; headers: Headers; body: unknown }> = []
    const uploadApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        gatewayRequests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        })
        return Response.json({
          uploadPath: '/v1/files/agents/research/uploads',
          uploadToken: 'attachment-upload-token',
          expiresAt: 905_000,
        })
      },
    })

    const response = await authedWith(
      uploadApp,
      `/v1/ws/${proxied.slug}/file-uploads`,
      filesWriteKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pathPrefix: 'agents/research/uploads' }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      vmBaseUrl: 'https://gateway-proxy.exe.xyz/',
      uploadPath: '/v1/files/agents/research/uploads',
      uploadToken: 'attachment-upload-token',
      expiresAt: 905_000,
    })
    expect(gatewayRequests).toEqual([
      {
        url: 'https://gateway-proxy.exe.xyz/v1/drive-grants',
        headers: expect.any(Headers),
        body: { kind: 'upload', pathPrefix: 'agents/research/uploads' },
      },
    ])
    expect(gatewayRequests[0]!.headers.get('x-duet-actor-context')).toMatch(/^api-key:/)
  })

  test('refuses a drive upload grant to a viewer without files write', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('attachment-upload-viewer'))
    const viewer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('attachment-upload-viewer'),
      'Attachment Viewer',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      userId: viewer.user._id,
      role: 'viewer',
    })
    const filesReadKey = await issueKey(viewer.client)
    let gatewayCalls = 0
    const uploadApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => {
        gatewayCalls += 1
        return Response.json({ ok: true })
      },
    })

    const response = await authedWith(
      uploadApp,
      `/v1/ws/${proxied.slug}/file-uploads`,
      filesReadKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${proxied.slug}:files:write`,
    })
    expect(gatewayCalls).toBe(0)
  })

  /* The guard moved with the endpoint. The retired route validated an agent cwd
   and *collapsed* `..`; this one normalizes a drive path and refuses it. Both
   keep containment, which is the property that matters — "is this shaped like an
   agent cwd" was never the boundary. */
  test('rejects an upload prefix that escapes the drive root', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('attachment-upload-cwd'))
    const filesWriteKey = await issueKey(owner.client)
    let gatewayCalls = 0
    const uploadApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => {
        gatewayCalls += 1
        return Response.json({ ok: true })
      },
    })

    const response = await authedWith(
      uploadApp,
      `/v1/ws/${proxied.slug}/file-uploads`,
      filesWriteKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pathPrefix: '../../etc/uploads' }),
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
    expect(gatewayCalls).toBe(0)
  })

  test('passes through typed workspace lifecycle refusals from grant minting', async () => {
    const paused = await provisionRegisteredWorkspace(uniqueSlug('attachment-upload-paused'))
    await mutate(convex, 'testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: paused.workspaceId,
      servicingStatus: 'paused',
      now: Date.now(),
    })
    const provisioningSlug = uniqueSlug('attachment-upload-provisioning')
    await prepareWorkspaceForHttpRegistration(provisioningSlug, 'Attachment Provisioning')
    const archived = await provisionRegisteredWorkspace(uniqueSlug('attachment-upload-archived'))
    await mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: archived.workspaceId,
      status: 'archived',
    })
    const unhealthy = await provisionRegisteredWorkspace(uniqueSlug('attachment-upload-unhealthy'))
    await mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: unhealthy.workspaceId,
      status: 'unhealthy',
    })
    const targets = [
      { slug: paused.slug, status: 402, error: 'workspace_paused' },
      { slug: provisioningSlug, status: 409, error: 'workspace_provisioning' },
      { slug: unhealthy.slug, status: 503, error: 'workspace_unhealthy' },
      { slug: archived.slug, status: 410, error: 'workspace_archived' },
    ] as const
    let gatewayCalls = 0
    const uploadApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => {
        gatewayCalls += 1
        return Response.json({ ok: true })
      },
    })

    for (const target of targets) {
      const key = await issueKey(owner.client)
      const response = await authedWith(uploadApp, `/v1/ws/${target.slug}/file-uploads`, key.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // A real prefix, so the lifecycle refusal is what answers rather than
        // request validation. The folder is named explicitly on this endpoint
        // — an omitted one would otherwise mean the whole drive.
        body: JSON.stringify({ pathPrefix: 'uploads' }),
      })
      expect(response.status).toBe(target.status)
      expect(await response.json()).toEqual({ error: target.error })
    }
    expect(gatewayCalls).toBe(0)
  })

  // The `manage-agents` skill tells an agent what these two answers mean, so
  // they are contract, not incidental: a slug the caller NAMED is refused
  // rather than suffixed, and reserved is refused the same way malformed is.
  test('a reserved or taken agent slug is refused, never adjusted', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-slug-refusal'))
    const agentsKey = await issueKey(owner.client)
    // Registration pushes an anchor reconcile; without a gateway the successful
    // case would 502 before it could conflict with anything.
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: true }),
    })
    const register = (body: unknown) =>
      authedWith(app, `/v1/ws/${proxied.slug}/agents`, agentsKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    // `root` addresses the default agent; no registration may take it.
    const reserved = await register({ path: 'agents/root', slug: 'root' })
    expect(reserved.status).toBe(400)
    expect(await reserved.json()).toEqual({ error: 'invalid_request' })

    // Malformed reads the same to the caller — both mean "choose another".
    const malformed = await register({ path: 'agents/x', slug: 'Not A Slug' })
    expect(malformed.status).toBe(400)

    expect((await register({ path: 'agents/taken', slug: 'taken' })).status).toBe(201)
    const conflict = await register({ path: 'agents/taken-two', slug: 'taken' })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: 'conflict' })
  })

  test('agents routes enforce their independent scope and expose CRUD', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('agents-crud'))
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: true }),
    })
    const slug = uniqueSlug('api-agent')
    const path = `agents/${slug}`
    const agentsKey = await issueKey(owner.client)
    const outsiderKey = await issueKey(
      (await humanWorkspaceFixture(workspace.workspaceId, null)).client,
    )

    const denied = await authedWith(app, `/v1/ws/${workspace.slug}/agents`, outsiderKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, slug }),
    })
    expect(denied.status).toBe(403)

    const created = await authedWith(app, `/v1/ws/${workspace.slug}/agents`, agentsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, slug, name: 'Research', icon: 'assets/icon.png' }),
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { agent: { id: string; slug: string } }
    expect(createdBody).toMatchObject({
      agent: { slug, anchorPath: path, name: 'Research', icon: 'assets/icon.png' },
    })

    const listed = await authedWith(app, `/v1/ws/${workspace.slug}/agents`, agentsKey.key)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ items: [expect.objectContaining({ slug })] })

    const byId = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agents?id=${encodeURIComponent(createdBody.agent.id)}`,
      agentsKey.key,
    )
    expect(byId.status).toBe(200)
    expect(await byId.json()).toMatchObject({ items: [{ id: createdBody.agent.id, slug }] })

    const bySlug = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agents?slug=${encodeURIComponent(slug)}`,
      agentsKey.key,
    )
    expect(bySlug.status).toBe(200)
    expect(await bySlug.json()).toMatchObject({ items: [{ id: createdBody.agent.id, slug }] })

    const ambiguous = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agents?id=${encodeURIComponent(createdBody.agent.id)}&slug=${encodeURIComponent(slug)}`,
      agentsKey.key,
    )
    expect(ambiguous.status).toBe(400)

    const updated = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agents/${slug}`,
      agentsKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Research' }),
      },
    )
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ agent: { slug, name: 'Updated Research' } })

    const createdAgent = (await query(owner.client, 'domains/agents/model:getBySlug', {
      workspaceId: workspace.workspaceId,
      slug,
    })) as { anchorId: string }
    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: createdAgent.anchorId,
      reason: 'api_agent_test',
    })
    const deniedRepair = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/anchors/${createdAgent.anchorId}/reanchor`,
      outsiderKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: `${path}-repaired` }),
      },
    )
    expect(deniedRepair.status).toBe(404)
    expect(await deniedRepair.json()).toEqual({ error: 'not_found' })
    const repaired = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/anchors/${createdAgent.anchorId}/reanchor`,
      agentsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: `${path}-repaired` }),
      },
    )
    expect(repaired.status).toBe(200)
    expect(await repaired.json()).toMatchObject({
      anchor: { kind: 'agent', path: `${path}-repaired`, state: 'active' },
    })

    const deleted = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agents/${slug}`,
      agentsKey.key,
      { method: 'DELETE' },
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })
  })

  // One register call materialises the whole agent, and the whole agent means
  // RUNNING apps: the route must push app reconciliation for the apps it
  // registered, wait on their readiness, and mark them reconciled — exactly
  // like standalone app registration — not answer 201 while they idle in
  // 'reconciling' until an unrelated VM-sync poll happens by.
  test('registering an agent with apps reconciles those apps before answering', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-apps-reconcile'))
    const agentsKey = await issueKey(owner.client)
    const appsKey = await issueKey(owner.client)
    const gatewayCalls: Array<{ path: string; body: { requiredReadySlugs?: string[] } }> = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        gatewayCalls.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)),
        })
        return Response.json({ ok: true })
      },
    })
    const declaration = {
      path: 'agents/researcher',
      slug: 'researcher',
      name: 'Researcher',
      apps: [
        {
          path: 'agents/researcher/apps/board',
          slug: 'board',
          command: 'bun run server.ts',
          apiScopes: [],
        },
      ],
    }
    const register = () =>
      authedWith(routeApp, `/v1/ws/${proxied.slug}/agents`, agentsKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(declaration),
      })

    const created = await register()
    expect(created.status).toBe(201)
    // The 201 must SAY what it registered: a staging API that predated the
    // `apps` request field answered 201 while silently discarding them, and
    // nothing in the response could show it. Callers verify this echo, not
    // their own request.
    expect(await created.json()).toMatchObject({
      agent: { slug: 'researcher' },
      apps: [{ slug: 'board', path: 'agents/researcher/apps/board', status: 'created' }],
    })
    const appPushes = gatewayCalls.filter(call => call.path === '/v1/apps/reconcile')
    expect(appPushes).toHaveLength(1)
    expect(appPushes[0]!.body.requiredReadySlugs).toEqual(['board'])
    const listed = await authedWith(routeApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key)
    expect(await listed.json()).toMatchObject({
      items: [expect.objectContaining({ slug: 'board', runtimeStatus: 'reconciled' })],
    })

    // A repeat register with unchanged declarations writes nothing, so it has
    // nothing to wait on: no second app reconcile push — but the response
    // still accounts for every declared app.
    const repeated = await register()
    expect(repeated.status).toBe(201)
    expect(await repeated.json()).toMatchObject({
      apps: [{ slug: 'board', path: 'agents/researcher/apps/board', status: 'unchanged' }],
    })
    expect(gatewayCalls.filter(call => call.path === '/v1/apps/reconcile')).toHaveLength(1)
  })

  // A recursive delete that takes the `.duet-anchor` marker with it leaves the
  // anchor `broken`, and nothing the caller could do at this path fixed it:
  // register returned the broken agent unchanged and the caller was stuck
  // issuing raw reanchor calls in a retry loop. Registering at the path IS the
  // ownership proof the anti-hijack refusal wants, so register heals every
  // anchor it names — the agent's own and each declared app's, unchanged
  // declarations included.
  test('register heals a broken anchor at its own path — the agent and its declared apps', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-heal'))
    const agentsKey = await issueKey(owner.client)
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: true }),
    })
    const declaration = {
      path: 'agents/phoenix',
      slug: 'phoenix',
      apps: [
        {
          path: 'agents/phoenix/apps/board',
          slug: 'board',
          command: 'bun run server.ts',
          apiScopes: [],
        },
      ],
    }
    const register = () =>
      authedWith(routeApp, `/v1/ws/${proxied.slug}/agents`, agentsKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(declaration),
      })
    expect((await register()).status).toBe(201)
    const registered = (await query(owner.client, 'domains/agents/model:getBySlug', {
      workspaceId: proxied.workspaceId,
      slug: 'phoenix',
    })) as { anchorId: string }
    const anchorsBefore = (await query(owner.client, 'domains/anchors/model:listByWorkspace', {
      workspaceId: proxied.workspaceId,
    })) as Array<{ id: string; path: string; state: string }>
    const appAnchor = anchorsBefore.find(anchor => anchor.path === 'agents/phoenix/apps/board')!
    for (const anchorId of [registered.anchorId, appAnchor.id]) {
      await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
        anchorId,
        reason: 'delete_then_recreate',
      })
    }

    const healed = await register()
    expect(healed.status).toBe(201)
    // The response must not hand back a broken agent the caller cannot fix.
    expect(await healed.json()).toMatchObject({
      agent: { slug: 'phoenix', anchorState: 'active' },
      // The unchanged declaration still rides back — and its anchor healed
      // even though no app row was rewritten.
      apps: [{ slug: 'board', path: 'agents/phoenix/apps/board', status: 'unchanged' }],
    })
    const anchorsAfter = (await query(owner.client, 'domains/anchors/model:listByWorkspace', {
      workspaceId: proxied.workspaceId,
    })) as Array<{ id: string; state: string }>
    expect(
      anchorsAfter
        .filter(anchor => [registered.anchorId, appAnchor.id].includes(anchor.id))
        .map(anchor => anchor.state),
    ).toEqual(['active', 'active'])
  })

  test('a failed app reconcile during agent register reports the failed install', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-apps-fail'))
    const agentsKey = await issueKey(owner.client)
    const appsKey = await issueKey(owner.client)
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input =>
        new URL(String(input)).pathname === '/v1/apps/reconcile'
          ? Response.json({ error: 'gateway_unavailable' }, { status: 503 })
          : Response.json({ ok: true }),
    })
    const failed = await authedWith(routeApp, `/v1/ws/${proxied.slug}/agents`, agentsKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'agents/flaky',
        slug: 'flaky',
        apps: [
          {
            path: 'agents/flaky/apps/board',
            slug: 'board',
            command: 'bun run server.ts',
            apiScopes: [],
          },
        ],
      }),
    })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({
      error: 'app_reconcile_failed',
      operation: 'register',
      reason: 'gateway_unavailable',
      app: { slug: 'board', runtimeStatus: 'reconcile_failed' },
    })
    const listed = await authedWith(routeApp, `/v1/ws/${proxied.slug}/apps`, appsKey.key)
    expect(await listed.json()).toMatchObject({
      items: [expect.objectContaining({ slug: 'board', runtimeStatus: 'reconcile_failed' })],
    })
  })

  test('agent disable controls future launch projection without tearing down running sessions', async () => {
    const agentWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-disable'))
    const agentsKey = await issueKey(owner.client)
    const slug = uniqueSlug('disabled-agent')
    const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: agentWorkspace.workspaceId,
      path: `agents/${slug}`,
      slug,
      name: 'Onboarded agent',
    })) as { id: string }
    const gatewayCalls: Array<{ path: string; body: unknown }> = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        gatewayCalls.push({
          path: new URL(String(input)).pathname,
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        })
        return Response.json({ ok: true })
      },
    })

    const setDisabled = (disabled: boolean) =>
      authedWith(routeApp, `/v1/ws/${agentWorkspace.slug}/agents/${slug}/disabled`, agentsKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled }),
      })

    const disabled = await setDisabled(true)
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toMatchObject({
      agent: { id: registered.id, slug, disabledAt: expect.any(Number) },
    })
    expect(gatewayCalls).toHaveLength(1)
    const disabledCall = gatewayCalls[0]!
    expect(disabledCall.path).toBe('/v1/anchors/reconcile')
    expect(disabledCall.body).toMatchObject({
      anchors: [
        expect.objectContaining({
          id: expect.any(String),
          kind: 'agent',
          path: `agents/${slug}`,
        }),
      ],
    })
    const disabledAgentAnchor = (
      disabledCall.body as { anchors: Array<Record<string, unknown>> }
    ).anchors.find(anchor => anchor.path === `agents/${slug}`)
    expect(disabledAgentAnchor).not.toHaveProperty('agentId')

    const enabled = await setDisabled(false)
    expect(enabled.status).toBe(200)
    expect((await enabled.json()).agent).not.toHaveProperty('disabledAt')
    expect(gatewayCalls).toHaveLength(2)
    const enabledCall = gatewayCalls[1]!
    expect(enabledCall.path).toBe('/v1/anchors/reconcile')
    const enabledAgentAnchor = (
      enabledCall.body as { anchors: Array<Record<string, unknown>> }
    ).anchors.find(anchor => anchor.path === `agents/${slug}`)
    expect(enabledAgentAnchor).toMatchObject({ agentId: registered.id })
  })

  test('every dispatch of an onboarding session carries launch.onboarding', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('onb-launch'))
    const sessionsKey = await issueKey(owner.client)
    const slug = uniqueSlug('onb-launch-agent')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: `agents/${slug}`,
      slug,
    })
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const background = waitUntilCollector()
    const launchApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: background.waitUntil,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        return runnerInputReceipt(body)
      },
    })

    const opened = await authedWith(
      launchApp,
      `/v1/ws/${proxied.slug}/agents/${slug}/onboarding-session`,
      sessionsKey.key,
      { method: 'POST' },
    )
    expect(opened.status).toBe(200)
    const { sessionId } = (await opened.json()) as { sessionId: string }
    await background.drain()

    // Turn two. The gateway rebuilds its launch from whatever the API sends, so
    // if the flag rode only the creating request this message would relaunch
    // the session under AGENTS.md instead of ONBOARDING.md — invisibly, because
    // the conversation would simply start behaving like an ordinary chat.
    const continued = await authedWith(
      launchApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/messages`,
      sessionsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'my brand colours are blue and white' }),
      },
    )
    expect(continued.status).toBe(202)
    await background.drain()

    expect(gatewayCalls.length).toBeGreaterThanOrEqual(2)
    expect(gatewayCalls.map(call => call.launch.onboarding)).toEqual(gatewayCalls.map(() => true))
    expect(gatewayCalls.every(call => call.launch.cwd === `agents/${slug}`)).toBe(true)
  })

  // The browser's devtools read this header natively, and it is the only way
  // to see how a message's wait splits between the API's own phases and the
  // gateway's spawn without instrumenting a deploy.
  test('a message response reports where the API spent the request', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-message-timing'))
    await grantCredits(proxied.workspaceId, 'grant:agent-message-timing')
    const sessionsKey = await issueKey(owner.client)
    const background = waitUntilCollector()
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: background.waitUntil,
      fetch: async (_input, init) =>
        runnerInputReceipt(JSON.parse(String(init?.body)) as GatewayRunnerInputRequest),
    })
    const created = await authedWith(
      app,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      sessionsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Start.' }),
      },
    )
    expect(created.status).toBe(201)
    const sessionId = ((await created.json()) as { session: { sessionId: string } }).session
      .sessionId
    await background.drain()

    const response = await authedWith(
      app,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/messages`,
      sessionsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Review the brief.' }),
      },
    )
    expect(response.status).toBe(202)
    await background.drain()

    const phasesOf = (timed: Response) =>
      Object.fromEntries(
        (timed.headers.get('server-timing') ?? '')
          .split(', ')
          .map(entry => entry.split(';dur=') as [string, string])
          .map(([name, duration]) => [name, Number(duration)]),
      )
    // Creation preflights on its own; a message's preflight rides inside its
    // prepare transaction, so there is no separate phase to report.
    expect(Object.keys(phasesOf(created))).toEqual([
      'preflight',
      'images',
      'prepare',
      'integrations',
      'dispatch',
    ])
    expect(Object.keys(phasesOf(response))).toEqual([
      'images',
      'prepare',
      'integrations',
      'dispatch',
    ])
    for (const timed of [created, response]) {
      expect(Object.values(phasesOf(timed)).every(duration => Number.isInteger(duration))).toBe(
        true,
      )
    }
  })

  test('an attachment-bearing message reaches durable session history', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-attachment-message'))
    await grantCredits(proxied.workspaceId, 'grant:agent-attachment-message')
    const sessionsKey = await issueKey(owner.client)
    const background = waitUntilCollector()
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: background.waitUntil,
      fetch: async (_input, init) =>
        runnerInputReceipt(JSON.parse(String(init?.body)) as GatewayRunnerInputRequest),
    })
    const attachments = [
      {
        path: 'agents/designer/uploads/brand-guide.pdf',
        name: 'Brand Guide.pdf',
        bytes: 42,
        mimeType: 'application/pdf',
      },
    ]
    const created = await authedWith(
      app,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      sessionsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Start.', attachments }),
      },
    )
    const sessionId = ((await created.json()) as { session: { sessionId: string } }).session
      .sessionId
    await background.drain()
    const clientRequestId = '018f47a0-4dd1-7c2e-9cb7-8f4e71da8c02'

    const response = await authedWith(
      app,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/messages`,
      sessionsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Review the brief.', attachments, clientRequestId }),
      },
    )
    expect(response.status).toBe(202)
    await background.drain()
    const events = (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      sessionId,
    })) as Array<{ event: Record<string, unknown> }>
    expect(
      events.find(row => row.event.type === 'prompt_submitted' && row.event.prompt === 'Start.')
        ?.event,
    ).toMatchObject({
      type: 'prompt_submitted',
      attachments,
    })
    expect(events.find(row => row.event.prompt === 'Review the brief.')?.event).toMatchObject({
      type: 'prompt_submitted',
      attachments,
    })

    const conflictingReplay = await authedWith(
      app,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/messages`,
      sessionsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Review the brief.',
          clientRequestId,
          attachments: [{ ...attachments[0], path: 'agents/designer/uploads/revised.pdf' }],
        }),
      },
    )
    expect(conflictingReplay.status).toBe(400)
    expect(await conflictingReplay.json()).toEqual({ error: 'invalid_request' })
  })

  test('agent mutation success waits for anchor reconciliation and retry re-drives a failure', async () => {
    const agentWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-reconcile'))
    const agentsKey = await issueKey(owner.client)
    const slug = uniqueSlug('retry-agent')
    let gatewayStatus = 502
    let pushes = 0
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        if (new URL(String(input)).pathname === '/v1/anchors/reconcile') pushes += 1
        return Response.json(
          gatewayStatus === 200 ? { ok: true } : { error: 'marker_reconcile_failed' },
          { status: gatewayStatus },
        )
      },
    })
    const request = () =>
      authedWith(routeApp, `/v1/ws/${agentWorkspace.slug}/agents`, agentsKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: `agents/${slug}`, slug }),
      })

    const failed = await request()
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({
      error: 'agent_reconcile_failed',
      reason: 'marker_reconcile_failed',
    })
    gatewayStatus = 200
    const retried = await request()
    expect(retried.status).toBe(201)
    expect(pushes).toBe(2)
  })

  test('foreground session waits submit all route families and return correlated terminals', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-foreground-waits'))
    await grantCredits(proxied.workspaceId, 'grant:agent-foreground-waits')
    const sessionKey = await issueKey(owner.client)
    let waitApp!: ReturnType<typeof createApiApp>
    waitApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        const url = new URL(String(input))
        if (init?.method === 'GET') {
          return new Response('', { status: 204 })
        }
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        const match = url.pathname.match(/^\/v1\/agent\/sessions\/([^/]+)\/input$/)
        if (match === null) return Response.json({ error: 'not_found' }, { status: 404 })
        const sessionId = decodeURIComponent(match[1]!)
        const delivered = primaryEnvelopeBody(
          body.input.kind === 'answer' ? body.input.answer : body.input.message,
        )
        const ask = body.input.kind === 'prompt' && delivered === 'ask me'
        await relayAgentEvent(
          waitApp,
          proxied.vmToken,
          sessionId,
          ask
            ? {
                type: 'ask',
                state: waitingTurnState(),
                questions: [{ question: 'Approve?', options: [] }],
              }
            : {
                type: 'complete',
                state: completedTurnState(),
                status: 'completed',
                result: delivered,
              },
          body.throughSeq,
        )
        return runnerInputReceipt(body)
      },
    })
    const submit = async (path: string, body: Record<string, unknown>) => {
      const response = await authedWith(waitApp, `/v1/ws/${proxied.slug}${path}`, sessionKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, clientRequestId: crypto.randomUUID() }),
      })
      expect(response.status).toBe(200)
      return (await response.json()) as {
        sessionId: string
        inputSeq: number
        cwd?: string
        terminal: { event: { type: string; result?: string } }
      }
    }

    const flat = await submit('/agent/sessions/wait', {
      prompt: 'flat',
      audience: { kind: 'specific', memberUserIds: [] },
    })
    expect(flat).toMatchObject({
      inputSeq: 2,
      terminal: { event: { type: 'complete', result: 'flat' } },
    })
    // A root session has no cwd, and the response says so by omission.
    expect(flat.cwd).toBeUndefined()
    const flatDetail = await authedWith(
      waitApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${flat.sessionId}`,
      sessionKey.key,
    )
    expect(await flatDetail.json()).toMatchObject({ audience: { kind: 'specific', count: 1 } })
    const nested = await submit(`/agent/sessions/${flat.sessionId}/sessions/wait`, {
      prompt: 'nested',
      cwd: 'agents/growth',
    })
    expect(nested.terminal.event).toMatchObject({ type: 'complete', result: 'nested' })
    // The child's cwd rides on the wait response: the terminal result's
    // relative file paths are relative to the child's frame, not the caller's.
    expect(nested.cwd).toBe('agents/growth')
    const rejectedNestedAudience = await authedWith(
      waitApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${flat.sessionId}/sessions/wait`,
      sessionKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'not a nested audience override',
          clientRequestId: crypto.randomUUID(),
          audience: { kind: 'workspace' },
        }),
      },
    )
    expect(rejectedNestedAudience.status).toBe(400)
    const message = await submit(`/agent/sessions/${flat.sessionId}/messages/wait`, {
      prompt: 'follow up',
    })
    expect(message).toMatchObject({
      sessionId: flat.sessionId,
      terminal: { event: { type: 'complete', result: 'follow up' } },
    })
    const rootDefault = await submit('/agents/root/sessions/default/messages/wait', {
      prompt: 'root default',
      attachments: [
        {
          path: 'uploads/default.pdf',
          name: 'default.pdf',
          bytes: 12,
          mimeType: 'application/pdf',
        },
      ],
    })
    expect(rootDefault.terminal.event.type).toBe('complete')
    expect(rootDefault.terminal.event.result).toContain('root default')
    expect(rootDefault.terminal.event.result).toContain('uploads/default.pdf')
    const rootDefaultEvents = (await convex.query(
      'domains/agentSessions/model:listEventsForDelivery',
      {
        internalKey: INTERNAL_KEY,
        workspaceId: proxied.workspaceId,
        sessionId: rootDefault.sessionId,
      },
    )) as Array<{ event: Record<string, unknown> }>
    expect(
      rootDefaultEvents.find(row => row.event.type === 'prompt_submitted')?.event,
    ).toMatchObject({
      attachments: [
        {
          path: 'uploads/default.pdf',
          name: 'default.pdf',
          bytes: 12,
          mimeType: 'application/pdf',
        },
      ],
    })
    const rootDefaultFollowUp = await submit('/agents/root/sessions/default/messages/wait', {
      prompt: 'root default follow up',
    })
    expect(rootDefaultFollowUp).toMatchObject({
      sessionId: rootDefault.sessionId,
      terminal: { event: { type: 'complete', result: 'root default follow up' } },
    })
    const rejectedDefaultMode = await authedWith(
      waitApp,
      `/v1/ws/${proxied.slug}/agents/root/sessions/default/messages/wait`,
      sessionKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'not a default mode override',
          clientRequestId: crypto.randomUUID(),
          mode: { name: 'noop', prompt: 'not used', states: [] },
        }),
      },
    )
    expect(rejectedDefaultMode.status).toBe(400)

    const agentSlug = uniqueSlug('foreground-agent')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: `agents/${agentSlug}`,
      slug: agentSlug,
    })
    const agentDefault = await submit(`/agents/${agentSlug}/sessions/default/messages/wait`, {
      prompt: 'agent default',
    })
    expect(agentDefault.terminal.event).toMatchObject({
      type: 'complete',
      result: 'agent default',
    })

    const sharedDefaultRequestId = crypto.randomUUID()
    const submitDefaultOwner = async (path: string) => {
      const response = await authedWith(waitApp, `/v1/ws/${proxied.slug}${path}`, sessionKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'same payload across default owners',
          clientRequestId: sharedDefaultRequestId,
        }),
      })
      expect(response.status).toBe(200)
      return (await response.json()) as { sessionId: string }
    }
    const rootOwnerSubmission = await submitDefaultOwner(
      '/agents/root/sessions/default/messages/wait',
    )
    const agentOwnerSubmission = await submitDefaultOwner(
      `/agents/${agentSlug}/sessions/default/messages/wait`,
    )
    expect(agentOwnerSubmission.sessionId).not.toBe(rootOwnerSubmission.sessionId)

    const asking = await submit('/agent/sessions/wait', { prompt: 'ask me' })
    expect(asking.terminal.event.type).toBe('ask')
    const answer = await submit(`/agent/sessions/${asking.sessionId}/answer/wait`, {
      answer: 'approved',
    })
    expect(answer.terminal.event).toMatchObject({ type: 'complete', result: 'approved' })

    const retryParent = await submit('/agent/sessions/wait', { prompt: 'retry parent' })
    const nestedRequest = {
      prompt: 'nested retry target',
      clientRequestId: crypto.randomUUID(),
    }
    const nestedPath = `/v1/ws/${proxied.slug}/agent/sessions/${retryParent.sessionId}/sessions/wait`
    const firstNested = await authedWith(waitApp, nestedPath, sessionKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nestedRequest),
    })
    expect(firstNested.status).toBe(200)
    const firstNestedBody = (await firstNested.json()) as { sessionId: string; inputSeq: number }
    const otherParent = await submit('/agent/sessions/wait', { prompt: 'other retry parent' })
    const wrongParentRecovery = await authedWith(
      waitApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${otherParent.sessionId}/sessions/wait`,
      sessionKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(nestedRequest),
      },
    )
    expect(wrongParentRecovery.status).toBe(400)
    await convex.mutation('domains/agentSessions/model:beginSessionSubtreeDeletion', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
      workspaceId: proxied.workspaceId,
      sessionId: retryParent.sessionId,
      now: Date.now(),
    })
    const recoveredNested = await authedWith(waitApp, nestedPath, sessionKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nestedRequest),
    })
    expect(recoveredNested.status).toBe(404)
    expect(await recoveredNested.json()).toEqual({ error: 'not_found' })
    expect(firstNestedBody.sessionId).toBeTruthy()
  }, 60_000)

  test('foreground wait submission time consumes the route deadline', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-wait-route-deadline'))
    await grantCredits(proxied.workspaceId, 'grant:agent-wait-route-deadline')
    const key = await issueKey(owner.client)
    let now = Date.now()
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => now,
      fetch: async (_input, init) => {
        if (init?.method === 'GET') return new Response('', { status: 204 })
        now += SESSION_WAIT_TIMEOUT_MS
        return runnerInputReceipt(JSON.parse(String(init?.body)) as GatewayRunnerInputRequest)
      },
    })
    const request = {
      prompt: 'deadline',
      clientRequestId: crypto.randomUUID(),
    }
    const submit = () =>
      authedWith(routeApp, `/v1/ws/${proxied.slug}/agent/sessions/wait`, key.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(2_000),
      })

    const response = await submit()
    expect(response.status).toBe(202)
    const pending = (await response.json()) as {
      sessionId: string
      inputSeq: number
      status: string
    }
    expect(pending).toEqual({ sessionId: expect.any(String), inputSeq: 2, status: 'pending' })

    await relayAgentEvent(
      routeApp,
      proxied.vmToken,
      pending.sessionId,
      {
        type: 'complete',
        state: completedTurnState(),
        status: 'completed',
        result: 'finished after deadline',
      },
      pending.inputSeq,
    )
    const resumed = await submit()
    expect(resumed.status).toBe(200)
    expect(await resumed.json()).toMatchObject({
      sessionId: pending.sessionId,
      inputSeq: pending.inputSeq,
      terminal: { event: { type: 'complete', result: 'finished after deadline' } },
    })
  }, 60_000)

  test('an existing wait submission remains recoverable on retry', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-wait-recovery'))
    await grantCredits(proxied.workspaceId, 'grant:agent-wait-recovery')
    const key = await issueKey(owner.client)
    let routeApp!: ReturnType<typeof createApiApp>
    routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        if (init?.method === 'GET') return new Response('', { status: 204 })
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        const sessionId = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-2)!)
        await relayAgentEvent(
          routeApp,
          proxied.vmToken,
          sessionId,
          {
            type: 'complete',
            state: completedTurnState(),
            status: 'completed',
            result: 'durable result',
          },
          body.throughSeq,
        )
        return runnerInputReceipt(body)
      },
    })
    const clientRequestId = crypto.randomUUID()
    const submit = () =>
      authedWith(routeApp, `/v1/ws/${proxied.slug}/agent/sessions/wait`, key.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'recover me', clientRequestId }),
      })

    const first = await submit()
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { sessionId: string; inputSeq: number }
    const recovered = await submit()
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject(firstBody)
  }, 60_000)

  test('an admitted participant wait finishes after removal, but its HTTP retry reauthorizes', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('agent-wait-removal'))
    await grantCredits(target.workspaceId, 'grant:agent-wait-removal')
    const participant = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('agent-wait-removal'),
      'Wait Participant',
    )
    const membershipId = (await mutate(
      owner.client,
      'testing/workspaces:addWorkspaceMemberForTest',
      {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        userId: participant.user._id,
        role: 'viewer',
      },
    )) as string
    const session = await createAgentSession(target.workspaceId, 'Initial turn', 1_000)
    const snapshot = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      sessionId: session.sessionId,
    })) as { deliveryAttempt: { attemptId: string; throughSeq: number } }
    await convex.mutation('domains/agentSessions/model:markRunnerInputDelivered', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      sessionId: session.sessionId,
      attemptId: snapshot.deliveryAttempt.attemptId,
      throughSeq: snapshot.deliveryAttempt.throughSeq,
    })
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      sessionId: session.sessionId,
      membershipIds: [membershipId],
    })
    const key = await issueKey(participant.client)
    let gatewayCalls = 0
    let removed = false
    let routeApp!: ReturnType<typeof createApiApp>
    routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        if (init?.method === 'GET') return new Response('', { status: 204 })
        gatewayCalls += 1
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        if (!removed) {
          removed = true
          await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
            internalKey: INTERNAL_KEY,
            workspaceId: target.workspaceId,
            sessionId: session.sessionId,
            membershipId,
            granted: false,
            now: 2_000,
          })
        }
        await relayAgentEvent(
          routeApp,
          target.vmToken,
          session.sessionId,
          {
            type: 'complete',
            state: completedTurnState(),
            status: 'completed',
            result: 'accepted before removal',
          },
          body.throughSeq,
        )
        return runnerInputReceipt(body)
      },
    })
    const clientRequestId = crypto.randomUUID()
    const submit = () =>
      authedWith(
        routeApp,
        `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/messages/wait`,
        key.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'Finish this accepted wait', clientRequestId }),
        },
      )

    const accepted = await submit()
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      sessionId: session.sessionId,
      terminal: { event: { type: 'complete', result: 'accepted before removal' } },
    })
    const retried = await submit()
    expect(retried.status).toBe(404)
    expect(await retried.json()).toEqual({ error: 'not_found' })
    expect(gatewayCalls).toBe(1)
  }, 60_000)

  test('an admitted SSE drains a multi-page tail after removal while reconnect reauthorizes', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('agent-sse-removal'))
    const participant = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('agent-sse-removal'),
      'SSE Participant',
    )
    const membershipId = (await mutate(
      owner.client,
      'testing/workspaces:addWorkspaceMemberForTest',
      {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        userId: participant.user._id,
        role: 'viewer',
      },
    )) as string
    const session = await createAgentSession(target.workspaceId, 'Initial turn', 1_000)
    await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      sessionId: session.sessionId,
      membershipIds: [membershipId],
    })
    for (let index = 0; index < 101; index += 1) {
      await appendAgentNote(target.workspaceId, session.sessionId, `note-${index}`, 2_000 + index)
    }
    const key = await issueKey(participant.client)
    const nonparticipant = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('agent-sse-nonparticipant'),
      'SSE Nonparticipant',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      userId: nonparticipant.user._id,
      role: 'viewer',
    })
    const nonparticipantKey = await issueKey(nonparticipant.client)
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => new Response('', { status: 204 }),
    })

    const hiddenInvalid = await authedWith(
      routeApp,
      `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/events?since=invalid`,
      nonparticipantKey.key,
      { headers: { 'last-event-id': '-1' } },
    )
    expect(hiddenInvalid.status).toBe(404)
    expect(await hiddenInvalid.json()).toEqual({ error: 'not_found' })

    const accepted = await authedWith(
      routeApp,
      `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/events`,
      key.key,
    )
    expect(accepted.status).toBe(200)
    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      now: 4_000,
    })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      userId: participant.user._id,
      role: 'viewer',
    })

    const events = await readSseEvents(accepted, 103)
    expect(events.map(event => event.seq)).toEqual(
      Array.from({ length: 103 }, (_, index) => index + 1),
    )
    const reconnect = await authedWith(
      routeApp,
      `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/events`,
      key.key,
      { headers: { 'last-event-id': '103' } },
    )
    expect(reconnect.status).toBe(404)
    expect(await reconnect.json()).toEqual({ error: 'not_found' })
  }, 120_000)

  test('large durable events replay in order across cancellation and reconnect', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('agent-sse-large-replay'))
    const session = await createAgentSession(target.workspaceId, 'Large replay', 1_000)
    const key = await issueKey(owner.client)
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => new Response(null, { status: 204 }),
    })
    const chunk = 'x'.repeat(200 * 1024)
    let head = 0
    for (let batch = 0; batch < 10; batch += 1) {
      const seeded = (await convex.mutation('testing/agentSessions:seedSessionOutputForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
        count: 10,
        chunkBytes: chunk.length,
      })) as { lastEventSeq: number }
      head = seeded.lastEventSeq
      // Keep fixture writes below the local deployment's rolling write quota.
      await Bun.sleep(600)
    }
    const open = (afterSeq: number) =>
      authedWith(
        routeApp,
        `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/events`,
        key.key,
        { headers: { 'last-event-id': String(afterSeq) } },
      )
    // readSseEvents cancels the reader at this boundary, including unread rows
    // in the current backend page. Reconnect must start at the delivered id.
    const first = await readSseEvents(await open(head - 100), 45)
    const rest = await readSseEvents(await open(first.at(-1)!.seq!), 55)
    expect([...first, ...rest].map(row => row.seq)).toEqual(
      Array.from({ length: 100 }, (_, index) => head - 99 + index),
    )
    for (const row of [...first, ...rest]) {
      expect(row.event).toEqual({ type: 'task_output', taskId: 't1', chunk })
    }
  }, 120_000)

  test('input revocation is side-effect free before preflight and cleans known blobs after it', async () => {
    const runRace = async (phase: 'beforePreflight' | 'afterImagesStored') => {
      const phaseSlug = phase === 'beforePreflight' ? 'before-preflight' : 'after-images'
      const target = await provisionRegisteredWorkspace(uniqueSlug(`agent-input-${phaseSlug}`))
      await grantCredits(target.workspaceId, `grant:agent-input-${phaseSlug}`)
      const participant = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail(`agent-input-${phaseSlug}`),
        'Race Participant',
      )
      const membershipId = (await mutate(
        owner.client,
        'testing/workspaces:addWorkspaceMemberForTest',
        {
          internalKey: INTERNAL_KEY,
          workspaceId: target.workspaceId,
          userId: participant.user._id,
          role: 'viewer',
        },
      )) as string
      const session = await createAgentSession(target.workspaceId, 'Race target', 1_000)
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        sessionId: session.sessionId,
        membershipIds: [membershipId],
      })
      const key = await issueKey(participant.client)
      const beforeChildren = (await convex.query('testing/agentSessions:childRowCountsForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      })) as { images: number }
      const beforeTransactions = (await convex.query(
        'testing/credits:listWorkspaceTransactionsForTest',
        { internalKey: INTERNAL_KEY, workspaceId: target.workspaceId },
      )) as unknown[]
      const beforeScheduled = (await convex.query(
        'testing/credits:listScheduledCreditFunctionsForTest',
        { internalKey: INTERNAL_KEY },
      )) as unknown[]
      let providerCalls = 0
      let gatewayCalls = 0
      let hookCalls = 0
      const revoke = async () => {
        hookCalls += 1
        await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: target.workspaceId,
          sessionId: session.sessionId,
          membershipId,
          granted: false,
          now: 2_000,
        })
      }
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => {
          gatewayCalls += 1
          return Response.json({ ok: true })
        },
        composioMcpProvider: {
          createToolRouterSession: async () => {
            providerCalls += 1
            throw new Error('provider must not be called')
          },
          useToolRouterSession: async () => {
            providerCalls += 1
            throw new Error('provider must not be called')
          },
          updateToolRouterSession: async () => {
            providerCalls += 1
          },
          deleteToolRouterSession: async () => {
            providerCalls += 1
          },
        },
        sessionInputTestHooks: { [phase]: revoke },
      })

      const response = await authedWith(
        app,
        `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/messages`,
        key.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Race the grant',
            images: [{ data: 'cmFjZS1pbWFnZQ==', mimeType: 'image/png' }],
          }),
        },
      )

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
      expect(hookCalls).toBe(1)
      expect({ providerCalls, gatewayCalls }).toEqual({ providerCalls: 0, gatewayCalls: 0 })
      const afterChildren = (await convex.query('testing/agentSessions:childRowCountsForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      })) as { images: number }
      expect(afterChildren.images).toBe(beforeChildren.images)
      const afterTransactions = (await convex.query(
        'testing/credits:listWorkspaceTransactionsForTest',
        { internalKey: INTERNAL_KEY, workspaceId: target.workspaceId },
      )) as unknown[]
      const afterScheduled = (await convex.query(
        'testing/credits:listScheduledCreditFunctionsForTest',
        { internalKey: INTERNAL_KEY },
      )) as unknown[]
      if (phase === 'beforePreflight') {
        expect(afterTransactions).toEqual(beforeTransactions)
        expect(afterScheduled).toEqual(beforeScheduled)
      }
    }

    await runRace('beforePreflight')
    await runRace('afterImagesStored')
  }, 60_000)

  test('nested, source, and default revocation races stop before durable or external effects', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('agent-scoped-input-races'))
    await grantCredits(target.workspaceId, 'grant:agent-scoped-input-races')
    const participant = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('agent-scoped-input-races'),
      'Scoped Race Participant',
    )
    const membershipId = (await mutate(
      owner.client,
      'testing/workspaces:addWorkspaceMemberForTest',
      {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        userId: participant.user._id,
        role: 'viewer',
      },
    )) as string
    const parent = await createAgentSession(target.workspaceId, 'Nested race parent', 1_000)
    const source = await createAgentSession(target.workspaceId, 'Source race author', 2_000)
    const messageTarget = await createAgentSession(target.workspaceId, 'Source race target', 3_000)
    for (const sessionId of [parent.sessionId, source.sessionId]) {
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        sessionId,
        membershipIds: [membershipId],
      })
    }
    const agentSlug = uniqueSlug('scoped-race-agent')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: target.workspaceId,
      path: `agents/${agentSlug}`,
      slug: agentSlug,
    })) as { id: string }
    const defaultDelivery = (await convex.mutation(
      'domains/agentSessions/model:prepareRunnerInputDelivery',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: {
          principal: { kind: 'human', userId: owner.user._id },
          actorId: owner.user._id,
        },
        workspaceId: target.workspaceId,
        defaultOwner: { kind: 'agent', agentId: agent.id },
        attemptId: 'scoped-race-default-create',
        input: {
          kind: 'initial_prompt',
          prompt: 'Default race target',
          behavior: 'steer',
          cwd: `agents/${agentSlug}`,
          sender: { kind: 'user', userId: owner.user._id },
        },
        now: 4_000,
      },
    )) as { sessionId: string }
    const key = await issueKey(participant.client)

    const runRace = async (
      kind: 'nested' | 'source' | 'default',
      phase: 'beforePreflight' | 'afterImagesStored',
    ) => {
      const scopedSessionId = kind === 'nested' ? parent.sessionId : source.sessionId
      if (kind !== 'default') {
        await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: target.workspaceId,
          sessionId: scopedSessionId,
          membershipId,
          granted: true,
          now: 5_000,
        })
      } else {
        await mutate(owner.client, 'domains/agents/model:setAgentDisabled', {
          workspaceId: target.workspaceId,
          slug: agentSlug,
          disabled: false,
        })
      }
      const beforeSessions = (await convex.query(
        'testing/agentSessions:rawSessionsForWorkspaceForTest',
        { internalKey: INTERNAL_KEY, workspaceId: target.workspaceId },
      )) as unknown[]
      const durableSessionId =
        kind === 'nested'
          ? parent.sessionId
          : kind === 'source'
            ? messageTarget.sessionId
            : defaultDelivery.sessionId
      const beforeChildren = (await convex.query('testing/agentSessions:childRowCountsForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: durableSessionId,
      })) as {
        events: number
        relayReceipts: number
        images: number
        reads: number
        toolRouter: number
      }
      const beforeTransactions = (await convex.query(
        'testing/credits:listWorkspaceTransactionsForTest',
        { internalKey: INTERNAL_KEY, workspaceId: target.workspaceId },
      )) as unknown[]
      const beforeScheduled = (await convex.query(
        'testing/credits:listScheduledCreditFunctionsForTest',
        { internalKey: INTERNAL_KEY },
      )) as unknown[]
      let providerCalls = 0
      let gatewayCalls = 0
      const revoke = async () => {
        if (kind === 'default') {
          // The owner stops being ready: a disabled agent has no chat to run.
          await mutate(owner.client, 'domains/agents/model:setAgentDisabled', {
            workspaceId: target.workspaceId,
            slug: agentSlug,
            disabled: true,
          })
          return
        }
        await convex.mutation('testing/agentSessions:applyAudienceGrantForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: target.workspaceId,
          sessionId: scopedSessionId,
          membershipId,
          granted: false,
          now: 6_000,
        })
      }
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        sessionInputTestHooks: { [phase]: revoke },
        fetch: async () => {
          gatewayCalls += 1
          return Response.json({ ok: true })
        },
        composioMcpProvider: {
          createToolRouterSession: async () => {
            providerCalls += 1
            throw new Error('provider must not be called')
          },
          useToolRouterSession: async () => {
            providerCalls += 1
            throw new Error('provider must not be called')
          },
          updateToolRouterSession: async () => {
            providerCalls += 1
          },
          deleteToolRouterSession: async () => {
            providerCalls += 1
          },
        },
      })
      const path =
        kind === 'nested'
          ? `/v1/ws/${target.slug}/agent/sessions/${parent.sessionId}/sessions`
          : kind === 'source'
            ? `/v1/ws/${target.slug}/agent/sessions/${messageTarget.sessionId}/messages`
            : `/v1/ws/${target.slug}/agents/${agentSlug}/sessions/default/messages`
      const response = await authedWith(app, path, key.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: `Race ${kind} ${phase}`,
          images: [{ data: 'cmFjZS1pbWFnZQ==', mimeType: 'image/png' }],
          ...(kind === 'source' ? { sourceSessionId: source.sessionId } : {}),
        }),
      })

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
      expect({ providerCalls, gatewayCalls }).toEqual({ providerCalls: 0, gatewayCalls: 0 })
      const afterSessions = (await convex.query(
        'testing/agentSessions:rawSessionsForWorkspaceForTest',
        { internalKey: INTERNAL_KEY, workspaceId: target.workspaceId },
      )) as unknown[]
      expect(afterSessions).toHaveLength(beforeSessions.length)
      expect(
        await convex.query('testing/agentSessions:childRowCountsForTest', {
          internalKey: INTERNAL_KEY,
          sessionId: durableSessionId,
        }),
      ).toMatchObject({
        events: beforeChildren.events,
        relayReceipts: beforeChildren.relayReceipts,
        images: beforeChildren.images,
        reads: beforeChildren.reads,
        toolRouter: beforeChildren.toolRouter,
      })
      if (phase === 'beforePreflight') {
        expect(
          await convex.query('testing/credits:listWorkspaceTransactionsForTest', {
            internalKey: INTERNAL_KEY,
            workspaceId: target.workspaceId,
          }),
        ).toEqual(beforeTransactions)
        expect(
          await convex.query('testing/credits:listScheduledCreditFunctionsForTest', {
            internalKey: INTERNAL_KEY,
          }),
        ).toEqual(beforeScheduled)
      }
    }

    for (const kind of ['nested', 'source', 'default'] as const) {
      await runRace(kind, 'beforePreflight')
      await runRace(kind, 'afterImagesStored')
    }
  }, 60_000)

  test('agent sessions are preflight-gated and SSE reconnect reads Convex state without loss', async () => {
    const blockedWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-empty'))
    await setCredits(blockedWorkspace.workspaceId, 0, 'balance:agent-empty')
    const blockedKey = await issueKey(owner.client)
    const blockedGatewayCalls: string[] = []
    const blockedApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      appUrl: 'http://localhost:3000',
      fetch: async input => {
        blockedGatewayCalls.push(String(input))
        return Response.json({ ok: true })
      },
    })

    const blocked = await authedWith(
      blockedApp,
      `/v1/ws/${blockedWorkspace.slug}/agent/sessions`,
      blockedKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'should not spawn' }),
      },
    )
    expect(blocked.status).toBe(402)
    expect(await blocked.json()).toEqual({
      error: 'insufficient_credits',
      code: 'insufficient_credits',
      tier: 'account',
      balanceMicroUsd: 0,
      autoTopupScheduled: false,
      billingUrl: 'http://localhost:3000/settings/billing',
    })
    expect(blocked.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(blocked.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('insufficient_credits')
    expect(blockedGatewayCalls).toEqual([])

    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-sse'))
    await grantCredits(proxied.workspaceId, 'grant:agent-sse')
    const agentKey = await issueKey(owner.client)
    let proxyApp!: ReturnType<typeof createApiApp>
    const gatewayCalls: Array<{
      url: string
      method: string
      since?: number
      body?: GatewayRunnerInputRequest
    }> = []
    const proxyBackground = waitUntilCollector()
    proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 654_000,
      waitUntil: proxyBackground.waitUntil,
      fetch: async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (method === 'GET') {
          const since = Number(new URL(url).searchParams.get('since') ?? '0')
          gatewayCalls.push({ url, method, since })
          return new Response(
            liveGatewaySse(proxyApp, proxied.vmToken, sessionIdFromGatewayEventsUrl(url), since),
            {
              headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
              },
            },
          )
        }
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push({ url, method, body })
        const deliveredSessionId = sessionIdFromGatewayInputUrl(url)
        await relayAgentEvent(proxyApp, proxied.vmToken, deliveredSessionId, {
          type: 'turn_started',
          state: runningTurnState(),
        })
        await relayAgentEvent(proxyApp, proxied.vmToken, deliveredSessionId, {
          type: 'step',
          step: { type: 'text', text: 'canonical backfill' },
        })
        return runnerInputReceipt(body)
      },
    })

    const created = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'summarize demo:/reports' }),
      },
    )
    expect(created.status).toBe(201)
    const sessionId = ((await created.json()) as { session: { sessionId: string } }).session
      .sessionId
    await proxyBackground.drain()
    expect(gatewayCalls).toEqual([
      {
        url: `https://gateway-proxy.exe.xyz/v1/agent/sessions/${sessionId}/input`,
        method: 'POST',
        body: expectedRunnerInput({
          throughSeq: 2,
          message: 'summarize demo:/reports',
          behavior: 'steer',
        }),
      },
    ])

    const missingAttach = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/agent/sessions/sess_missing/events`,
      agentKey.key,
    )
    expect(missingAttach.status).toBe(404)
    expect(await missingAttach.json()).toEqual({ error: 'not_found' })

    const otherWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-sse-other'))
    const foreignSession = await createBackendAgentSession(otherWorkspace.workspaceId, 'foreign')
    const foreignAttach = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${foreignSession.sessionId}/events?since=bad`,
      agentKey.key,
      { headers: { 'last-event-id': '-1' } },
    )
    expect(foreignAttach.status).toBe(404)
    expect(await foreignAttach.json()).toEqual({ error: 'not_found' })

    const invalidResumeQuery = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/events?since=invalid`,
      agentKey.key,
    )
    expect(invalidResumeQuery.status).toBe(400)
    expect(await invalidResumeQuery.json()).toEqual({ error: 'invalid_request' })
    const invalidDualResume = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/events?future=1`,
      agentKey.key,
      { headers: { 'last-event-id': '-1' } },
    )
    expect(invalidDualResume.status).toBe(400)
    expect(await invalidDualResume.json()).toEqual({ error: 'invalid_request' })
    const invalidResumeHeader = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/events`,
      agentKey.key,
      { headers: { 'last-event-id': '-1' } },
    )
    expect(invalidResumeHeader.status).toBe(400)
    expect(await invalidResumeHeader.json()).toEqual({ error: 'invalid_last_event_id' })
    const aheadResume = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/events`,
      agentKey.key,
      { headers: { 'last-event-id': String(Number.MAX_SAFE_INTEGER) } },
    )
    expect(aheadResume.status).toBe(409)
    expect(await aheadResume.json()).toEqual({ error: 'last_event_id_ahead' })

    const firstAttach = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/events`,
      agentKey.key,
    )
    const firstEvents = await readSseEvents(firstAttach, 6)
    expect(firstEvents.map(event => event.event.type)).toEqual([
      'session_created',
      'prompt_submitted',
      'turn_started',
      'step',
      'step',
      'step',
    ])
    expect(firstEvents.map(event => event.seq)).toEqual([1, 2, 3, 4, undefined, 5])
    // Backfilled input frames carry the same identity-only author the history
    // page exposes, and nothing resolved from it.
    expect(firstEvents[1]!.event).toMatchObject({
      sender: { kind: 'user', userId: owner.user._id },
    })
    expect(firstEvents[1]!.event).not.toHaveProperty('userEmail')
    expect(firstEvents[3]!.event).toEqual({
      type: 'step',
      step: { type: 'text', text: 'canonical backfill' },
    })
    expect(firstEvents[4]).toEqual({
      eventName: 'step',
      event: { type: 'step', step: { type: 'text_delta', delta: 'live 5' } },
    })
    expect(firstEvents[5]).toMatchObject({
      seq: 5,
      event: { type: 'step', step: { type: 'text', text: 'live canonical 5' } },
    })

    const lastSeen = firstEvents.findLast(event => event.seq !== undefined)!.seq!
    await relayAgentEvent(proxyApp, proxied.vmToken, sessionId, {
      type: 'step',
      step: { type: 'text', text: 'canonical while disconnected' },
    })
    const secondAttach = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/events`,
      agentKey.key,
      { headers: { 'last-event-id': String(lastSeen) } },
    )
    const reattached = await readSseEvents(secondAttach, 3)
    expect(reattached.map(event => event.seq)).toEqual([6, undefined, 7])
    expect(reattached[0]!.event).toEqual({
      type: 'step',
      step: { type: 'text', text: 'canonical while disconnected' },
    })
    expect(reattached[1]).toEqual({
      eventName: 'step',
      event: { type: 'step', step: { type: 'text_delta', delta: 'live 7' } },
    })
    expect(reattached[2]).toMatchObject({
      seq: 7,
      event: { type: 'step', step: { type: 'text', text: 'live canonical 7' } },
    })
    const durableSeqsAcrossReconnect = [...firstEvents, ...reattached]
      .map(event => event.seq)
      .filter(seq => seq !== undefined)
    expect(new Set(durableSeqsAcrossReconnect).size).toBe(durableSeqsAcrossReconnect.length)

    const finishedSession = await createBackendAgentSession(proxied.workspaceId, 'finished prompt')
    await relayAgentEvent(proxyApp, proxied.vmToken, finishedSession.sessionId, {
      type: 'turn_started',
      state: runningTurnState(),
    })
    await relayAgentEvent(
      proxyApp,
      proxied.vmToken,
      finishedSession.sessionId,
      {
        type: 'complete',
        state: completedTurnState(),
        status: 'completed',
        result: 'done',
      },
      finishedSession.lastEventSeq,
    )
    expect(
      await convex.query('domains/agentSessions/model:findCoveringTerminal', {
        internalKey: INTERNAL_KEY,
        workspaceId: proxied.workspaceId,
        sessionId: finishedSession.sessionId,
        inputSeq: finishedSession.lastEventSeq,
      }),
    ).toMatchObject({ event: { type: 'complete', result: 'done' } })
    const liveAttachesBeforeFinished = gatewayCalls.filter(call => call.method === 'GET').length
    const finishedAttach = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${finishedSession.sessionId}/events`,
      agentKey.key,
    )
    const finishedEvents = await readSseEvents(finishedAttach, 10)
    expect(finishedEvents.map(event => event.event.type)).toEqual([
      'session_created',
      'prompt_submitted',
      'turn_started',
      'complete',
    ])
    expect(gatewayCalls.filter(call => call.method === 'GET')).toHaveLength(
      liveAttachesBeforeFinished,
    )
    expect(gatewayCalls.filter(call => call.method === 'GET').map(call => call.since)).toEqual([
      4, 6,
    ])

    const askWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-answer-retry'))
    await grantCredits(askWorkspace.workspaceId, 'grant:agent-answer-retry')
    const askKey = await issueKey(owner.client)
    let answerApp!: ReturnType<typeof createApiApp>
    const answerBackground = waitUntilCollector()
    const answerRequestId = crypto.randomUUID()
    const answerInput = {
      answer: 'approved',
      clientRequestId: answerRequestId,
      images: [{ data: 'YW5zd2VyLWltZw==', mimeType: 'image/webp' }],
      attachments: [
        {
          path: 'uploads/approval.pdf',
          name: 'approval.pdf',
          bytes: 23,
          mimeType: 'application/pdf',
        },
      ],
    }
    let acceptAnswers = false
    let answerGatewayCalls = 0
    let lastAnswerGatewayBody: GatewayRunnerInputRequest | undefined
    answerApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: answerBackground.waitUntil,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        if (body.input.kind === 'prompt') return runnerInputReceipt(body)
        answerGatewayCalls += 1
        lastAnswerGatewayBody = body
        return acceptAnswers
          ? runnerInputReceipt(body)
          : Response.json({ error: 'runner_unavailable' }, { status: 503 })
      },
    })
    const askCreated = await authedWith(
      answerApp,
      `/v1/ws/${askWorkspace.slug}/agent/sessions`,
      askKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'needs approval' }),
      },
    )
    expect(askCreated.status).toBe(201)
    const askSessionId = ((await askCreated.json()) as { session: { sessionId: string } }).session
      .sessionId
    await answerBackground.drain()
    await relayAgentEvent(answerApp, askWorkspace.vmToken, askSessionId, {
      type: 'ask',
      state: waitingTurnState(),
      questions: [{ question: 'Approve?', options: [] }],
    })
    const failedAnswer = await authedWith(
      answerApp,
      `/v1/ws/${askWorkspace.slug}/agent/sessions/${askSessionId}/answer`,
      askKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(answerInput),
      },
    )
    expect(failedAnswer.status).toBe(202)
    expect(await failedAnswer.json()).toEqual({ ok: true, delivery: 'queued' })
    await answerBackground.drain()
    const acceptedAnswer = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      workspaceId: askWorkspace.workspaceId,
      sessionId: askSessionId,
    })) as { turnStatus: string }
    expect(acceptedAnswer.turnStatus).toBe('running')
    expect(answerGatewayCalls).toBe(1)

    acceptAnswers = true
    const deliveredAnswer = await authedWith(
      answerApp,
      `/v1/ws/${askWorkspace.slug}/agent/sessions/${askSessionId}/answer`,
      askKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(answerInput),
      },
    )
    expect(deliveredAnswer.status).toBe(202)
    expect(await deliveredAnswer.json()).toEqual({ ok: true, delivery: 'accepted' })
    await answerBackground.drain()
    expect(
      await convex.query('domains/agentSessions/model:getSession', {
        internalKey: INTERNAL_KEY,
        workspaceId: askWorkspace.workspaceId,
        sessionId: askSessionId,
      }),
    ).toMatchObject({ turnStatus: 'running' })
    expect(answerGatewayCalls).toBe(2)
    expect(lastAnswerGatewayBody?.input.images).toEqual([
      { data: 'YW5zd2VyLWltZw==', mimeType: 'image/webp' },
    ])
    const answerEvents = (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: askWorkspace.workspaceId,
      sessionId: askSessionId,
    })) as Array<{ event: Record<string, unknown> }>
    expect(answerEvents.find(row => row.event.type === 'answer_submitted')?.event).toMatchObject({
      attachments: answerInput.attachments,
    })

    const acknowledgedRetry = await authedWith(
      answerApp,
      `/v1/ws/${askWorkspace.slug}/agent/sessions/${askSessionId}/answer`,
      askKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(answerInput),
      },
    )
    expect(acknowledgedRetry.status).toBe(202)
    expect(await acknowledgedRetry.json()).toEqual({ ok: true, delivery: 'accepted' })
    await answerBackground.drain()
    expect(answerGatewayCalls).toBe(2)
  }, 60_000)

  test('agent notes append without credit preflight or gateway dispatch', async () => {
    const noted = await provisionRegisteredWorkspace(uniqueSlug('agent-notes'))
    const agentKey = await issueKey(owner.client)
    const outsiderKey = await issueKey(
      (await humanWorkspaceFixture(noted.workspaceId, null)).client,
    )
    const gatewayCalls: string[] = []
    const noteApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        gatewayCalls.push(String(input))
        return Response.json({ ok: true })
      },
    })
    const runningSession = await createBackendAgentSession(noted.workspaceId, 'running prompt')
    const askSession = await createBackendAgentSession(noted.workspaceId, 'ask prompt')
    await convex.mutation('domains/agentSessions/model:relayRunnerEvent', {
      internalKey: INTERNAL_KEY,
      workspaceId: noted.workspaceId,
      sessionId: askSession.sessionId,
      relayId: crypto.randomUUID(),
      event: { type: 'ask', state: waitingTurnState(), questions: [] },
    })
    const completeSession = await createBackendAgentSession(noted.workspaceId, 'complete prompt')
    await convex.mutation('domains/agentSessions/model:relayRunnerEvent', {
      internalKey: INTERNAL_KEY,
      workspaceId: noted.workspaceId,
      sessionId: completeSession.sessionId,
      relayId: crypto.randomUUID(),
      event: {
        type: 'complete',
        state: completedTurnState(),
        status: 'completed',
        result: 'done',
      },
    })
    const otherWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-notes-other'))
    const otherSession = await createBackendAgentSession(otherWorkspace.workspaceId, 'other prompt')

    for (const [sessionId, note] of [
      [runningSession.sessionId, 'context while running'],
      [askSession.sessionId, 'context while asking'],
      [completeSession.sessionId, 'context after completion'],
    ]) {
      const response = await authedWith(
        noteApp,
        `/v1/ws/${noted.slug}/agent/sessions/${sessionId}/note`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            note,
            ...(sessionId === runningSession.sessionId
              ? {
                  attachments: [
                    {
                      path: 'uploads/note.pdf',
                      name: 'note.pdf',
                      bytes: 34,
                      mimeType: 'application/pdf',
                    },
                  ],
                }
              : {}),
          }),
        },
      )
      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({ seq: expect.any(Number) })
    }

    const noteEvents = (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: noted.workspaceId,
      sessionId: runningSession.sessionId,
    })) as Array<{ event: Record<string, unknown> }>
    expect(noteEvents.find(row => row.event.note === 'context while running')?.event).toMatchObject(
      {
        type: 'note_submitted',
        attachments: [
          {
            path: 'uploads/note.pdf',
            name: 'note.pdf',
            bytes: 34,
            mimeType: 'application/pdf',
          },
        ],
      },
    )

    const forbidden = await authedWith(
      noteApp,
      `/v1/ws/${noted.slug}/agent/sessions/${runningSession.sessionId}/note`,
      outsiderKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'wrong scope' }),
      },
    )
    expect(forbidden.status).toBe(403)
    const missing = await authedWith(
      noteApp,
      `/v1/ws/${noted.slug}/agent/sessions/${otherSession.sessionId}/note`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'wrong workspace' }),
      },
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not_found' })
    expect(gatewayCalls).toEqual([])
  })

  test('agent messages dispatch queued notes as a composed runner prompt', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-notes-flush'))
    await grantCredits(proxied.workspaceId, 'grant:agent-notes-flush')
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: Array<{ url: string; body: GatewayRunnerInputRequest }> = []
    const notesBackground = waitUntilCollector()
    const notesApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: notesBackground.waitUntil,
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push({
          url: String(input),
          body,
        })
        return runnerInputReceipt(body)
      },
    })

    const created = await authedWith(
      notesApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'initial work' }),
      },
    )
    expect(created.status).toBe(201)
    const sessionId = ((await created.json()) as { session: { sessionId: string } }).session
      .sessionId
    await notesBackground.drain()
    for (const note of ['prefer concise output', 'check README first']) {
      const noted = await authedWith(
        notesApp,
        `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/note`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note }),
        },
      )
      expect(noted.status).toBe(202)
    }

    const message = await authedWith(
      notesApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/messages`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'summarize the project', behavior: 'follow_up' }),
      },
    )
    expect(message.status).toBe(202)
    expect(await message.json()).toEqual({ ok: true, delivery: 'accepted' })
    await notesBackground.drain()
    expect(gatewayCalls).toEqual([
      {
        url: `https://gateway-proxy.exe.xyz/v1/agent/sessions/${sessionId}/input`,
        body: expectedRunnerInput({
          throughSeq: 2,
          message: 'initial work',
          behavior: 'steer',
        }),
      },
      {
        url: `https://gateway-proxy.exe.xyz/v1/agent/sessions/${sessionId}/input`,
        body: expectedRunnerInput({
          throughSeq: 5,
          behavior: 'follow_up',
          message: 'summarize the project',
          notes: [
            { seq: 3, body: 'prefer concise output' },
            { seq: 4, body: 'check README first' },
          ],
        }),
      },
    ])
    const events = (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      sessionId,
      afterSeq: 0,
    })) as Array<{ seq: number; event: { type: string } }>
    expect(events.map(row => [row.seq, row.event.type])).toEqual([
      [1, 'session_created'],
      [2, 'prompt_submitted'],
      [3, 'note_submitted'],
      [4, 'note_submitted'],
      [5, 'prompt_submitted'],
    ])
  })

  test('agent note images flush with the next message and replay bytes by scope', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-images-flush'))
    await grantCredits(proxied.workspaceId, 'grant:agent-images-flush')
    const agentKey = await issueKey(owner.client)
    const outsiderKey = await issueKey(
      (await humanWorkspaceFixture(proxied.workspaceId, null)).client,
    )
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const imageBackground = waitUntilCollector()
    const imageApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: imageBackground.waitUntil,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        return runnerInputReceipt(body)
      },
    })

    const created = await authedWith(
      imageApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'initial work' }),
      },
    )
    expect(created.status).toBe(201)
    const sessionId = ((await created.json()) as { session: { sessionId: string } }).session
      .sessionId
    await imageBackground.drain()
    const noteRequest = {
      note: 'use this screenshot',
      clientRequestId: '11111111-1111-4111-8111-111111111111',
      images: [{ data: 'bm90ZS1pbWc=', mimeType: 'image/png' }],
    }
    const note = await authedWith(
      imageApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/note`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(noteRequest),
      },
    )
    expect(note.status).toBe(202)
    const noteAccepted = (await note.json()) as { seq: number }

    // Simulate the caller losing the first response: the same semantic request
    // must deduplicate without deleting the blobs referenced by the durable row.
    const noteRetry = await authedWith(
      imageApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/note`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(noteRequest),
      },
    )
    expect(noteRetry.status).toBe(202)
    expect(await noteRetry.json()).toEqual(noteAccepted)

    const message = await authedWith(
      imageApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/messages`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'describe it',
          images: [{ data: 'cHJvbXB0LWltZw==', mimeType: 'image/webp' }],
        }),
      },
    )
    expect(message.status).toBe(202)
    expect(await message.json()).toEqual({ ok: true, delivery: 'accepted' })
    await imageBackground.drain()
    expect(gatewayCalls.at(-1)).toEqual(
      expectedRunnerInput({
        throughSeq: 4,
        behavior: 'steer',
        message: 'describe it',
        notes: [{ seq: 3, body: 'use this screenshot' }],
        images: [
          { data: 'cHJvbXB0LWltZw==', mimeType: 'image/webp' },
          { data: 'bm90ZS1pbWc=', mimeType: 'image/png' },
        ],
      }),
    )
    const events = (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      sessionId,
      afterSeq: 0,
    })) as Array<{
      seq: number
      event: {
        type: string
        images?: Array<{ storageId: string; mimeType: string; bytes: number }>
      }
    }>
    const noteImage = events.find(row => row.seq === 3)?.event.images?.[0]
    expect(noteImage).toMatchObject({ mimeType: 'image/png', bytes: 8 })
    expect(JSON.stringify(events)).not.toContain('bm90ZS1pbWc=')

    const replay = await authedWith(
      imageApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/images/${noteImage!.storageId}`,
      agentKey.key,
    )
    expect(replay.status).toBe(200)
    expect(replay.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await replay.arrayBuffer()).toString('utf8')).toBe('note-img')

    const forbidden = await authedWith(
      imageApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/images/${noteImage!.storageId}`,
      outsiderKey.key,
    )
    expect(forbidden.status).toBe(403)
  })

  test('agent image request caps and mime allowlist reject invalid inputs', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-image-reject'))
    await grantCredits(proxied.workspaceId, 'grant:agent-image-reject')
    const agentKey = await issueKey(owner.client)
    const imageApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: true }),
    })

    const tooMany = await authedWith(
      imageApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'look',
          images: Array.from({ length: 5 }, () => ({ data: 'aA==', mimeType: 'image/png' })),
        }),
      },
    )
    expect(tooMany.status).toBe(400)

    const badMime = await authedWith(
      imageApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'look',
          images: [{ data: 'aA==', mimeType: 'image/svg+xml' }],
        }),
      },
    )
    expect(badMime.status).toBe(400)
  })

  test('failed image dispatch leaves the image-bearing input queued', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-image-fail'))
    await grantCredits(proxied.workspaceId, 'grant:agent-image-fail')
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: unknown[] = []
    const imageFailureBackground = waitUntilCollector()
    const imageApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: imageFailureBackground.waitUntil,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        return gatewayCalls.length === 1
          ? runnerInputReceipt(body)
          : Response.json({ error: 'runner_unavailable' }, { status: 503 })
      },
    })
    const created = await authedWith(
      imageApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'initial' }),
      },
    )
    const sessionId = ((await created.json()) as { session: { sessionId: string } }).session
      .sessionId
    await imageFailureBackground.drain()

    const failed = await authedWith(
      imageApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/messages`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'will retry',
        }),
      },
    )
    expect(failed.status).toBe(202)
    expect(await failed.json()).toEqual({ ok: true, delivery: 'queued' })
    await imageFailureBackground.drain()
    const session = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      sessionId,
    })) as { lastDeliveredInputSeq: number; deliveryAttempt?: RunnerDeliveryAttempt }
    expect(session.lastDeliveredInputSeq).toBe(2)
    expect(session.deliveryAttempt).toBeUndefined()
    const events = (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      sessionId,
      afterSeq: 0,
    })) as Array<{
      seq: number
      event: {
        type: string
        images?: Array<{ storageId: string; mimeType: string; bytes: number }>
      }
    }>
    expect(events.find(row => row.seq === 3)?.event.images).toBeUndefined()
  })

  test('a lost initial prompt is redelivered by the next VM sync poll', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-sync-drain'))
    await grantCredits(proxied.workspaceId, 'grant:agent-sync-drain')
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const drainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        if (gatewayCalls.length === 1) {
          return Response.json({ error: 'runner_unavailable' }, { status: 503 })
        }
        return runnerInputReceipt(body)
      },
    })

    // Establish a fresh heartbeat so the next sync is inside the persistence
    // dedupe window — pending input must trigger the drain on its own.
    const warmup = await vmSyncRequest(drainApp, proxied.vmToken)
    expect(warmup.status).toBe(200)

    const created = await authedWith(
      drainApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'lost first prompt' }),
      },
    )
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      session: { sessionId: string }
      dispatched: boolean
    }
    expect(createdBody.dispatched).toBe(false)

    const sync = await vmSyncRequest(drainApp, proxied.vmToken)
    expect(sync.status).toBe(200)
    expect(gatewayCalls).toHaveLength(2)
    expect(gatewayCalls[1]).toEqual(
      expectedRunnerInput({ throughSeq: 2, message: 'lost first prompt', behavior: 'steer' }),
    )
  })

  test('failed create dispatch is retried and drained by the next message', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-create-drain'))
    await grantCredits(proxied.workspaceId, 'grant:agent-create-drain')
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const drainBackground = waitUntilCollector()
    const drainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: drainBackground.waitUntil,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        if (gatewayCalls.length === 1) {
          return Response.json({ error: 'runner_unavailable' }, { status: 503 })
        }
        return runnerInputReceipt(body)
      },
    })

    const created = await authedWith(
      drainApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'initial prompt' }),
      },
    )
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      session: { sessionId: string }
      dispatched: boolean
    }
    expect(createdBody.dispatched).toBe(false)
    await drainBackground.drain()

    // A lost initial prompt must be visible to the VM-sync drain rail — the
    // user may never send a follow-up to shake it loose.
    const drainCandidates = (await convex.query(
      'domains/agentSessions/model:listRunnerInputDrainCandidates',
      {
        internalKey: INTERNAL_KEY,
        workspaceId: proxied.workspaceId,
        limit: 10,
      },
    )) as { sessions: Array<{ sessionId: string }> }
    expect(drainCandidates.sessions.map(row => row.sessionId)).toContain(
      createdBody.session.sessionId,
    )

    const message = await authedWith(
      drainApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${createdBody.session.sessionId}/messages`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'follow up after failed create' }),
      },
    )
    expect(message.status).toBe(202)
    expect(await message.json()).toEqual({ ok: true, delivery: 'queued' })
    await drainBackground.drain()
    expect(gatewayCalls).toEqual([
      expectedRunnerInput({
        throughSeq: 2,
        message: 'initial prompt',
        behavior: 'steer',
      }),
      expectedRunnerInput({
        throughSeq: 2,
        message: 'initial prompt',
        behavior: 'steer',
      }),
      expectedRunnerInput({
        throughSeq: 3,
        message: 'follow up after failed create',
        behavior: 'steer',
      }),
    ])
    const session = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      sessionId: createdBody.session.sessionId,
    })) as { lastDeliveredInputSeq: number; deliveryAttempt?: RunnerDeliveryAttempt }
    expect(session.lastDeliveredInputSeq).toBe(3)
    expect(session.deliveryAttempt).toBeUndefined()
  })

  test('drain abandons the failed attempt and leaves later input queued', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-drain-failure'))
    await grantCredits(proxied.workspaceId, 'grant:agent-drain-failure')
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const drainFailureBackground = waitUntilCollector()
    const drainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: drainFailureBackground.waitUntil,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        if (gatewayCalls.length === 1 || gatewayCalls.length === 3) {
          return Response.json({ error: 'runner_unavailable' }, { status: 503 })
        }
        return runnerInputReceipt(body)
      },
    })

    const created = await authedWith(
      drainApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'initial prompt' }),
      },
    )
    const sessionId = ((await created.json()) as { session: { sessionId: string } }).session
      .sessionId
    await drainFailureBackground.drain()
    const message = await authedWith(
      drainApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/messages`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'queued follow up' }),
      },
    )
    expect(message.status).toBe(202)
    expect(await message.json()).toEqual({ ok: true, delivery: 'queued' })
    await drainFailureBackground.drain()
    expect(gatewayCalls).toEqual([
      expectedRunnerInput({
        throughSeq: 2,
        message: 'initial prompt',
        behavior: 'steer',
      }),
      expectedRunnerInput({
        throughSeq: 2,
        message: 'initial prompt',
        behavior: 'steer',
      }),
      expectedRunnerInput({
        throughSeq: 3,
        message: 'queued follow up',
        behavior: 'steer',
      }),
    ])
    const session = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      sessionId,
    })) as { lastDeliveredInputSeq: number; deliveryAttempt?: RunnerDeliveryAttempt }
    expect(session.lastDeliveredInputSeq).toBe(2)
    expect(session.deliveryAttempt).toBeUndefined()
  }, 120_000)

  test('create accepts a cwd and threads it through gateway dispatch and the snapshot', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-create-cwd'))
    await grantCredits(proxied.workspaceId, 'grant:agent-create-cwd')
    const registeredAgent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'projects/demo',
      slug: 'demo-agent',
      name: 'Demo Agent',
    })) as { id: string }
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const createBackground = waitUntilCollector()
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: createBackground.waitUntil,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        return runnerInputReceipt(body)
      },
    })

    const created = await authedWith(app, `/v1/ws/${proxied.slug}/agent/sessions`, agentKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'work in the demo folder',
        behavior: 'follow_up',
        cwd: 'projects/demo',
      }),
    })
    expect(created.status).toBe(201)
    const sessionId = ((await created.json()) as { session: { sessionId: string } }).session
      .sessionId
    await createBackground.drain()
    expect(gatewayCalls).toEqual([
      expectedRunnerInput({
        throughSeq: 2,
        message: 'work in the demo folder',
        behavior: 'follow_up',
        cwd: 'projects/demo',
      }),
    ])

    const snapshot = await authedWith(
      app,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}`,
      agentKey.key,
    )
    expect(snapshot.status).toBe(200)
    const snapshotBody = (await snapshot.json()) as {
      cwd?: string
      agent?: { id: string; name: string }
      lastDeliveredInputSeq?: number
    }
    expect(snapshotBody.cwd).toBe('projects/demo')
    expect(snapshotBody.agent).toEqual({ id: registeredAgent.id, name: 'Demo Agent' })
    expect(snapshotBody).not.toHaveProperty('userId')
    expect(snapshotBody).not.toHaveProperty('creator')
    expect(snapshotBody.lastDeliveredInputSeq).toBe(2)

    for (const cwd of ['/etc', 'projects/../..', '..']) {
      const rejected = await authedWith(
        app,
        `/v1/ws/${proxied.slug}/agent/sessions`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'escape the drive', cwd }),
        },
      )
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({ error: 'invalid_request' })
    }
    expect(gatewayCalls).toHaveLength(1)
  })

  test('cwd route authenticates a post-rotation VM key and commits only after the canonical gateway receipt', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('agent-cwd-route'))
    const other = await provisionRegisteredWorkspace(uniqueSlug('agent-cwd-route-other'))
    const session = await createAgentSession(
      target.workspaceId,
      'Move this session',
      1_000,
      'projects/drafts',
    )
    // Real clock: the auth middleware validates expiry with Date.now(), so
    // keys minted at tiny synthetic epochs arrive pre-expired.
    const mintedAt = Date.now()
    const staleVmKey = (await convex.mutation('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      now: mintedAt,
    })) as { key: string; prefix: string }
    await convex.mutation('testing/apiKeys:replaceApiKeyScopesForTest', {
      internalKey: INTERNAL_KEY,
      keyPrefix: staleVmKey.prefix,
      scopes: [`ws:${target.slug}:services`, `ws:${target.slug}:apps`, `ws:${target.slug}:agents`],
    })
    const vmKey = (await convex.mutation('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      now: mintedAt + 1,
    })) as { key: string; scopes: string[] }
    expect(vmKey.scopes).toContain(`ws:${target.slug}:sessions`)
    const otherKey = (await convex.mutation('domains/apiKeys/mutations:mintVmModelKey', {
      internalKey: INTERNAL_KEY,
      workspaceId: other.workspaceId,
      now: mintedAt,
    })) as { key: string }
    let cwdObservedAtGateway: unknown
    const cwdApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 3_000,
      fetch: async (_input, init) => {
        cwdObservedAtGateway = (
          (await convex.query('domains/agentSessions/model:getSession', {
            internalKey: INTERNAL_KEY,
            workspaceId: target.workspaceId,
            sessionId: session.sessionId,
          })) as { cwd?: string }
        ).cwd
        expect(JSON.parse(String(init?.body))).toEqual({
          cwd: 'projects/drafts/../published',
        })
        return Response.json({ cwd: 'projects/published' })
      },
    })
    const path = `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/cwd`

    const moved = await authedWith(cwdApp, path, vmKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'projects/drafts/../published' }),
    })
    expect(moved.status).toBe(200)
    expect(await moved.json()).toEqual({
      session: { id: session.sessionId, cwd: 'projects/published' },
    })
    expect(cwdObservedAtGateway).toBe('projects/drafts')
    expect(
      await convex.query('domains/agentSessions/model:getSession', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ cwd: 'projects/published', updatedAt: 3_000 })

    // Scope-first like every sibling session route: a foreign workspace's
    // key gets the typed insufficient_scope, not a workspace-hiding 404.
    const hidden = await authedWith(cwdApp, path, otherKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'projects/hidden' }),
    })
    expect(hidden.status).toBe(403)
    expect(await hidden.json()).toMatchObject({ error: 'insufficient_scope' })
  })

  test('cwd route returns a gateway 422 verbatim without mutating the row', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('agent-cwd-invalid'))
    const session = await createAgentSession(
      target.workspaceId,
      'Reject this move',
      1_000,
      'projects/current',
    )
    const key = await issueKey(owner.client)
    const cwdApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () =>
        Response.json({ error: 'invalid_cwd', reason: 'not_a_directory' }, { status: 422 }),
    })

    const response = await authedWith(
      cwdApp,
      `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/cwd`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: 'projects/missing' }),
      },
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: 'invalid_cwd',
      reason: 'not_a_directory',
    })
    expect(
      await convex.query('domains/agentSessions/model:getSession', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ cwd: 'projects/current', updatedAt: 1_000 })
  })

  test('cwd route returns 502 without mutating when the gateway is unreachable', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('agent-cwd-down'))
    const session = await createAgentSession(
      target.workspaceId,
      'Keep this cwd',
      1_000,
      'projects/current',
    )
    const key = await issueKey(owner.client)
    const cwdApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => {
        throw new Error('gateway down')
      },
    })

    const response = await authedWith(
      cwdApp,
      `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/cwd`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: 'projects/next' }),
      },
    )

    expect(response.status).toBe(502)
    expect(
      await convex.query('domains/agentSessions/model:getSession', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ cwd: 'projects/current', updatedAt: 1_000 })
  })

  test('cwd route maps a lost CAS to 409 and preserves the newer row', async () => {
    const target = await provisionRegisteredWorkspace(uniqueSlug('agent-cwd-conflict'))
    const session = await createAgentSession(
      target.workspaceId,
      'Race this move',
      1_000,
      'projects/current',
    )
    const key = await issueKey(owner.client)
    const gatewayCwdPosts: unknown[] = []
    const cwdApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        gatewayCwdPosts.push(JSON.parse(String(init?.body)))
        if (gatewayCwdPosts.length > 1) return Response.json({ cwd: 'projects/concurrent' })
        await convex.mutation('domains/agentSessions/model:setSessionCwd', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId: target.workspaceId,
          sessionId: session.sessionId,
          expectedCwd: 'projects/current',
          cwd: 'projects/concurrent',
          now: 2_000,
        })
        return Response.json({ cwd: 'projects/requested' })
      },
    })

    const response = await authedWith(
      cwdApp,
      `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/cwd`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: 'projects/requested' }),
      },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'cwd_conflict' })
    expect(
      await convex.query('domains/agentSessions/model:getSession', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ cwd: 'projects/concurrent', updatedAt: 2_000 })
    // The losing request re-aligns the gateway with the row's authoritative
    // cwd so the envelope never idles on the rejected value.
    expect(gatewayCwdPosts).toEqual([{ cwd: 'projects/requested' }, { cwd: 'projects/concurrent' }])
  })

  /* A reader's transcript is a thin slice of the timeline: a subagent-heavy
     turn is thousands of task rows around a few dozen visible ones. Paging the
     raw timeline hands the reader page after page that renders to nothing. The
     transcript view pages the visible rows by their own index, and its cursor
     stays bound to that view. */
  test('the transcript view pages only the rows a reader sees and binds its cursor', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-history-transcript'))
    const key = await issueKey(owner.client)
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: true, discarded: false }),
    })
    const session = await createAgentSession(proxied.workspaceId, 'Build the bridge', 1_000)
    const relay = (event: Record<string, unknown>, acceptedThroughSeq?: number) =>
      relayAgentEvent(app, proxied.vmToken, session.sessionId, event, acceptedThroughSeq)
    // seq 1 session_created, seq 2 prompt_submitted, then:
    await relay({ type: 'turn_started', state: runningTurnState() }) // 3
    await relay({
      type: 'task_started',
      task: {
        id: 't1',
        kind: 'subagent',
        name: 'security-review',
        label: 'Run state security-review',
        ownerScopeId: 'turn-1',
        status: 'running',
        startedAt: 1_100,
      },
    }) // 4
    await relay({
      type: 'step',
      origin: { taskId: 't1' },
      step: { type: 'text', text: 'work inside the child' },
    }) // 5
    await relay({ type: 'task_output', taskId: 't1', chunk: 'child output' }) // 6
    await relay({
      type: 'task_settled',
      settlement: { id: 't1', status: 'completed', settledAt: 1_200, result: 'child done' },
    }) // 7
    await relay({ type: 'step', step: { type: 'text', text: 'the answer' } }) // 8
    await relay(
      { type: 'complete', state: completedTurnState(), status: 'completed', result: 'the answer' },
      2,
    ) // 9

    const historyPath = `/v1/ws/${proxied.slug}/agent/sessions/${session.sessionId}/history`
    const pageSeqs = async (query: string) => {
      const response = await authedWith(app, `${historyPath}?${query}`, key.key)
      expect(response.status).toBe(200)
      const page = (await response.json()) as SessionHistoryPage
      return { seqs: page.items.map(item => item.seq), nextCursor: page.nextCursor }
    }

    const newest = await pageSeqs('view=transcript&limit=2')
    expect(newest.seqs).toEqual([9, 8])
    const older = await pageSeqs(
      `view=transcript&limit=2&cursor=${encodeURIComponent(newest.nextCursor!)}`,
    )
    expect(older.seqs).toEqual([3, 2])
    const oldest = await pageSeqs(
      `view=transcript&limit=2&cursor=${encodeURIComponent(older.nextCursor!)}`,
    )
    expect(oldest).toEqual({ seqs: [1], nextCursor: null })

    const ascending = await pageSeqs('view=transcript&order=asc&afterSeq=2')
    expect(ascending).toEqual({ seqs: [3, 8, 9], nextCursor: null })

    // The raw timeline is untouched: runner replays and wait callers still see
    // every row.
    expect((await pageSeqs('limit=100')).seqs).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1])

    const rebound = await authedWith(
      app,
      `${historyPath}?cursor=${encodeURIComponent(newest.nextCursor!)}`,
      key.key,
    )
    expect(rebound.status).toBe(400)
    expect(await rebound.json()).toEqual({ error: 'invalid_cursor' })
  }, 60_000)

  describe('agent session list route', () => {
    test('lists only roots or one parent direct children and binds child cursors to that parent', async () => {
      const listed = await provisionRegisteredWorkspace(uniqueSlug('agent-lineage-route'))
      const key = await issueKey(owner.client)
      const listApp = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
      const parent = await createAgentSession(listed.workspaceId, 'parent', 1_000)
      for (const slug of ['lineage-one', 'lineage-two']) {
        await mutate(owner.client, 'domains/agents/model:registerAgent', {
          workspaceId: listed.workspaceId,
          path: `agents/${slug}`,
          slug,
          name: slug,
        })
      }
      const createChild = async (
        parentSessionId: string,
        attemptId: string,
        now: number,
        cwd: string,
      ) =>
        (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId: listed.workspaceId,
          createdBySessionId: parentSessionId,
          attemptId,
          input: {
            kind: 'initial_prompt',
            prompt: attemptId,
            behavior: 'steer',
            sender: { kind: 'session', sessionId: parentSessionId },
            cwd,
          },
          now,
        })) as { sessionId: string }
      const firstChild = await createChild(
        parent.sessionId,
        'api-lineage-first-child',
        3_000,
        'agents/lineage-one',
      )
      const secondChild = await createChild(
        parent.sessionId,
        'api-lineage-second-child',
        4_000,
        'agents/lineage-two',
      )
      const grandchild = await createChild(
        secondChild.sessionId,
        'api-lineage-grandchild',
        5_000,
        'agents/lineage-one',
      )

      const roots = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions?topLevel=true`,
        key.key,
      )
      expect(roots.status).toBe(200)
      const rootsBody = (await roots.json()) as SessionListPage
      expect(rootsBody.items.map(row => row.id)).toEqual([parent.sessionId])

      const children = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions/${parent.sessionId}/sessions`,
        key.key,
      )
      expect(children.status).toBe(200)
      const childrenBody = (await children.json()) as SessionListPage
      expect(childrenBody.items.map(row => row.id)).toEqual([
        secondChild.sessionId,
        firstChild.sessionId,
      ])
      expect(childrenBody.nextCursor).toBeNull()

      const grandchildren = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions/${secondChild.sessionId}/sessions`,
        key.key,
      )
      expect(grandchildren.status).toBe(200)
      const grandchildrenBody = (await grandchildren.json()) as SessionListPage
      expect(grandchildrenBody.items.map(row => row.id)).toEqual([grandchild.sessionId])

      const pagedChildren = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions/${parent.sessionId}/sessions?limit=1`,
        key.key,
      )
      const pagedChildrenBody = (await pagedChildren.json()) as SessionListPage
      expect(pagedChildrenBody.items.map(row => row.id)).toEqual([secondChild.sessionId])
      expect(pagedChildrenBody.nextCursor).toBeString()
      const secondChildPage = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions/${parent.sessionId}/sessions?limit=1&cursor=${encodeURIComponent(pagedChildrenBody.nextCursor!)}`,
        key.key,
      )
      expect(secondChildPage.status).toBe(200)
      expect(await secondChildPage.json()).toMatchObject({
        items: [expect.objectContaining({ id: firstChild.sessionId })],
        nextCursor: null,
      })
      const wrongParentCursor = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions/${firstChild.sessionId}/sessions?limit=1&cursor=${encodeURIComponent(pagedChildrenBody.nextCursor!)}`,
        key.key,
      )
      expect(wrongParentCursor.status).toBe(400)
      expect(await wrongParentCursor.json()).toEqual({ error: 'invalid_cursor' })

      const malformedParent = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions/not-a-session/sessions`,
        key.key,
      )
      expect(malformedParent.status).toBe(404)
      expect(await malformedParent.json()).toEqual({ error: 'not_found' })

      for (const path of [
        `/v1/ws/${listed.slug}/agent/sessions?topLevel=false`,
        `/v1/ws/${listed.slug}/agent/sessions/${parent.sessionId}/sessions?search=child`,
      ]) {
        const invalid = await authedWith(listApp, path, key.key)
        expect(invalid.status).toBe(400)
        expect(await invalid.json()).toEqual({ error: 'invalid_request' })
      }
    })

    test('requires the sessions capability and pages newest-first session summaries', async () => {
      const listed = await provisionRegisteredWorkspace(uniqueSlug('agent-list-route'))
      const agentKey = await issueKey(owner.client)
      const outsiderKey = await issueKey(
        (await humanWorkspaceFixture(listed.workspaceId, null)).client,
      )
      const listApp = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

      const denied = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions`,
        outsiderKey.key,
      )
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({
        error: 'insufficient_scope',
        scope: `ws:${listed.slug}:sessions`,
      })

      const longPrompt = 'x'.repeat(260)
      const first = await createAgentSession(listed.workspaceId, longPrompt, 1_000)
      const second = await createAgentSession(listed.workspaceId, 'second prompt', 2_000)
      const third = await createAgentSession(
        listed.workspaceId,
        'third prompt',
        3_000,
        'projects/third',
      )
      await appendAgentNote(listed.workspaceId, first.sessionId, 'route bump', 4_000)

      const firstPage = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions?limit=2`,
        agentKey.key,
      )
      expect(firstPage.status).toBe(200)
      const firstBody = (await firstPage.json()) as SessionListPage
      expect(firstBody.items.map(session => session.id)).toEqual([first.sessionId, third.sessionId])
      expect(firstBody.items[0]).toMatchObject({
        turnStatus: 'running',
        title: `${'x'.repeat(71)}…`,
        titleOrigin: 'excerpt',
        createdAt: 1_000,
        updatedAt: 4_000,
        lastEventSeq: 3,
      })
      expect(firstBody.items[0]!.cwd).toBeUndefined()
      expect(firstBody.items[1]!.cwd).toBe('projects/third')
      expect(firstBody.items[0]).not.toHaveProperty('userId')
      expect(firstBody.items[0]).not.toHaveProperty('creator')
      expect(firstBody.nextCursor).toBeDefined()

      const secondPage = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions?limit=2&cursor=${encodeURIComponent(
          firstBody.nextCursor!,
        )}`,
        agentKey.key,
      )
      expect(secondPage.status).toBe(200)
      const secondBody = (await secondPage.json()) as SessionListPage
      expect(secondBody.items.map(session => session.id)).toEqual([second.sessionId])
      expect(secondBody.nextCursor).toBeNull()

      for (const cursorUrl of [
        `/v1/ws/${listed.slug}/agent/sessions?cursor=not-an-opaque-cursor`,
        `/v1/ws/${listed.slug}/agent/sessions?search=third&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      ]) {
        const invalid = await authedWith(listApp, cursorUrl, agentKey.key)
        expect(invalid.status).toBe(400)
        expect(await invalid.json()).toEqual({ error: 'invalid_cursor' })
      }

      const otherWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-list-cursor'))
      const otherKey = await issueKey(owner.client)
      const crossWorkspace = await authedWith(
        listApp,
        `/v1/ws/${otherWorkspace.slug}/agent/sessions?cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
        otherKey.key,
      )
      expect(crossWorkspace.status).toBe(400)
      expect(await crossWorkspace.json()).toEqual({ error: 'invalid_cursor' })

      const clamped = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions?limit=0`,
        agentKey.key,
      )
      expect(clamped.status).toBe(400)
      expect(await clamped.json()).toEqual({ error: 'invalid_request' })
    })

    test('forwards an agent scope and rejects the archived:include combination (D19)', async () => {
      const listed = await provisionRegisteredWorkspace(uniqueSlug('agent-list-scope'))
      const agentKey = await issueKey(owner.client)
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
      const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId: listed.workspaceId,
        path: 'agents/scout',
        slug: 'scout',
        name: 'Scout',
      })) as { id: string }
      const attributed = await createAgentSession(
        listed.workspaceId,
        'scoped agent session',
        1_000,
        'agents/scout/notes',
      )
      const rootSession = await createAgentSession(listed.workspaceId, 'root session', 2_000)

      const scoped = await authedWith(
        app,
        `/v1/ws/${listed.slug}/agent/sessions?agentId=${encodeURIComponent(agent.id)}`,
        agentKey.key,
      )
      expect(scoped.status).toBe(200)
      expect(((await scoped.json()) as SessionListPage).items.map(s => s.id)).toEqual([
        attributed.sessionId,
      ])

      const root = await authedWith(
        app,
        `/v1/ws/${listed.slug}/agent/sessions?agentId=root`,
        agentKey.key,
      )
      expect(root.status).toBe(200)
      expect(((await root.json()) as SessionListPage).items.map(s => s.id)).toEqual([
        rootSession.sessionId,
      ])

      const rejected = await authedWith(
        app,
        `/v1/ws/${listed.slug}/agent/sessions?agentId=${encodeURIComponent(agent.id)}&archived=include`,
        agentKey.key,
      )
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({ error: 'invalid_request' })
    })

    test('uses the default page size and keeps workspaces isolated', async () => {
      const listed = await provisionRegisteredWorkspace(uniqueSlug('agent-list-default'))
      const other = await provisionRegisteredWorkspace(uniqueSlug('agent-list-other'))
      const agentKey = await issueKey(owner.client)
      const listApp = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

      for (let index = 0; index < 21; index += 1) {
        await createAgentSession(listed.workspaceId, `listed ${index}`, 10_000 + index)
      }
      await createAgentSession(other.workspaceId, 'other workspace', 99_000)

      const response = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions`,
        agentKey.key,
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as SessionListPage

      expect(body.items).toHaveLength(21)
      expect(body.items.map(session => session.title)).not.toContain('other workspace')
      expect(body.nextCursor).toBeNull()
    }, 45_000)

    test('returns an empty search page with a continuation when bounded scanning has more work', async () => {
      const listed = await provisionRegisteredWorkspace(uniqueSlug('agent-list-empty-page'))
      const agentKey = await issueKey(owner.client)
      const listApp = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
      const match = await createAgentSession(
        listed.workspaceId,
        'uniquely discoverable needle',
        1_000,
      )
      const stale = await createAgentSession(
        listed.workspaceId,
        'uniquely discoverable needle stale row',
        2_000,
      )
      await convex.mutation('testing/agentSessions:setSessionVisibleWithoutDiscoveryForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: stale.sessionId,
        visible: false,
      })

      const firstResponse = await authedWith(
        listApp,
        `/v1/ws/${listed.slug}/agent/sessions?search=uniquely%20discoverable%20needle&limit=1`,
        agentKey.key,
      )
      expect(firstResponse.status).toBe(200)
      const first = (await firstResponse.json()) as SessionListPage
      expect(first.items).toEqual([])
      expect(first.nextCursor).toEqual(expect.any(String))

      const found = [...first.items]
      let cursor = first.nextCursor
      while (cursor !== null) {
        const response = await authedWith(
          listApp,
          `/v1/ws/${listed.slug}/agent/sessions?search=uniquely%20discoverable%20needle&limit=1&cursor=${encodeURIComponent(cursor)}`,
          agentKey.key,
        )
        expect(response.status).toBe(200)
        const page = (await response.json()) as SessionListPage
        found.push(...page.items)
        cursor = page.nextCursor
      }
      expect(found.map(session => session.id)).toEqual([match.sessionId])
    }, 90_000)

    test('returns machine-backed and plain sessions in one page, bucketed apart', async () => {
      const listed = await provisionRegisteredWorkspace(uniqueSlug('agent-jobs-route'))
      const agentKey = await issueKey(owner.client)
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
      const registeredAgent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId: listed.workspaceId,
        path: 'jobs/deploy',
        slug: 'deploy-agent',
        name: 'Deploy Agent',
      })) as { id: string }
      const job = await createAgentSession(
        listed.workspaceId,
        'Deployment reminder',
        1_000,
        'jobs/deploy',
      )
      const ordinary = await createAgentSession(listed.workspaceId, 'Ordinary session', 2_000)
      const stateMachine = apiStateMachineFixture()
      await convex.mutation('domains/agentSessions/model:relayRunnerEvent', {
        internalKey: INTERNAL_KEY,
        workspaceId: listed.workspaceId,
        sessionId: job.sessionId,
        relayId: crypto.randomUUID(),
        event: { type: 'state_machine', stateMachine },
        now: 3_000,
      })

      // Settle both turns. This is the pair that matters: two sessions whose
      // turn ended identically, bucketed apart because one of them still has a
      // machine running underneath it.
      for (const [sessionId, at] of [
        [ordinary.sessionId, 2_500],
        [job.sessionId, 3_500],
      ] as const) {
        await convex.mutation('domains/agentSessions/model:relayRunnerEvent', {
          internalKey: INTERNAL_KEY,
          workspaceId: listed.workspaceId,
          sessionId,
          relayId: crypto.randomUUID(),
          event: { type: 'complete', state: completedTurnState(), status: 'completed' },
          now: at,
        })
      }

      // There is one list. A job is a session that happens to carry a machine,
      // so it comes back from the same route as an ordinary conversation —
      // newest first — rather than from a second route under a second name.
      const all = await authedWith(app, `/v1/ws/${listed.slug}/agent/sessions`, agentKey.key)
      expect(all.status).toBe(200)
      const listedSessions = ((await all.json()) as SessionListPage).items
      expect(listedSessions.map(session => session.id)).toEqual([job.sessionId, ordinary.sessionId])
      expect(listedSessions[0]).toMatchObject({
        id: job.sessionId,
        agent: { id: registeredAgent.id, name: 'Deploy Agent' },
        // The turn ended; the machine did not. `bucket` reads the machine when
        // there is one, which is the whole reason it is a materialized column
        // and not `turnStatus` under another name.
        turnStatus: 'complete',
        bucket: 'running',
        machine: { step: 'wait', activity: 'running' },
      })
      // Same turn outcome, no machine, different bucket.
      expect(listedSessions[1]).toMatchObject({
        id: ordinary.sessionId,
        turnStatus: 'complete',
        bucket: 'done',
      })
      expect(listedSessions[1]).not.toHaveProperty('machine')

      // What `?view=active` used to select is now a bucket filter on the one list.
      const running = await authedWith(
        app,
        `/v1/ws/${listed.slug}/agent/sessions?bucket=running&search=deployment&limit=1`,
        agentKey.key,
      )
      expect(running.status).toBe(200)
      expect(((await running.json()) as SessionListPage).items.map(s => s.id)).toEqual([
        job.sessionId,
      ])

      const invalid = await authedWith(
        app,
        `/v1/ws/${listed.slug}/agent/sessions?bucket=unknown`,
        agentKey.key,
      )
      expect(invalid.status).toBe(400)
    })

    test('activity is one read per owner, and its route beats :sessionId', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-activity-route'))
      const agentKey = await issueKey(owner.client)
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => Response.json({ ok: true, discarded: false }),
      })
      const session = await createAgentSession(workspace.workspaceId, 'Drive work', 1_000)

      const response = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/activity`,
        agentKey.key,
      )
      /* The assertion that matters is not the body but that we got one at all:
         Hono matches in registration order, so `activity` registered after
         `:sessionId` would arrive as a session id and answer 404 for a session
         nobody asked for. A literal losing to a parameter is silent in exactly
         this way. */
      expect(response.status).toBe(200)
      const body = SessionActivityResponseSchema.parse(await response.json())
      const root = body.owners.find(owner => owner.agentId === ROOT_AGENT_SCOPE)
      expect(root?.sessions.map(row => row.id)).toEqual([session.sessionId])
      expect(root?.truncated).toBe(false)

      // The neighbouring route still resolves a real id, so the fix is an
      // ordering rather than a carve-out.
      const detail = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
      )
      expect(detail.status).toBe(200)
    })

    test('detail hides a specific session from a viewer who is not a participant', async () => {
      const target = await provisionRegisteredWorkspace(uniqueSlug('agent-detail-audience'))
      const viewer = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail('agent-detail-audience-viewer'),
        'Audience Viewer',
      )
      await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        userId: viewer.user._id,
        role: 'viewer',
      })
      const ownerMembership = (
        (await convex.query('testing/workspaces:workspaceMembersForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: target.workspaceId,
        })) as Array<{ _id: string; userId: string }>
      ).find(member => member.userId === owner.user._id)!._id
      const session = await createAgentSession(
        target.workspaceId,
        'Keep this side chat quiet',
        1_000,
      )
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        sessionId: session.sessionId,
        membershipIds: [ownerMembership],
      })
      const viewerKey = await issueKey(viewer.client)
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

      const response = await authedWith(
        app,
        `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}`,
        viewerKey.key,
      )

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    })

    test('point routes normalize malformed ids before any gateway side effect', async () => {
      const target = await provisionRegisteredWorkspace(uniqueSlug('agent-point-malformed'))
      const key = await issueKey(owner.client)
      let gatewayCalls = 0
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => {
          gatewayCalls += 1
          return Response.json({ ok: true })
        },
      })
      const path = `/v1/ws/${target.slug}/agent/sessions/not-a-session`
      const requests: RequestInit[] = [
        {},
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Never written' }),
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: 'projects/never' }),
        },
        { method: 'POST' },
        {},
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seq: 1 }),
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'Never billed or dispatched' }),
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer: 'Never appended' }),
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: 'Never stored' }),
        },
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Never waited',
            clientRequestId: crypto.randomUUID(),
          }),
        },
      ]
      const suffixes = [
        '',
        '',
        '/cwd',
        '/interrupt',
        '/history',
        '/read',
        '/messages',
        '/answer',
        '/note',
        '/images/not-storage',
        '/messages/wait',
      ]

      for (let index = 0; index < requests.length; index += 1) {
        const response = await authedWith(
          app,
          `${path}${suffixes[index]}`,
          key.key,
          requests[index],
        )
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'not_found' })
      }
      for (const [suffix, init] of [
        ['/integrations', { method: 'POST' }],
        [
          '/events',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              relayId: crypto.randomUUID(),
              event: { type: 'turn_started', state: runningTurnState() },
            }),
          },
        ],
      ] as const) {
        const response = await app.request(`/v1/vm/agent/sessions/not-a-session${suffix}`, {
          ...init,
          headers: {
            ...('headers' in init ? init.headers : {}),
            authorization: `Bearer ${target.vmToken}`,
          },
        })
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'not_found' })
      }
      expect(gatewayCalls).toBe(0)
    })

    test('a viewer participant can rename a specific session', async () => {
      const target = await provisionRegisteredWorkspace(uniqueSlug('agent-rename-participant'))
      const viewer = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail('agent-rename-participant-viewer'),
        'Rename Viewer',
      )
      const membershipId = (await mutate(
        owner.client,
        'testing/workspaces:addWorkspaceMemberForTest',
        {
          internalKey: INTERNAL_KEY,
          workspaceId: target.workspaceId,
          userId: viewer.user._id,
          role: 'viewer',
        },
      )) as string
      const session = await createAgentSession(target.workspaceId, 'Let a viewer rename me', 1_000)
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        sessionId: session.sessionId,
        membershipIds: [membershipId],
      })
      const viewerKey = await issueKey(viewer.client)
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

      const response = await authedWith(
        app,
        `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}`,
        viewerKey.key,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Viewer-owned title' }),
        },
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        id: session.sessionId,
        title: 'Viewer-owned title',
        permissions: { rename: true },
      })
    })

    test('delete authorizes a live root once and accepts replayed work', async () => {
      const target = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-policy'))
      const viewer = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail('agent-delete-policy-viewer'),
        'Delete Viewer',
      )
      const editor = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail('agent-delete-policy-editor'),
        'Delete Editor',
      )
      const viewerMembershipId = (await mutate(
        owner.client,
        'testing/workspaces:addWorkspaceMemberForTest',
        {
          internalKey: INTERNAL_KEY,
          workspaceId: target.workspaceId,
          userId: viewer.user._id,
          role: 'viewer',
        },
      )) as string
      const editorMembershipId = (await mutate(
        owner.client,
        'testing/workspaces:addWorkspaceMemberForTest',
        {
          internalKey: INTERNAL_KEY,
          workspaceId: target.workspaceId,
          userId: editor.user._id,
          role: 'editor',
        },
      )) as string
      const viewerKey = await issueKey(viewer.client)
      const editorKey = await issueKey(editor.client)
      const ownerKey = await issueKey(owner.client)
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
      const deleteRequest = (sessionId: string, key: string) =>
        authedWith(app, `/v1/ws/${target.slug}/agent/sessions/${sessionId}`, key, {
          method: 'DELETE',
        })

      const viewerSession = await createAgentSession(
        target.workspaceId,
        'Viewer cannot delete this side chat',
        1_000,
      )
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        sessionId: viewerSession.sessionId,
        membershipIds: [viewerMembershipId, editorMembershipId],
      })
      expect((await deleteRequest(viewerSession.sessionId, viewerKey.key)).status).toBe(403)
      expect((await deleteRequest(viewerSession.sessionId, editorKey.key)).status).toBe(204)
      expect((await deleteRequest('not-a-session', ownerKey.key)).status).toBe(204)

      const allowed = await createAgentSession(target.workspaceId, 'Owner deletes this', 3_000)
      expect((await deleteRequest(allowed.sessionId, ownerKey.key)).status).toBe(204)
      expect((await deleteRequest(allowed.sessionId, ownerKey.key)).status).toBe(204)
      expect(
        await convex.query('testing/agentSessions:sessionDeletionWorkForTest', {
          internalKey: INTERNAL_KEY,
          sessionId: allowed.sessionId,
        }),
      ).toMatchObject({ sessionId: allowed.sessionId, rootSessionId: allowed.sessionId })
    })

    test('archive routes personal and global policy through the public contract', async () => {
      const target = await provisionRegisteredWorkspace(uniqueSlug('agent-archive-policy'))
      const viewer = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail('agent-archive-policy-viewer'),
        'Archive Viewer',
      )
      await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        userId: viewer.user._id,
        role: 'viewer',
      })
      const viewerKey = await issueKey(viewer.client)
      const session = await createAgentSession(target.workspaceId, 'Archive only for me', 1_000)
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
      const archive = (body: unknown) =>
        authedWith(
          app,
          `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/archive`,
          viewerKey.key,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        )

      const personal = await archive({ kind: 'personal', archived: true })
      expect(personal.status).toBe(200)
      expect(await personal.json()).toMatchObject({
        archive: {
          globalArchivedAt: null,
          personalArchivedAt: expect.any(Number),
          reason: 'personal',
        },
      })
      expect((await archive({ kind: 'global', archived: true })).status).toBe(403)
      expect((await archive({ kind: 'personal', archived: false, private: true })).status).toBe(400)
      expect((await archive({ archived: false })).status).toBe(400)
    })

    test('the read cursor is a monotonic maximum over the wire', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-read-route'))
      const agentKey = await issueKey(owner.client)
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => Response.json({ ok: true, discarded: false }),
      })
      const session = await createAgentSession(workspace.workspaceId, 'Watch the deploy', 1_000)
      const read = async (body: unknown) =>
        authedWith(
          app,
          `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/read`,
          agentKey.key,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        )

      const first = await read({ seq: 4 })
      expect(first.status).toBe(200)
      expect(SessionReadResponseSchema.parse(await first.json())).toEqual({ lastReadSeq: 4 })

      // A flush the browser queued before the newer one, landing after it. The
      // response reports the cursor that won, not the seq that was sent.
      const stale = await read({ seq: 1 })
      expect(stale.status).toBe(200)
      expect(await stale.json()).toEqual({ lastReadSeq: 4 })

      expect(await (await read({ seq: 9 })).json()).toEqual({ lastReadSeq: 9 })

      // A seq is an event number, not a timestamp, and not a boolean.
      expect((await read({ seq: -1 })).status).toBe(400)
      expect((await read({ seq: 2.5 })).status).toBe(400)
      expect((await read({})).status).toBe(400)
    })

    test('an app remains a workspace principal after its actor membership is removed', async () => {
      const appActor = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail('agent-app-principal'),
        'App Principal Actor',
      )
      const target = await provisionRegisteredWorkspace(uniqueSlug('agent-app-principal'))
      await grantCredits(target.workspaceId, 'grant:agent-app-principal')
      await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        userId: appActor.user._id,
        role: 'editor',
      })
      const session = await createAgentSession(
        target.workspaceId,
        'Workspace-principal target',
        1_000,
      )
      const registeredApp = (await mutate(appActor.client, 'domains/apps/model:registerApp', {
        internalKey: INTERNAL_KEY,
        actorId: appActor.user._id,
        workspaceId: target.workspaceId,
        path: 'apps/session-worker',
        command: 'bun run server.ts',
        apiScopes: ['sessions'],
        slug: 'session-worker',
      })) as { id: string }
      const appKey = (await mutate(appActor.client, 'domains/apiKeys/mutations:mintAppKey', {
        internalKey: INTERNAL_KEY,
        appId: registeredApp.id,
        now: Date.now(),
      })) as { key: string }
      const membershipId = (
        (await convex.query('testing/workspaces:workspaceMembersForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: target.workspaceId,
        })) as Array<{ _id: string; userId: string }>
      ).find(member => member.userId === appActor.user._id)!._id
      await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
        internalKey: INTERNAL_KEY,
        membershipId,
        now: 2_000,
      })
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async (_input, init) =>
          runnerInputReceipt(JSON.parse(String(init?.body)) as GatewayRunnerInputRequest),
      })

      const appCreated = await authedWith(app, `/v1/ws/${target.slug}/agent/sessions`, appKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Workspace principal side session',
          audience: { kind: 'specific', memberUserIds: [owner.user._id] },
        }),
      })
      expect(appCreated.status).toBe(201)
      expect(await appCreated.json()).toMatchObject({
        snapshot: { audience: { kind: 'specific', count: 1 } },
      })

      const stream = await authedWith(
        app,
        `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/events`,
        appKey.key,
      )
      expect(stream.status).toBe(200)
      expect((await readSseEvents(stream, 1))[0]).toMatchObject({
        seq: 1,
        event: { type: 'session_created' },
      })

      const message = await authedWith(
        app,
        `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/messages`,
        appKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'Continue under workspace trust.' }),
        },
      )
      expect(message.status).toBe(202)
      expect(await message.json()).toEqual({ ok: true, delivery: 'queued' })

      const read = await authedWith(
        app,
        `/v1/ws/${target.slug}/agent/sessions/${session.sessionId}/read`,
        appKey.key,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seq: 3 }),
        },
      )
      expect(read.status).toBe(403)
      expect(await read.json()).toEqual({ error: 'forbidden' })
      expect(
        await convex.query('testing/agentSessions:memberReadCursorsForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: target.workspaceId,
          userId: appActor.user._id,
        }),
      ).toEqual([])

      const activity = SessionActivityResponseSchema.parse(
        await (
          await authedWith(app, `/v1/ws/${target.slug}/agent/sessions/activity`, appKey.key)
        ).json(),
      )
      expect(
        activity.owners.flatMap(owner => owner.sessions).find(row => row.id === session.sessionId)
          ?.unread,
      ).toBe(false)
    }, 60_000)

    test('watching a session does not mark it read', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-read-firewall'))
      const agentKey = await issueKey(owner.client)
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => Response.json({ ok: true, discarded: false }),
      })
      const session = await createAgentSession(
        workspace.workspaceId,
        'Agent watching itself',
        1_000,
      )

      // Everything an agent does to observe its own work. None of it is reading.
      for (const path of [
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/history`,
        `/v1/ws/${workspace.slug}/agent/sessions`,
      ]) {
        expect((await authedWith(app, path, agentKey.key)).status).toBe(200)
      }

      // An agent that cleared a badge by polling would clear a *person's* badge:
      // a workspace key resolves to a user like any other credential.
      expect(
        await convex.query('testing/agentSessions:memberReadCursorsForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          userId: owner.user._id,
        }),
      ).toEqual([])
    })

    test('serves detail/history and applies rename, archive, and idempotent delete', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-lifecycle-route'))
      const agentKey = await issueKey(owner.client)
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => Response.json({ ok: true, discarded: false }),
      })
      const session = await createAgentSession(workspace.workspaceId, 'Inspect release logs', 1_000)

      const detail = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
      )
      expect(detail.status).toBe(200)
      expect(await detail.json()).toMatchObject({
        id: session.sessionId,
        title: 'Inspect release logs',
        titleOrigin: 'excerpt',
      })

      const history = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/history?limit=1`,
        agentKey.key,
      )
      expect(history.status).toBe(200)
      const newest = (await history.json()) as SessionHistoryPage
      expect(newest).toMatchObject({
        items: [{ seq: 2, event: { type: 'prompt_submitted' } }],
      })
      expect(newest.nextCursor).toEqual(expect.any(String))
      const olderHistory = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/history?limit=1&cursor=${encodeURIComponent(newest.nextCursor!)}`,
        agentKey.key,
      )
      expect(await olderHistory.json()).toEqual({
        items: [
          {
            seq: 1,
            createdAt: 1_000,
            event: {
              type: 'session_created',
              prompt: 'Inspect release logs',
              createdAt: '1970-01-01T00:00:01.000Z',
            },
          },
        ],
        nextCursor: null,
      })
      const ascending = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/history?limit=1&order=asc`,
        agentKey.key,
      )
      const ascendingPage = (await ascending.json()) as SessionHistoryPage
      expect(ascendingPage).toMatchObject({
        items: [{ seq: 1, event: { type: 'session_created' } }],
      })
      expect(ascendingPage.nextCursor).toEqual(expect.any(String))
      const reboundOrder = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/history?cursor=${encodeURIComponent(ascendingPage.nextCursor!)}`,
        agentKey.key,
      )
      expect(reboundOrder.status).toBe(400)
      expect(await reboundOrder.json()).toEqual({ error: 'invalid_cursor' })
      const crossDomain = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions?cursor=${encodeURIComponent(ascendingPage.nextCursor!)}`,
        agentKey.key,
      )
      expect(crossDomain.status).toBe(400)
      expect(await crossDomain.json()).toEqual({ error: 'invalid_cursor' })
      const afterInitial = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/history?order=asc&afterSeq=1`,
        agentKey.key,
      )
      expect(await afterInitial.json()).toMatchObject({
        items: [{ seq: 2, event: { type: 'prompt_submitted' } }],
        nextCursor: null,
      })
      expect(
        (
          await authedWith(
            app,
            `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/history?before=0`,
            agentKey.key,
          )
        ).status,
      ).toBe(400)

      const renamed = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Release log diagnosis' }),
        },
      )
      expect(renamed.status).toBe(200)
      const renamedBody = SessionSummarySchema.parse(await renamed.json())
      expect(renamedBody).toMatchObject({
        id: session.sessionId,
        turnStatus: 'running',
        title: 'Release log diagnosis',
        titleOrigin: 'manual',
        titleStatus: 'complete',
        createdAt: 1_000,
        lastEventSeq: 2,
      })

      const archived = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/archive`,
        agentKey.key,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'global', archived: true }),
        },
      )
      expect(archived.status).toBe(200)
      expect(await archived.json()).toMatchObject({ id: session.sessionId })

      for (const [path, method, body] of [
        [`/v1/ws/${workspace.slug}/agent/sessions/not-an-id`, 'PATCH', { title: 'Cannot rename' }],
        [
          `/v1/ws/${workspace.slug}/agent/sessions/not-an-id/archive`,
          'PUT',
          { kind: 'global', archived: true },
        ],
      ] as const) {
        const invalidId = await authedWith(app, path, agentKey.key, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(invalidId.status).toBe(404)
        expect(await invalidId.json()).toEqual({ error: 'not_found' })
      }

      await convex.mutation('domains/agentSessions/model:relayRunnerEvent', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        sessionId: session.sessionId,
        relayId: crypto.randomUUID(),
        event: {
          type: 'complete',
          state: completedTurnState(),
          status: 'completed',
          result: 'done',
        },
        now: 5_000,
      })
      const deleted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
        { method: 'DELETE' },
      )
      expect(deleted.status).toBe(204)
      expect(await deleted.text()).toBe('')
      const hidden = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
      )
      expect(hidden.status).toBe(404)
      for (const [path, method] of [
        [`/v1/ws/${workspace.slug}/agent/sessions/not-an-id`, 'GET'],
        [`/v1/ws/${workspace.slug}/agent/sessions/not-an-id/history`, 'GET'],
        [`/v1/ws/${workspace.slug}/agent/sessions/not-an-id/events`, 'GET'],
        [`/v1/ws/${workspace.slug}/agent/sessions/not-an-id`, 'DELETE'],
      ] as const) {
        const invalidId = await authedWith(app, path, agentKey.key, { method })
        expect(invalidId.status).toBe(method === 'DELETE' ? 204 : 404)
        if (method === 'DELETE') expect(await invalidId.text()).toBe('')
        else expect(await invalidId.json()).toEqual({ error: 'not_found' })
      }
    })

    test('seals a running session and accepts durable work before returning', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-running'))
      const agentKey = await issueKey(owner.client)
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
      const session = await createAgentSession(workspace.workspaceId, 'Keep the runner busy', 1_000)

      const deleted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
        { method: 'DELETE' },
      )
      expect(deleted.status).toBe(204)
      expect(
        await convex.query('domains/agentSessions/model:getSession', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          sessionId: session.sessionId,
        }),
      ).toBeNull()
      expect(
        await convex.query('testing/agentSessions:sessionDeletionWorkForTest', {
          internalKey: INTERNAL_KEY,
          sessionId: session.sessionId,
        }),
      ).toMatchObject({ sessionId: session.sessionId })
    })

    test('captures conversation-owned Tool Router identity in durable deletion work', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-tool-router'))
      const agentKey = await issueKey(owner.client)
      const prepared = (await convex.mutation(
        'domains/agentSessions/model:prepareRunnerInputDelivery',
        {
          internalKey: INTERNAL_KEY,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          workspaceId: workspace.workspaceId,
          attemptId: `test:${crypto.randomUUID()}`,
          projectIntegrations: true,
          input: {
            kind: 'initial_prompt',
            prompt: 'Delete this provider workbench',
            behavior: 'steer',
            sender: { kind: 'user', userId: owner.user._id },
          },
          now: 1_000,
        },
      )) as {
        sessionId: string
        dispatch: { integrations: true }
      }
      await convex.mutation('domains/integrations/turnConfig:adoptToolRouterSession', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        duetSessionId: prepared.sessionId,
        expectedProviderSessionId: null,
        providerSessionId: 'provider-session-delete-me',
        permissionFingerprint: 'current-permissions',
      })
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

      const deleted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${prepared.sessionId}`,
        agentKey.key,
        { method: 'DELETE' },
      )

      expect(deleted.status).toBe(204)
      expect(
        await convex.query('testing/agentSessions:sessionDeletionWorkForTest', {
          internalKey: INTERNAL_KEY,
          sessionId: prepared.sessionId,
        }),
      ).toMatchObject({ providerSessionId: 'provider-session-delete-me' })
      expect(
        await convex.query('domains/agentSessions/model:getSession', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          sessionId: prepared.sessionId,
        }),
      ).toBeNull()
    })

    test('seals a sleeping session before asynchronous runner disposal', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-sleeping'))
      const agentKey = await issueKey(owner.client)
      const session = await createAgentSession(workspace.workspaceId, 'Wake me later', 1_000)
      await convex.mutation('domains/agentSessions/model:relayRunnerEvent', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        sessionId: session.sessionId,
        relayId: crypto.randomUUID(),
        event: {
          type: 'sleep',
          state: {
            status: 'sleeping',
            mode: 'agent',
            agent: { status: 'waiting', messages: [] },
          },
          wakeAt: 60_000,
        },
        now: 2_000,
      })
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

      const deleted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
        { method: 'DELETE' },
      )

      expect(deleted.status).toBe(204)
      expect(
        await convex.query('domains/agentSessions/model:getSession', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          sessionId: session.sessionId,
        }),
      ).toBeNull()
    })

    test('accepts durable deletion and seals before returning when the gateway is unreachable', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-offline'))
      const agentKey = await issueKey(owner.client)
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => Response.json({ error: 'runner_unavailable' }, { status: 503 }),
      })
      const session = await createAgentSession(workspace.workspaceId, 'Stranded runner', 1_000)

      const deleted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
        { method: 'DELETE' },
      )

      expect(deleted.status).toBe(204)
      expect(await deleted.text()).toBe('')
      expect(
        await convex.query('domains/agentSessions/model:getSession', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          sessionId: session.sessionId,
        }),
      ).toBeNull()
      expect(
        await convex.query('testing/agentSessions:rawSessionForTest', {
          internalKey: INTERNAL_KEY,
          sessionId: session.sessionId,
        }),
      ).toMatchObject({ visible: false, archiveState: 'deleting' })
      expect(
        await convex.query('testing/agentSessions:sessionDeletionWorkForTest', {
          internalKey: INTERNAL_KEY,
          sessionId: session.sessionId,
        }),
      ).toMatchObject({ sessionId: session.sessionId })
    })

    // The private disposal callback is the only path that reaches the VM for a
    // deletion. Driving it through the assembled app proves the wiring the
    // route unit tests stub: the internal-key gate, the Convex plan, and the
    // gateway client's DELETE against the runner.
    test('the disposal callback discards the runner through the assembled gateway client', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-dispose'))
      await waitForRegisteredGateway(workspace.vmToken)
      const agentKey = await issueKey(owner.client)
      const gatewayCalls: Array<{ method: string; pathname: string }> = []
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input)
          gatewayCalls.push({ method: init?.method ?? 'GET', pathname: url.pathname })
          return Response.json({ ok: true, discarded: true })
        },
      })
      const session = await createAgentSession(workspace.workspaceId, 'Dispose this runner', 1_000)

      const deleted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
        { method: 'DELETE' },
      )
      expect(deleted.status).toBe(204)
      // A childless root finishes its scan inside the accepting transaction, so
      // its external disposal run is already open once the 204 lands.
      const work = (await convex.query('testing/agentSessions:sessionDeletionWorkForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      })) as { _id: string; externalState: string }
      expect(work.externalState).toBe('running')

      const disposed = await app.request(`/v1/internal/session-deletions/${work._id}/dispose`, {
        method: 'POST',
        headers: { authorization: `Bearer ${INTERNAL_KEY}` },
      })
      expect(disposed.status).toBe(200)
      expect(await disposed.json()).toEqual({
        status: 'disposed',
        runner: 'absent',
        providerAttempted: false,
      })
      expect(gatewayCalls).toEqual([
        { method: 'DELETE', pathname: `/v1/agent/sessions/${session.sessionId}` },
      ])
    })

    // Oversized relay events are invalid at the public API boundary. They must
    // never fall through to the VM-auth refusal that once obscured this case.
    test('an oversized relay event is invalid rather than unauthorized', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('relay-unstorable'))
      await waitForRegisteredGateway(workspace.vmToken)
      const session = await createAgentSession(workspace.workspaceId, 'Unstorable relay', 1_000)
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

      const relayed = await app.request(`/v1/vm/agent/sessions/${session.sessionId}/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${workspace.vmToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          relayId: 'relay-unstorable',
          event: {
            type: 'step',
            step: { type: 'text', text: 'x'.repeat(1024 * 1024 + 1) },
          },
        }),
      })

      expect(relayed.status).toBe(400)
      expect(await relayed.json()).toEqual({ error: 'invalid_request' })
    })

    test('ends a session the gateway reports it could not interrupt', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-interrupt-stuck'))
      const viewer = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail('agent-interrupt-viewer'),
        'Interrupt Viewer',
      )
      const membershipId = (await mutate(
        owner.client,
        'testing/workspaces:addWorkspaceMemberForTest',
        {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          userId: viewer.user._id,
          role: 'viewer',
        },
      )) as string
      const agentKey = await issueKey(viewer.client)
      const session = await createAgentSession(workspace.workspaceId, 'Wedged turn', 1_000)
      await convex.mutation('testing/agentSessions:makeSpecificSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        sessionId: session.sessionId,
        membershipIds: [membershipId],
      })
      // The VM answers, and its answer is that no runner took the interrupt —
      // its own process is already gone. Stop is the user's decision, so the
      // control plane honours it whether or not a runner was there to tell.
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => Response.json({ ok: true, interrupted: false }),
      })

      const interrupted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/interrupt`,
        agentKey.key,
        { method: 'POST' },
      )

      expect(interrupted.status).toBe(200)
      expect(
        await convex.query('domains/agentSessions/model:getSession', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          sessionId: session.sessionId,
        }),
      ).toMatchObject({ id: session.sessionId, turnStatus: 'interrupted' })
      const stopped = (await convex.query('testing/agentSessions:rawSessionForTest', {
        internalKey: INTERNAL_KEY,
        sessionId: session.sessionId,
      })) as {
        runnerInputPending: boolean
        lastDeliveredInputSeq: number
        lastRunnerInputSeq: number
      }
      expect(stopped.runnerInputPending).toBe(false)
      expect(stopped.lastDeliveredInputSeq).toBe(stopped.lastRunnerInputSeq)
    })

    test('ends a session whose interrupt the gateway never answered', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-interrupt-offline'))
      const agentKey = await issueKey(owner.client)
      const session = await createAgentSession(workspace.workspaceId, 'Unreachable VM', 1_000)
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => Response.json({ error: 'internal_server_error' }, { status: 500 }),
      })

      const interrupted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}/interrupt`,
        agentKey.key,
        { method: 'POST' },
      )

      expect(interrupted.status).toBe(200)
      expect(
        await convex.query('domains/agentSessions/model:getSession', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          sessionId: session.sessionId,
        }),
      ).toMatchObject({ id: session.sessionId, turnStatus: 'interrupted' })
    })

    test('accepts deletion while a workspace is paused', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-paused'))
      const agentKey = await issueKey(owner.client)
      const session = await createAgentSession(workspace.workspaceId, 'Delete while paused', 1_000)
      await convex.mutation('testing/workspaces:setWorkspaceServicingForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        servicingStatus: 'paused',
        now: 2_000,
      })
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

      const deleted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
        { method: 'DELETE' },
      )

      expect(deleted.status).toBe(204)
      expect(
        await convex.query('domains/agentSessions/model:getSession', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          sessionId: session.sessionId,
        }),
      ).toBeNull()
    })

    test('accepts and seals deletion while workspace servicing is banned', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-no-gateway'))
      const agentKey = await issueKey(owner.client)
      const session = await createAgentSession(workspace.workspaceId, 'Keep until discard', 1_000)
      await convex.mutation('testing/workspaces:setWorkspaceServicingForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        servicingStatus: 'banned',
        now: 2_000,
      })
      const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

      const deleted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`,
        agentKey.key,
        { method: 'DELETE' },
      )

      expect(deleted.status).toBe(204)
      expect(await deleted.text()).toBe('')
      expect(
        await convex.query('domains/agentSessions/model:getSession', {
          internalKey: INTERNAL_KEY,
          workspaceId: workspace.workspaceId,
          sessionId: session.sessionId,
        }),
      ).toBeNull()
    })

    test('concurrent running-session deletes remain idempotently accepted', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-race'))
      const agentKey = await issueKey(owner.client)
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => Response.json({ ok: true }),
      })
      const session = await createAgentSession(workspace.workspaceId, 'Delete concurrently', 1_000)
      const path = `/v1/ws/${workspace.slug}/agent/sessions/${session.sessionId}`

      const responses = await Promise.all([
        authedWith(app, path, agentKey.key, { method: 'DELETE' }),
        authedWith(app, path, agentKey.key, { method: 'DELETE' }),
      ])

      expect(responses.map(response => response.status)).toEqual([204, 204])
      expect(await Promise.all(responses.map(response => response.text()))).toEqual(['', ''])
    })

    test('deleting an agent tears its runners down at the gateway keyed by anchor', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-teardown'))
      const agentsKey = await issueKey(owner.client)
      const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId: workspace.workspaceId,
        path: 'agents/reviewer',
        slug: 'reviewer',
      })) as { anchorId: string }
      const gatewayRequests: Array<{ method: string; pathname: string }> = []
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async (input, init) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          gatewayRequests.push({ method: init?.method ?? 'GET', pathname: new URL(url).pathname })
          return Response.json({ ok: true, discarded: [] })
        },
      })

      const deleted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agents/reviewer`,
        agentsKey.key,
        { method: 'DELETE' },
      )

      expect(deleted.status).toBe(200)
      expect(gatewayRequests).toContainEqual({
        method: 'DELETE',
        pathname: `/v1/agent/agents/${registered.anchorId}/sessions`,
      })
      const requestCount = gatewayRequests.length
      const retried = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agents/reviewer`,
        agentsKey.key,
        { method: 'DELETE' },
      )
      expect(retried.status).toBe(200)
      expect(await retried.json()).toEqual({ ok: true })
      expect(gatewayRequests).toHaveLength(requestCount)
    })

    test('viewer agent deletion is refused before bulk session teardown', async () => {
      const target = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-viewer'))
      const viewer = await signInWithMagicLink<UserRow>(
        convex,
        uniqueEmail('agent-delete-viewer-member'),
        'Delete Viewer',
      )
      await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
        userId: viewer.user._id,
        role: 'viewer',
      })
      await mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId: target.workspaceId,
        path: 'agents/viewer-target',
        slug: 'viewer-target',
      })
      const viewerKey = await issueKey(viewer.client)
      let gatewayCalls = 0
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => {
          gatewayCalls += 1
          return Response.json({ ok: true, discarded: [] })
        },
      })

      const response = await authedWith(
        app,
        `/v1/ws/${target.slug}/agents/viewer-target`,
        viewerKey.key,
        { method: 'DELETE' },
      )

      expect(response.status).toBe(403)
      expect(gatewayCalls).toBe(0)
    })

    test('does not delete an agent when the gateway teardown is unreachable', async () => {
      const workspace = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-failclosed'))
      const agentsKey = await issueKey(owner.client)
      await mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId: workspace.workspaceId,
        path: 'agents/writer',
        slug: 'writer',
      })
      const app = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async () => {
          throw new Error('gateway unreachable')
        },
      })

      const deleted = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agents/writer`,
        agentsKey.key,
        { method: 'DELETE' },
      )

      expect(deleted.status).toBe(502)
      expect(await deleted.json()).toEqual({ error: 'agent_gateway_unavailable' })
      // Nothing was deleted: the agent still lists (the list route never touches the gateway).
      const listed = await authedWith(app, `/v1/ws/${workspace.slug}/agents`, agentsKey.key)
      expect((await listed.json()).items.map((agent: { slug: string }) => agent.slug)).toContain(
        'writer',
      )
    })

    test('refuses replica Train writes and agent delete before touching the gateway', async () => {
      // A shared-in (replica) agent is read-only. The delete route must assert
      // mutability BEFORE the teardown leg, so a direct-API replica delete refuses
      // without killing the recipient's runners. The UI never offers replica delete
      // (D21), but the seam fails closed on its own.
      const recipient = await provisionRegisteredWorkspace(uniqueSlug('agent-delete-replica'))
      await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace._id,
        now: Date.now(),
      })
      await mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId: workspace._id,
        path: 'agent-replica-src',
        slug: 'shared-bot',
        name: 'Shared Bot',
      })
      const shareResult = (await mutate(owner.client, 'testing/shares:createShareForTest', {
        internalKey: INTERNAL_KEY,
        fromWorkspaceId: workspace._id,
        toEmail: owner.user.email,
        path: 'agent-replica-src',
        mode: 'read',
      })) as { share: { id: string } }
      const browserKey = await mintBrowserSession(owner.client)
      const gatewayRequests: Array<{ method: string; pathname: string }> = []
      const routeApp = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        fetch: async (input, init) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const pathname = new URL(url).pathname
          gatewayRequests.push({ method: init?.method ?? 'GET', pathname })
          if (pathname.startsWith('/v1/train/agents/') && pathname.endsWith('/uploads')) {
            return Response.json({
              items: [],
              nextCursor: null,
              meta: { totalBytes: 0, fileCount: 0, capBytes: 1, running: false },
            })
          }
          return Response.json({ ok: true, discarded: [] })
        },
      })

      const accepted = await authedWith(
        routeApp,
        `/v1/share-requests/${shareResult.share.id}/accept`,
        browserKey,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            toWorkspaceId: recipient.workspaceId,
            mountPath: 'shared/agent-replica-src',
          }),
        },
      )
      expect(accepted.status).toBe(200)
      await mutate(owner.client, 'testing/workspaces:setWorkspaceServicingForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: recipient.workspaceId,
        servicingStatus: 'active',
        now: Date.now(),
      })

      const agentsKey = await issueKey(owner.client)
      const replicas = (await authedWith(
        routeApp,
        `/v1/ws/${recipient.slug}/agents`,
        agentsKey.key,
      ).then(response => response.json())) as {
        items: Array<{ slug: string; sourceShareId?: string }>
      }
      const replica = replicas.items.find(agent => agent.sourceShareId !== undefined)
      expect(replica).toBeDefined()
      gatewayRequests.length = 0

      const memoryKey = await issueKey(owner.client)
      const trainBase = `/v1/ws/${recipient.slug}/agents/${replica!.slug}/train`
      const readable = await authedWith(routeApp, `${trainBase}/uploads`, memoryKey.key)
      expect(readable.status).toBe(200)
      gatewayRequests.length = 0

      const trainWrites = await Promise.all([
        authedWith(routeApp, `${trainBase}/uploads/session`, memoryKey.key, { method: 'POST' }),
        authedWith(routeApp, `${trainBase}/uploads/url`, memoryKey.key, { method: 'POST' }),
        authedWith(routeApp, `${trainBase}/uploads/source.md`, memoryKey.key, {
          method: 'DELETE',
        }),
        authedWith(routeApp, trainBase, memoryKey.key, { method: 'POST' }),
        authedWith(routeApp, `${trainBase}/records/memory`, memoryKey.key, { method: 'PATCH' }),
        authedWith(routeApp, `${trainBase}/records/memory`, memoryKey.key, { method: 'DELETE' }),
      ])
      expect(trainWrites.map(response => response.status)).toEqual([403, 403, 403, 403, 403, 403])
      expect(gatewayRequests).toEqual([])

      const deleted = await authedWith(
        routeApp,
        `/v1/ws/${recipient.slug}/agents/${replica!.slug}`,
        agentsKey.key,
        { method: 'DELETE' },
      )

      expect(deleted.status).toBe(403)
      expect(await deleted.json()).toEqual({ error: 'forbidden' })
      // The teardown leg never ran: no per-agent session-discard call reached the gateway.
      expect(
        gatewayRequests.some(request =>
          /\/v1\/agent\/agents\/.*\/sessions$/.test(request.pathname),
        ),
      ).toBe(false)
    })
  })

  test('default session aliases stay lazy, create-or-message, and attribute agent cwd', async () => {
    // This test owns its billing lifecycle: earlier suites deliberately lapse
    // the shared owner's subscription, which must not alter session delivery.
    const aliasOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('default-session-alias-owner'),
      'Default Alias Owner',
    )
    await mutate(
      aliasOwner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    // Register the user's signup-birthed personal workspace rather than
    // creating a second one: workspace birth is payment-gated past the first.
    const aliasPersonal = (await listMine(aliasOwner.client))[0]!.workspace
    // The signup-birthed workspace carries a live attach run; the helper
    // settles it before registering, so the token below is never rotated
    // out from under the test.
    const target = await provisionRegisteredWorkspace(
      aliasPersonal.slug,
      aliasOwner,
      aliasPersonal._id,
    )
    await completeWorkspaceForTest(aliasOwner.client, target.workspaceId)
    await grantCredits(target.workspaceId, 'grant:default-session-alias')
    await waitForRegisteredGateway(target.vmToken)
    const agent = (await mutate(aliasOwner.client, 'domains/agents/model:registerAgent', {
      workspaceId: target.workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { id: string }
    const key = await issueKey(aliasOwner.client)
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const integrationLifecycle: string[] = []
    let rejectProviderCreate = false
    const defaultApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      env: { COMPOSIO_API_KEY: 'test-composio-key' },
      composioMcpProvider: {
        createToolRouterSession: async () => {
          integrationLifecycle.push('provider:create')
          if (rejectProviderCreate) {
            throw new Error('provider unavailable')
          }
          return {
            providerSessionId: `provider-default-${integrationLifecycle.length}`,
            mcp: { type: 'http', url: 'https://mcp.example/default-session' },
          }
        },
        useToolRouterSession: async ({ providerSessionId }) => ({
          providerSessionId,
          mcp: { type: 'http', url: 'https://mcp.example/default-session' },
        }),
        updateToolRouterSession: async () => {
          integrationLifecycle.push('provider:update')
        },
        deleteToolRouterSession: async () => undefined,
      },
      fetch: async (_input, init) => {
        integrationLifecycle.push('gateway:dispatch')
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        return runnerInputReceipt(body)
      },
    })
    // `root` is a reserved slug, so it can never shadow a registered agent and
    // the drive root is addressed in the same route family as every other
    // owner. There is no `/agent/sessions/default` family any more.
    const rootPath = `/v1/ws/${target.slug}/agents/root/sessions/default`
    const agentPath = `/v1/ws/${target.slug}/agents/research/sessions/default`
    const setDefault = (path: string, sessionId: string | null) =>
      authedWith(defaultApp, path, key.key, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })

    // "No chat yet" is a 200 with a null session, never a 404: it is the
    // alias's ordinary answer, and browsers log every 4xx to the console.
    const unsetRoot = await authedWith(defaultApp, rootPath, key.key)
    expect(unsetRoot.status).toBe(200)
    expect(await unsetRoot.json()).toEqual({ session: null })
    const unsetAgent = await authedWith(defaultApp, agentPath, key.key)
    expect(unsetAgent.status).toBe(200)
    expect(await unsetAgent.json()).toEqual({ session: null })
    const unsetHistory = await authedWith(defaultApp, `${rootPath}/history`, key.key)
    expect(unsetHistory.status).toBe(404)
    expect(await unsetHistory.json()).toEqual({ error: 'no_default_session' })
    expect(
      (
        (await convex.query('domains/agentSessions/model:listSessions', {
          internalKey: INTERNAL_KEY,
          identity: {
            principal: { kind: 'human', userId: aliasOwner.user._id },
            actorId: aliasOwner.user._id,
          },
          actorId: aliasOwner.user._id,
          workspaceId: target.workspaceId,
        })) as SessionListPage
      ).items,
    ).toEqual([])

    // Default chat is its own strict wire shape: ordinary creation controls do
    // not silently bleed into this endpoint.
    const rejectedMode = await authedWith(defaultApp, `${rootPath}/messages`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Start the root default.',
        mode: { name: 'noop', prompt: 'never honored', states: [] },
      }),
    })
    expect(rejectedMode.status).toBe(400)
    expect(await rejectedMode.json()).toEqual({ error: 'invalid_request' })
    expect(gatewayCalls).toEqual([])

    const created = await authedWith(defaultApp, `${rootPath}/messages`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Start the root default.' }),
    })
    expect(created.status).toBe(201)
    const createdBody = SessionCreateResponseSchema.parse(await created.json())
    const rootSessionId = createdBody.session.sessionId
    expect(createdBody.snapshot.id).toBe(rootSessionId)
    expect(createdBody.snapshot.requestedMachine).toBeUndefined()

    const continued = await authedWith(defaultApp, `${rootPath}/messages`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Continue the root default.' }),
    })
    expect(continued.status).toBe(202)
    const continuedBody = (await continued.json()) as { delivery: string }
    // 'accepted' vs 'queued' is a race against the creating request's async
    // delivery mark — the contract is only that the message lands on the SAME
    // session either way.
    expect(continuedBody).toMatchObject({ sessionId: rootSessionId, ok: true })
    expect(['accepted', 'queued']).toContain(continuedBody.delivery)
    expect(await (await authedWith(defaultApp, rootPath, key.key)).json()).toMatchObject({
      session: { id: rootSessionId },
    })
    const latestHistoryResponse = await authedWith(
      defaultApp,
      `${rootPath}/history?limit=1`,
      key.key,
    )
    expect(latestHistoryResponse.status).toBe(200)
    const latestHistory = (await latestHistoryResponse.json()) as SessionHistoryPage
    expect(latestHistory).toMatchObject({
      items: [
        {
          event: {
            type: 'prompt_submitted',
            inputKind: 'message',
            prompt: 'Continue the root default.',
            sender: { kind: 'user', userId: aliasOwner.user._id },
          },
        },
      ],
    })
    expect(latestHistory.nextCursor).toEqual(expect.any(String))
    const malformedHistory = await authedWith(
      defaultApp,
      `${rootPath}/history?cursor=not-an-opaque-cursor`,
      key.key,
    )
    expect(malformedHistory.status).toBe(400)
    expect(await malformedHistory.json()).toEqual({ error: 'invalid_cursor' })
    const replacementRootResponse = await authedWith(
      defaultApp,
      `/v1/ws/${target.slug}/agent/sessions`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Replacement root default' }),
      },
    )
    expect(replacementRootResponse.status).toBe(201)
    const replacementRoot = SessionCreateResponseSchema.parse(await replacementRootResponse.json())
    expect((await setDefault(rootPath, replacementRoot.session.sessionId)).status).toBe(200)
    const pinnedDefault = await authedWith(
      defaultApp,
      `${rootPath}/history?limit=1&cursor=${encodeURIComponent(latestHistory.nextCursor!)}`,
      key.key,
    )
    expect(pinnedDefault.status).toBe(200)
    expect(((await pinnedDefault.json()) as SessionHistoryPage).items).toHaveLength(1)

    /* The default chat is the newest session right now, which is the shape that
       breaks a small page. `excludeDefault` names ONE row, resolved once before
       the scan — so it must not spend a candidate slot. It used to: the scan
       took `limit` candidates, the newest of them was the excluded chat, and the
       page came back empty while a match sat one row behind it. A caller asking
       for one row got "there is nothing here".

       `limit: 1` because that is the size the defect needs and the size a
       presence check actually asks for; at the default page size the excluded
       row is lost in the noise and the bug is invisible. `activity.ts` has
       compensated for this since it was written — see its `excludeAllowance`. */
    expect(
      (
        (await convex.query('domains/agentSessions/model:listSessions', {
          internalKey: INTERNAL_KEY,
          identity: {
            principal: { kind: 'human', userId: aliasOwner.user._id },
            actorId: aliasOwner.user._id,
          },
          actorId: aliasOwner.user._id,
          workspaceId: target.workspaceId,
          agentId: ROOT_AGENT_SCOPE,
          excludeDefault: true,
          limit: 1,
        })) as SessionListPage
      ).items.map(session => session.id),
    ).toEqual([rootSessionId])

    expect((await setDefault(rootPath, rootSessionId)).status).toBe(200)
    /* The other half of the same allowance, and the one the case above cannot
       reach: there, the excluded chat sat inside the candidate window, so the
       page came back one row short and the allowance was what refilled it.

       When the excluded chat sits *outside* the window the allowance is pure
       surplus — `limit + 1` admissible rows for a caller who asked for
       `limit` — and the slice that takes the extra one back off is what stops
       the page overrunning what was asked for. That slice drops a row nobody
       has read, so the continuation has to stay *before* it or the row is
       simply lost between two pages. `limit: 1` again, because a page of one is
       where an off-by-one is a whole page.

       Two claims, and both were checked by breaking the code under them: drop
       the slice and a caller asking for one row gets two; advance the cursor
       past the row the slice dropped and the second page comes back empty.
       `droppedAdmissibleCandidate` itself is *not* pinned here and cannot be
       from outside — with an allowance of one it can only be true when
       `source.hasMore` already is, so the clause is defensive rather than
       load-bearing, and a test that claimed to cover it would be claiming
       something unreachable.

       Read the unbounded list first and assert the bounded pages against it,
       rather than against session ids this test happens to have created: the
       claim is about the pager, and it should not go quiet the day an earlier
       block adds a root conversation. The one row this block does create is
       the precondition — two conversations to page through, with the default
       chat behind both of them. */
    const secondRootResponse = await authedWith(
      defaultApp,
      `/v1/ws/${target.slug}/agent/sessions`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'A second root conversation to page past.' }),
      },
    )
    expect(secondRootResponse.status).toBe(201)
    SessionCreateResponseSchema.parse(await secondRootResponse.json())
    const listRoot = async (extra: Record<string, unknown> = {}) =>
      (await convex.query('domains/agentSessions/model:listSessions', {
        internalKey: INTERNAL_KEY,
        identity: {
          principal: { kind: 'human', userId: aliasOwner.user._id },
          actorId: aliasOwner.user._id,
        },
        actorId: aliasOwner.user._id,
        workspaceId: target.workspaceId,
        agentId: ROOT_AGENT_SCOPE,
        excludeDefault: true,
        ...extra,
      })) as SessionListPage
    const everyRootConversation = (await listRoot({ limit: 50 })).items.map(session => session.id)
    // The claim below is vacuous with fewer than two rows to page through.
    expect(everyRootConversation.length).toBeGreaterThanOrEqual(2)
    const firstRootPage = await listRoot({ limit: 1 })
    // Sliced rather than indexed: the whole list is the expectation, and a page
    // of it is a slice of it.
    expect(firstRootPage.items.map(session => session.id)).toEqual(
      everyRootConversation.slice(0, 1),
    )
    expect(firstRootPage.nextCursor).toEqual(expect.any(String))
    expect(
      (await listRoot({ limit: 1, cursor: firstRootPage.nextCursor })).items.map(
        session => session.id,
      ),
    ).toEqual(everyRootConversation.slice(1, 2))
    // Integrations are prepared as part of creating the session, so this holds
    // whether or not a dispatch follows.
    expect(integrationLifecycle[0]).toBe('provider:create')
    // The ordering and launch-payload claims below need a dispatch to have
    // happened, and this harness cannot make one happen: when delivery comes
    // back 'queued' the route accepts without dispatching, and nothing here
    // drives the drain, so the fake fetch is legitimately never called — the
    // same concession the agent default below already makes, for the same
    // reason. Re-posting cannot manufacture a dispatch either (a new message
    // queues behind the in-flight delivery, and a repeated clientRequestId is
    // deduped into a no-op), which is why the retry loop that used to sit here
    // failed on a loaded machine instead of recovering. Assert the ordering on
    // the runs that do dispatch; `agent-runner` and the backend dispatch tests
    // own it unconditionally.
    if (gatewayCalls.length > 0) {
      expect(integrationLifecycle.indexOf('provider:create')).toBeLessThan(
        integrationLifecycle.indexOf('gateway:dispatch'),
      )
      expect(gatewayCalls[0]?.launch.integrations).toBe(true)
    }
    const agentCreated = await authedWith(defaultApp, `${agentPath}/messages`, key.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Start the agent default.' }),
    })
    expect(agentCreated.status).toBe(201)
    const agentBody = SessionCreateResponseSchema.parse(await agentCreated.json())
    expect(agentBody.session.sessionId).not.toBe(rootSessionId)
    expect(agentBody.snapshot).toMatchObject({
      cwd: 'agents/research',
      agent: { id: agent.id },
    })
    const agentHistoryPage = (await (
      await authedWith(defaultApp, `${agentPath}/history?limit=1`, key.key)
    ).json()) as SessionHistoryPage
    expect(agentHistoryPage.nextCursor).toEqual(expect.any(String))
    // A disabled agent has no folder to run in, so the alias has no chat
    // behind it — history reads answer as if no default had ever been made.
    await mutate(aliasOwner.client, 'domains/agents/model:setAgentDisabled', {
      workspaceId: target.workspaceId,
      slug: 'research',
      disabled: true,
    })
    for (const deniedHistoryPath of [
      `${agentPath}/history?limit=1`,
      `${agentPath}/history?limit=1&cursor=${encodeURIComponent(agentHistoryPage.nextCursor!)}`,
    ]) {
      const deniedHistory = await authedWith(defaultApp, deniedHistoryPath, key.key)
      expect(await deniedHistory.json()).toEqual({ error: 'no_default_session' })
      expect(deniedHistory.status).toBe(404)
    }
    await mutate(aliasOwner.client, 'domains/agents/model:setAgentDisabled', {
      workspaceId: target.workspaceId,
      slug: 'research',
      disabled: false,
    })
    // No gateway-call assertion: when delivery is 'queued' the route 201s
    // without dispatching and the drain delivers later, so the fake fetch is
    // legitimately never called in this test's window. The launch.cwd
    // projection is pinned by the backend dispatch tests; the durable proof
    // here is the snapshot's cwd + agent attribution above.
    expect(['accepted', 'queued']).toContain(agentBody.delivery)

    // Demoting the default chat is a pointer move and nothing else. The PUT
    // answers with the body the next GET would give, so a clear reads back the
    // alias's ordinary "no chat yet" null rather than a distinct success shape.
    const clearedAgent = await setDefault(agentPath, null)
    expect(clearedAgent.status).toBe(200)
    expect(await clearedAgent.json()).toEqual({ session: null })
    expect(await (await authedWith(defaultApp, agentPath, key.key)).json()).toEqual({
      session: null,
    })
    // Demoted, not archived: the conversation is still an active session, and
    // it now appears in exactly the list its own chat panel held it out of.
    expect(
      (
        (await convex.query('domains/agentSessions/model:listSessions', {
          internalKey: INTERNAL_KEY,
          identity: {
            principal: { kind: 'human', userId: aliasOwner.user._id },
            actorId: aliasOwner.user._id,
          },
          actorId: aliasOwner.user._id,
          workspaceId: target.workspaceId,
          agentId: agent.id,
          excludeDefault: true,
        })) as SessionListPage
      ).items.map(session => session.id),
    ).toEqual([agentBody.session.sessionId])

    // The drive root is an owner like any agent, on the same route family. The
    // set direction is reversible on the wire even though the product only
    // ever clears.
    const clearedRoot = await setDefault(rootPath, null)
    expect(clearedRoot.status).toBe(200)
    expect(await clearedRoot.json()).toEqual({ session: null })
    const repointed = await setDefault(rootPath, rootSessionId)
    expect(repointed.status).toBe(200)
    expect(await repointed.json()).toMatchObject({ session: { id: rootSessionId } })
    expect(await (await authedWith(defaultApp, rootPath, key.key)).json()).toMatchObject({
      session: { id: rootSessionId },
    })

    // Unlike the GET, which folds an unresolvable owner into its designed null,
    // a write against a slug no agent holds is a miss.
    const unknownOwner = await setDefault(
      `/v1/ws/${target.slug}/agents/nobody/sessions/default`,
      null,
    )
    expect(unknownOwner.status).toBe(404)
    expect(await unknownOwner.json()).toEqual({ error: 'not_found' })

    const malformed = await authedWith(defaultApp, rootPath, key.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 5 }),
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'invalid_request' })

    const malformedId = await setDefault(rootPath, 'not-an-id')
    expect(malformedId.status).toBe(404)
    expect(await malformedId.json()).toEqual({ error: 'not_found' })

    // An owner the alias cannot resolve — here a disabled agent — is a miss
    // before integrations or the gateway are ever consulted.
    await mutate(aliasOwner.client, 'domains/agents/model:registerAgent', {
      workspaceId: target.workspaceId,
      path: 'agents/blocked',
      slug: 'blocked',
    })
    await mutate(aliasOwner.client, 'domains/agents/model:setAgentDisabled', {
      workspaceId: target.workspaceId,
      slug: 'blocked',
      disabled: true,
    })
    rejectProviderCreate = true
    const gatewayCallCount = gatewayCalls.length
    const integrationCallCount = integrationLifecycle.length
    const blocked = await authedWith(
      defaultApp,
      `/v1/ws/${target.slug}/agents/blocked/sessions/default/messages`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Do not dispatch without integrations.' }),
      },
    )
    expect(blocked.status).toBe(404)
    expect(await blocked.json()).toEqual({ error: 'not_found' })
    expect(integrationLifecycle).toHaveLength(integrationCallCount)
    expect(gatewayCalls).toHaveLength(gatewayCallCount)
  }, 60_000)

  test('an app key with the declared scopes can steer its owner agent default session', async () => {
    const appOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('default-session-app-owner'),
      'Default Session App Owner',
    )
    await mutate(
      appOwner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    const personal = (await listMine(appOwner.client))[0]!.workspace
    const target = await provisionRegisteredWorkspace(personal.slug, appOwner, personal._id)
    await completeWorkspaceForTest(appOwner.client, target.workspaceId)
    await grantCredits(target.workspaceId, 'grant:default-session-app')
    await waitForRegisteredGateway(target.vmToken)
    const agentSlug = `board-${crypto.randomUUID().slice(0, 8)}`
    await mutate(appOwner.client, 'domains/agents/model:registerAgent', {
      workspaceId: target.workspaceId,
      path: `agents/${agentSlug}`,
      slug: agentSlug,
    })
    const contentBoard = (await mutate(appOwner.client, 'domains/apps/model:registerApp', {
      internalKey: INTERNAL_KEY,
      actorId: appOwner.user._id,
      workspaceId: target.workspaceId,
      path: `agents/${agentSlug}/apps/content-board`,
      command: 'bun run server.ts',
      apiScopes: ['agents', 'sessions'],
      slug: 'content-board',
    })) as { id: string }
    const appKey = (await mutate(appOwner.client, 'domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: contentBoard.id,
      now: Date.now(),
    })) as { key: string }
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) =>
        runnerInputReceipt(JSON.parse(String(init?.body)) as GatewayRunnerInputRequest),
    })

    const whoami = await authedWith(routeApp, '/v1/whoami', appKey.key)
    expect(whoami.status).toBe(200)
    expect(await whoami.json()).toMatchObject({
      credential: { kind: 'app' },
      scopes: [`ws:${target.slug}:agents`, `ws:${target.slug}:sessions`],
      workspaces: [{ slug: target.slug }],
    })
    const agents = await authedWith(routeApp, `/v1/ws/${target.slug}/agents`, appKey.key)
    expect(agents.status).toBe(200)
    expect(await agents.json()).toMatchObject({
      items: [{ slug: agentSlug, anchorPath: `agents/${agentSlug}` }],
    })

    const message = await authedWith(
      routeApp,
      `/v1/ws/${target.slug}/agents/${agentSlug}/sessions/default/messages`,
      appKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Approved. Continue.', behavior: 'steer' }),
      },
    )
    expect(message.status).toBe(201)
    const sessionId = ((await message.json()) as { session: { sessionId: string } }).session
      .sessionId
    const events = (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      sessionId,
    })) as Array<{ event: Record<string, unknown> }>
    expect(events.find(row => row.event.type === 'prompt_submitted')?.event).toMatchObject({
      prompt: 'Approved. Continue.',
      behavior: 'steer',
      sender: { kind: 'app', appId: contentBoard.id },
    })

    const agentsOnlyApp = (await mutate(appOwner.client, 'domains/apps/model:registerApp', {
      internalKey: INTERNAL_KEY,
      actorId: appOwner.user._id,
      workspaceId: target.workspaceId,
      path: `agents/${agentSlug}/apps/agents-only`,
      command: 'bun run server.ts',
      apiScopes: ['agents'],
      slug: 'agents-only',
    })) as { id: string }
    const agentsOnlyKey = (await mutate(appOwner.client, 'domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: agentsOnlyApp.id,
      now: Date.now(),
    })) as { key: string }
    const forbidden = await authedWith(
      routeApp,
      `/v1/ws/${target.slug}/agents/${agentSlug}/sessions/default/messages`,
      agentsOnlyKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Should be refused.', behavior: 'steer' }),
      },
    )
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${target.slug}:sessions`,
    })
  }, 60_000)

  // The default agent's rename shares a path shape with every other agent's, so
  // the only thing keeping them apart is route order. A mutation-level test
  // cannot see that: `/agents/root` falling through to `:slug` would 404 on a
  // slug no agent can hold, and nothing below the router would notice.
  test('PATCH /agents/root renames the default agent without touching agent rows', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('duet-rename'))
    const agentsKey = await issueKey(owner.client)
    const app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })

    const renamed = await authedWith(app, `/v1/ws/${proxied.slug}/agents/root`, agentsKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Milo' }),
    })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toEqual({ name: 'Milo' })

    // It is a rename, not a registration: no agent row appears.
    const listed = await authedWith(app, `/v1/ws/${proxied.slug}/agents`, agentsKey.key)
    expect(await listed.json()).toEqual({ items: [], nextCursor: null })

    // And an ordinary slug still reaches the registered-agent handler, which
    // answers 404 for one that does not exist rather than renaming the root.
    const missing = await authedWith(app, `/v1/ws/${proxied.slug}/agents/research`, agentsKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    })
    expect(missing.status).toBe(404)

    const invalid = await authedWith(app, `/v1/ws/${proxied.slug}/agents/root`, agentsKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    })
    expect(invalid.status).toBe(400)
  })

  test('onboarded completion and reset promptly refresh the gateway and survive a failed or stalled refresh', async () => {
    const agentWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-onboarded'))
    const agentsKey = await issueKey(owner.client)
    const slug = uniqueSlug('onboarded-agent')
    const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: agentWorkspace.workspaceId,
      path: `agents/${slug}`,
      slug,
    })) as { id: string }
    let refreshes = 0
    let unavailable: false | true | 'stalled' = false
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        if (unavailable === 'stalled') {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            })
          })
        }
        if (unavailable) throw new Error('gateway unavailable')
        if (new URL(String(input)).pathname === '/v1/agents/roster/refresh') refreshes++
        return Response.json({ ok: true })
      },
    })

    const setOnboarded = (onboarded: boolean) =>
      authedWith(
        routeApp,
        `/v1/ws/${agentWorkspace.slug}/agents/${slug}/onboarded`,
        agentsKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ onboarded }),
        },
      )

    const onboarded = await setOnboarded(true)
    expect(onboarded.status).toBe(200)
    expect(await onboarded.json()).toMatchObject({
      agent: { id: registered.id, slug, onboardedAt: expect.any(Number) },
    })
    expect(refreshes).toBe(1)

    const reset = await setOnboarded(false)
    expect(reset.status).toBe(200)
    expect((await reset.json()).agent).not.toHaveProperty('onboardedAt')
    expect(refreshes).toBe(2)
    unavailable = true
    const completedOffline = await setOnboarded(true)
    expect(completedOffline.status).toBe(200)
    expect(await completedOffline.json()).toMatchObject({
      agent: { onboardedAt: expect.any(Number) },
    })
    unavailable = 'stalled'
    expect((await setOnboarded(true)).status).toBe(200)
    unavailable = false
    expect((await setOnboarded(true)).status).toBe(200)
    expect(refreshes).toBe(3)

    const malformed = await authedWith(
      routeApp,
      `/v1/ws/${agentWorkspace.slug}/agents/${slug}/onboarded`,
      agentsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ onboarded: 'yes' }),
      },
    )
    expect(malformed.status).toBe(400)

    const unknownSlug = await authedWith(
      routeApp,
      `/v1/ws/${agentWorkspace.slug}/agents/${uniqueSlug('missing')}/onboarded`,
      agentsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ onboarded: true }),
      },
    )
    expect(unknownSlug.status).toBe(404)
  })

  // An `onboarding: { kind: 'app' }` agent runs no interview, so the app is the
  // only thing present when the user finishes — and it holds nothing but its own
  // runtime key: no session id, no agent slug, not even its own app slug. Before
  // this route nothing set `onboardedAt` for an app onboarding at all, and the
  // card stayed locked behind a setup the user had already completed.
  test('onboarded-by-app completes from the app credential alone', async () => {
    const agentWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-app-onb'))
    const agentsKey = await issueKey(owner.client)
    const slug = uniqueSlug('app-onb-agent')
    const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: agentWorkspace.workspaceId,
      path: `agents/${slug}`,
      slug,
    })) as { id: string }
    const setupApp = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: agentWorkspace.workspaceId,
      path: `agents/${slug}/apps/setup`,
      command: 'bun run server.ts',
      apiScopes: ['agents'],
    })) as { id: string }
    const appKey = (await mutate(owner.client, 'domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: setupApp.id,
      now: Date.now(),
    })) as { key: string }
    const gatewayCalls: string[] = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        gatewayCalls.push(new URL(String(input)).pathname)
        return Response.json({ ok: true })
      },
    })
    const post = (key: string) =>
      authedWith(routeApp, `/v1/ws/${agentWorkspace.slug}/app/onboarded`, key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ onboarded: true }),
      })

    const completed = await post(appKey.key)
    expect(completed.status).toBe(200)
    expect(await completed.json()).toMatchObject({
      agent: { id: registered.id, slug, onboardedAt: expect.any(Number) },
    })
    expect(gatewayCalls).toEqual(['/v1/agents/roster/refresh'])

    // The credential IS the address here. A key that carries the capability but
    // names no app has no agent to resolve, and must say so rather than guess.
    const notAnApp = await post(agentsKey.key)
    expect(notAnApp.status).toBe(403)
    expect(await notAnApp.json()).toEqual({ error: 'app_credential_required' })
  })

  test('onboarded-by-app refuses an app that sits outside every agent folder', async () => {
    const agentWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-rootapp-onb'))
    const rootApp = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: agentWorkspace.workspaceId,
      path: `apps/${uniqueSlug('loose')}`,
      command: 'bun run server.ts',
      apiScopes: ['agents'],
    })) as { id: string }
    const appKey = (await mutate(owner.client, 'domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: rootApp.id,
      now: Date.now(),
    })) as { key: string }

    const response = await authedWith(
      createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY }),
      `/v1/ws/${agentWorkspace.slug}/app/onboarded`,
      appKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ onboarded: true }),
      },
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'not_agent_app' })
  })

  // The onboarding agent knows only $DUET_SESSION_ID — the slug route above made
  // it derive the workspace and agent slugs through a whoami + list + jq
  // pipeline, and a live e2e run showed a real runner skipping that ceremony
  // entirely, stranding the user behind a locked card. This route is the same
  // completion keyed by what the agent already has.
  test('onboarded-by-session completes from inside the conversation without knowing any slug', async () => {
    const agentWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-sess-onb'))
    const agentsKey = await issueKey(owner.client)
    const slug = uniqueSlug('sess-onb-agent')
    const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: agentWorkspace.workspaceId,
      path: `agents/${slug}`,
      slug,
    })) as { id: string }
    const opened = (await convex.mutation('domains/agentSessions/creation:openOnboardingSession', {
      internalKey: INTERNAL_KEY,
      workspaceId: agentWorkspace.workspaceId,
      agentId: registered.id,
      actorId: owner.user._id,
      identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
    })) as { sessionId: string }
    const gatewayCalls: string[] = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        gatewayCalls.push(new URL(String(input)).pathname)
        return Response.json({ ok: true })
      },
    })

    const completed = await authedWith(
      routeApp,
      `/v1/ws/${agentWorkspace.slug}/agent/sessions/${opened.sessionId}/onboarded`,
      agentsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ onboarded: true }),
      },
    )
    expect(completed.status).toBe(200)
    expect(await completed.json()).toMatchObject({
      agent: { id: registered.id, slug, onboardedAt: expect.any(Number) },
    })
    expect(gatewayCalls).toEqual(['/v1/agents/roster/refresh'])

    // An ordinary conversation — even one correctly attributed to the agent —
    // is not an unlock path; only the onboarding session is.
    const plain = (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: {
        principal: { kind: 'human', userId: owner.user._id },
        actorId: owner.user._id,
      },
      workspaceId: agentWorkspace.workspaceId,
      attemptId: `sess-onb-plain-${slug}`,
      input: {
        kind: 'initial_prompt',
        prompt: 'hello',
        behavior: 'steer',
        sender: { kind: 'user', userId: owner.user._id },
        clientRequestId: '10000000-0000-4000-8000-0000000000b7',
        cwd: `agents/${slug}`,
      },
    })) as { sessionId: string }
    const rejected = await authedWith(
      routeApp,
      `/v1/ws/${agentWorkspace.slug}/agent/sessions/${plain.sessionId}/onboarded`,
      agentsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ onboarded: true }),
      },
    )
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toEqual({ error: 'not_onboarding_session' })

    // A session id that names no session — including a malformed one the id
    // validator refuses — is a 404, never a 500.
    const missing = await authedWith(
      routeApp,
      `/v1/ws/${agentWorkspace.slug}/agent/sessions/not-a-session/onboarded`,
      agentsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ onboarded: true }),
      },
    )
    expect(missing.status).toBe(404)
  })

  test('onboarding-session opens once and reuses the same hidden conversation', async () => {
    const agentWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-onb-session'))
    const sessionsKey = await issueKey(owner.client)
    const slug = uniqueSlug('onb-session-agent')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: agentWorkspace.workspaceId,
      path: `agents/${slug}`,
      slug,
    })
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ ok: true }),
    })

    const open = () =>
      authedWith(
        routeApp,
        `/v1/ws/${agentWorkspace.slug}/agents/${slug}/onboarding-session`,
        sessionsKey.key,
        { method: 'POST' },
      )

    const first = await open()
    expect(first.status).toBe(200)
    const { sessionId } = (await first.json()) as { sessionId: string }
    expect(sessionId).toBeTruthy()

    const bodyful = await authedWith(
      routeApp,
      `/v1/ws/${agentWorkspace.slug}/agents/${slug}/onboarding-session`,
      sessionsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audience: { kind: 'workspace' } }),
      },
    )
    expect(bodyful.status).toBe(400)
    expect(await bodyful.json()).toEqual({ error: 'invalid_request' })

    const viewer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('onboarding-session-viewer'),
      'Onboarding Viewer',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: agentWorkspace.workspaceId,
      userId: viewer.user._id,
      role: 'viewer',
    })
    const viewerKey = await issueKey(viewer.client)
    const viewerDenied = await authedWith(
      routeApp,
      `/v1/ws/${agentWorkspace.slug}/agents/${slug}/onboarding-session`,
      viewerKey.key,
      { method: 'POST' },
    )
    expect(viewerDenied.status).toBe(403)
    expect(await viewerDenied.json()).toEqual({ error: 'forbidden' })

    // Pressing "Start setup" again lands in the same conversation rather than
    // forking a second one the user can never find again.
    const second = await open()
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ sessionId })

    const missing = await authedWith(
      routeApp,
      `/v1/ws/${agentWorkspace.slug}/agents/${uniqueSlug('nope')}/onboarding-session`,
      sessionsKey.key,
      { method: 'POST' },
    )
    expect(missing.status).toBe(404)
  })

  test('an app onboarding launch keeps its attribution actor and workspace audience', async () => {
    const agentWorkspace = await provisionRegisteredWorkspace(uniqueSlug('app-onb-creator'))
    const slug = uniqueSlug('app-onb-creator-agent')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: agentWorkspace.workspaceId,
      path: `agents/${slug}`,
      slug,
    })
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: agentWorkspace.workspaceId,
      path: `agents/${slug}/apps/setup`,
      command: 'bun run server.ts',
      apiScopes: ['sessions'],
    })) as { id: string }
    const appKey = (await mutate(owner.client, 'domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: app.id,
      now: Date.now(),
    })) as { key: string }

    const response = await authedWith(
      createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY }),
      `/v1/ws/${agentWorkspace.slug}/agents/${slug}/onboarding-session`,
      appKey.key,
      { method: 'POST' },
    )
    expect(response.status).toBe(200)
    const { sessionId } = (await response.json()) as { sessionId: string }
    const row = (await convex.query('testing/agentSessions:rawSessionForTest', {
      internalKey: INTERNAL_KEY,
      sessionId,
    })) as Record<string, unknown>
    expect(row).toMatchObject({
      userId: owner.user._id,
      audienceKind: 'workspace',
    })
  })

  test('nested create inherits parent context, stamps path lineage, and authors input by session', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-nested-create'))
    await grantCredits(proxied.workspaceId, 'grant:agent-nested-create')
    const registeredAgent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'agents/research',
      slug: 'research',
      name: 'Research',
    })) as { id: string }
    const agentKey = await issueKey(owner.client)
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const nestedApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        return runnerInputReceipt(body)
      },
    })

    const parentResponse = await authedWith(
      nestedApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Parent research.',
          cwd: 'agents/research',
          tier: 'frontier',
        }),
      },
    )
    const parent = SessionCreateResponseSchema.parse(await parentResponse.json())

    const rejectedNestedControls = await authedWith(
      nestedApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${parent.session.sessionId}/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Inherited child.',
          createdBySessionId: 'body-is-unknown-key-noise',
        }),
      },
    )
    expect(rejectedNestedControls.status).toBe(400)
    expect(await rejectedNestedControls.json()).toEqual({ error: 'invalid_request' })

    const inheritedResponse = await authedWith(
      nestedApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${parent.session.sessionId}/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Inherited child.' }),
      },
    )
    expect(inheritedResponse.status).toBe(201)
    const inherited = SessionCreateResponseSchema.parse(await inheritedResponse.json())
    expect(inherited.snapshot).toMatchObject({
      createdBySessionId: parent.session.sessionId,
      cwd: 'agents/research',
      tier: 'frontier',
      agent: { id: registeredAgent.id, name: 'Research' },
    })
    // The child's first input is authored by the parent structurally: the
    // request carried an API key whose credential would otherwise derive a
    // user sender.
    const inheritedInput = inherited.history.events[1]!
    expect(inheritedInput.event).toMatchObject({
      type: 'prompt_submitted',
      sender: { kind: 'session', sessionId: parent.session.sessionId },
    })
    expect(inheritedInput.seq).toBe(2)
    expect(typeof inheritedInput.createdAt).toBe('number')
    expect(inheritedInput.event).not.toHaveProperty('submittedAt')
    expect(inheritedInput.event).not.toHaveProperty('origin')
    expect(inheritedInput.event).not.toHaveProperty('userId')

    const overriddenResponse = await authedWith(
      nestedApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${parent.session.sessionId}/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Overridden child.',
          cwd: 'projects/standalone',
          tier: 'balanced',
        }),
      },
    )
    const overridden = SessionCreateResponseSchema.parse(await overriddenResponse.json())
    expect(overridden.snapshot).toMatchObject({
      createdBySessionId: parent.session.sessionId,
      cwd: 'projects/standalone',
      tier: 'balanced',
    })
    expect(overridden.snapshot.agent).toBeUndefined()

    const attributedMessage = await authedWith(
      nestedApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${inherited.session.sessionId}/messages`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Cross-session follow-up.',
          sourceSessionId: parent.session.sessionId,
        }),
      },
    )
    expect(attributedMessage.status).toBe(202)
    const historyAfterSourced = (
      (await (
        await authedWith(
          nestedApp,
          `/v1/ws/${proxied.slug}/agent/sessions/${inherited.session.sessionId}/history`,
          agentKey.key,
        )
      ).json()) as { items: SessionTimelineEntry[] }
    ).items
    expect(historyAfterSourced[0]?.event).toMatchObject({
      type: 'prompt_submitted',
      sender: { kind: 'session', sessionId: parent.session.sessionId },
    })

    // A source session the workspace cannot resolve — absent, malformed, or
    // owned by someone else — reads identically and never reaches the timeline.
    const otherWorkspaceSession = await createAgentSession(
      (await provisionRegisteredWorkspace(uniqueSlug('agent-nested-foreign'))).workspaceId,
      'Foreign session.',
      1_000,
    )
    for (const sourceSessionId of [
      'garbage',
      parent.session.sessionId.slice(0, -1),
      otherWorkspaceSession.sessionId,
    ]) {
      const rejected = await authedWith(
        nestedApp,
        `/v1/ws/${proxied.slug}/agent/sessions/${inherited.session.sessionId}/messages`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'Unresolvable source.', sourceSessionId }),
        },
      )
      expect(rejected.status).toBe(404)
      expect(await rejected.json()).toEqual({ error: 'not_found' })
      const rejectedNote = await authedWith(
        nestedApp,
        `/v1/ws/${proxied.slug}/agent/sessions/${inherited.session.sessionId}/note`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: 'Unresolvable source.', sourceSessionId }),
        },
      )
      expect(rejectedNote.status).toBe(404)
    }
    const historyAfterRejections = (
      (await (
        await authedWith(
          nestedApp,
          `/v1/ws/${proxied.slug}/agent/sessions/${inherited.session.sessionId}/history`,
          agentKey.key,
        )
      ).json()) as { items: SessionTimelineEntry[] }
    ).items
    expect(historyAfterRejections.map(row => row.seq)).toEqual(
      historyAfterSourced.map(row => row.seq),
    )

    const missingParent = await authedWith(
      nestedApp,
      `/v1/ws/${proxied.slug}/agent/sessions/not-a-session/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'No parent.' }),
      },
    )
    expect(missingParent.status).toBe(404)
    expect(await missingParent.json()).toEqual({ error: 'not_found' })

    await convex.mutation('domains/agentSessions/model:beginSessionSubtreeDeletion', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
      workspaceId: proxied.workspaceId,
      sessionId: parent.session.sessionId,
      now: Date.now(),
    })
    const deletingParent = await authedWith(
      nestedApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${parent.session.sessionId}/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Deleting parent.' }),
      },
    )
    expect(deletingParent.status).toBe(404)
    expect(await deletingParent.json()).toEqual({ error: 'not_found' })
    const sealedChild = await authedWith(
      nestedApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${inherited.session.sessionId}`,
      agentKey.key,
    )
    expect(sealedChild.status).toBe(404)
    expect(await sealedChild.json()).toEqual({ error: 'not_found' })

    expect(gatewayCalls).toEqual([
      expectedRunnerInput({
        throughSeq: 2,
        message: 'Parent research.',
        behavior: 'steer',
        cwd: 'agents/research',
        tier: 'frontier',
      }),
      expectedRunnerInput({
        throughSeq: 2,
        message: 'Inherited child.',
        sender: {
          kind: 'session',
          sessionId: parent.session.sessionId,
          // Composition-time enrichment: the parent lives in agents/research.
          agentSlug: 'research',
          agentName: 'Research',
        },
        behavior: 'steer',
        cwd: 'agents/research',
        tier: 'frontier',
        createdBySessionId: parent.session.sessionId,
      }),
      expectedRunnerInput({
        throughSeq: 2,
        message: 'Overridden child.',
        sender: {
          kind: 'session',
          sessionId: parent.session.sessionId,
          // Composition-time enrichment: the parent lives in agents/research.
          agentSlug: 'research',
          agentName: 'Research',
        },
        behavior: 'steer',
        cwd: 'projects/standalone',
        tier: 'balanced',
        createdBySessionId: parent.session.sessionId,
      }),
      expectedRunnerInput({
        throughSeq: 3,
        message: 'Cross-session follow-up.',
        sender: {
          kind: 'session',
          sessionId: parent.session.sessionId,
          // Composition-time enrichment: the parent lives in agents/research.
          agentSlug: 'research',
          agentName: 'Research',
        },
        behavior: 'steer',
        cwd: 'agents/research',
        tier: 'frontier',
        createdBySessionId: parent.session.sessionId,
      }),
    ])
  })

  test('session creation returns its durable timeline after the correlated runner receipt', async () => {
    const handoffOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('agent-create-handoff'),
      'Agent Create Handoff',
    )
    await mutate(
      handoffOwner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    const proxied = await provisionRegisteredWorkspace(
      uniqueSlug('agent-create-handoff'),
      handoffOwner,
    )
    await grantCredits(proxied.workspaceId, 'grant:agent-create-handoff')
    const agentKey = await issueKey(handoffOwner.client)
    let markGatewayStarted!: () => void
    let releaseGateway!: () => void
    const gatewayStarted = new Promise<void>(resolve => {
      markGatewayStarted = resolve
    })
    const gatewayRelease = new Promise<void>(resolve => {
      releaseGateway = resolve
    })
    const gatewayCalls: GatewayRunnerInputRequest[] = []
    const background: Promise<unknown>[] = []
    const handoffApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      waitUntil: promise => background.push(promise),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
        gatewayCalls.push(body)
        markGatewayStarted()
        await gatewayRelease
        return runnerInputReceipt(body)
      },
    })

    let created: Response | undefined
    const request = authedWith(handoffApp, `/v1/ws/${proxied.slug}/agent/sessions`, agentKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Inspect the overnight deployment',
        clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
      }),
    }).then(response => {
      created = response
      return response
    })

    try {
      await gatewayStarted
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(created).toBeUndefined()
      releaseGateway()
      const response = await request
      expect(response.status).toBe(201)
      const body = SessionCreateResponseSchema.parse(await response.json())
      expect(body.session).toMatchObject({
        sessionId: body.snapshot.id,
        lastEventSeq: 2,
        lastDeliveredInputSeq: 2,
      })
      expect(body.snapshot).toMatchObject({
        id: body.session.sessionId,
        workspaceId: proxied.workspaceId,
        lastEventSeq: 2,
        lastDeliveredInputSeq: 2,
      })
      expect(body.snapshot.deliveryAttempt).toBeUndefined()
      expect(body.history.events.map(entry => entry.event)).toEqual([
        expect.objectContaining({
          type: 'session_created',
          prompt: 'Inspect the overnight deployment',
        }),
        expect.objectContaining({
          type: 'prompt_submitted',
          prompt: 'Inspect the overnight deployment',
          inputKind: 'initial',
        }),
      ])
      expect(body.dispatched).toBe(false)
      expect(body.delivery).toBe('accepted')

      const retriedCreate = await authedWith(
        handoffApp,
        `/v1/ws/${proxied.slug}/agent/sessions`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Inspect the overnight deployment',
            clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
          }),
        },
      )
      const retriedBody = SessionCreateResponseSchema.parse(await retriedCreate.json())
      expect(retriedCreate.status).toBe(201)
      expect(retriedBody.session.sessionId).toBe(body.session.sessionId)
      // Same clientRequestId, different launch tier: the fingerprint changes, so
      // this is a conflicting replay rather than an idempotent retry.
      const conflictingRetry = await authedWith(
        handoffApp,
        `/v1/ws/${proxied.slug}/agent/sessions`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Inspect the overnight deployment',
            tier: 'frontier',
            clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
          }),
        },
      )
      expect(conflictingRetry.status).toBe(400)
      expect(await conflictingRetry.json()).toEqual({ error: 'invalid_request' })
      const conflictingCreateBehavior = await authedWith(
        handoffApp,
        `/v1/ws/${proxied.slug}/agent/sessions`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Inspect the overnight deployment',
            behavior: 'follow_up',
            clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
          }),
        },
      )
      expect(conflictingCreateBehavior.status).toBe(400)
      expect(await conflictingCreateBehavior.json()).toEqual({ error: 'invalid_request' })

      const followUp = await authedWith(
        handoffApp,
        `/v1/ws/${proxied.slug}/agent/sessions/${body.session.sessionId}/messages`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Follow up before the runner starts',
            clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b92',
          }),
        },
      )
      expect(followUp.status).toBe(202)
      expect(await followUp.json()).toEqual({ ok: true, delivery: 'accepted' })
      const retriedFollowUp = await authedWith(
        handoffApp,
        `/v1/ws/${proxied.slug}/agent/sessions/${body.session.sessionId}/messages`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Follow up before the runner starts',
            clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b92',
          }),
        },
      )
      expect(retriedFollowUp.status).toBe(202)
      const conflictingFollowUpBehavior = await authedWith(
        handoffApp,
        `/v1/ws/${proxied.slug}/agent/sessions/${body.session.sessionId}/messages`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Follow up before the runner starts',
            behavior: 'follow_up',
            clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b92',
          }),
        },
      )
      expect(conflictingFollowUpBehavior.status).toBe(400)
      expect(await conflictingFollowUpBehavior.json()).toEqual({ error: 'invalid_request' })
      expect(gatewayCalls).toEqual([
        expectedRunnerInput({
          sender: { kind: 'user', email: handoffOwner.user.email },
          throughSeq: 2,
          message: 'Inspect the overnight deployment',
          behavior: 'steer',
        }),
        expectedRunnerInput({
          sender: { kind: 'user', email: handoffOwner.user.email },
          throughSeq: 3,
          message: 'Follow up before the runner starts',
          behavior: 'steer',
        }),
      ])
    } finally {
      releaseGateway()
      await Promise.all(background)
      await request
    }
    expect(gatewayCalls).toEqual([
      expectedRunnerInput({
        sender: { kind: 'user', email: handoffOwner.user.email },
        throughSeq: 2,
        message: 'Inspect the overnight deployment',
        behavior: 'steer',
      }),
      expectedRunnerInput({
        sender: { kind: 'user', email: handoffOwner.user.email },
        throughSeq: 3,
        message: 'Follow up before the runner starts',
        behavior: 'steer',
      }),
    ])
  })

  test('thrown gateway dispatch still acknowledges the durably queued input', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-dispatch-throws'))
    await grantCredits(proxied.workspaceId, 'grant:agent-dispatch-throws')
    const agentKey = await issueKey(owner.client)
    let gatewayCallCount = 0
    const throwingApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        gatewayCallCount += 1
        if (gatewayCallCount === 1) {
          const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
          return runnerInputReceipt(body)
        }
        throw new Error('gateway connection reset')
      },
    })
    const created = await authedWith(
      throwingApp,
      `/v1/ws/${proxied.slug}/agent/sessions`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'initial' }),
      },
    )
    const sessionId = ((await created.json()) as { session: { sessionId: string } }).session
      .sessionId

    const accepted = await authedWith(
      throwingApp,
      `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/messages`,
      agentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'keep this queued' }),
      },
    )

    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ ok: true, delivery: 'queued' })
    const events = (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      sessionId,
      afterSeq: 0,
    })) as SessionTimelineEntry[]
    // The durable row owns the only input timestamp: the event itself carries
    // authorship and nothing else time-shaped.
    expect(events.map(row => row.event)).toContainEqual({
      type: 'prompt_submitted',
      prompt: 'keep this queued',
      inputKind: 'message',
      behavior: 'steer',
      sender: { kind: 'user', userId: owner.user._id },
    })
  })

  test('stalled gateway dispatch still creates the durable session as queued', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-dispatch-stalls'))
    await grantCredits(proxied.workspaceId, 'grant:agent-dispatch-stalls')
    const agentKey = await issueKey(owner.client)
    const stalledApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => await new Promise<Response>(() => {}),
      agentRequestTimeoutMs: 5,
    })

    const result = await Promise.race([
      authedWith(stalledApp, `/v1/ws/${proxied.slug}/agent/sessions`, agentKey.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'start even if the cold runner stalls' }),
      }),
      Bun.sleep(2_000).then(() => 'stalled' as const),
    ])

    expect(result).not.toBe('stalled')
    if (result === 'stalled') return
    expect(result.status).toBe(201)
    const created = SessionCreateResponseSchema.parse(await result.json())
    expect(created.delivery).toBe('queued')
    const events = (await convex.query('domains/agentSessions/model:listEventsForDelivery', {
      internalKey: INTERNAL_KEY,
      workspaceId: proxied.workspaceId,
      sessionId: created.snapshot.id,
      afterSeq: 0,
    })) as SessionTimelineEntry[]
    expect(events.map(row => row.event)).toContainEqual({
      type: 'prompt_submitted',
      prompt: 'start even if the cold runner stalls',
      inputKind: 'initial',
      behavior: 'steer',
      sender: { kind: 'user', userId: owner.user._id },
    })
  })

  test.each([
    ['frontier', 'balanced'],
    ['openai-frontier', 'anthropic-max'],
  ] as const)(
    'selection %s resolves once per queued prompt and answers resume the effective selection',
    async (tierA, tierB) => {
      const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-tier-threading'))
      await grantCredits(proxied.workspaceId, 'grant:agent-tier-threading')
      await mutate(owner.client, 'domains/workspaces/mutations:setDefaultModel', {
        workspaceId: proxied.workspaceId,
        tier: tierA,
      })
      const agentKey = await issueKey(owner.client)
      const gatewayCalls: GatewayRunnerInputRequest[] = []
      const modelBackground = waitUntilCollector()
      const modelApp = createApiApp({
        convexUrl: convex.url,
        internalKey: INTERNAL_KEY,
        waitUntil: modelBackground.waitUntil,
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as GatewayRunnerInputRequest
          gatewayCalls.push(body)
          return gatewayCalls.length === 1
            ? Response.json({ error: 'runner_unavailable' }, { status: 503 })
            : runnerInputReceipt(body)
        },
      })

      const invalid = await authedWith(
        modelApp,
        `/v1/ws/${proxied.slug}/agent/sessions`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // 'recommended' was a pre-tier virtual model name; it is not a tier id.
          body: JSON.stringify({ prompt: 'reject legacy', tier: 'recommended' }),
        },
      )
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'invalid_request' })

      const created = await authedWith(
        modelApp,
        `/v1/ws/${proxied.slug}/agent/sessions`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'first tier', cwd: 'projects/demo', tier: tierB }),
        },
      )
      const createdBody = SessionCreateResponseSchema.parse(await created.json())
      expect(createdBody.snapshot.tier).toBe(tierB)
      const sessionId = createdBody.snapshot.id
      await modelBackground.drain()
      const continued = await authedWith(
        modelApp,
        `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/messages`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'second tier', tier: tierA }),
        },
      )
      expect(continued.status).toBe(202)
      expect(await continued.json()).toEqual({ ok: true, delivery: 'queued' })
      await modelBackground.drain()
      expect(
        gatewayCalls.map(call => [
          primaryEnvelopeBody(
            call.input.kind === 'prompt' ? call.input.message : call.input.answer,
          ),
          call.launch.tier,
        ]),
      ).toEqual([
        ['first tier', tierB],
        ['first tier', tierB],
        ['second tier', tierA],
      ])

      await relayAgentEvent(modelApp, proxied.vmToken, sessionId, {
        type: 'ask',
        state: waitingTurnState(),
        questions: [{ question: 'Approve?', options: [] }],
      })
      const answered = await authedWith(
        modelApp,
        `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}/answer`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer: 'approved' }),
        },
      )
      expect(answered.status).toBe(202)
      expect(await answered.json()).toEqual({ ok: true, delivery: 'accepted' })
      await modelBackground.drain()
      expect(gatewayCalls.at(-1)).toEqual(
        expectedRunnerAnswer({
          throughSeq: 5,
          answer: 'approved',
          cwd: 'projects/demo',
          tier: tierA,
        }),
      )

      await mutate(owner.client, 'domains/workspaces/mutations:setDefaultModel', {
        workspaceId: proxied.workspaceId,
        tier: tierB,
      })
      const reloaded = await authedWith(
        modelApp,
        `/v1/ws/${proxied.slug}/agent/sessions/${sessionId}`,
        agentKey.key,
      )
      expect(reloaded.status).toBe(200)
      expect(SessionSnapshotSchema.parse(await reloaded.json()).tier).toBe(tierA)

      const workspaceDefault = await authedWith(
        modelApp,
        `/v1/ws/${proxied.slug}/agent/sessions`,
        agentKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'workspace default' }),
        },
      )
      expect(workspaceDefault.status).toBe(201)
      await modelBackground.drain()
      expect(gatewayCalls.at(-1)).toEqual(
        expectedRunnerInput({
          throughSeq: 2,
          message: 'workspace default',
          behavior: 'steer',
          tier: tierB,
        }),
      )

      const floorWorkspace = await provisionRegisteredWorkspace(uniqueSlug('agent-model-floor'))
      await grantCredits(floorWorkspace.workspaceId, 'grant:agent-model-floor')
      const floorKey = await issueKey(owner.client)
      const floor = await authedWith(
        modelApp,
        `/v1/ws/${floorWorkspace.slug}/agent/sessions`,
        floorKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'catalog floor' }),
        },
      )
      expect(floor.status).toBe(201)
      await modelBackground.drain()
      expect(gatewayCalls.at(-1)).toEqual(
        expectedRunnerInput({
          throughSeq: 2,
          message: 'catalog floor',
          behavior: 'steer',
        }),
      )
      const vmPayloads = JSON.stringify(gatewayCalls)
      expect(vmPayloads).not.toContain(`"resolvedModelId"`)
      // The tier is the only routing fact on the wire: no concrete gateway model
      // id may reach the VM, whichever tier resolved.
      for (const model of APPROVED_MODELS.entries) {
        expect(vmPayloads).not.toContain(`"${model.id}"`)
      }
    },
  )

  test('servicing status blocks agent sessions before credit preflight', async () => {
    const internalAdmin = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('servicing-admin').replace(/@[^@]+$/, '@aomni.com'),
      'Servicing Admin',
    )
    const servicingOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('servicing-owner'),
      'Servicing Owner',
    )
    await mutate(
      servicingOwner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    const paused = await provisionRegisteredWorkspace(
      uniqueSlug('servicing-paused'),
      servicingOwner,
    )
    await grantCredits(paused.workspaceId, 'grant:servicing-paused')
    for (let index = 0; index < 3; index += 1) {
      await convex.mutation('domains/credits/internal:recordInvoicePaymentFailure', {
        internalKey: INTERNAL_KEY,
        workspaceId: paused.workspaceId,
        userId: servicingOwner.user._id,
        error: {
          code: 'card_declined',
          message: 'Your payment method was declined.',
          at: Date.now() + index,
        },
      })
    }
    const pausedAgentKey = await issueKey(servicingOwner.client)
    const gatewayCalls: string[] = []
    const servicingApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        gatewayCalls.push(String(input))
        return Response.json({ ok: true })
      },
    })

    const pausedAgent = await authedWith(
      servicingApp,
      `/v1/ws/${paused.slug}/agent/sessions`,
      pausedAgentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'blocked while paused' }),
      },
    )
    expect(pausedAgent.status).toBe(402)
    expect(await pausedAgent.json()).toEqual({
      error: 'subscription_inactive',
      code: 'subscription_inactive',
      billingUrl: 'https://app.duet.so/settings/billing',
    })
    expect(pausedAgent.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(pausedAgent.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('subscription_inactive')

    expect(gatewayCalls).toEqual([])

    const bannedOwner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('servicing-banned-owner'),
      'Servicing Banned Owner',
    )
    await mutate(
      bannedOwner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      { internalKey: INTERNAL_KEY },
    )
    const banned = await provisionRegisteredWorkspace(uniqueSlug('servicing-banned'), bannedOwner)
    await grantCredits(banned.workspaceId, 'grant:servicing-banned')
    const running = await createAgentSession(
      banned.workspaceId,
      'terminalize through paused-safe relay',
      Date.now(),
      undefined,
      bannedOwner.user._id,
    )
    await relayAgentEvent(
      servicingApp,
      banned.vmToken,
      running.sessionId,
      {
        type: 'turn_started',
        state: { status: 'running', mode: 'agent', agent: { status: 'running', messages: [] } },
      },
      running.lastEventSeq,
    )
    const recoverySnapshot = (await convex.query('domains/agentSessions/model:getSession', {
      internalKey: INTERNAL_KEY,
      workspaceId: banned.workspaceId,
      sessionId: running.sessionId,
    })) as { deliveryAttempt: { attemptId: string; throughSeq: number } }
    await convex.mutation('domains/agentSessions/model:markRunnerInputDelivered', {
      internalKey: INTERNAL_KEY,
      workspaceId: banned.workspaceId,
      sessionId: running.sessionId,
      attemptId: recoverySnapshot.deliveryAttempt.attemptId,
      throughSeq: recoverySnapshot.deliveryAttempt.throughSeq,
    })
    const recoveryUrl = `/v1/vm/agent/sessions/${running.sessionId}/interrupted-checkpoint`
    const recoveryHeaders = {
      authorization: `Bearer ${banned.vmToken}`,
      'content-type': 'application/json',
    }
    expect((await servicingApp.request(recoveryUrl)).status).toBe(401)
    expect(
      (
        await servicingApp.request(recoveryUrl, {
          headers: { authorization: `Bearer ${paused.vmToken}` },
        })
      ).status,
    ).toBe(404)
    const targetResponse = await servicingApp.request(recoveryUrl, { headers: recoveryHeaders })
    expect(targetResponse.status).toBe(200)
    const recoveryTarget = await targetResponse.json()
    expect(recoveryTarget).toMatchObject({ acceptedThroughSeq: running.lastEventSeq })
    const recoveryResponse = await servicingApp.request(recoveryUrl, {
      method: 'POST',
      headers: recoveryHeaders,
      body: JSON.stringify(recoveryTarget),
    })
    expect(recoveryResponse.status).toBe(200)
    expect(await recoveryResponse.json()).toEqual({ repaired: true })
    const duplicateRecovery = await servicingApp.request(recoveryUrl, {
      method: 'POST',
      headers: recoveryHeaders,
      body: JSON.stringify(recoveryTarget),
    })
    expect(await duplicateRecovery.json()).toEqual({ repaired: false })
    await convex.mutation('domains/internalAdmin/model:mutateWorkspace', {
      internalKey: INTERNAL_KEY,
      workspaceId: banned.workspaceId,
      actorId: internalAdmin.user._id,
      requestId: crypto.randomUUID(),
      reason: 'terms review',
      now: Date.now(),
      operation: 'ban',
    })
    const bannedAgentKey = await issueKey(bannedOwner.client)
    const bannedAgent = await authedWith(
      servicingApp,
      `/v1/ws/${banned.slug}/agent/sessions`,
      bannedAgentKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'blocked while banned' }),
      },
    )
    expect(bannedAgent.status).toBe(402)
    expect(await bannedAgent.json()).toMatchObject({
      error: 'payment_required',
      code: 'payment_required',
    })
    expect(bannedAgent.headers.get(X_DUET_GATEWAY_HEADER)).toBe('block')
    expect(bannedAgent.headers.get(X_DUET_GATEWAY_CODE_HEADER)).toBe('payment_required')
    expect(
      await relayAgentEvent(
        servicingApp,
        banned.vmToken,
        running.sessionId,
        {
          type: 'system',
          level: 'info',
          message: 'Stopped absent runner',
          metadata: { code: 'interrupt_undeliverable' },
        },
        running.lastEventSeq,
      ),
    ).toMatchObject({ status: 'interrupted', accepted: true })
    expect(
      await relayAgentEvent(servicingApp, banned.vmToken, running.sessionId, {
        type: 'interrupted',
        state: {
          status: 'interrupted',
          mode: 'agent',
          agent: { status: 'cancelled', messages: [] },
        },
      }),
    ).toMatchObject({ status: 'interrupted', accepted: false })

    await expect(
      convex.mutation('domains/internalAdmin/model:mutateWorkspace', {
        internalKey: INTERNAL_KEY,
        workspaceId: banned.workspaceId,
        actorId: internalAdmin.user._id,
        requestId: crypto.randomUUID(),
        reason: 'manual servicing is forbidden',
        now: Date.now(),
        operation: 'servicing',
        servicingStatus: 'active',
      }),
    ).rejects.toThrow()
    expect(gatewayCalls).toHaveLength(0)
  })

  test('specific audience creation, paging, self-removal, and final archive use public policy', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('specific-audience-api'))
    await grantCredits(workspace.workspaceId, 'grant:specific-audience-api')
    const viewer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('specific-audience-viewer'),
      'Specific Viewer',
    )
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      userId: viewer.user._id,
      role: 'viewer',
    })
    const [ownerKey, viewerKey] = await Promise.all([
      issueKey(owner.client),
      issueKey(viewer.client),
    ])
    let gatewayCalls = 0
    const creationBody = {
      prompt: 'Keep this side chat quiet',
      clientRequestId: '30000000-0000-4000-8000-000000000017',
      audience: { kind: 'specific' as const, memberUserIds: [viewer.user._id] },
    }
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        gatewayCalls += 1
        return runnerInputReceipt(JSON.parse(String(init?.body)) as GatewayRunnerInputRequest)
      },
    })
    const createdResponse = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agent/sessions`,
      ownerKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(creationBody),
      },
    )
    expect(createdResponse.status).toBe(201)
    const created = SessionCreateResponseSchema.parse(await createdResponse.json())
    expect(created.snapshot.audience).toMatchObject({ kind: 'specific', count: 2 })

    const audiencePath = `/v1/ws/${workspace.slug}/agent/sessions/${created.snapshot.id}/audience`
    const beforeNoOp = (await (
      await authedWith(
        app,
        `/v1/ws/${workspace.slug}/agent/sessions/${created.snapshot.id}`,
        ownerKey.key,
      )
    ).json()) as { updatedAt: number }
    const noOp = await authedWith(app, audiencePath, ownerKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: [owner.user._id] }),
    })
    expect(noOp.status).toBe(200)
    expect((await noOp.json()) as { updatedAt: number }).toMatchObject({
      updatedAt: beforeNoOp.updatedAt,
    })
    const page = await authedWith(app, `${audiencePath}?limit=1`, viewerKey.key)
    expect(page.status).toBe(200)
    const first = (await page.json()) as { items: Array<{ userId: string }>; nextCursor: string }
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toBeTruthy()
    const second = await authedWith(
      app,
      `${audiencePath}?limit=100&cursor=${encodeURIComponent(first.nextCursor)}`,
      viewerKey.key,
    )
    expect((await second.json()) as object).toMatchObject({
      items: [expect.any(Object)],
      nextCursor: null,
    })

    const selfRemoved = await authedWith(app, audiencePath, viewerKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remove: [viewer.user._id] }),
    })
    expect(selfRemoved.status).toBe(204)
    expect(await selfRemoved.text()).toBe('')
    expect((await authedWith(app, audiencePath, viewerKey.key)).status).toBe(404)
    const hiddenCursor = await authedWith(app, `${audiencePath}?cursor=invalid`, viewerKey.key)
    expect(hiddenCursor.status).toBe(404)
    expect(await hiddenCursor.json()).toEqual({ error: 'not_found' })
    const hiddenMember = await authedWith(app, audiencePath, viewerKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: ['not-a-user-id'] }),
    })
    expect(hiddenMember.status).toBe(404)
    expect(await hiddenMember.json()).toEqual({ error: 'not_found' })

    const retry = await authedWith(app, `/v1/ws/${workspace.slug}/agent/sessions`, ownerKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(creationBody),
    })
    expect(retry.status).toBe(201)
    expect(SessionCreateResponseSchema.parse(await retry.json()).snapshot.id).toBe(
      created.snapshot.id,
    )
    expect(gatewayCalls).toBe(1)
    expect((await authedWith(app, audiencePath, viewerKey.key)).status).toBe(404)

    const mismatchedRetry = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agent/sessions`,
      ownerKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...creationBody,
          audience: { kind: 'specific', memberUserIds: [] },
        }),
      },
    )
    expect(mismatchedRetry.status).toBe(400)
    expect(await mismatchedRetry.json()).toEqual({ error: 'invalid_request' })

    const malformedMember = await authedWith(app, audiencePath, ownerKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: ['not-a-user-id'] }),
    })
    expect(malformedMember.status).toBe(400)
    expect(await malformedMember.json()).toEqual({ error: 'invalid_audience_member' })

    const outsider = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('specific-audience-outsider'),
      'Audience Outsider',
    )
    const noncurrentAdd = await authedWith(app, audiencePath, ownerKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: [outsider.user._id] }),
    })
    expect(noncurrentAdd.status).toBe(400)
    expect(await noncurrentAdd.json()).toEqual({ error: 'invalid_audience_member' })
    const absentRemove = await authedWith(app, audiencePath, ownerKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remove: [outsider.user._id] }),
    })
    expect(absentRemove.status).toBe(200)

    const malformedSession = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agent/sessions/not-a-session/audience`,
      ownerKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ add: ['not-a-user-id'] }),
      },
    )
    expect(malformedSession.status).toBe(404)
    expect(await malformedSession.json()).toEqual({ error: 'not_found' })

    const workspaceSession = await createAgentSession(
      workspace.workspaceId,
      'Workspace audience stays immutable',
      1_000,
    )
    const immutable = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agent/sessions/${workspaceSession.sessionId}/audience?cursor=invalid`,
      ownerKey.key,
    )
    expect(immutable.status).toBe(409)
    expect(await immutable.json()).toEqual({ error: 'audience_kind_immutable' })
    const immutablePatch = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agent/sessions/${workspaceSession.sessionId}/audience`,
      ownerKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ add: ['not-a-user-id'] }),
      },
    )
    expect(immutablePatch.status).toBe(409)
    expect(await immutablePatch.json()).toEqual({ error: 'audience_kind_immutable' })

    const finalRemoved = await authedWith(app, audiencePath, ownerKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remove: [owner.user._id] }),
    })
    expect(finalRemoved.status).toBe(200)
    expect(await finalRemoved.json()).toMatchObject({
      audience: { kind: 'specific', count: 0 },
      archive: { reason: 'global', globalArchivedAt: expect.any(Number) },
    })
  })

  test('specific creation rechecks a removed target after image storage before any dispatch', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('specific-create-race'))
    await grantCredits(workspace.workspaceId, 'grant:specific-create-race')
    const viewer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('specific-create-race-viewer'),
      'Creation Race Viewer',
    )
    const membershipId = (await mutate(
      owner.client,
      'testing/workspaces:addWorkspaceMemberForTest',
      {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        userId: viewer.user._id,
        role: 'viewer',
      },
    )) as string
    const ownerKey = await issueKey(owner.client)
    let gatewayCalls = 0
    let hookCalls = 0
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => {
        gatewayCalls += 1
        return Response.json({ ok: true })
      },
      sessionInputTestHooks: {
        afterImagesStored: async () => {
          hookCalls += 1
          await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
            internalKey: INTERNAL_KEY,
            membershipId,
            now: 2_000,
          })
        },
      },
    })

    const response = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agent/sessions`,
      ownerKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Race current membership',
          audience: { kind: 'specific', memberUserIds: [viewer.user._id] },
          images: [{ data: 'cmFjZS1pbWFnZQ==', mimeType: 'image/png' }],
        }),
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_audience_member' })
    expect({ hookCalls, gatewayCalls }).toEqual({ hookCalls: 1, gatewayCalls: 0 })
  })

  test('wait and non-wait creation recheck creator membership before and after image storage', async () => {
    for (const kind of ['create', 'wait'] as const) {
      for (const phase of ['beforePreflight', 'afterImagesStored'] as const) {
        const workspace = await provisionRegisteredWorkspace(
          uniqueSlug(`specific-creator-${kind}-${phase}`),
        )
        await grantCredits(workspace.workspaceId, `grant:specific-creator-${kind}-${phase}`)
        const creator = await signInWithMagicLink<UserRow>(
          convex,
          uniqueEmail(`specific-creator-${kind}-${phase}`),
          'Specific Creator',
        )
        const membershipId = (await mutate(
          owner.client,
          'testing/workspaces:addWorkspaceMemberForTest',
          {
            internalKey: INTERNAL_KEY,
            workspaceId: workspace.workspaceId,
            userId: creator.user._id,
            role: 'viewer',
          },
        )) as string
        const key = await issueKey(creator.client)
        let gatewayCalls = 0
        let hookCalls = 0
        const revoke = async () => {
          hookCalls += 1
          await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
            internalKey: INTERNAL_KEY,
            membershipId,
            now: 2_000,
          })
        }
        const app = createApiApp({
          convexUrl: convex.url,
          internalKey: INTERNAL_KEY,
          fetch: async () => {
            gatewayCalls += 1
            return Response.json({ ok: true })
          },
          sessionInputTestHooks: { [phase]: revoke },
        })
        const response = await authedWith(
          app,
          `/v1/ws/${workspace.slug}/agent/sessions${kind === 'wait' ? '/wait' : ''}`,
          key.key,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: 'Membership must remain current',
              audience: { kind: 'specific', memberUserIds: [] },
              ...(kind === 'wait' ? { clientRequestId: crypto.randomUUID() } : {}),
              ...(phase === 'afterImagesStored'
                ? { images: [{ data: 'cmFjZS1pbWFnZQ==', mimeType: 'image/png' }] }
                : {}),
            }),
          },
        )
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'not_found' })
        expect({ hookCalls, gatewayCalls }).toEqual({ hookCalls: 1, gatewayCalls: 0 })
      }
    }
  }, 60_000)

  test('audience keysets follow Convex Unicode order across membership rejoin', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('audience-unicode-cursor'))
    await grantCredits(workspace.workspaceId, 'grant:audience-unicode-cursor')
    const firstViewer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('audience-unicode-first'),
      'Unicode First',
    )
    const secondViewer = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('audience-unicode-second'),
      'Unicode Second',
    )
    const firstMembershipId = (await mutate(
      owner.client,
      'testing/workspaces:addWorkspaceMemberForTest',
      {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        userId: firstViewer.user._id,
        role: 'viewer',
      },
    )) as string
    const secondMembershipId = (await mutate(
      owner.client,
      'testing/workspaces:addWorkspaceMemberForTest',
      {
        internalKey: INTERNAL_KEY,
        workspaceId: workspace.workspaceId,
        userId: secondViewer.user._id,
        role: 'viewer',
      },
    )) as string
    await convex.mutation('testing/workspaces:setMemberDirectoryOrderForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      membershipId: firstMembershipId,
      normalizedName: '\uE000',
    })
    await convex.mutation('testing/workspaces:setMemberDirectoryOrderForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      membershipId: secondMembershipId,
      normalizedName: '\u{10000}',
    })
    const [ownerKey, secondViewerKey] = await Promise.all([
      issueKey(owner.client),
      issueKey(secondViewer.client),
    ])
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) =>
        runnerInputReceipt(JSON.parse(String(init?.body)) as GatewayRunnerInputRequest),
    })
    const created = SessionCreateResponseSchema.parse(
      await (
        await authedWith(app, `/v1/ws/${workspace.slug}/agent/sessions`, ownerKey.key, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Unicode cursor proof',
            audience: {
              kind: 'specific',
              memberUserIds: [firstViewer.user._id, secondViewer.user._id],
            },
          }),
        })
      ).json(),
    )
    const path = `/v1/ws/${workspace.slug}/agent/sessions/${created.snapshot.id}/audience`
    const firstPage = (await (await authedWith(app, `${path}?limit=2`, ownerKey.key)).json()) as {
      items: Array<{ userId: string }>
      nextCursor: string
    }
    expect(firstPage.items.map(item => item.userId)).toEqual([owner.user._id, firstViewer.user._id])
    const viewerCursor = (
      (await (await authedWith(app, `${path}?limit=1`, secondViewerKey.key)).json()) as {
        nextCursor: string
      }
    ).nextCursor
    const crossPrincipal = await authedWith(
      app,
      `${path}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      secondViewerKey.key,
    )
    expect(crossPrincipal.status).toBe(400)
    expect(await crossPrincipal.json()).toEqual({ error: 'invalid_cursor' })

    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: firstMembershipId,
      now: 2_000,
    })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      userId: firstViewer.user._id,
      role: 'viewer',
    })
    const secondPage = await authedWith(
      app,
      `${path}?limit=100&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      ownerKey.key,
    )
    expect(await secondPage.json()).toEqual({
      items: [expect.objectContaining({ userId: secondViewer.user._id })],
      nextCursor: null,
    })

    const sparseFirst = (await (await authedWith(app, `${path}?limit=1`, ownerKey.key)).json()) as {
      nextCursor: string
    }
    const sparseEmpty = await authedWith(
      app,
      `${path}?limit=1&cursor=${encodeURIComponent(sparseFirst.nextCursor)}`,
      ownerKey.key,
    )
    const sparseBody = (await sparseEmpty.json()) as { items: unknown[]; nextCursor: string }
    expect(sparseBody.items).toEqual([])
    expect(sparseBody.nextCursor).toEqual(expect.any(String))

    const otherSession = SessionCreateResponseSchema.parse(
      await (
        await authedWith(app, `/v1/ws/${workspace.slug}/agent/sessions`, ownerKey.key, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Other cursor subject',
            audience: { kind: 'specific', memberUserIds: [] },
          }),
        })
      ).json(),
    )
    const crossSession = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/agent/sessions/${otherSession.snapshot.id}/audience?cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      ownerKey.key,
    )
    expect(crossSession.status).toBe(400)
    expect(await crossSession.json()).toEqual({ error: 'invalid_cursor' })

    const otherWorkspace = await provisionRegisteredWorkspace(
      uniqueSlug('audience-cross-workspace'),
    )
    await grantCredits(otherWorkspace.workspaceId, 'grant:audience-cross-workspace')
    const otherWorkspaceKey = await issueKey(owner.client)
    const otherWorkspaceSession = SessionCreateResponseSchema.parse(
      await (
        await authedWith(
          app,
          `/v1/ws/${otherWorkspace.slug}/agent/sessions`,
          otherWorkspaceKey.key,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: 'Other workspace cursor subject',
              audience: { kind: 'specific', memberUserIds: [] },
            }),
          },
        )
      ).json(),
    )
    const crossWorkspace = await authedWith(
      app,
      `/v1/ws/${otherWorkspace.slug}/agent/sessions/${otherWorkspaceSession.snapshot.id}/audience?cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      otherWorkspaceKey.key,
    )
    expect(crossWorkspace.status).toBe(400)
    expect(await crossWorkspace.json()).toEqual({ error: 'invalid_cursor' })

    await convex.mutation('testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId: secondMembershipId,
      now: 3_000,
    })
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace.workspaceId,
      userId: secondViewer.user._id,
      role: 'viewer',
    })
    const restored = await authedWith(app, path, ownerKey.key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: [secondViewer.user._id] }),
    })
    expect(restored.status).toBe(200)
    const reboundGeneration = await authedWith(
      app,
      `${path}?limit=1&cursor=${encodeURIComponent(viewerCursor)}`,
      secondViewerKey.key,
    )
    expect(reboundGeneration.status).toBe(400)
    expect(await reboundGeneration.json()).toEqual({ error: 'invalid_cursor' })
  })
})
