import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import {
  DUET_ACTOR_CONTEXT_HEADER,
  FileErrorSchema,
  INTERNAL_KEY,
  IntegrationAgentPolicyResponseSchema,
  IntegrationConnectResponseSchema,
  IntegrationConnectionListSchema,
  app,
  authedWith,
  bootApiSuite,
  connection,
  convex,
  createApiApp,
  createBackendAgentSession,
  grantCredits,
  integrationProviderFixture,
  issueKey,
  humanWorkspaceFixture,
  mintBrowserSession,
  mintHumanDeviceKey,
  mutate,
  owner,
  prepareWorkspaceForHttpRegistration,
  provisionRegisteredWorkspace,
  query,
  renderAccessMatrix,
  resetApiSuiteBetweenTests,
  skillsFixtureCatalog,
  stopApiSuite,
  uniqueSlug,
  urlToUploadFilename,
  waitForRegisteredGateway,
  workspace,
} from './index-suite'
import type { IntegrationConnection, RawApiKeyRow } from './index-suite'

// Train jobs and records, memory, the files proxy, uploads, connected providers, integrations.
// One topic slice of the api v1 suite; each slice file boots its own
// deployment through the shared kit in index-suite.ts.
describe('api v1: train, files, and integrations', () => {
  beforeAll(bootApiSuite, 240_000)
  afterAll(stopApiSuite)
  afterEach(resetApiSuiteBetweenTests)

  test('connected-provider routes require a workspace member and validate provider ids', async () => {
    expect(
      (
        await app.request(`/v1/ws/${workspace.slug}/connected-providers/openai-codex/connect`, {
          method: 'POST',
        })
      ).status,
    ).toBe(401)

    const browserKey = await mintBrowserSession(owner.client)
    const invalid = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/connected-providers/not-a-provider/connect`,
      browserKey,
      { method: 'POST' },
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_request' })
  })

  test('connected-provider poll passes through once and stamps the authenticated actor', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('cp-poll'))
    const browserKey = await mintBrowserSession(owner.client)
    const gatewayRequests: Array<{ pathname: string; authorization: string | null }> = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        const url = new URL(String(input))
        gatewayRequests.push({
          pathname: url.pathname,
          authorization: new Headers(init?.headers).get('authorization'),
        })
        return Response.json({
          status: 'connected',
          connection: {
            provider: 'openai-codex',
            state: 'connected',
            connectedAt: 170_000,
            eligibilityCheckedAt: 170_100,
          },
        })
      },
    })

    const polled = await authedWith(
      routeApp,
      `/v1/ws/${vm.slug}/connected-providers/connect/session-1`,
      browserKey,
    )
    expect(polled.status).toBe(200)
    expect(await polled.json()).toEqual({
      status: 'connected',
      connection: {
        provider: 'openai-codex',
        state: 'connected',
        connectedAt: 170_000,
        eligibilityCheckedAt: 170_100,
      },
    })
    expect(gatewayRequests).toEqual([
      {
        pathname: '/v1/connected-providers/connect/session-1',
        authorization: `Bearer ${vm.vmToken}`,
      },
    ])

    const listed = await authedWith(routeApp, `/v1/ws/${vm.slug}/connected-providers`, browserKey)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual([
      expect.objectContaining({
        provider: 'openai-codex',
        state: 'connected',
        connectedByUserId: owner.user._id,
        connectedByLabel: owner.user.email,
        canDisconnect: true,
      }),
    ])
  })

  test('connected-provider routes distinguish an unavailable workspace VM', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('cp-unavail'))
    const browserKey = await mintBrowserSession(owner.client)
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => {
        throw new TypeError('workspace VM is asleep')
      },
    })

    const response = await authedWith(
      routeApp,
      `/v1/ws/${vm.slug}/connected-providers/openai-codex/connect`,
      browserKey,
      { method: 'POST' },
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'workspace_vm_unavailable' })
  })

  test('files proxy enforces scopes and streams range and etag headers through the gateway', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('files-proxy'))
    const readKey = await issueKey(
      (await humanWorkspaceFixture(proxied.workspaceId, 'viewer')).client,
    )
    const writeKey = await issueKey(owner.client)
    const memoryKey = await issueKey(
      (await humanWorkspaceFixture(proxied.workspaceId, null)).client,
    )
    const gatewayRequests: Array<{
      url: string
      method: string
      headers: Headers
      bodyText?: string
    }> = []
    const proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 123_000,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        const bodyText =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : typeof init?.body === 'string'
              ? init.body
              : undefined
        gatewayRequests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers,
          bodyText,
        })
        if (init?.method === 'PUT' && bodyText === 'trigger storage full') {
          return Response.json({ error: 'storage_full' }, { status: 507 })
        }
        if (init?.method === 'HEAD') {
          return new Response(null, {
            headers: {
              'accept-ranges': 'bytes',
              'content-length': '10',
              'cache-control': 'private, max-age=31536000, immutable',
              'content-security-policy': 'sandbox',
              etag: '"gateway-etag"',
              'content-type': 'application/octet-stream',
              'x-content-type-options': 'nosniff',
            },
          })
        }
        if (init?.method === 'GET') {
          return new Response('cdef', {
            status: 206,
            headers: {
              'accept-ranges': 'bytes',
              'content-range': 'bytes 2-5/10',
              'cache-control': 'private, max-age=31536000, immutable',
              'content-security-policy': 'sandbox',
              etag: '"gateway-etag"',
              'content-type': 'application/octet-stream',
              'x-content-type-options': 'nosniff',
            },
          })
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { etag: '"written-etag"', 'content-type': 'application/json' },
        })
      },
    })

    expect((await proxyApp.request(`/v1/ws/${proxied.slug}/files/docs/a.txt`)).status).toBe(401)
    const insufficientRead = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/docs/a.txt`,
      memoryKey.key,
    )
    expect(insufficientRead.status).toBe(403)
    expect(await insufficientRead.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${proxied.slug}:files:read`,
    })

    const read = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/docs/a.txt?v=123`,
      readKey.key,
      {
        headers: {
          range: 'bytes=2-5',
          'if-none-match': '"client-etag"',
          'sec-fetch-dest': 'image',
        },
      },
    )
    expect(read.status).toBe(206)
    expect(read.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(read.headers.get('etag')).toBe('"gateway-etag"')
    expect(read.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(read.headers.get('content-security-policy')).toBe('sandbox')
    expect(read.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await read.text()).toBe('cdef')

    const head = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/docs/a.txt?v=123`,
      readKey.key,
      { method: 'HEAD' },
    )
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect(head.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(await head.arrayBuffer()).toHaveLength(0)

    const insufficientWrite = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/docs/a.txt`,
      readKey.key,
      {
        method: 'PUT',
        body: 'blocked',
      },
    )
    expect(insufficientWrite.status).toBe(403)
    expect(await insufficientWrite.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${proxied.slug}:files:write`,
    })

    const write = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/docs/a.txt`,
      writeKey.key,
      {
        method: 'PUT',
        headers: { 'if-match': '"gateway-etag"', 'content-type': 'text/plain' },
        body: 'updated body',
      },
    )
    expect(write.status).toBe(200)
    expect(write.headers.get('etag')).toBe('"written-etag"')

    const actionBody = JSON.stringify({
      operation: 'move',
      source: 'docs/a.txt',
      destination: 'docs/b.txt',
    })
    const insufficientAction = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/actions`,
      readKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: actionBody,
      },
    )
    expect(insufficientAction.status).toBe(403)
    const action = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/actions`,
      writeKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: actionBody,
      },
    )
    expect(action.status).toBe(200)

    expect(gatewayRequests).toHaveLength(4)
    expect(gatewayRequests[0]!.url).toBe('https://gateway-proxy.exe.xyz/v1/files/docs/a.txt?v=123')
    expect(gatewayRequests[0]!.headers.get('authorization')).toBe(`Bearer ${proxied.vmToken}`)
    expect(gatewayRequests[0]!.headers.get('range')).toBe('bytes=2-5')
    expect(gatewayRequests[0]!.headers.get('if-none-match')).toBe('"client-etag"')
    expect(gatewayRequests[0]!.headers.get('sec-fetch-dest')).toBe('image')
    expect(gatewayRequests[1]!.method).toBe('HEAD')
    expect(gatewayRequests[1]!.bodyText).toBeUndefined()
    expect(gatewayRequests[2]!.method).toBe('PUT')
    expect(gatewayRequests[2]!.headers.get('if-match')).toBe('"gateway-etag"')
    expect(gatewayRequests[2]!.headers.get('content-type')).toBe('text/plain')
    expect(gatewayRequests[2]!.bodyText).toBe('updated body')
    expect(gatewayRequests[3]!.url).toBe('https://gateway-proxy.exe.xyz/v1/files/actions')
    expect(gatewayRequests[3]!.method).toBe('POST')
    expect(gatewayRequests[3]!.headers.get('content-type')).toBe('application/json')
    expect(gatewayRequests[3]!.bodyText).toBe(actionBody)

    const storageFull = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/docs/full.txt`,
      writeKey.key,
      { method: 'PUT', body: 'trigger storage full' },
    )
    expect(storageFull.status).toBe(507)
    expect(FileErrorSchema.parse(await storageFull.json())).toEqual({ error: 'storage_full' })

    let markUpstreamStarted: (() => void) | undefined
    const upstreamStarted = new Promise<void>(resolve => {
      markUpstreamStarted = resolve
    })
    let upstreamObservedAbort = false
    const cancellationApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        markUpstreamStarted?.()
        return await new Promise<Response>(resolve => {
          const missingSignal = setTimeout(() => resolve(new Response(null)), 250)
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(missingSignal)
              upstreamObservedAbort = true
              resolve(new Response(null, { status: 499 }))
            },
            { once: true },
          )
        })
      },
    })
    const controller = new AbortController()
    const cancelled = authedWith(
      cancellationApp,
      `/v1/ws/${proxied.slug}/files/docs/a.txt`,
      readKey.key,
      { signal: controller.signal },
    )
    await upstreamStarted
    controller.abort()
    expect((await cancelled).status).toBe(499)
    expect(upstreamObservedAbort).toBe(true)
  })

  test('file transfer endpoints return one flat read resource and one direct upload grant', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('file-transfers'))
    const readKey = await issueKey(
      (await humanWorkspaceFixture(proxied.workspaceId, 'viewer')).client,
    )
    const writeKey = await issueKey(owner.client)
    const gatewayRequests: Array<{
      url: string
      method: string
      headers: Headers
      body?: unknown
    }> = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        const request = {
          url: String(input),
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        }
        gatewayRequests.push(request)
        if (request.method === 'HEAD') {
          return new Response(null, {
            headers: { 'content-type': 'application/pdf', 'content-length': '13' },
          })
        }
        if (request.body?.kind === 'download') {
          return Response.json({
            downloadPath: '/v1/files/docs/report%20one.pdf?grant=read-token',
            expiresAt: 901_000,
          })
        }
        return Response.json({
          uploadPath: '/v1/files/mcp/generated-media',
          uploadToken: 'upload-token',
          expiresAt: 901_000,
        })
      },
    })

    const download = await authedWith(
      routeApp,
      `/v1/ws/${proxied.slug}/file-downloads`,
      readKey.key,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [DUET_ACTOR_CONTEXT_HEADER]: 'session:spoofed',
        },
        body: JSON.stringify({ path: 'docs/report one.pdf' }),
      },
    )
    expect(download.status).toBe(200)
    expect(await download.json()).toEqual({
      uri: 'https://gateway-proxy.exe.xyz/v1/files/docs/report%20one.pdf?grant=read-token',
      name: 'docs/report one.pdf',
      mimeType: 'application/pdf',
      size: 13,
    })

    const upload = await authedWith(routeApp, `/v1/ws/${proxied.slug}/file-uploads`, writeKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pathPrefix: 'mcp/generated-media' }),
    })
    expect(upload.status).toBe(200)
    expect(await upload.json()).toEqual({
      vmBaseUrl: 'https://gateway-proxy.exe.xyz/',
      uploadPath: '/v1/files/mcp/generated-media',
      uploadToken: 'upload-token',
      expiresAt: 901_000,
    })

    const readCannotWrite = await authedWith(
      routeApp,
      `/v1/ws/${proxied.slug}/file-uploads`,
      readKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pathPrefix: 'mcp/generated-media' }),
      },
    )
    expect(readCannotWrite.status).toBe(403)
    expect(gatewayRequests).toHaveLength(3)
    const keyRows = (await convex.query('testing/apiKeys:rawApiKeysForTest', {
      internalKey: INTERNAL_KEY,
    })) as RawApiKeyRow[]
    const readKeyRow = keyRows.find(candidate => candidate.prefix === readKey.prefix)!
    const writeKeyRow = keyRows.find(candidate => candidate.prefix === writeKey.prefix)!
    expect(gatewayRequests[0]!.headers.get(DUET_ACTOR_CONTEXT_HEADER)).toBe(
      `api-key:${readKeyRow._id}`,
    )
    expect([...gatewayRequests[1]!.headers]).toEqual([])
    expect(gatewayRequests[2]!.headers.get(DUET_ACTOR_CONTEXT_HEADER)).toBe(
      `api-key:${writeKeyRow._id}`,
    )
  })

  test('files proxy preserves raw percent suffixes and literal action paths', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('files-percent-proxy'))
    const readKey = await issueKey(owner.client)
    const writeKey = await issueKey(owner.client)
    const gatewayRequests: Array<{ url: string; body?: string }> = []
    const proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (input, init) => {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : typeof init?.body === 'string'
              ? init.body
              : undefined
        gatewayRequests.push({ url: String(input), body })
        return init?.method === 'POST'
          ? Response.json({ ok: true, affectedEntries: 1 })
          : new Response('fixture')
      },
    })

    const literalPercent = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/100%25.pdf`,
      readKey.key,
    )
    const encodedSlash = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/a%252Fb`,
      readKey.key,
    )
    const actionBody = JSON.stringify({
      operation: 'move',
      source: '100%.pdf',
      destination: 'a%2Fb',
    })
    const action = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/actions`,
      writeKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: actionBody,
      },
    )

    expect([literalPercent.status, encodedSlash.status, action.status]).toEqual([200, 200, 200])
    expect(gatewayRequests).toEqual([
      { url: 'https://gateway-proxy.exe.xyz/v1/files/100%25.pdf', body: undefined },
      { url: 'https://gateway-proxy.exe.xyz/v1/files/a%252Fb', body: undefined },
      {
        url: 'https://gateway-proxy.exe.xyz/v1/files/actions',
        body: actionBody,
      },
    ])
  })

  test('files proxy synthesizes the actor header and never forwards a client-supplied one', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('actor-header'))
    const readKey = await issueKey(owner.client)
    const sessionToken = await mintBrowserSession(owner.client)
    const gatewayRequests: Array<{ headers: Headers }> = []
    const proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async (_input, init) => {
        gatewayRequests.push({ headers: new Headers(init?.headers) })
        return new Response('payload', {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            etag: '"gateway-etag"',
            // A hostile/buggy gateway echoing the actor header must not
            // leak it into the API response.
            [DUET_ACTOR_CONTEXT_HEADER]: 'session:evil-response',
          },
        })
      },
    })

    // An api key attributes as api-key:<credential doc id>; the spoofed
    // client header never reaches the gateway.
    const spoofed = { [DUET_ACTOR_CONTEXT_HEADER]: 'session:evil' }
    const viaApiKey = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/docs/a.txt`,
      readKey.key,
      { headers: spoofed },
    )
    expect(viaApiKey.status).toBe(200)
    expect(viaApiKey.headers.get(DUET_ACTOR_CONTEXT_HEADER)).toBeNull()
    const keyRows = (await convex.query('testing/apiKeys:rawApiKeysForTest', {
      internalKey: INTERNAL_KEY,
    })) as RawApiKeyRow[]
    const keyRow = keyRows.find(candidate => candidate.prefix === readKey.prefix)!
    expect(gatewayRequests[0]!.headers.get(DUET_ACTOR_CONTEXT_HEADER)).toBe(`api-key:${keyRow._id}`)

    // A browser session attributes as web:<userId>.
    const viaSession = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/docs/a.txt`,
      sessionToken,
      { headers: spoofed },
    )
    expect(viaSession.status).toBe(200)
    expect(gatewayRequests[1]!.headers.get(DUET_ACTOR_CONTEXT_HEADER)).toBe(`web:${owner.user._id}`)

    // An impersonated visit is that same person browsing: the drive must show
    // their touches as theirs, not as some key's.
    const impersonation = (await convex.mutation('domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email: owner.user.email,
      workspaceSlug: proxied.slug,
      ttlSeconds: 60,
      now: Date.now(),
    })) as { token: string }
    const viaVisit = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/docs/a.txt`,
      impersonation.token,
      { headers: spoofed },
    )
    expect(viaVisit.status).toBe(200)
    expect(gatewayRequests[2]!.headers.get(DUET_ACTOR_CONTEXT_HEADER)).toBe(`web:${owner.user._id}`)

    // Device login issues a human key; ordinary file calls retain key attribution.
    const deviceKey = await mintHumanDeviceKey('Actor Matrix Mac')
    const viaDeviceLogin = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/files/docs/a.txt`,
      deviceKey,
      { headers: spoofed },
    )
    expect(viaDeviceLogin.status).toBe(200)
    const deviceRows = (await convex.query('testing/apiKeys:rawApiKeysForTest', {
      internalKey: INTERNAL_KEY,
    })) as RawApiKeyRow[]
    const deviceRow = deviceRows.find(
      candidate => candidate.prefix === deviceKey.slice(0, 'duet_sk_'.length + 8),
    )!
    expect(gatewayRequests[3]!.headers.get(DUET_ACTOR_CONTEXT_HEADER)).toBe(
      `api-key:${deviceRow._id}`,
    )

    // The spoofed value appears nowhere in any forwarded header.
    for (const request of gatewayRequests) {
      for (const [, value] of request.headers) expect(value).not.toBe('session:evil')
    }

    // Proxies without an actor (memory) send no actor header at all, even
    // when the client supplies one.
    const viaMemory = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/memories/search?q=x`,
      sessionToken,
      { headers: spoofed },
    )
    expect(viaMemory.status).toBe(200)
    expect(gatewayRequests[4]!.headers.get(DUET_ACTOR_CONTEXT_HEADER)).toBeNull()
  })

  test('agent train resolves the public slug to its anchor before proxying', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-train-resolve'))
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { anchorId: string }
    const memoryKey = await issueKey(owner.client)
    const gatewayUrls: string[] = []
    const trainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        gatewayUrls.push(String(input))
        const cursor = new URL(String(input)).searchParams.get('cursor')
        return Response.json({
          items:
            cursor === null
              ? [{ filename: 'a.txt', size: 1, uploadedAt: 1 }]
              : [{ filename: 'b.txt', size: 1, uploadedAt: 2 }],
          nextCursor: cursor === null ? 'gateway-next' : null,
          meta: { totalBytes: 2, fileCount: 2, capBytes: 1024, running: false },
        })
      },
    })

    const response = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/agents/research/train/uploads`,
      memoryKey.key,
    )

    expect(response.status).toBe(200)
    const first = (await response.json()) as { items: unknown[]; nextCursor: string }
    expect(first.items).toHaveLength(1)
    const wrongScope = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/train/uploads?cursor=${encodeURIComponent(first.nextCursor)}`,
      memoryKey.key,
    )
    expect(wrongScope.status).toBe(400)
    const second = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/agents/research/train/uploads?cursor=${encodeURIComponent(first.nextCursor)}`,
      memoryKey.key,
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      items: [{ filename: 'b.txt' }],
      nextCursor: null,
    })
    expect(gatewayUrls).toEqual([
      `https://gateway-proxy.exe.xyz/v1/train/agents/${agent.anchorId}/uploads?limit=50`,
      `https://gateway-proxy.exe.xyz/v1/train/agents/${agent.anchorId}/uploads?limit=50&cursor=gateway-next`,
    ])
  })

  test('agent upload sessions return the scoped upload path minted by the gateway', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-train-upload-session'))
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { anchorId: string }
    const memoryKey = await issueKey(owner.client)
    const scopedUploadPath = `/v1/train/agents/${agent.anchorId}/uploads`
    const gatewayUrls: string[] = []
    const trainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 5_000,
      fetch: async input => {
        gatewayUrls.push(String(input))
        return Response.json({
          uploadPath: scopedUploadPath,
          uploadToken: 'agent-upload-token',
          expiresAt: 905_000,
        })
      },
    })

    const response = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/agents/research/train/uploads/session`,
      memoryKey.key,
      { method: 'POST' },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      vmBaseUrl: 'https://gateway-proxy.exe.xyz/',
      uploadPath: scopedUploadPath,
      uploadToken: 'agent-upload-token',
      expiresAt: 905_000,
    })
    expect(gatewayUrls).toEqual([
      `https://gateway-proxy.exe.xyz/v1/train/agents/${agent.anchorId}/upload-token`,
    ])
  })

  test('brokers direct-upload credentials and proxies upload metadata with files-grade headers', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-uploads'))
    const memberKey = await issueKey(owner.client)
    const memoryKey = await issueKey(owner.client)
    const gatewayRequests: Array<{ url: string; method: string; headers: Headers }> = []
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 5_000,
      fetch: async (input, init) => {
        gatewayRequests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
        })
        if (String(input).endsWith('/v1/train/upload-token')) {
          return Response.json({
            uploadPath: '/v1/train/uploads',
            uploadToken: 'upload-token',
            expiresAt: 905_000,
          })
        }
        if (init?.method === 'DELETE') return Response.json({ ok: true })
        return Response.json({
          items: [],
          nextCursor: null,
          meta: { totalBytes: 0, fileCount: 0, capBytes: 1024, running: false },
        })
      },
    })

    const session = await authedWith(
      app,
      `/v1/ws/${proxied.slug}/train/uploads/session`,
      memberKey.key,
      { method: 'POST' },
    )
    expect(session.status).toBe(200)
    expect(await session.json()).toEqual({
      vmBaseUrl: 'https://gateway-proxy.exe.xyz/',
      uploadPath: '/v1/train/uploads',
      uploadToken: 'upload-token',
      expiresAt: 905_000,
    })

    const list = await authedWith(app, `/v1/ws/${proxied.slug}/train/uploads`, memoryKey.key, {
      headers: { range: 'bytes=0-1', 'if-none-match': 'etag-list' },
    })
    const removed = await authedWith(
      app,
      `/v1/ws/${proxied.slug}/train/uploads/source.md`,
      memoryKey.key,
      { method: 'DELETE', headers: { 'if-match': 'etag-delete' } },
    )
    expect(list.status).toBe(200)
    expect(removed.status).toBe(200)
    expect(gatewayRequests.map(request => [request.method, request.url])).toEqual([
      ['POST', 'https://gateway-proxy.exe.xyz/v1/train/upload-token'],
      ['GET', 'https://gateway-proxy.exe.xyz/v1/train/uploads?limit=50'],
      ['DELETE', 'https://gateway-proxy.exe.xyz/v1/train/uploads/source.md'],
    ])
    expect(gatewayRequests[1]!.headers.get('range')).toBeNull()
    expect(gatewayRequests[1]!.headers.get('if-none-match')).toBeNull()
    expect(gatewayRequests[2]!.headers.get('if-match')).toBe('etag-delete')
  })

  test('a retrain target reaches the gateway in the proxied start body', async () => {
    // The start route rebuilds its body rather than forwarding the caller's, so
    // every field the contract gains has to be added here too. Dropping this
    // one does not fail loudly: the gateway derives a fresh slug and the user
    // gets a SECOND memory while being told theirs was replaced.
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-target-slug'))
    const memoryKey = await issueKey(owner.client)
    let startBody: string | undefined
    const startApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 5_100,
      fetch: async (input, init) => {
        if (String(input).endsWith('/v1/train') && (init?.method ?? 'GET') === 'POST') {
          startBody = typeof init?.body === 'string' ? init.body : undefined
          return Response.json({ jobId: 'job_1' }, { status: 202 })
        }
        return Response.json({ files: [], totalBytes: 0, capBytes: 1, running: false })
      },
    })

    await authedWith(startApp, `/v1/ws/${proxied.slug}/train`, memoryKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetSlug: 'train-2026-08-17-abcd1234' }),
    })

    expect(startBody).toBeDefined()
    expect(JSON.parse(startBody!)).toMatchObject({ targetSlug: 'train-2026-08-17-abcd1234' })
  })

  test('restage re-scrapes what it can and keeps the archived copy of what it cannot', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-restage'))
    const memoryKey = await issueKey(owner.client)
    const fresh = 'https://example.com/fresh'
    const gone = 'https://example.com/gone'
    const putBodies = new Map<string, string>()
    let uploadListReads = 0
    const restageApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 5_100,
      firecrawlKey: 'firecrawl-key',
      fetch: async (input, init) => {
        const url = String(input)
        if (url === 'https://api.firecrawl.dev/v2/scrape') {
          const requested = JSON.parse(String(init?.body)) as { url: string }
          // The page that 404s is the whole point: its archived copy has to
          // survive, or "reload my sources" becomes "you have no sources".
          if (requested.url === gone) return Response.json({ error: 'not found' }, { status: 404 })
          return Response.json({
            success: true,
            data: { markdown: '# Fresh today', metadata: { title: 'Fresh' } },
          })
        }
        if (url.endsWith('/restage'))
          return Response.json({ staged: 2, rescraped: 0, fellBack: [], urls: [fresh, gone] })
        if ((init?.method ?? 'GET') === 'GET') {
          uploadListReads += 1
          return Response.json({ error: 'unexpected_upload_list' }, { status: 500 })
        }
        putBodies.set(url, typeof init?.body === 'string' ? init.body : '')
        return Response.json({ file: { filename: 'x', size: 1, uploadedAt: 1 } }, { status: 201 })
      },
    })

    const response = await authedWith(
      restageApp,
      `/v1/ws/${proxied.slug}/train/records/some-memory/restage`,
      memoryKey.key,
      { method: 'POST' },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ staged: 2, rescraped: 1, fellBack: [gone] })
    // Only the reachable page was rewritten. The 404'd one was never PUT, so
    // the archived copy the gateway staged is still what sits in the inbox —
    // assert the absence, because a PUT of empty bytes would keep the same
    // file count while destroying the content.
    const written = [...putBodies.keys()].filter(url => url.includes('/uploads/'))
    expect(written).toHaveLength(1)
    expect(written[0]).toContain(urlToUploadFilename(fresh).slice(0, 20))
    expect([...putBodies.values()].join('')).toContain('# Fresh today')
    expect(uploadListReads).toBe(0)
  })

  test('adds a scraped URL to the train inbox through the server-side gateway PUT', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-url-upload'))
    const outsiderKey = await issueKey((await humanWorkspaceFixture(proxied.workspaceId, null)).client)
    const memoryKey = await issueKey(owner.client)
    const gatewayRequests: Array<{ url: string; method: string; headers: Headers; body?: string }> =
      []
    let firecrawlRequests = 0
    const uploadedAt = 5_100
    const url = 'https://example.com/handbook'
    const urlApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => uploadedAt,
      firecrawlKey: 'firecrawl-key',
      fetch: async (input, init) => {
        if (String(input) === 'https://api.firecrawl.dev/v2/scrape') {
          firecrawlRequests += 1
          return Response.json({
            success: true,
            data: { markdown: '# Handbook', metadata: { title: 'The Handbook' } },
          })
        }
        if ((init?.method ?? 'GET') === 'GET') {
          gatewayRequests.push({
            url: String(input),
            method: 'GET',
            headers: new Headers(init?.headers),
          })
          return Response.json({
            files: [],
            totalBytes: 0,
            capBytes: 1_073_741_824,
            running: false,
          })
        }
        const body = typeof init?.body === 'string' ? init.body : undefined
        gatewayRequests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
          body,
        })
        return Response.json(
          {
            file: {
              filename: 'url-example-com-handbook-47011408.md',
              size: new TextEncoder().encode(body).byteLength,
              uploadedAt,
              url,
            },
          },
          { status: 201 },
        )
      },
    })

    expect(
      (await urlApp.request(`/v1/ws/${proxied.slug}/train/uploads/url`, { method: 'POST' })).status,
    ).toBe(401)
    const denied = await authedWith(
      urlApp,
      `/v1/ws/${proxied.slug}/train/uploads/url`,
      outsiderKey.key,
      { method: 'POST', body: JSON.stringify({ url }) },
    )
    expect(denied.status).toBe(403)
    const malformed = await authedWith(
      urlApp,
      `/v1/ws/${proxied.slug}/train/uploads/url`,
      memoryKey.key,
      { method: 'POST', body: JSON.stringify({ url: 'not a URL' }) },
    )
    expect(malformed.status).toBe(400)
    expect(firecrawlRequests).toBe(0)
    expect(gatewayRequests).toHaveLength(0)

    const response = await authedWith(
      urlApp,
      `/v1/ws/${proxied.slug}/train/uploads/url`,
      memoryKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      },
    )

    expect(response.status).toBe(201)
    expect(firecrawlRequests).toBe(1)
    expect(await response.json()).toEqual({
      filename: 'url-example-com-handbook-47011408.md',
      size: new TextEncoder().encode(gatewayRequests[1]!.body).byteLength,
      uploadedAt,
      url,
    })
    expect(gatewayRequests).toHaveLength(2)
    expect(gatewayRequests.map(request => request.method)).toEqual(['GET', 'PUT'])
    expect(gatewayRequests[0]!.url).toBe('https://gateway-proxy.exe.xyz/v1/train/uploads')
    expect(gatewayRequests[1]!.url).toBe(
      'https://gateway-proxy.exe.xyz/v1/train/uploads/url-example-com-handbook-47011408.md',
    )
    expect(gatewayRequests[1]!.headers.get('authorization')).toBe(`Bearer ${proxied.vmToken}`)
    expect(gatewayRequests[1]!.headers.get('x-duet-train-source-url')).toBe(url)
    expect(gatewayRequests[1]!.body).toContain('url: "https://example.com/handbook"')
    expect(gatewayRequests[1]!.body).toContain('# Handbook')
  })

  test('checks the workspace gateway before spending a Firecrawl request', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-url-offline'))
    const memoryKey = await issueKey(owner.client)
    let firecrawlRequests = 0
    const urlApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      firecrawlKey: 'firecrawl-key',
      fetch: async input => {
        if (String(input) === 'https://api.firecrawl.dev/v2/scrape') firecrawlRequests += 1
        return Response.json({ error: 'gateway_unavailable' }, { status: 503 })
      },
    })

    const response = await authedWith(
      urlApp,
      `/v1/ws/${proxied.slug}/train/uploads/url`,
      memoryKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/offline' }),
      },
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'gateway_unavailable' })
    expect(firecrawlRequests).toBe(0)
  })

  test('concurrent integration connects share one provider idempotency key', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('integration-concurrent'))
    const key = await issueKey(owner.client)
    const seen = new Set<string>()
    const attempts: string[] = []
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      appUrl: 'http://localhost:3000',
      integrationProvider: integrationProviderFixture({
        listConnections: async () => ({ items: [], nextCursor: null }),
        beginConnection: async args => {
          attempts.push(args.label)
          if (seen.has(args.label)) throw new Error('integration_already_connected')
          seen.add(args.label)
          return { authorizeUrl: 'https://provider.example/authorize' }
        },
      }),
    })
    const request = () =>
      authedWith(app, `/v1/ws/${workspace.slug}/integrations/connect`, key.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          integration: 'gmail',
          redirectTo: `/w/${workspace.slug}/computer/integrations`,
        }),
      })

    const responses = await Promise.all([request(), request()])

    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    expect(attempts).toEqual([`${workspace.workspaceId}:gmail`, `${workspace.workspaceId}:gmail`])
  })

  test('a VM refreshes the current integration projection for its own sleeping session', async () => {
    const scoped = await provisionRegisteredWorkspace(uniqueSlug('integration-wake-refresh'))
    await grantCredits(scoped.workspaceId, 'grant:integration-wake-refresh')
    await waitForRegisteredGateway(scoped.vmToken)
    const session = await createBackendAgentSession(scoped.workspaceId, 'sleep first')
    await mutate(owner.client, 'domains/integrations/model:setIntegrationAgentPolicy', {
      internalKey: INTERNAL_KEY,
      workspaceId: scoped.workspaceId,
      toolkitSlug: 'github',
      allowedAgentIds: [],
    })
    const integrationApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      env: { COMPOSIO_API_KEY: 'test-composio-key' },
      composioMcpProvider: {
        createToolRouterSession: async () => ({
          providerSessionId: 'provider-wake-refresh',
          mcp: { type: 'http', url: 'https://mcp.example/wake-refresh' },
        }),
        useToolRouterSession: async ({ providerSessionId }) => ({
          providerSessionId,
          mcp: { type: 'http', url: 'https://mcp.example/wake-refresh' },
        }),
        updateToolRouterSession: async () => undefined,
        deleteToolRouterSession: async () => undefined,
      },
    })

    const refreshed = await integrationApp.request(
      `/v1/vm/agent/sessions/${session.sessionId}/integrations`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${scoped.vmToken}` },
      },
    )
    expect(refreshed.status).toBe(200)
    const body = (await refreshed.json()) as { integrations?: true }
    expect(body.integrations).toBe(true)
    expect(
      await convex.query('testing/agentSessions:toolRouterConfigsForSessionForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: scoped.workspaceId,
        sessionId: session.sessionId,
      }),
    ).toEqual([
      expect.objectContaining({
        disabledToolkitSlugs: ['github'],
        providerSessionId: 'provider-wake-refresh',
      }),
    ])

    const foreign = await provisionRegisteredWorkspace(uniqueSlug('integration-wake-foreign'))
    await grantCredits(foreign.workspaceId, 'grant:integration-wake-foreign')
    await waitForRegisteredGateway(foreign.vmToken)
    const rejected = await integrationApp.request(
      `/v1/vm/agent/sessions/${session.sessionId}/integrations`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${foreign.vmToken}` },
      },
    )
    expect(rejected.status).toBe(404)
    expect(await rejected.json()).toEqual({ error: 'not_found' })
  })

  // D16's blast radius: the two kinds of MCP server share one refresh call and
  // nothing else. A Composio outage omits its own half — which is also how this
  // response says "no integrations this turn" — and still hands the waking
  // session the custom servers the workspace registered.
  test('a provider failure omits integrations without taking custom MCP servers down', async () => {
    const scoped = await provisionRegisteredWorkspace(uniqueSlug('integration-wake-unavailable'))
    await grantCredits(scoped.workspaceId, 'grant:integration-wake-unavailable')
    await waitForRegisteredGateway(scoped.vmToken)
    const session = await createBackendAgentSession(scoped.workspaceId, 'sleep without provider')
    await mutate(owner.client, 'domains/mcpServers/model:registerMcpServer', {
      internalKey: INTERNAL_KEY,
      workspaceId: scoped.workspaceId,
      actorId: owner.user._id,
      name: 'notes',
      url: 'https://notes.example/mcp',
      authKind: 'none',
    })
    const integrationApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      composioMcpProvider: {
        createToolRouterSession: async () => {
          throw new Error('provider unavailable')
        },
        useToolRouterSession: async () => {
          throw new Error('unexpected use')
        },
        updateToolRouterSession: async () => {
          throw new Error('unexpected update')
        },
        deleteToolRouterSession: async () => undefined,
      },
    })

    const response = await integrationApp.request(
      `/v1/vm/agent/sessions/${session.sessionId}/integrations`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${scoped.vmToken}` },
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mcpServers: [{ name: 'notes' }] })
  })

  // The VM owns the credential store, and it can change from a workspace
  // terminal without the control plane hearing about it. So the list route
  // asks the VM at read time and folds the answer into the stored rows —
  // a row that says "connected" must not survive the VM saying otherwise.
  test('listing connected providers reads the VM and folds the answer in', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('cp-live'))
    const browserKey = await mintBrowserSession(owner.client)
    let vmConnections: unknown[] = [
      {
        provider: 'openai-codex',
        state: 'connected',
        connectedAt: 100,
        eligibilityCheckedAt: 110,
      },
    ]
    let reachable = true
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        if (!reachable) throw new Error('vm unreachable')
        const url = new URL(String(input))
        if (url.pathname === '/v1/connected-providers') return Response.json(vmConnections)
        return Response.json({ error: 'unexpected' }, { status: 404 })
      },
      approvedModelCatalog: skillsFixtureCatalog(),
    })

    const first = await authedWith(routeApp, `/v1/ws/${vm.slug}/connected-providers`, browserKey)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual([
      expect.objectContaining({ provider: 'openai-codex', state: 'connected' }),
    ])

    // Disconnected out of band: the next read must see it, not the stored row.
    vmConnections = []
    const second = await authedWith(routeApp, `/v1/ws/${vm.slug}/connected-providers`, browserKey)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual([
      expect.objectContaining({ provider: 'openai-codex', state: 'reconnect_needed' }),
    ])

    // An unreachable VM costs freshness, never the page.
    reachable = false
    const offline = await authedWith(routeApp, `/v1/ws/${vm.slug}/connected-providers`, browserKey)
    expect(offline.status).toBe(200)
    expect(await offline.json()).toEqual([
      expect.objectContaining({ provider: 'openai-codex', state: 'reconnect_needed' }),
    ])
  })

  test('memory proxy enforces memory scope and passes add and search through the gateway', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('memory-proxy'))
    const outsiderKey = await issueKey(
      (await humanWorkspaceFixture(proxied.workspaceId, null)).client,
    )
    const memoryKey = await issueKey(owner.client)
    const gatewayRequests: Array<{
      url: string
      method: string
      headers: Headers
      bodyText?: string
    }> = []
    const proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 456_000,
      fetch: async (input, init) => {
        const bodyText =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : typeof init?.body === 'string'
              ? init.body
              : undefined
        gatewayRequests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
          bodyText,
        })
        if (init?.method === 'POST') {
          return Response.json({
            id: 'mem_1',
            content: 'Enterprise discount cap is 20 percent',
            kind: 'note',
            source: 'api',
            priority: 'medium',
            createdAt: '2026-07-06T00:00:00.000Z',
            lastUsedAt: '2026-07-06T00:00:00.000Z',
            observedDate: '2026-07-06',
            tags: [],
          })
        }
        return Response.json({
          query: 'discount',
          limit: 10,
          results: [
            {
              id: 'mem_1',
              content: 'Enterprise discount cap is 20 percent',
              kind: 'note',
              source: 'api',
              priority: 'medium',
              relevanceScore: 1,
              createdAt: '2026-07-06T00:00:00.000Z',
              lastUsedAt: '2026-07-06T00:00:00.000Z',
              observedDate: '2026-07-06',
              tags: [],
            },
          ],
        })
      },
    })

    expect(
      (await proxyApp.request(`/v1/ws/${proxied.slug}/memories/search?q=discount`)).status,
    ).toBe(401)
    const insufficient = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/memories/search?q=discount`,
      outsiderKey.key,
    )
    expect(insufficient.status).toBe(403)
    expect(await insufficient.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${proxied.slug}:memory`,
    })

    const add = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/memories`, memoryKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Enterprise discount cap is 20 percent',
        source: 'api',
      }),
    })
    expect(add.status).toBe(200)
    expect(await add.json()).toMatchObject({ id: 'mem_1', source: 'api' })

    const search = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/memories/search?q=discount`,
      memoryKey.key,
    )
    expect(search.status).toBe(200)
    expect(await search.json()).toMatchObject({
      query: 'discount',
      results: [{ id: 'mem_1', relevanceScore: 1 }],
    })

    expect(gatewayRequests).toHaveLength(2)
    expect(gatewayRequests[0]!.url).toBe('https://gateway-proxy.exe.xyz/v1/memory')
    expect(gatewayRequests[0]!.method).toBe('POST')
    expect(gatewayRequests[0]!.headers.get('authorization')).toBe(`Bearer ${proxied.vmToken}`)
    expect(gatewayRequests[0]!.headers.get('content-type')).toBe('application/json')
    expect(gatewayRequests[0]!.bodyText).toBe(
      JSON.stringify({
        content: 'Enterprise discount cap is 20 percent',
        source: 'api',
      }),
    )
    expect(gatewayRequests[1]!.url).toBe(
      'https://gateway-proxy.exe.xyz/v1/memory/search?q=discount',
    )
    expect(gatewayRequests[1]!.method).toBe('GET')
  })

  test('maps one gateway memory-count response from anchor ids to public agent slugs', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-train-counts'))
    const research = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { anchorId: string }
    const support = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'agents/support',
      slug: 'support',
    })) as { anchorId: string }
    const outsiderKey = await issueKey(
      (await humanWorkspaceFixture(proxied.workspaceId, null)).client,
    )
    const trainKey = await issueKey(owner.client)
    const gatewayUrls: string[] = []
    const trainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        gatewayUrls.push(String(input))
        return Response.json({
          rootCount: 73,
          counts: {
            [research.anchorId]: 4,
            [support.anchorId]: null,
          },
          trainableAgents: [research.anchorId],
        })
      },
    })

    const denied = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/train/memory-counts`,
      outsiderKey.key,
    )
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${proxied.slug}:memory`,
    })
    expect(gatewayUrls).toEqual([])

    const response = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/train/memory-counts`,
      trainKey.key,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      rootCount: 73,
      counts: { research: 4, support: null },
      trainableAgents: ['research'],
    })
    expect(gatewayUrls).toEqual(['https://gateway-proxy.exe.xyz/v1/train/memory-counts'])
  })

  test('root and agent train job APIs isolate list and detail results', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-train-jobs'))
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { id: string; anchorId: string }
    const memoryKey = await issueKey(owner.client)
    const trainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 910_000,
      fetch: async input =>
        Response.json(
          {
            jobId: String(input).includes(`/agents/${agent.anchorId}`)
              ? 'agent-api-job'
              : 'root-api-job',
          },
          { status: 202 },
        ),
    })

    const rootStart = await authedWith(trainApp, `/v1/ws/${proxied.slug}/train`, memoryKey.key, {
      method: 'POST',
    })
    const agentStart = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/agents/research/train`,
      memoryKey.key,
      { method: 'POST' },
    )
    expect([rootStart.status, agentStart.status]).toEqual([202, 202])

    const rootList = await authedWith(trainApp, `/v1/ws/${proxied.slug}/train/jobs`, memoryKey.key)
    const agentList = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/agents/research/train/jobs`,
      memoryKey.key,
    )
    expect((await rootList.json()).items.map((job: { jobId: string }) => job.jobId)).toEqual([
      'root-api-job',
    ])
    expect((await agentList.json()).items).toMatchObject([
      { jobId: 'agent-api-job', agentId: agent.id },
    ])

    const rootCannotReadAgent = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/train/agent-api-job`,
      memoryKey.key,
    )
    const agentCannotReadRoot = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/agents/research/train/root-api-job`,
      memoryKey.key,
    )
    expect([rootCannotReadAgent.status, agentCannotReadRoot.status]).toEqual([404, 404])

    expect(
      await query(convex, 'testing/train:listRawForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: proxied.workspaceId,
      }),
    ).toContainEqual(
      expect.objectContaining({
        jobId: 'agent-api-job',
        agentId: agent.id,
        agentSlug: 'research',
      }),
    )
  })

  test('root record proxy stays byte-stable while agent records gain inherited owner slugs', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-train-record-owners'))
    const parent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'agents/parent',
      slug: 'parent',
    })) as { anchorId: string }
    const child = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'agents/parent/child',
      slug: 'child',
    })) as { anchorId: string }
    const memoryKey = await issueKey(owner.client)
    const summary = (slug: string) => ({
      slug,
      memoryId: `mem-${slug}`,
      createdAt: '2026-07-11T00:00:00Z',
      observedDate: '2026-07-11',
      hasArchive: false,
    })
    const rootBody = { items: [summary('root-own')], nextCursor: null }
    const trainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        const pathname = new URL(String(input)).pathname
        if (pathname === '/v1/train/records') return Response.json(rootBody)
        if (pathname === `/v1/train/agents/${child.anchorId}/records`) {
          return Response.json({
            items: [
              summary('child-own'),
              { ...summary('parent-memory'), inherited: true, ownerScope: parent.anchorId },
              { ...summary('root-memory'), inherited: true, ownerScope: 'root' },
            ],
            nextCursor: null,
          })
        }
        if (pathname === `/v1/train/agents/${child.anchorId}/records/parent-memory`) {
          return Response.json({
            record: {
              ...summary('parent-memory'),
              inherited: true,
              ownerScope: parent.anchorId,
              content: '# Parent memory',
            },
          })
        }
        throw new Error(`unexpected gateway path: ${pathname}`)
      },
    })

    const rootResponse = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/train/records`,
      memoryKey.key,
    )
    const agentResponse = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/agents/child/train/records`,
      memoryKey.key,
    )
    const detailResponse = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/agents/child/train/records/parent-memory`,
      memoryKey.key,
    )

    expect(await rootResponse.text()).toBe(JSON.stringify(rootBody))
    const agentBody = (await agentResponse.json()) as { items: Array<Record<string, unknown>> }
    expect(agentBody).toMatchObject({
      items: [
        { slug: 'child-own' },
        { slug: 'parent-memory', inherited: true, ownerAgentSlug: 'parent' },
        { slug: 'root-memory', inherited: true },
      ],
    })
    expect(agentBody.items[2]).not.toHaveProperty('ownerAgentSlug')
    expect(await detailResponse.json()).toMatchObject({
      record: { slug: 'parent-memory', ownerAgentSlug: 'parent' },
    })
  })

  test('inherited-409 conflicts translate owner anchors to public slugs and fail closed on skew', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-409'))
    const parent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'agents/parent',
      slug: 'parent',
    })) as { anchorId: string }
    const child = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: proxied.workspaceId,
      path: 'agents/parent/child',
      slug: 'child',
    })) as { anchorId: string }
    const memoryKey = await issueKey(owner.client)
    let ownerScope: string = parent.anchorId
    const conflictApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () =>
        Response.json({ error: 'inherited_record_read_only', ownerScope }, { status: 409 }),
    })

    const translated = await authedWith(
      conflictApp,
      `/v1/ws/${proxied.slug}/agents/child/train/records/parent-memory`,
      memoryKey.key,
      { method: 'DELETE' },
    )
    expect(translated.status).toBe(409)
    expect(await translated.json()).toEqual({
      error: 'inherited_record_read_only',
      ownerAgentSlug: 'parent',
    })

    ownerScope = 'anchor-that-no-agent-owns'
    const skewed = await authedWith(
      conflictApp,
      `/v1/ws/${proxied.slug}/agents/child/train/records/parent-memory`,
      memoryKey.key,
      { method: 'DELETE' },
    )
    expect(skewed.status).toBe(502)
    expect(await skewed.json()).toEqual({ error: 'gateway_failed' })
    void child
  })

  test('lets the authoritative upload store reject a 26th staged website', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-url-limit'))
    const memoryKey = await issueKey(owner.client)
    let firecrawlRequests = 0
    const urlApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      firecrawlKey: 'firecrawl-key',
      fetch: async (input, init) => {
        if (String(input) === 'https://api.firecrawl.dev/v2/scrape') {
          firecrawlRequests += 1
          return Response.json({ success: true, data: { markdown: '# Source 26' } })
        }
        if ((init?.method ?? 'GET') === 'GET') {
          return Response.json({ items: [], nextCursor: null })
        }
        return Response.json({ error: 'too_many_urls' }, { status: 413 })
      },
    })

    const response = await authedWith(
      urlApp,
      `/v1/ws/${proxied.slug}/train/uploads/url`,
      memoryKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/source-26' }),
      },
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'too_many_urls' })
    expect(firecrawlRequests).toBe(1)
  })

  test('refreshes an equivalent staged website spelling at the URL cap', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-url-refresh'))
    const memoryKey = await issueKey(owner.client)
    const requestedUrl = 'https://EXAMPLE.com'
    const filename = urlToUploadFilename(requestedUrl)
    let firecrawlRequests = 0
    const urlApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      firecrawlKey: 'firecrawl-key',
      fetch: async (input, init) => {
        if (String(input) === 'https://api.firecrawl.dev/v2/scrape') {
          firecrawlRequests += 1
          return Response.json({
            success: true,
            data: { markdown: '# Refreshed', metadata: { title: 'Example' } },
          })
        }
        const body = typeof init?.body === 'string' ? init.body : ''
        return Response.json(
          {
            file: {
              filename,
              size: new TextEncoder().encode(body).byteLength,
              uploadedAt: 1,
              url: requestedUrl,
            },
          },
          { status: 201 },
        )
      },
    })

    const response = await authedWith(
      urlApp,
      `/v1/ws/${proxied.slug}/train/uploads/url`,
      memoryKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: requestedUrl }),
      },
    )

    expect(response.status).toBe(201)
    expect(firecrawlRequests).toBe(1)
    expect(await response.json()).toMatchObject({ filename, url: requestedUrl })
  })

  test('returns a typed Firecrawl failure without starting a gateway PUT', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-url-failure'))
    const memoryKey = await issueKey(owner.client)
    const requests: string[] = []
    const urlApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      firecrawlKey: 'firecrawl-key',
      fetch: async (input, init) => {
        requests.push(String(input))
        if ((init?.method ?? 'GET') === 'GET') {
          return Response.json({
            files: [],
            totalBytes: 0,
            capBytes: 1_073_741_824,
            running: false,
          })
        }
        return new Response('rate limited', { status: 429 })
      },
    })

    const response = await authedWith(
      urlApp,
      `/v1/ws/${proxied.slug}/train/uploads/url`,
      memoryKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/rate-limited' }),
      },
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'source_fetch_failed',
      detail: 'non_2xx',
      message: 'Firecrawl returned HTTP 429',
      status: 429,
    })
    expect(requests).toEqual([
      'https://gateway-proxy.exe.xyz/v1/train/uploads',
      'https://api.firecrawl.dev/v2/scrape',
    ])
  })

  test('integration connect delegates lifecycle ownership to the provider', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('integration-cleanup'))
    const key = await issueKey(owner.client)
    const disconnects: string[] = []
    const connections: IntegrationConnection[] = []
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      appUrl: 'http://localhost:3000',
      integrationProvider: integrationProviderFixture({
        listConnections: async () => ({ items: connections, nextCursor: null }),
        getConnection: async args =>
          args.workspaceId === workspace.workspaceId
            ? connections.find(connection => connection.id === args.providerConnectionId)
            : undefined,
        beginConnection: async () => {
          connections.push({
            id: 'connected_firecrawl_pending',
            integration: 'firecrawl',
            status: 'pending',
            connectedAt: 1,
            updatedAt: 1,
          })
          return {
            authorizeUrl: 'https://provider.example/authorize',
          }
        },
        disconnect: async args => {
          disconnects.push(args.providerConnectionId)
          connections.splice(
            connections.findIndex(connection => connection.id === args.providerConnectionId),
            1,
          )
        },
      }),
    })

    const response = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/integrations/connect`,
      key.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          integration: 'firecrawl',
          redirectTo: `/w/${workspace.slug}/computer/integrations`,
        }),
      },
    )
    expect(response.status).toBe(200)
    const connected = IntegrationConnectResponseSchema.parse(await response.json())
    expect(connected).toEqual({
      integration: 'firecrawl',
      authorizeUrl: 'https://provider.example/authorize',
    })

    const cleanup = await authedWith(
      app,
      `/v1/ws/${workspace.slug}/integrations/connections/connected_firecrawl_pending`,
      key.key,
      { method: 'DELETE' },
    )
    expect(cleanup.status).toBe(200)
    expect(await cleanup.json()).toEqual({
      id: 'connected_firecrawl_pending',
      disconnected: true,
    })
    expect(disconnects).toEqual(['connected_firecrawl_pending'])
  })

  test('integration lifecycle uses provider state directly while the old action route stays deleted', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('integration-api'))
    const integrationsKey = await issueKey(owner.client)
    const catalogCalls: Array<Record<string, unknown>> = []
    const beginCalls: Array<Record<string, unknown>> = []
    const disconnectCalls: Array<Record<string, unknown>> = []
    let connections: IntegrationConnection[] = []

    const integrationApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      appUrl: 'http://localhost:3000',
      integrationProvider: integrationProviderFixture({
        listCatalog: async args => {
          catalogCalls.push(args)
          return {
            items: [
              {
                integration: 'gmail',
                name: 'Gmail',
                connected: connections.some(
                  connection =>
                    connection.integration === 'gmail' && connection.status === 'active',
                ),
              },
              { integration: 'linear', name: 'Linear', connected: false },
            ],
            nextCursor: 'page-2',
          }
        },
        listConnections: async args => {
          expect(args.workspaceId).toBe(proxied.workspaceId)
          return { items: connections, nextCursor: null }
        },
        getConnection: async args =>
          args.workspaceId === proxied.workspaceId
            ? connections.find(connection => connection.id === args.providerConnectionId)
            : undefined,
        beginConnection: async args => {
          beginCalls.push(args)
          connections = [
            {
              id: `connected_${args.integration}_1`,
              integration: args.integration,
              status: 'pending',
              connectedAt: 1,
              updatedAt: 1,
            },
          ]
          return {
            authorizeUrl: 'https://provider.example/authorize',
          }
        },
        disconnect: async args => {
          disconnectCalls.push(args)
          connections = connections.filter(
            connection => connection.id !== args.providerConnectionId,
          )
        },
      }),
    })

    const catalog = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/catalog?q=mail&limit=2`,
      integrationsKey.key,
    )
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toEqual({
      items: [
        { integration: 'gmail', name: 'Gmail', connected: false },
        { integration: 'linear', name: 'Linear', connected: false },
      ],
      nextCursor: expect.any(String),
    })
    expect(catalogCalls).toEqual([{ workspaceId: proxied.workspaceId, search: 'mail', limit: 2 }])

    for (const redirectTo of [
      'https://evil.example/steal',
      'https://canvas--a-different-workspace.edge.duet.so/oauth/complete',
    ]) {
      const rejected = await authedWith(
        integrationApp,
        `/v1/ws/${proxied.slug}/integrations/connect`,
        integrationsKey.key,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ integration: 'gmail', redirectTo }),
        },
      )
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({ error: 'redirect_not_allowed' })
    }

    const connect = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/connect`,
      integrationsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          integration: 'gmail',
          redirectTo: `/w/${proxied.slug}/computer/integrations?status=error#spoofed`,
        }),
      },
    )
    expect(connect.status).toBe(200)
    expect(await connect.json()).toEqual({
      integration: 'gmail',
      authorizeUrl: 'https://provider.example/authorize',
    })
    expect(beginCalls).toHaveLength(1)
    expect(beginCalls[0]).toMatchObject({
      workspaceId: proxied.workspaceId,
      integration: 'gmail',
      label: `${proxied.workspaceId}:gmail`,
    })
    const providerCallback = new URL(String(beginCalls[0]!.callbackUrl))
    expect(providerCallback.origin).toBe('http://localhost')
    expect(providerCallback.pathname).toBe('/v1/integrations/composio/oauth/callback')
    expect(providerCallback.searchParams.get('nonce')).toBeString()

    const pending = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/connections`,
      integrationsKey.key,
    )
    expect(await pending.json()).toEqual({ items: connections, nextCursor: null })

    /* A half-finished authorization is NOT a connection, and pressing Connect
       again must start over rather than be told the thing already exists.

       The provider row sits at `pending` from the moment the authorize URL is
       minted until the user comes back through the callback. If they never do
       — the provider errored, they closed the tab, they said no — nothing
       clears it: there is no expiry here and none upstream. This route used to
       treat any non-`disconnected` row as already-connected, so the second
       attempt answered `integration_already_connected` while the onboarding
       page rendered `pending` as a status pill with no button beside it. Both
       directions locked, permanently, on a connection that never existed. */
    const retriedWhilePending = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/connect`,
      integrationsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          integration: 'gmail',
          redirectTo: `/w/${proxied.slug}/computer/integrations`,
        }),
      },
    )
    expect(retriedWhilePending.status).toBe(200)
    expect(disconnectCalls).toEqual([
      { workspaceId: proxied.workspaceId, providerConnectionId: 'connected_gmail_1' },
    ])
    expect(beginCalls).toHaveLength(2)

    connections = connections.map(connection => ({
      ...connection,
      status: 'active',
      updatedAt: 2,
    }))
    const connectedCatalog = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/catalog`,
      integrationsKey.key,
    )
    expect(await connectedCatalog.json()).toMatchObject({
      items: [
        { integration: 'gmail', connected: true },
        { integration: 'linear', connected: false },
      ],
    })

    const duplicate = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/connect`,
      integrationsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          integration: 'gmail',
          redirectTo: `/w/${proxied.slug}/computer/integrations`,
        }),
      },
    )
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'integration_already_connected' })

    connections = connections.map(connection => ({ ...connection, status: 'error' }))
    const reconnected = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/connect`,
      integrationsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          integration: 'gmail',
          redirectTo: `/w/${proxied.slug}/computer/integrations`,
        }),
      },
    )
    expect(reconnected.status).toBe(200)
    expect(disconnectCalls).toEqual([
      { workspaceId: proxied.workspaceId, providerConnectionId: 'connected_gmail_1' },
      { workspaceId: proxied.workspaceId, providerConnectionId: 'connected_gmail_1' },
    ])
    expect(beginCalls).toHaveLength(3)
    expect(beginCalls[1]).toMatchObject({
      label: `${proxied.workspaceId}:gmail`,
    })
    connections = connections.map(connection => ({ ...connection, status: 'active' }))

    const deletedAction = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/use`,
      integrationsKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          integration: 'gmail',
          action: 'draft_email',
          params: { to: 'team@example.com' },
        }),
      },
    )
    expect(deletedAction.status).toBe(404)

    const disconnected = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/connections/connected_gmail_1`,
      integrationsKey.key,
      { method: 'DELETE' },
    )
    expect(await disconnected.json()).toEqual({ id: 'connected_gmail_1', disconnected: true })
    // Three by now: the stale pending attempt, the errored connection, and this
    // explicit disconnect. The provider's own row id is reused by the fixture.
    expect(disconnectCalls).toEqual(
      Array.from({ length: 3 }, () => ({
        workspaceId: proxied.workspaceId,
        providerConnectionId: 'connected_gmail_1',
      })),
    )
    const disconnectsAfterExplicitDelete = disconnectCalls.length

    const repeated = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/connections/connected_gmail_1`,
      integrationsKey.key,
      { method: 'DELETE' },
    )
    expect(await repeated.json()).toEqual({ id: 'connected_gmail_1', disconnected: false })
    // Deleting a row the provider no longer has must not call out a second
    // time. Stated against the count above rather than a literal, so a new
    // disconnect earlier in this lifecycle cannot silently satisfy it.
    expect(disconnectCalls).toHaveLength(disconnectsAfterExplicitDelete)

    const callback = await authedWith(
      integrationApp,
      `/v1/ws/${proxied.slug}/integrations/callback`,
      integrationsKey.key,
      { method: 'POST' },
    )
    expect(callback.status).toBe(404)
  })

  test('integration disconnect removes any connection the provider places in this workspace', async () => {
    const workspace = await provisionRegisteredWorkspace(uniqueSlug('integration-point-delete'))
    const key = await issueKey(owner.client)
    const disconnected: string[] = []
    let listCalls = 0
    /* The provider owns tenancy: a row belongs to whichever workspace it is
       filed under, and nothing about how it was created — labelled by Duet's
       own connect route, or made by an agent through the provider's connect
       flow — changes whether this workspace may remove it. */
    const records = new Map([
      ['later-page', { workspaceId: workspace.workspaceId, integration: 'gmail' }],
      ['agent-made', { workspaceId: workspace.workspaceId, integration: 'slack' }],
      ['another-workspace', { workspaceId: 'workspace-other', integration: 'gmail' }],
    ])
    const app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      integrationProvider: integrationProviderFixture({
        listConnections: async () => {
          listCalls += 1
          return {
            items: Array.from({ length: 100 }, (_, index) =>
              connection(`earlier-${index}`, 'gmail'),
            ),
            nextCursor: 'later',
          }
        },
        getConnection: async args => {
          const found = records.get(args.providerConnectionId)
          return found === undefined || found.workspaceId !== args.workspaceId
            ? undefined
            : connection(args.providerConnectionId, found.integration)
        },
        disconnect: async args => {
          disconnected.push(args.providerConnectionId)
          records.delete(args.providerConnectionId)
        },
      }),
    })

    for (const connectionId of ['later-page', 'agent-made']) {
      const owned = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/integrations/connections/${connectionId}`,
        key.key,
        { method: 'DELETE' },
      )
      expect(await owned.json()).toEqual({ id: connectionId, disconnected: true })
    }
    expect(disconnected).toEqual(['later-page', 'agent-made'])

    for (const connectionId of ['another-workspace', 'later-page', 'unknown']) {
      const absent = await authedWith(
        app,
        `/v1/ws/${workspace.slug}/integrations/connections/${connectionId}`,
        key.key,
        { method: 'DELETE' },
      )
      expect(await absent.json()).toEqual({ id: connectionId, disconnected: false })
    }
    // Still only the two, so another workspace's row was never touched and a
    // repeat delete stayed idempotent.
    expect(disconnected).toEqual(['later-page', 'agent-made'])
    // Disconnect resolves one id; it never walks the connection list, so a
    // row's page position cannot decide whether it can be removed.
    expect(listCalls).toBe(0)
  })

  test('integration policy responses expose the access matrix and survive provider reconnection', async () => {
    const scoped = await provisionRegisteredWorkspace(uniqueSlug('integration-policy'))
    const key = await issueKey(owner.client)
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: scoped.workspaceId,
      path: 'agents/agent-a',
      slug: 'agent-a',
    })) as { id: string }
    let githubConnectionId = 'github-connection-before'
    const integrationApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      integrationProvider: integrationProviderFixture({
        listConnections: async () => ({
          items: [
            connection('gmail-connection', 'gmail'),
            connection(githubConnectionId, 'github'),
            connection('slack-connection', 'slack'),
            connection('notion-connection', 'notion'),
          ],
          nextCursor: null,
        }),
      }),
    })

    const policies: Array<[string, string[]]> = [
      ['github', []],
      ['slack', ['root']],
      ['notion', [agent.id]],
    ]
    for (const [integration, allowedAgentIds] of policies) {
      const response = await authedWith(
        integrationApp,
        `/v1/ws/${scoped.slug}/integrations/${integration}/agent-policy`,
        key.key,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allowedAgentIds }),
        },
      )
      expect(response.status).toBe(200)
      expect(IntegrationAgentPolicyResponseSchema.parse(await response.json())).toEqual({
        integration,
        allowedAgentIds,
      })
    }

    const readMatrix = async () => {
      const response = await authedWith(
        integrationApp,
        `/v1/ws/${scoped.slug}/integrations/connections`,
        key.key,
      )
      expect(response.status).toBe(200)
      return IntegrationConnectionListSchema.parse(await response.json())
    }
    const before = await readMatrix()
    expect(renderAccessMatrix(before.items, agent.id)).toBe(
      [
        'toolkit\tpolicy\troot\tagent-a\tfuture',
        'gmail\tabsent\tyes\tyes\tyes',
        'github\t[]\tno\tno\tno',
        'slack\t[root]\tyes\tno\tno',
        'notion\t[agent-a]\tno\tyes\tno',
      ].join('\n'),
    )

    githubConnectionId = 'github-connection-after'
    const after = await readMatrix()
    expect(after.items.find(item => item.integration === 'github')).toMatchObject({
      id: 'github-connection-after',
      allowedAgentIds: [],
    })

    const cleared = await authedWith(
      integrationApp,
      `/v1/ws/${scoped.slug}/integrations/github/agent-policy`,
      key.key,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    )
    expect(IntegrationAgentPolicyResponseSchema.parse(await cleared.json())).toEqual({
      integration: 'github',
    })
    expect((await readMatrix()).items.find(item => item.integration === 'github')).toEqual(
      connection('github-connection-after', 'github'),
    )

    const foreign = await provisionRegisteredWorkspace(uniqueSlug('integration-policy-foreign'))
    const foreignAgent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: foreign.workspaceId,
      path: 'agents/foreign',
      slug: 'foreign',
    })) as { id: string }
    const rejected = await authedWith(
      integrationApp,
      `/v1/ws/${scoped.slug}/integrations/notion/agent-policy`,
      key.key,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedAgentIds: [foreignAgent.id] }),
      },
    )
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: 'invalid_request' })
    expect((await readMatrix()).items.find(item => item.integration === 'notion')).toMatchObject({
      allowedAgentIds: [agent.id],
    })

    const malformed = await authedWith(
      integrationApp,
      `/v1/ws/${scoped.slug}/integrations/notion/agent-policy`,
      key.key,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedAgentIds: ['not-an-agent-id'] }),
      },
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'invalid_request' })
  })

  test('integration policy mutation requires the existing integrations scope', async () => {
    const scoped = await provisionRegisteredWorkspace(uniqueSlug('integration-policy-scope'))
    const key = await issueKey((await humanWorkspaceFixture(scoped.workspaceId, 'viewer')).client)
    const integrationApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      integrationProvider: integrationProviderFixture({}),
    })

    const response = await authedWith(
      integrationApp,
      `/v1/ws/${scoped.slug}/integrations/github/agent-policy`,
      key.key,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedAgentIds: [] }),
      },
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${scoped.slug}:integrations`,
    })
  })

  test('skills listing is a sessions-scoped deterministic collection', async () => {
    const vm = await provisionRegisteredWorkspace(uniqueSlug('skills'))
    const sessionsKey = await issueKey(owner.client)
    const outsiderKey = await issueKey((await humanWorkspaceFixture(vm.workspaceId, null)).client)
    const gatewayUrls: string[] = []
    const routeApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        gatewayUrls.push(new URL(String(input)).pathname + new URL(String(input)).search)
        return Response.json({
          skills: [
            { name: 'review', path: '/drive/.agents/skills/review', scope: 'project' },
            { name: 'analyze', path: '/drive/.agents/skills/analyze', scope: 'project' },
          ],
        })
      },
    })

    expect((await routeApp.request(`/v1/ws/${vm.slug}/skills`)).status).toBe(401)
    const wrongScope = await authedWith(routeApp, `/v1/ws/${vm.slug}/skills`, outsiderKey.key)
    expect(wrongScope.status).toBe(403)
    expect(await wrongScope.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${vm.slug}:sessions`,
    })

    const listed = await authedWith(
      routeApp,
      `/v1/ws/${vm.slug}/skills?cwd=agents%2Fscout&limit=1`,
      sessionsKey.key,
    )
    expect(listed.status).toBe(200)
    const first = (await listed.json()) as { items: unknown[]; nextCursor: string }
    expect(first.items).toEqual([
      { name: 'analyze', path: '/drive/.agents/skills/analyze', scope: 'project' },
    ])
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await authedWith(
      routeApp,
      `/v1/ws/${vm.slug}/skills?cwd=agents%2Fscout&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      sessionsKey.key,
    )
    expect(await second.json()).toEqual({
      items: [{ name: 'review', path: '/drive/.agents/skills/review', scope: 'project' }],
      nextCursor: null,
    })

    const rebound = await authedWith(
      routeApp,
      `/v1/ws/${vm.slug}/skills?cwd=agents%2Fother&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      sessionsKey.key,
    )
    expect(rebound.status).toBe(400)
    expect(await rebound.json()).toEqual({ error: 'invalid_cursor' })

    for (const invalidQuery of ['limit=101', 'limit=1&unexpected=true']) {
      const invalid = await authedWith(
        routeApp,
        `/v1/ws/${vm.slug}/skills?${invalidQuery}`,
        sessionsKey.key,
      )
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'invalid_request' })
    }
    expect(gatewayUrls).toEqual([
      '/v1/skills?cwd=agents%2Fscout',
      '/v1/skills?cwd=agents%2Fscout',
      '/v1/skills?cwd=agents%2Fother',
    ])
  })

  test('train start resolves URLs inline, calls the gateway directly, and stores creator identity', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-cutover'))
    const memoryKey = await issueKey(owner.client)
    const gatewayRequests: Array<{ url: string; headers: Headers; body: unknown }> = []
    const trainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => Date.parse('2026-07-15T12:00:00.000Z'),
      firecrawlKey: 'firecrawl-key',
      fetch: async (input, init) => {
        if (String(input) === 'https://api.firecrawl.dev/v2/scrape') {
          return Response.json({
            success: true,
            data: { markdown: '# Scraped', metadata: { title: 'Scraped title' } },
          })
        }
        gatewayRequests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        })
        return Response.json({ jobId: 'gateway-job' }, { status: 202 })
      },
    })

    const response = await authedWith(trainApp, `/v1/ws/${proxied.slug}/train`, memoryKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        urls: ['https://example.com/handbook'],
        files: [{ filename: 'inline.md', content: '# Inline' }],
        driveFiles: ['reports/q2.pdf'],
      }),
    })

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ jobId: 'gateway-job' })
    expect(gatewayRequests).toHaveLength(1)
    expect(gatewayRequests[0]!.url).toBe('https://gateway-proxy.exe.xyz/v1/train')
    expect(gatewayRequests[0]!.headers.get(DUET_ACTOR_CONTEXT_HEADER)).toBe(`web:${owner.user._id}`)
    expect(gatewayRequests[0]!.body).toEqual({
      files: [
        { filename: 'inline.md', content: '# Inline', encoding: 'utf8' },
        {
          filename: expect.stringMatching(/^url-example-com-handbook-/),
          content: expect.stringContaining('# Scraped'),
          encoding: 'utf8',
        },
      ],
      driveFiles: ['reports/q2.pdf'],
    })
    expect(
      await query(convex, 'testing/train:listRawForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: proxied.workspaceId,
      }),
    ).toContainEqual(expect.objectContaining({ jobId: 'gateway-job', userId: owner.user._id }))
  })

  test('train routes use memory scope, reject caps, and project the accepted gateway job', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-api'))
    const outsiderKey = await issueKey(
      (await humanWorkspaceFixture(proxied.workspaceId, null)).client,
    )
    const memoryKey = await issueKey(owner.client)
    const trainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 900_000,
      firecrawlKey: 'firecrawl-key',
      fetch: async input => {
        if (String(input) === 'https://api.firecrawl.dev/v2/scrape') {
          return Response.json({
            success: true,
            data: { markdown: '# Scraped', metadata: { title: 'Scraped title' } },
          })
        }
        return Response.json({ jobId: 'gateway-projected-job' }, { status: 202 })
      },
    })

    expect(
      (await trainApp.request(`/v1/ws/${proxied.slug}/train`, { method: 'POST' })).status,
    ).toBe(401)
    const denied = await authedWith(trainApp, `/v1/ws/${proxied.slug}/train`, outsiderKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ filename: 'notes.md', content: 'hello' }] }),
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({
      error: 'insufficient_scope',
      scope: `ws:${proxied.slug}:memory`,
    })

    const capped = await authedWith(trainApp, `/v1/ws/${proxied.slug}/train`, memoryKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        urls: Array.from({ length: 26 }, (_, index) => `https://example.com/${index}`),
      }),
    })
    expect(capped.status).toBe(400)

    const started = await authedWith(trainApp, `/v1/ws/${proxied.slug}/train`, memoryKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: ['https://example.com'] }),
    })
    expect(started.status).toBe(202)
    const body = (await started.json()) as { jobId: string }
    expect(body.jobId).toBe('gateway-projected-job')

    const queued = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/train/${body.jobId}`,
      memoryKey.key,
    )
    expect(await queued.json()).toMatchObject({
      job: {
        jobId: body.jobId,
        state: 'queued',
        phase: 'preparing',
        userId: owner.user._id,
      },
    })

    const history = await authedWith(trainApp, `/v1/ws/${proxied.slug}/train/jobs`, memoryKey.key)
    expect(history.status).toBe(200)
    expect(await history.json()).toMatchObject({
      items: [{ jobId: body.jobId, state: 'queued', phase: 'preparing', userId: owner.user._id }],
      nextCursor: null,
    })
    const invalidHistory = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/train/jobs?limit=999`,
      memoryKey.key,
    )
    expect(invalidHistory.status).toBe(400)
  })

  test('unknown agent train slugs return 404 without reaching the gateway', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('agent-train-missing'))
    const memoryKey = await issueKey(owner.client)
    const gatewayUrls: string[] = []
    const trainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async input => {
        gatewayUrls.push(String(input))
        return Response.json({ files: [], totalBytes: 0, capBytes: 1024, running: false })
      },
    })

    const response = await authedWith(
      trainApp,
      `/v1/ws/${proxied.slug}/agents/missing/train/uploads`,
      memoryKey.key,
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
    expect(gatewayUrls).toEqual([])
  })

  test('train record CRUD is capability-checked and transparently proxied to the VM', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-records'))
    const outsiderKey = await issueKey(
      (await humanWorkspaceFixture(proxied.workspaceId, null)).client,
    )
    const memoryKey = await issueKey(owner.client)
    const gatewayRequests: Array<{ url: string; method: string; body?: string; headers: Headers }> =
      []
    let gatewayFailed = false
    const proxyApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      now: () => 901_000,
      fetch: async (input, init) => {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : typeof init?.body === 'string'
              ? init.body
              : undefined
        gatewayRequests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body,
          headers: new Headers(init?.headers),
        })
        if (gatewayFailed) {
          return Response.json(
            { error: 'train_record_read_failed', message: 'memory file could not be read' },
            { status: 500 },
          )
        }
        if (init?.method === 'DELETE') {
          return Response.json({
            deleted: true,
            slug: 'handbook',
            memoryId: 'mem_1',
          })
        }
        if (init?.method === 'PATCH') {
          return Response.json({
            record: {
              slug: 'handbook',
              memoryId: 'mem_1',
              createdAt: '2026-07-11T00:00:00Z',
              observedDate: '2026-07-11',
              hasArchive: true,
              content: 'updated',
            },
          })
        }
        return Response.json({
          items: [
            {
              slug: 'handbook',
              memoryId: 'mem_1',
              createdAt: '2026-07-11T00:00:00Z',
              observedDate: '2026-07-11',
              hasArchive: true,
            },
          ],
          nextCursor: null,
        })
      },
    })

    const denied = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/train/records`,
      outsiderKey.key,
    )
    expect(denied.status).toBe(403)

    const invalidUpdate = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/train/records/handbook`,
      memoryKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '   ' }),
      },
    )
    expect(invalidUpdate.status).toBe(400)
    expect(gatewayRequests).toHaveLength(0)

    const listed = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/train/records`, memoryKey.key)
    expect(listed.status).toBe(200)

    const updated = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/train/records/handbook`,
      memoryKey.key,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'updated' }),
      },
    )
    expect(updated.status).toBe(200)

    const deleted = await authedWith(
      proxyApp,
      `/v1/ws/${proxied.slug}/train/records/handbook`,
      memoryKey.key,
      { method: 'DELETE' },
    )
    expect(deleted.status).toBe(200)
    expect(gatewayRequests.map(request => [request.method, request.url])).toEqual([
      ['GET', 'https://gateway-proxy.exe.xyz/v1/train/records?limit=50'],
      ['PATCH', 'https://gateway-proxy.exe.xyz/v1/train/records/handbook'],
      ['DELETE', 'https://gateway-proxy.exe.xyz/v1/train/records/handbook'],
    ])
    expect(gatewayRequests[1]!.body).toBe(JSON.stringify({ content: 'updated' }))
    expect(gatewayRequests[1]!.headers.get('authorization')).toBe(`Bearer ${proxied.vmToken}`)

    gatewayFailed = true
    const failed = await authedWith(proxyApp, `/v1/ws/${proxied.slug}/train/records`, memoryKey.key)
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({
      error: 'train_record_read_failed',
      message: 'memory file could not be read',
    })
  })

  test('surfaces a quota-full URL artifact PUT as 413', async () => {
    const proxied = await provisionRegisteredWorkspace(uniqueSlug('train-url-quota'))
    const memoryKey = await issueKey(owner.client)
    const urlApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      firecrawlKey: 'firecrawl-key',
      fetch: async (input, init) => {
        if (String(input) === 'https://api.firecrawl.dev/v2/scrape') {
          return Response.json({
            success: true,
            data: { markdown: '# Too large', metadata: { title: 'Too large' } },
          })
        }
        if ((init?.method ?? 'GET') === 'GET') {
          return Response.json({
            files: [],
            totalBytes: 0,
            capBytes: 1_073_741_824,
            running: false,
          })
        }
        return Response.json({ error: 'quota_exceeded' }, { status: 413 })
      },
    })

    const response = await authedWith(
      urlApp,
      `/v1/ws/${proxied.slug}/train/uploads/url`,
      memoryKey.key,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/too-large' }),
      },
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'quota_exceeded' })
  })

  test('train start holds provisioning workspaces without creating a job', async () => {
    const slug = uniqueSlug('train-provisioning')
    const begun = await prepareWorkspaceForHttpRegistration(slug, 'Train Provisioning')
    const memoryKey = await issueKey(owner.client)
    const trainApp = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      fetch: async () => Response.json({ jobId: 'registered-job' }, { status: 202 }),
    })

    const held = await authedWith(trainApp, `/v1/ws/${slug}/train`, memoryKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: ['https://example.com'] }),
    })

    expect(held.status).toBe(409)
    expect(await held.json()).toEqual({ error: 'workspace_provisioning' })
    expect(
      await query(convex, 'testing/train:listRawForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: begun.workspaceId,
      }),
    ).toEqual([])

    const registered = await trainApp.request('/v1/vm/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provisioningToken: begun.provisioningToken,
        workspaceHint: begun.workspaceId,
        vmName: 'duet-test-train-provisioning',
        sshDest: 'exedev@duet-test-train-provisioning.exe.xyz',
        httpsUrl: 'https://gateway-train-provisioning.exe.xyz',
      }),
    })
    expect(registered.status).toBe(200)

    const started = await authedWith(trainApp, `/v1/ws/${slug}/train`, memoryKey.key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ filename: 'notes.md', content: 'hello' }] }),
    })
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({ jobId: 'registered-job' })
  }, 60_000)
})
