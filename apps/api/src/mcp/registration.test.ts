import { afterEach, beforeEach, expect, test } from 'bun:test'

import { exchangeAuthorization, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidClientError,
  InvalidGrantError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { convexTest } from 'convex-test'

import type { FetchLike } from '@repo/contract'
import { createFakeOAuthIssuer, FAKE_OAUTH_ISSUER_MOUNT_PATH } from '@repo/fake-oauth-issuer'

import schema from '../../../../packages/backend/convex/schema'
import {
  discoverMcpAuthorizationServer,
  duetMcpClientMetadataDocument,
  mcpClientMetadataUrl,
  mcpOAuthRedirectUri,
  noteMcpClientRejection,
  resolveMcpClientRegistration,
  type McpAuthorizationServer,
  type McpClientCredentials,
  type McpRegistrationStore,
} from './registration'
import { convexMcpRegistrationStore } from './registration-store'

const previousKey = process.env.DUET_API_INTERNAL_KEY
beforeEach(() => {
  process.env.DUET_API_INTERNAL_KEY = 'internal-secret'
})
afterEach(() => {
  if (previousKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = previousKey
})

const ISSUER_ORIGIN = 'https://issuer.test'
const MOUNT_URL = `${ISSUER_ORIGIN}${FAKE_OAUTH_ISSUER_MOUNT_PATH}`
const SERVER_URL = `${MOUNT_URL}/mcp`
const API_URL = 'https://api.duet.test'
const CLIENT_METADATA_URL = mcpClientMetadataUrl(API_URL)

const resolveHost = async (hostname: string) =>
  hostname === 'issuer.test' ? ['203.0.113.10'] : ['203.0.113.11']

test('chooses CIMD when the authorization server advertises it, and registers nothing', async () => {
  const issuer = createFakeOAuthIssuer({ clientMetadataFetch: servedClientMetadata })
  const fetchImpl = mountedFetch(issuer.fetch)
  const store = await registrationStoreFixture()

  const authorizationServer = await discoverMcpAuthorizationServer({
    serverUrl: SERVER_URL,
    fetchImpl,
    resolveHost,
  })
  const credentials = await resolveMcpClientRegistration({
    authorizationServer,
    apiUrl: API_URL,
    store,
    fetchImpl,
    resolveHost,
  })

  // Slice 09 asks consent for this scope and sends this RFC 8707 audience, so
  // discovery has to carry both off the challenge and the resource metadata.
  expect(authorizationServer).toMatchObject({
    authorizationServerUrl: MOUNT_URL,
    scope: 'mcp:tools',
    resource: SERVER_URL,
  })
  expect(credentials).toEqual({ method: 'cimd', clientId: CLIENT_METADATA_URL })
  // The issuer records the path it saw, with the mount prefix already stripped.
  expect(issuer.requests.map(entry => entry.path)).not.toContain('/register')
  expect(await store.rows()).toEqual([])
})

test('the CIMD client id Duet publishes is accepted through consent and token exchange', async () => {
  const issuer = createFakeOAuthIssuer({ clientMetadataFetch: servedClientMetadata })
  const fetchImpl = mountedFetch(issuer.fetch)

  const tokens = await consentAndExchange(
    fetchImpl,
    await connect(fetchImpl, await registrationStoreFixture()),
  )

  expect(tokens).toMatchObject({ access_token: expect.stringMatching(/^fake-oauth-access-/) })
})

test('falls back to DCR, keeps the RFC 7592 fields, and the minted client id works', async () => {
  const issuer = createFakeOAuthIssuer()
  const fetchImpl = mountedFetch(issuer.fetch)
  const store = await registrationStoreFixture()

  const connected = await connect(fetchImpl, store)
  const tokens = await consentAndExchange(fetchImpl, connected)

  // Captured before the first assertion: Bun's asymmetric matchers overwrite
  // the fields they match on the received object.
  const clientId = connected.credentials.clientId
  expect(connected.credentials).toMatchObject({
    method: 'dcr',
    clientId: expect.stringMatching(/^fake-oauth-client-/),
  })
  // The regression that fails the moment anyone reintroduces the SDK's
  // `registerClient()`: it parses both fields away, and they are the only two
  // that make a registration deletable.
  expect((await store.rows())[0]).toMatchObject({
    authorizationServer: MOUNT_URL,
    registrationClientUri: `${MOUNT_URL}/register/${clientId}`,
    registrationAccessToken: expect.stringMatching(/^fake-oauth-registration-/),
    tokenEndpointAuthMethod: 'none',
  })
  expect(connected.credentials).toHaveProperty('registrationId', (await store.rows())[0]!._id)
  expect(tokens).toMatchObject({ access_token: expect.stringMatching(/^fake-oauth-access-/) })
})

test('two concurrent connects behind one authorization server register once, loser deleted', async () => {
  const issuer = createFakeOAuthIssuer()
  const minted: string[] = []
  const fetchImpl = recordingMints(mountedFetch(issuer.fetch), minted)
  const store = await registrationStoreFixture()

  const [first, second] = await Promise.all([connect(fetchImpl, store), connect(fetchImpl, store)])

  const survivor = (await store.rows()).at(0)?.clientId ?? 'no registration survived'
  expect((await store.rows()).map(row => row.authorizationServer)).toEqual([MOUNT_URL])
  // Both connects end up holding the SAME client id — the surviving row's.
  expect([first.credentials.clientId, second.credentials.clientId]).toEqual([survivor, survivor])
  // Two were minted, because both connects passed the reuse read before either
  // wrote; exactly the one that lost the swap was deleted again.
  expect(minted).toHaveLength(2)
  expect(minted).toContain(survivor)
  expect(deletedClientIds(issuer)).toEqual(minted.filter(clientId => clientId !== survivor))
})

test('a second server behind the same authorization server reuses without registering again', async () => {
  const issuer = createFakeOAuthIssuer()
  const fetchImpl = mountedFetch(issuer.fetch)
  const store = await registrationStoreFixture()

  const first = await connect(fetchImpl, store)
  const second = await connect(fetchImpl, store)

  expect(second.credentials.clientId).toBe(first.credentials.clientId)
  expect(registrationPosts(issuer)).toBe(1)
  expect(deletedClientIds(issuer)).toEqual([])
})

test('an invalid_client marks the registration instead of silently registering again', async () => {
  const issuer = createFakeOAuthIssuer()
  const fetchImpl = mountedFetch(issuer.fetch)
  const store = await registrationStoreFixture()
  const rejected = await connect(fetchImpl, store)
  const deadClientId = rejected.credentials.clientId

  const noted = await noteMcpClientRejection({
    store,
    credentials: rejected.credentials,
    error: new InvalidClientError('client is unknown here'),
  })
  // The AS is still rejecting, so a re-register must be a deliberate act. Only
  // the next connect performs one, and it performs exactly one.
  expect((await store.rows()).map(row => row.invalidReason)).toEqual(['invalid_client'])
  const reconnected = await connect(fetchImpl, store)

  expect(noted).toBe('marked')
  // `auth()` would have invalidated the credentials and re-registered inside
  // the very call that failed; nothing here does.
  expect(registrationPosts(issuer)).toBe(2)
  expect((await store.rows()).map(row => row.invalidReason)).toEqual([undefined])
  expect(reconnected.credentials.clientId).not.toBe(deadClientId)
})

test('an error that is not the AS disowning the client leaves the registration alone', async () => {
  const issuer = createFakeOAuthIssuer()
  const fetchImpl = mountedFetch(issuer.fetch)
  const store = await registrationStoreFixture()
  const connected = await connect(fetchImpl, store)

  const noted = await noteMcpClientRejection({
    store,
    credentials: connected.credentials,
    error: new InvalidGrantError('the authorization code expired'),
  })

  expect(noted).toBe('not_a_client_rejection')
  expect((await store.rows()).map(row => row.invalidReason)).toEqual([undefined])
})

test('a rejected CIMD client has no registration to mark', async () => {
  const noted = await noteMcpClientRejection({
    store: await registrationStoreFixture(),
    credentials: { method: 'cimd', clientId: CLIENT_METADATA_URL },
    error: new InvalidClientError('client metadata document refused'),
  })

  expect(noted).toBe('no_registration')
})

test('refuses OAuth outright when the server offers neither CIMD nor registration', async () => {
  const store = await registrationStoreFixture()

  const authorizationServer = await discoverMcpAuthorizationServer({
    serverUrl: `${UNREGISTRABLE_ORIGIN}/mcp`,
    fetchImpl: unregistrableServer,
    resolveHost,
  })
  const refused = resolveMcpClientRegistration({
    authorizationServer,
    apiUrl: API_URL,
    store,
    fetchImpl: unregistrableServer,
    resolveHost,
  })

  await expect(refused).rejects.toMatchObject({ code: 'oauth_unsupported' })
  expect(await store.rows()).toEqual([])
})

/**
 * D7's refusal branch has a live example: GitHub Copilot's MCP server
 * challenges properly, publishes protected-resource metadata, and then
 * advertises neither client id metadata documents nor a registration endpoint.
 */
const UNREGISTRABLE_ORIGIN = 'https://copilot.test'

const unregistrableServer: FetchLike = async input => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.pathname === '/mcp') {
    return new Response(null, {
      status: 401,
      headers: {
        'www-authenticate': `Bearer resource_metadata="${UNREGISTRABLE_ORIGIN}/.well-known/oauth-protected-resource"`,
      },
    })
  }
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    return Response.json({
      resource: `${UNREGISTRABLE_ORIGIN}/mcp`,
      authorization_servers: [UNREGISTRABLE_ORIGIN],
      scopes_supported: ['mcp'],
    })
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return Response.json({
      issuer: UNREGISTRABLE_ORIGIN,
      authorization_endpoint: `${UNREGISTRABLE_ORIGIN}/authorize`,
      token_endpoint: `${UNREGISTRABLE_ORIGIN}/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    })
  }
  return Response.json({ error: 'not_found' }, { status: 404 })
}

function registrationPosts(issuer: ReturnType<typeof createFakeOAuthIssuer>): number {
  return issuer.requests.filter(entry => entry.method === 'POST' && entry.path === '/register')
    .length
}

/** The issuer records requests, not answers, so the minted ids are read here. */
function recordingMints(fetchImpl: FetchLike, minted: string[]): FetchLike {
  const bothArrived = Promise.withResolvers<void>()
  let arrivals = 0
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (init?.method === 'POST' && url.pathname === `${FAKE_OAUTH_ISSUER_MOUNT_PATH}/register`) {
      arrivals += 1
      if (arrivals === 2) bothArrived.resolve()
      await bothArrived.promise
    }
    const response = await fetchImpl(input, init)
    if (url.pathname !== `${FAKE_OAUTH_ISSUER_MOUNT_PATH}/register` || !response.ok) return response
    const copy = response.clone()
    const document = (await copy.json()) as { client_id?: string }
    if (document.client_id !== undefined) minted.push(document.client_id)
    return response
  }
}

function deletedClientIds(issuer: ReturnType<typeof createFakeOAuthIssuer>): string[] {
  const prefix = '/register/'
  return issuer.requests
    .filter(entry => entry.method === 'DELETE' && entry.path.startsWith(prefix))
    .map(entry => entry.path.slice(prefix.length))
}

/** Discovery plus D7's choice — what slice 09's connect route will do. */
async function connect(
  fetchImpl: FetchLike,
  store: McpRegistrationStore,
): Promise<{ authorizationServer: McpAuthorizationServer; credentials: McpClientCredentials }> {
  const authorizationServer = await discoverMcpAuthorizationServer({
    serverUrl: SERVER_URL,
    fetchImpl,
    resolveHost,
  })
  const credentials = await resolveMcpClientRegistration({
    authorizationServer,
    apiUrl: API_URL,
    store,
    fetchImpl,
    resolveHost,
  })
  return { authorizationServer, credentials }
}

/**
 * The rest of the flow, so a client id is proven usable rather than merely
 * chosen: authorize, approve on the issuer's own consent page, redeem the code.
 */
async function consentAndExchange(
  fetchImpl: FetchLike,
  connected: { authorizationServer: McpAuthorizationServer; credentials: McpClientCredentials },
): Promise<Record<string, unknown>> {
  const metadata = connected.authorizationServer.metadata as unknown as Parameters<
    typeof startAuthorization
  >[1]['metadata']
  const clientInformation = { client_id: connected.credentials.clientId }
  const redirectUri = mcpOAuthRedirectUri(API_URL)
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    connected.authorizationServer.authorizationServerUrl,
    {
      metadata,
      clientInformation,
      redirectUrl: redirectUri,
      state: 'slice-08-state',
      ...(connected.authorizationServer.scope === undefined
        ? {}
        : { scope: connected.authorizationServer.scope }),
    },
  )

  const page = await fetchImpl(authorizationUrl.toString())
  const html = await page.text()
  const submitted = new URL(decodeEntities(/<form[^>]*action="([^"]+)"/.exec(html)?.[1] ?? ''))
  for (const [, name, value] of html.matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
  )) {
    submitted.searchParams.set(decodeEntities(name ?? ''), decodeEntities(value ?? ''))
  }
  submitted.searchParams.set('decision', 'approve')
  const redirected = await fetchImpl(submitted.toString())
  const location = new URL(redirected.headers.get('location') ?? '')

  return (await exchangeAuthorization(connected.authorizationServer.authorizationServerUrl, {
    metadata,
    clientInformation,
    authorizationCode: location.searchParams.get('code') ?? '',
    codeVerifier,
    redirectUri,
    fetchFn: fetchImpl as unknown as typeof fetch,
  })) as unknown as Record<string, unknown>
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

/** The document `apps/api` serves at Duet's `client_id` URL, as the issuer sees it. */
async function servedClientMetadata(url: string): Promise<Response> {
  if (url !== CLIENT_METADATA_URL) return new Response(null, { status: 404 })
  return Response.json(duetMcpClientMetadataDocument(API_URL))
}

/**
 * The issuer is path-mounted, exactly as `apps/api` mounts it: only requests
 * under the mount reach it, and everything else is the API's own 404 — which
 * is what the SDK's first two authorization-server discovery candidates hit.
 */
function mountedFetch(issuerFetch: FetchLike): FetchLike {
  return async (input, init) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    const url = new URL(request.url)
    if (
      url.origin !== ISSUER_ORIGIN ||
      !url.pathname.startsWith(`${FAKE_OAUTH_ISSUER_MOUNT_PATH}/`)
    ) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    url.pathname = url.pathname.slice(FAKE_OAUTH_ISSUER_MOUNT_PATH.length)
    return await issuerFetch(new Request(url.toString(), request as unknown as RequestInit))
  }
}

async function registrationStoreFixture() {
  const t = convexTest(schema, {
    '../../../../packages/backend/convex/_generated/api.ts': async () => ({}),
    '../../../../packages/backend/convex/domains/mcpServers/credentials.ts': () =>
      import('../../../../packages/backend/convex/domains/mcpServers/credentials'),
  })
  const workspaceId = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'registration-flow@example.test',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    return await ctx.db.insert('workspaces', {
      slug: 'registration-flow',
      name: 'Registration flow',
      status: 'active',
      billingUserId: userId,
      createdAt: 1,
    })
  })
  const store = convexMcpRegistrationStore({
    convex: { query: t.query.bind(t), mutation: t.mutation.bind(t) } as never,
    internalKey: 'internal-secret',
    workspaceId,
    now: () => 1_000,
  })
  return { ...store, rows: () => t.run(ctx => ctx.db.query('mcpClientRegistrations').collect()) }
}
