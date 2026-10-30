import { expect, test } from 'bun:test'

import {
  auth,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import {
  createFakeOAuthIssuer,
  FAKE_MCP_OVERSIZED_TOOL,
  FAKE_MCP_SERVER_NAME,
  FAKE_OAUTH_ISSUER_MOUNT_PATH,
  type FakeOAuthIssuer,
} from './index'
import { sha256Base64Url } from './signing'

const BASE_URL = 'https://issuer.test'
const MOUNT_PATH = FAKE_OAUTH_ISSUER_MOUNT_PATH
const MOUNT_URL = `${BASE_URL}${MOUNT_PATH}`
const REDIRECT_URI = 'https://duet.test/oauth/mcp-callback'
const CLIENT_METADATA_URL = 'https://duet.test/.well-known/duet-mcp-client.json'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

test('approval becomes available when the signed grant reaches its approval time', async () => {
  let now = 10_000
  const issuer = createFakeOAuthIssuer({
    approvalDelayMs: 250,
    quotaAfterMs: Number.MAX_SAFE_INTEGER,
    now: () => now,
  })
  const device = await post(issuer.fetch, '/device/code', {
    client_id: 'duet-agent:openai-codex',
    scope: 'openid profile email',
  })

  expect(
    await post(issuer.fetch, '/token', {
      device_code: device.device_code,
      grant_type: DEVICE_GRANT,
    }),
  ).toEqual({ status: 'pending' })

  now += 250

  const tokens = await post(issuer.fetch, '/token', {
    device_code: device.device_code,
    grant_type: DEVICE_GRANT,
  })
  expect(tokens).toEqual({
    access_token: expect.stringMatching(/^fake-oauth-access-/),
    refresh_token: expect.stringMatching(/^fake-oauth-refresh-/),
    expires_in: expect.any(Number),
    account_id: expect.stringMatching(/^fake-account-openai-codex-/),
  })
  const lifetimeSeconds = Number(tokens.expires_in)
  expect(Number.isFinite(lifetimeSeconds)).toBe(true)
  expect(lifetimeSeconds).toBeGreaterThan(0)
  const complete = () =>
    issuer.fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${String(tokens.access_token)}` },
    })
  now += lifetimeSeconds * 1_000 - 1
  expect((await complete()).status).toBe(200)
  now += 1
  expect((await complete()).status).toBe(401)
})

test('device and token grants survive separate issuer instances', async () => {
  let now = 1_000
  const options = { approvalDelayMs: 100, now: () => now }
  const issuingInstance = createFakeOAuthIssuer(options)
  const consumingInstance = createFakeOAuthIssuer(options)
  const device = await post(issuingInstance.fetch, '/device/code', {
    client_id: 'duet-agent:openai-codex',
    scope: 'openid profile email',
  })

  expect(
    await post(consumingInstance.fetch, '/token', {
      device_code: device.device_code,
      grant_type: DEVICE_GRANT,
    }),
  ).toEqual({ status: 'pending' })

  now += 100
  const tokens = await post(consumingInstance.fetch, '/token', {
    device_code: device.device_code,
    grant_type: DEVICE_GRANT,
  })
  const completion = await consumingInstance.fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${String(tokens.access_token)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'fake-model' }),
  })

  expect(tokens).toMatchObject({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
    expires_in: expect.any(Number),
    account_id: expect.any(String),
  })
  expect(completion.status).toBe(200)
})

test('rejects a device code whose self-contained grant was altered', async () => {
  const issuer = createFakeOAuthIssuer({ approvalDelayMs: 0 })
  const device = await post(issuer.fetch, '/device/code', {
    client_id: 'duet-agent:openai-codex',
    scope: 'openid profile email',
  })
  const deviceCode = String(device.device_code)
  // Preserve the parseable payload and prefix so rejection must reach signature verification.
  // Change the first signature character: changing trailing base64 padding bits can decode identically.
  const separator = deviceCode.lastIndexOf('.')
  expect(separator).toBeGreaterThan(0)
  const signature = deviceCode.slice(separator + 1)
  const alteredCode = `${deviceCode.slice(0, separator + 1)}${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
  const response = await issuer.fetch(`${BASE_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: alteredCode, grant_type: DEVICE_GRANT }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid_request' })
})

test('an unauthenticated MCP request challenges with discovery that lands inside the mount', async () => {
  const fetchFn = mountedFetch(createFakeOAuthIssuer())

  const challenged = await fetchFn(`${MOUNT_URL}/mcp`, { method: 'POST', body: '{}' })
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(challenged)
  const info = await discoverOAuthServerInfo(`${MOUNT_URL}/mcp`, { resourceMetadataUrl, fetchFn })

  expect(challenged.status).toBe(401)
  expect(resourceMetadataUrl?.toString()).toBe(`${MOUNT_URL}/.well-known/oauth-protected-resource`)
  expect(info.resourceMetadata).toMatchObject({
    resource: `${MOUNT_URL}/mcp`,
    authorization_servers: [MOUNT_URL],
  })
  expect(info.authorizationServerMetadata).toMatchObject({
    issuer: MOUNT_URL,
    authorization_endpoint: `${MOUNT_URL}/authorize`,
    token_endpoint: `${MOUNT_URL}/token`,
    registration_endpoint: `${MOUNT_URL}/register`,
    code_challenge_methods_supported: ['S256'],
  })
})

test('the issuer answers at the URLs it advertises even when the host strips no prefix', async () => {
  // The loopback server in `@repo/test-harness` serves the handler at a root,
  // where the mount prefix arrives intact instead of being stripped away.
  const issuer = createFakeOAuthIssuer()

  const document = await issuer.fetch(`${BASE_URL}/.well-known/openid-configuration`)
  const metadata = (await document.json()) as Record<string, string>
  const registered = await issuer.fetch(metadata.registration_endpoint as string, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
  })

  expect(metadata.registration_endpoint).toBe(`${MOUNT_URL}/register`)
  expect(registered.status).toBe(201)
})

test('the SDK client registers, is redirected to a clickable consent page, and exchanges the code', async () => {
  const fetchFn = mountedFetch(createFakeOAuthIssuer())
  const provider = new FixtureClientProvider()
  const serverUrl = `${MOUNT_URL}/mcp`
  const resourceMetadataUrl = new URL(`${MOUNT_URL}/.well-known/oauth-protected-resource`)

  expect(await auth(provider, { serverUrl, resourceMetadataUrl, fetchFn })).toBe('REDIRECT')

  const authorizationUrl = provider.authorizationUrl
  expect(authorizationUrl?.origin.concat(authorizationUrl.pathname)).toBe(`${MOUNT_URL}/authorize`)
  expect(authorizationUrl?.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorizationUrl?.searchParams.get('scope')).toBe('mcp:tools')
  expect(authorizationUrl?.searchParams.get('resource')).toBe(serverUrl)

  const consent = await completeConsent(fetchFn, authorizationUrl as URL, 'approve')
  expect(consent.html).toContain('id="fake-issuer-approve"')
  expect(consent.location.searchParams.get('iss')).toBe(MOUNT_URL)
  expect(`${consent.location.origin}${consent.location.pathname}`).toBe(REDIRECT_URI)

  const code = consent.location.searchParams.get('code') ?? ''
  expect(await auth(provider, { serverUrl, authorizationCode: code, fetchFn })).toBe('AUTHORIZED')
  expect(provider.savedTokens).toMatchObject({
    access_token: expect.stringMatching(/^fake-oauth-access-/),
    refresh_token: expect.stringMatching(/^fake-oauth-refresh-/),
    token_type: 'Bearer',
    expires_in: expect.any(Number),
    scope: 'mcp:tools',
  })
})

test('with client id metadata documents on, the SDK authorizes by URL and never registers', async () => {
  const issuer = createFakeOAuthIssuer({
    clientMetadataFetch: async url => clientMetadataDocument(url, [REDIRECT_URI]),
  })
  const fetchFn = mountedFetch(issuer)
  const provider = new FixtureClientProvider(CLIENT_METADATA_URL)
  const serverUrl = `${MOUNT_URL}/mcp`
  const resourceMetadataUrl = new URL(`${MOUNT_URL}/.well-known/oauth-protected-resource`)

  expect(await auth(provider, { serverUrl, resourceMetadataUrl, fetchFn })).toBe('REDIRECT')
  expect(provider.authorizationUrl?.searchParams.get('client_id')).toBe(CLIENT_METADATA_URL)

  const consent = await completeConsent(fetchFn, provider.authorizationUrl as URL, 'approve')
  const code = consent.location.searchParams.get('code') ?? ''
  expect(await auth(provider, { serverUrl, authorizationCode: code, fetchFn })).toBe('AUTHORIZED')

  expect(provider.savedTokens).toMatchObject({
    access_token: expect.stringMatching(/^fake-oauth-access-/),
    token_type: 'Bearer',
  })
  // The whole point of the branch: nothing was registered, so there is nothing
  // to clean up afterwards.
  expect(issuer.requests.map(entry => entry.path)).not.toContain('/register')
})

test('a client id metadata document is refused when it does not list the redirect, and when off', async () => {
  const listedElsewhere = mountedFetch(
    createFakeOAuthIssuer({
      clientMetadataFetch: async url =>
        clientMetadataDocument(url, ['https://elsewhere.test/callback']),
    }),
  )
  const disabled = mountedFetch(createFakeOAuthIssuer())

  const mismatched = await listedElsewhere(authorizationRequest(CLIENT_METADATA_URL, {}).toString())
  const refusedOutright = await disabled(authorizationRequest(CLIENT_METADATA_URL, {}).toString())

  expect(mismatched.status).toBe(400)
  expect(await mismatched.json()).toMatchObject({ error: 'invalid_request' })
  // Off by default: a URL client_id is just an unknown client, and the
  // registration path stays the one that has to be used.
  expect(refusedOutright.status).toBe(400)
  expect(await refusedOutright.json()).toMatchObject({ error: 'invalid_client' })
})

test('dynamic registration answers with the RFC 7592 management credentials', async () => {
  const fetchFn = mountedFetch(createFakeOAuthIssuer())

  const registration = await registerFixtureClient(fetchFn)

  expect(registration.client_id).toMatch(/^fake-oauth-client-/)
  expect(registration.registration_access_token).toMatch(/^fake-oauth-registration-/)
  expect(registration.registration_client_uri).toBe(
    `${MOUNT_URL}/register/${String(registration.client_id)}`,
  )
})

test('the registration URI deletes only for the registration access token it was issued with', async () => {
  const fetchFn = mountedFetch(createFakeOAuthIssuer())
  const registration = await registerFixtureClient(fetchFn)
  const other = await registerFixtureClient(fetchFn)

  const deleted = await fetchFn(String(registration.registration_client_uri), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${String(registration.registration_access_token)}` },
  })
  const foreign = await fetchFn(String(registration.registration_client_uri), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${String(other.registration_access_token)}` },
  })
  const anonymous = await fetchFn(String(registration.registration_client_uri), {
    method: 'DELETE',
  })

  expect(deleted.status).toBe(204)
  expect(foreign.status).toBe(401)
  expect(anonymous.status).toBe(401)
})

test('the authorization endpoint refuses plain PKCE and reports denial on the redirect', async () => {
  const fetchFn = mountedFetch(createFakeOAuthIssuer())
  const registration = await registerFixtureClient(fetchFn)
  const clientId = String(registration.client_id)

  const plain = await fetchFn(
    authorizationRequest(clientId, { code_challenge_method: 'plain' }).toString(),
  )
  const denied = await completeConsent(fetchFn, authorizationRequest(clientId, {}), 'deny')

  expect(plain.status).toBe(302)
  expect(new URL(plain.headers.get('location') ?? '').searchParams.get('error')).toBe(
    'invalid_request',
  )
  expect(denied.location.searchParams.get('error')).toBe('access_denied')
  expect(denied.location.searchParams.get('iss')).toBe(MOUNT_URL)
  expect(denied.location.searchParams.get('state')).toBe('fixture-state')
})

test('an authorization code is redeemable on a second instance and only with its own verifier', async () => {
  const issuing = mountedFetch(createFakeOAuthIssuer())
  const consuming = mountedFetch(createFakeOAuthIssuer())
  const registration = await registerFixtureClient(issuing)
  const verifier = 'fixture-code-verifier-that-is-long-enough-to-be-real'
  const challenge = await sha256Base64Url(verifier)
  const consent = await completeConsent(
    issuing,
    authorizationRequest(String(registration.client_id), { code_challenge: challenge }),
    'approve',
  )
  const code = consent.location.searchParams.get('code') ?? ''

  const wrongVerifier = await tokenRequest(consuming, {
    grant_type: 'authorization_code',
    code,
    code_verifier: `${verifier}-not`,
    redirect_uri: REDIRECT_URI,
  })
  const exchanged = await tokenRequest(consuming, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  })

  expect(wrongVerifier.status).toBe(400)
  expect(wrongVerifier.body).toMatchObject({ error: 'invalid_grant' })
  expect(exchanged.status).toBe(200)
  expect(exchanged.body).toMatchObject({
    access_token: expect.stringMatching(/^fake-oauth-access-/),
    token_type: 'Bearer',
  })
})

test('the SDK MCP client initializes, lists tools, and reads an oversized result over SSE', async () => {
  const exchanges: { url: string; method: string; status: number; contentType: string | null }[] =
    []
  const fetchFn = recordingFetch(mountedFetch(createFakeOAuthIssuer()), exchanges)
  const { provider } = await authorizedFixtureClient(fetchFn)

  const client = new Client({ name: 'duet-fixture-test', version: '1.0.0' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${MOUNT_URL}/mcp`), {
        authProvider: provider,
        fetch: fetchFn,
      }),
    )
    const tools = await client.listTools()
    const echoed = await client.callTool({ name: 'echo', arguments: { message: 'hello' } })
    const oversized = await client.callTool({ name: FAKE_MCP_OVERSIZED_TOOL, arguments: {} })

    expect(client.getServerVersion()).toMatchObject({ name: FAKE_MCP_SERVER_NAME })
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      'echo',
      FAKE_MCP_OVERSIZED_TOOL,
      'whoami',
    ])
    expect(echoed.content).toEqual([{ type: 'text', text: 'echo: hello' }])

    const document = (oversized.content as { text: string }[])[0]?.text ?? ''
    expect(document.length).toBeGreaterThan(128 * 1_024)
    // Real servers duplicate their payload into structuredContent; a client that
    // caps results must be able to drop the copy first.
    expect(oversized.structuredContent).toEqual({ document })

    // Every JSON-RPC answer is SSE-framed, the way every real server measured in
    // slice 00 answered — including `initialize` and `tools/list`.
    const answered = exchanges.filter(
      exchange => exchange.url.endsWith('/mcp') && exchange.status === 200,
    )
    expect(answered.length).toBe(4)
    expect(answered.every(exchange => exchange.contentType === 'text/event-stream')).toBe(true)
  } finally {
    await client.close()
  }
})

test('the MCP resource refuses a device-flow credential', async () => {
  const issuer = createFakeOAuthIssuer({ approvalDelayMs: 0 })
  const fetchFn = mountedFetch(issuer)
  const device = await post(issuer.fetch, '/device/code', {
    client_id: 'duet-agent:openai-codex',
    scope: 'openid profile email',
  })
  const tokens = await post(issuer.fetch, '/token', {
    device_code: device.device_code,
    grant_type: DEVICE_GRANT,
  })

  const response = await fetchFn(`${MOUNT_URL}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${String(tokens.access_token)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

  expect(response.status).toBe(401)
  expect(extractWWWAuthenticateParams(response).resourceMetadataUrl?.toString()).toBe(
    `${MOUNT_URL}/.well-known/oauth-protected-resource`,
  )
})

test('refreshing through the SDK rotates on the first refresh and preserves on the second', async () => {
  const fetchFn = mountedFetch(createFakeOAuthIssuer())
  const { provider, tokens } = await authorizedFixtureClient(fetchFn)
  const serverUrl = `${MOUNT_URL}/mcp`

  expect(await auth(provider, { serverUrl, fetchFn })).toBe('AUTHORIZED')
  const rotated = provider.savedTokens as OAuthTokens
  expect(await auth(provider, { serverUrl, fetchFn })).toBe('AUTHORIZED')
  const preserved = provider.savedTokens as OAuthTokens

  expect(rotated.token_type).toBe('Bearer')
  expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
  // The fixture withholds a new refresh token every other time on purpose, so
  // the client's "the AS returned none, keep the old one" branch is exercised.
  expect(preserved.refresh_token).toBe(rotated.refresh_token)
  expect(preserved.access_token).not.toBe(rotated.access_token)
})

test('revocation answers 200 for a live token and for one it has never seen', async () => {
  const fetchFn = mountedFetch(createFakeOAuthIssuer())
  const { tokens } = await authorizedFixtureClient(fetchFn)

  const live = await fetchFn(`${MOUNT_URL}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: tokens.refresh_token ?? '',
      token_type_hint: 'refresh_token',
    }),
  })
  const unknown = await fetchFn(`${MOUNT_URL}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'never-minted-here' }),
  })

  expect(live.status).toBe(200)
  expect(unknown.status).toBe(200)
})

/**
 * Mirrors `apps/api/src/routes/fake-oauth-issuer.ts`: only paths under the
 * mount reach the issuer, and the prefix is stripped before it does. Everything
 * else is the API's own 404 — which is what the SDK's first two authorization
 * server discovery candidates hit.
 */
function mountedFetch(issuer: FakeOAuthIssuer): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${MOUNT_PATH}/`)) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    url.pathname = url.pathname.slice(MOUNT_PATH.length)
    return await issuer.fetch(new Request(url.toString(), request as unknown as RequestInit))
  }) as unknown as typeof fetch
}

/**
 * The smallest `OAuthClientProvider` that can drive a real flow: it stores what
 * the SDK hands it and captures the authorization URL instead of navigating.
 */
class FixtureClientProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined
  savedClient: OAuthClientInformationFull | undefined
  savedTokens: OAuthTokens | undefined
  private verifier = ''
  private discovery:
    | Parameters<NonNullable<OAuthClientProvider['saveDiscoveryState']>>[0]
    | undefined

  /** Set it to offer a Client ID Metadata Document instead of registering. */
  constructor(readonly clientMetadataUrl?: string) {}

  get redirectUrl(): string {
    return REDIRECT_URI
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Duet (fixture)',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.savedClient
  }

  saveClientInformation(information: OAuthClientInformationFull): void {
    this.savedClient = information
  }

  tokens(): OAuthTokens | undefined {
    return this.savedTokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.savedTokens = tokens
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    return this.verifier
  }

  state(): string {
    return 'fixture-state'
  }

  // Real clients cache discovery across the consent redirect; without it the
  // second `auth()` call would rediscover from the bare server URL, where none
  // of this issuer's documents are reachable.
  saveDiscoveryState(
    state: Parameters<NonNullable<OAuthClientProvider['saveDiscoveryState']>>[0],
  ): void {
    this.discovery = state
  }

  discoveryState(): ReturnType<NonNullable<OAuthClientProvider['discoveryState']>> {
    return this.discovery
  }
}

/** Registers, consents, and exchanges — the state Duet's proxy starts from. */
async function authorizedFixtureClient(
  fetchFn: typeof fetch,
): Promise<{ provider: FixtureClientProvider; tokens: OAuthTokens }> {
  const provider = new FixtureClientProvider()
  const serverUrl = `${MOUNT_URL}/mcp`
  const resourceMetadataUrl = new URL(`${MOUNT_URL}/.well-known/oauth-protected-resource`)
  await auth(provider, { serverUrl, resourceMetadataUrl, fetchFn })
  const consent = await completeConsent(fetchFn, provider.authorizationUrl as URL, 'approve')
  await auth(provider, {
    serverUrl,
    authorizationCode: consent.location.searchParams.get('code') ?? '',
    fetchFn,
  })
  return { provider, tokens: provider.savedTokens as OAuthTokens }
}

/**
 * Drives the consent page the way the browser journey does: read the page,
 * resubmit its own form, follow the redirect it answers with.
 */
async function completeConsent(
  fetchFn: typeof fetch,
  authorizationUrl: URL,
  decision: 'approve' | 'deny',
): Promise<{ html: string; location: URL }> {
  const page = await fetchFn(authorizationUrl.toString())
  const html = await page.text()
  expect(page.headers.get('content-type')).toContain('text/html')

  const action = decodeEntities(/<form[^>]*action="([^"]+)"/.exec(html)?.[1] ?? '')
  const submitted = new URL(action)
  for (const [, name, value] of html.matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
  )) {
    submitted.searchParams.set(decodeEntities(name ?? ''), decodeEntities(value ?? ''))
  }
  submitted.searchParams.set('decision', decision)

  const redirected = await fetchFn(submitted.toString())
  expect(redirected.status).toBe(302)
  return { html, location: new URL(redirected.headers.get('location') ?? '') }
}

/** The document Duet would host at its `client_id` URL (D24). */
function clientMetadataDocument(url: string, redirectUris: string[]): Response {
  if (url !== CLIENT_METADATA_URL) return new Response(null, { status: 404 })
  return Response.json({
    client_id: CLIENT_METADATA_URL,
    client_name: 'Duet (fixture)',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })
}

async function registerFixtureClient(fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchFn(`${MOUNT_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Duet (fixture)',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as Record<string, unknown>
}

function authorizationRequest(clientId: string, overrides: Record<string, string>): URL {
  const url = new URL(`${MOUNT_URL}/authorize`)
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: 'ZmFrZS1jaGFsbGVuZ2UtdmFsdWUtZm9yLXRoZS1maXh0dXJl',
    code_challenge_method: 'S256',
    scope: 'mcp:tools',
    resource: `${MOUNT_URL}/mcp`,
    state: 'fixture-state',
    ...overrides,
  }
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return url
}

async function tokenRequest(
  fetchFn: typeof fetch,
  body: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchFn(`${MOUNT_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  return { status: response.status, body: await response.json() }
}

function recordingFetch(
  fetchFn: typeof fetch,
  exchanges: { url: string; method: string; status: number; contentType: string | null }[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetchFn(input as never, init)
    const request =
      input instanceof Request ? input : new Request(String(input), { method: init?.method })
    exchanges.push({
      url: new URL(request.url).pathname,
      method: request.method,
      status: response.status,
      contentType: response.headers.get('content-type'),
    })
    return response
  }) as unknown as typeof fetch
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

async function post(
  fetchImpl: ReturnType<typeof createFakeOAuthIssuer>['fetch'],
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}
