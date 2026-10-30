import {
  buildDiscoveryUrls,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'

import type { FetchLike } from '@repo/contract'

import { guardedFetch, type HostResolver } from './ssrf'

/**
 * How Duet obtains a `client_id` from somebody else's authorization server.
 *
 * D7's revised order is CIMD → DCR → refuse. The MCP authorization spec now
 * calls Dynamic Client Registration deprecated, "retained for backwards
 * compatibility with authorization servers that do not support Client ID
 * Metadata Documents", and slice 00 found every OAuth-capable server it
 * probed — Linear, Notion, Sentry — already advertising CIMD. So the CIMD
 * branch is the hot path and DCR is the cold fallback: still built, because the
 * tested set is not the world, but not the shape the design serves.
 *
 * The difference matters beyond taste. A CIMD client is a URL, so nothing is
 * registered and nothing can be orphaned — D18's whole problem dissolves. DCR
 * mints state on a third party that only RFC 7592 can remove, which is why this
 * module issues that POST itself and keeps the raw body: the SDK's
 * `registerClient()` parses through two `.strip()`ed schemas that discard
 * `registration_client_uri` and `registration_access_token`, the only two
 * fields that make a registration deletable.
 */

/** Where `apps/api` publishes D24's Client ID Metadata Document. */
export const MCP_CLIENT_METADATA_PATH = '/.well-known/duet-mcp-client.json'

/** The one redirect URI Duet ever asks an authorization server to call back. */
export const MCP_OAUTH_CALLBACK_PATH = '/v1/mcp-servers/oauth/callback'

export function mcpClientMetadataUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}${MCP_CLIENT_METADATA_PATH}`
}

export function mcpOAuthRedirectUri(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}${MCP_OAUTH_CALLBACK_PATH}`
}

/**
 * Duet as an OAuth client, in the one shape both branches need.
 *
 * The very same fields are the body of the DCR POST and the substance of the
 * CIMD document, so they are written once. The document adds `client_id` (SEP
 * 991: the document names the URL it is served from); a registration request
 * must not, because that field is the authorization server's to assign.
 */
export function duetMcpClientMetadata(apiUrl: string): Record<string, unknown> {
  return {
    client_name: 'Duet',
    client_uri: 'https://duet.so',
    redirect_uris: [mcpOAuthRedirectUri(apiUrl)],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // Duet holds no client secret: a serverless deployment that registered as a
    // confidential client would have to store one per authorization server, and
    // PKCE is what actually binds the code to this client.
    token_endpoint_auth_method: 'none',
  }
}

export function duetMcpClientMetadataDocument(apiUrl: string): Record<string, unknown> {
  return { client_id: mcpClientMetadataUrl(apiUrl), ...duetMcpClientMetadata(apiUrl) }
}

/**
 * What discovery found, with the metadata document kept RAW.
 *
 * The SDK's parsed metadata is a strip-mode `z.object`, so it silently drops
 * whatever the branch it took does not declare. Measured against a document
 * carrying all four: the OIDC branch keeps `registration_endpoint` and
 * `client_id_metadata_document_supported` but loses `revocation_endpoint` and
 * `authorization_response_iss_parameter_supported`, because only the OAuth
 * schema declares those two.
 *
 * So D7's gate would survive the parsed object and RFC 7009 and RFC 9207 would
 * not. Reading the raw document is what makes all four questions answerable
 * from one place, rather than two that happen to work and two that silently
 * do not.
 */
export interface McpAuthorizationServer {
  /** The issuer URL RFC 9728 pointed at, used verbatim for every OAuth call. */
  authorizationServerUrl: string
  metadata: Record<string, unknown>
  /** The scope to ask consent for, per the MCP spec's own selection order. */
  scope?: string
  /** RFC 8707 audience: the resource identifier the server published. */
  resource?: string
}

export class McpAuthorizationServerUnreachableError extends Error {
  constructor(readonly detail: string) {
    super(`mcp authorization server discovery failed (${detail})`)
    this.name = 'McpAuthorizationServerUnreachableError'
  }
}

export interface DiscoverMcpAuthorizationServerOptions {
  serverUrl: string
  fetchImpl: FetchLike
  resolveHost?: HostResolver
}

/**
 * The RFC 9728 walk, taken through the `WWW-Authenticate` challenge.
 *
 * The challenge is not an optimization here: under a path-mounted issuer both
 * of `discoverOAuthProtectedResourceMetadata`'s own fallbacks land outside the
 * mount, so the challenge's `resource_metadata` is the only pointer that works.
 * That is also the flow the spec describes, so nothing is lost by following it.
 */
export async function discoverMcpAuthorizationServer(
  options: DiscoverMcpAuthorizationServerOptions,
): Promise<McpAuthorizationServer> {
  const guarded = guardedFetch(options.fetchImpl, options.resolveHost)
  const challenged = await guarded(options.serverUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'duet', version: '1.0.0' },
      },
    }),
  })
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(challenged)
  // The challenge is a header; the body is never read, and an unconsumed one
  // holds its socket open for the rest of the invocation.
  await challenged.body?.cancel()

  const info = await discoverOAuthServerInfo(options.serverUrl, {
    ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
    fetchFn: guarded,
  })
  const metadata = await fetchMcpAuthorizationServerMetadata({
    authorizationServerUrl: info.authorizationServerUrl,
    fetchImpl: options.fetchImpl,
    ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
  })
  return {
    authorizationServerUrl: info.authorizationServerUrl,
    metadata,
    // The MCP authorization spec's order: the challenge's own `scope` first,
    // the protected-resource metadata's `scopes_supported` second. Asking for a
    // scope the server never named is how an authorization request gets refused.
    ...optional('scope', scope ?? info.resourceMetadata?.scopes_supported?.join(' ')),
    ...optional('resource', info.resourceMetadata?.resource),
  }
}

/**
 * The raw metadata document, fetched over the SDK's own candidate list.
 *
 * `discoverAuthorizationServerMetadata` would answer the same question and then
 * throw the answer away through a strip-mode schema, so only the URL-building
 * half of it is reused.
 *
 * The consent callback needs this document a second time, long after discovery:
 * D23's `iss` table branches on `authorization_response_iss_parameter_supported`,
 * which is one of the fields the strip-mode schema discards.
 */
export async function fetchMcpAuthorizationServerMetadata(options: {
  authorizationServerUrl: string
  fetchImpl: FetchLike
  resolveHost?: HostResolver
}): Promise<Record<string, unknown>> {
  const guarded = guardedFetch(options.fetchImpl, options.resolveHost)
  for (const candidate of buildDiscoveryUrls(options.authorizationServerUrl)) {
    const response = await guarded(candidate.url.toString(), {
      headers: { 'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION },
    })
    if (!response.ok) {
      await response.body?.cancel()
      continue
    }
    const document = (await response.json().catch(() => null)) as unknown
    if (isRecord(document)) return document
  }
  throw new McpAuthorizationServerUnreachableError(options.authorizationServerUrl)
}

/** D7's third branch. The UI answers it with slice 05's static-token path. */
export class McpOAuthUnsupportedError extends Error {
  readonly code = 'oauth_unsupported'

  constructor(readonly authorizationServerUrl: string) {
    super('authorization server supports neither client id metadata documents nor registration')
    this.name = 'McpOAuthUnsupportedError'
  }
}

export type McpClientCredentials =
  /* Duet's `client_id` IS the URL of the document it publishes. Nothing is
     stored on the third party, so nothing can be orphaned. */
  | { method: 'cimd'; clientId: string }
  /* A registration this workspace minted, reused by every server behind the
     same authorization server. No client secret rides here: Duet registers as a
     public client (`token_endpoint_auth_method: none`), so PKCE is what binds
     the code, and the credential read deliberately never returns one. */
  | { method: 'dcr'; clientId: string; registrationId: string; tokenEndpointAuthMethod?: string }

/** The registration row as everything outside Convex is allowed to see it. */
export interface StoredMcpClientRegistration {
  id: string
  authorizationServer: string
  clientId: string
  tokenEndpointAuthMethod?: string
}

/** Every field of a DCR response that survives into the row. */
export interface McpClientRegistrationInput {
  authorizationServer: string
  clientId: string
  clientSecret?: string
  tokenEndpointAuthMethod?: string
  clientSecretExpiresAt?: number
  registrationClientUri?: string
  registrationAccessToken?: string
}

export interface McpRegistrationStore {
  /** The live registration for this authorization server, if there is one. */
  read(authorizationServer: string): Promise<StoredMcpClientRegistration | null>
  /**
   * D18's compare-and-swap: the first writer for a (workspace, authorization
   * server) wins, and every later one is told the row already exists so it can
   * clean up the registration it just minted.
   */
  adopt(
    input: McpClientRegistrationInput,
  ): Promise<{ status: 'adopted' | 'exists'; registration: StoredMcpClientRegistration }>
  /** Mark a registration the authorization server has rejected. */
  invalidate(registrationId: string, reason: string): Promise<void>
}

export interface ResolveMcpClientRegistrationOptions {
  authorizationServer: McpAuthorizationServer
  /**
   * This deployment's origin. Both branches are derived from it here rather
   * than passed in as a pair, because a `client_id` URL that does not match the
   * document Duet actually serves fails at the third party, at consent time,
   * with an `invalid_client` that names nothing.
   */
  apiUrl: string
  store: McpRegistrationStore
  fetchImpl: FetchLike
  resolveHost?: HostResolver
}

/**
 * D7's priority order, and the only place in Duet that ever registers a client.
 */
export async function resolveMcpClientRegistration(
  options: ResolveMcpClientRegistrationOptions,
): Promise<McpClientCredentials> {
  const { metadata, authorizationServerUrl } = options.authorizationServer
  // D18: one registration per (workspace, authorization server). The reuse read
  // comes FIRST so the common case — a second server behind an authorization
  // server this workspace already registered with — makes no DCR call at all.
  const existing = await readMcpClientRegistration(options)
  if (existing !== null) return existing

  const registrationEndpoint = metadata.registration_endpoint
  if (typeof registrationEndpoint !== 'string') {
    throw new McpOAuthUnsupportedError(authorizationServerUrl)
  }

  const guarded = guardedFetch(options.fetchImpl, options.resolveHost)
  const registered = await registerClientDirectly(
    registrationEndpoint,
    duetMcpClientMetadata(options.apiUrl),
    guarded,
  )
  const adoption = await options.store.adopt({
    authorizationServer: authorizationServerUrl,
    ...registered,
  })
  if (adoption.status === 'adopted') return dcrCredentials(adoption.registration)

  // Somebody else's registration got there first. Ours is live on the third
  // party and only RFC 7592 can remove it, so the loser cleans up after itself
  // — best effort, because a failure here is an orphan nothing can reach.
  await deleteRegistrationBestEffort(registered, guarded)
  return dcrCredentials(adoption.registration)
}

/**
 * D7's order, minus the branch that mints anything.
 *
 * The consent callback resolves the client a second time, after the browser has
 * been away, and it must arrive at the client the authorize leg used or the
 * authorization server refuses the code. Registering there instead would leave a
 * second "Duet" client on the third party in the middle of a flow the first one
 * started — so the two callers share this read and only one of them can go on to
 * register.
 */
export async function readMcpClientRegistration(options: {
  authorizationServer: McpAuthorizationServer
  apiUrl: string
  store: Pick<McpRegistrationStore, 'read'>
}): Promise<McpClientCredentials | null> {
  const { metadata, authorizationServerUrl } = options.authorizationServer
  // A CIMD client is a URL Duet publishes, so it is the same answer every time
  // and nothing has to have been stored for it to be available.
  if (metadata.client_id_metadata_document_supported === true) {
    return { method: 'cimd', clientId: mcpClientMetadataUrl(options.apiUrl) }
  }
  const reused = await options.store.read(authorizationServerUrl)
  return reused === null ? null : dcrCredentials(reused)
}

function dcrCredentials(registration: StoredMcpClientRegistration): McpClientCredentials {
  return {
    method: 'dcr',
    clientId: registration.clientId,
    registrationId: registration.id,
    ...optional('tokenEndpointAuthMethod', registration.tokenEndpointAuthMethod),
  }
}

/**
 * RFC 7591, issued by Duet rather than by the SDK's `registerClient()`.
 *
 * The helper parses its response through `OAuthClientInformationFullSchema`,
 * which merges two `.strip()`ed schemas declaring neither
 * `registration_client_uri` nor `registration_access_token`. Those two fields
 * are the whole of RFC 7592, so routing this POST through the SDK would make
 * every registration Duet ever mints permanently undeletable. Fifteen lines
 * here buy the cleanup back.
 */
async function registerClientDirectly(
  registrationEndpoint: string,
  clientMetadata: Record<string, unknown>,
  fetchImpl: FetchLike,
): Promise<Omit<McpClientRegistrationInput, 'authorizationServer'>> {
  const response = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(clientMetadata),
  })
  const document = (await response.json().catch(() => null)) as unknown
  if (!response.ok || !isRecord(document) || typeof document.client_id !== 'string') {
    throw new McpClientRegistrationFailedError(response.status, errorCodeOf(document))
  }
  return {
    clientId: document.client_id,
    ...optional('clientSecret', stringField(document, 'client_secret')),
    ...optional('tokenEndpointAuthMethod', stringField(document, 'token_endpoint_auth_method')),
    ...optional('clientSecretExpiresAt', expiresAtMs(document.client_secret_expires_at)),
    ...optional('registrationClientUri', stringField(document, 'registration_client_uri')),
    ...optional('registrationAccessToken', stringField(document, 'registration_access_token')),
  }
}

export class McpClientRegistrationFailedError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode?: string,
  ) {
    super(`dynamic client registration failed (${status}${errorCode ? ` ${errorCode}` : ''})`)
    this.name = 'McpClientRegistrationFailedError'
  }
}

/**
 * RFC 7592 delete of a registration Duet minted and then lost the race for.
 *
 * A server that returned neither management field cannot be asked, and a delete
 * that fails leaves an orphan nobody can reach — both are logged rather than
 * raised, because the caller's connect legitimately succeeded on the winner's
 * registration.
 */
async function deleteRegistrationBestEffort(
  fields: Omit<McpClientRegistrationInput, 'authorizationServer'>,
  fetchImpl: FetchLike,
): Promise<void> {
  const { registrationClientUri, registrationAccessToken } = fields
  if (registrationClientUri === undefined || registrationAccessToken === undefined) {
    console.warn('[mcp-registration] orphaned registration; server published no RFC 7592 fields', {
      clientId: fields.clientId,
    })
    return
  }
  try {
    const response = await fetchImpl(registrationClientUri, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${registrationAccessToken}` },
    })
    if (response.ok || response.status === 404) return
    console.warn('[mcp-registration] orphaned registration; RFC 7592 delete refused', {
      clientId: fields.clientId,
      status: response.status,
    })
  } catch (error) {
    console.warn('[mcp-registration] orphaned registration; RFC 7592 delete failed', {
      clientId: fields.clientId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function stringField(document: Record<string, unknown>, name: string): string | undefined {
  const value = document[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** RFC 7591 sends seconds since the epoch; `0` means it never expires. */
function expiresAtMs(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value * 1_000 : undefined
}

function errorCodeOf(document: unknown): string | undefined {
  return isRecord(document) ? stringField(document, 'error') : undefined
}

/**
 * What Duet does instead of letting the SDK re-register.
 *
 * `auth()` treats `invalid_client` and `unauthorized_client` as a reason to
 * call `invalidateCredentials('all')` and perform a **fresh** DCR inside the
 * very call that failed (`client/auth.js:152-155`, `:227-257`). Against a
 * flapping authorization server that is a stream of orphaned "Duet"
 * registrations, which is the exact outcome D18 exists to prevent.
 *
 * So the rejection is recorded and nothing else happens. The row survives with
 * `invalidAt` set, the reuse read stops returning it, and the NEXT connect —
 * one human click, once — registers deliberately.
 */
export type McpClientRejectionOutcome = 'marked' | 'no_registration' | 'not_a_client_rejection'

export async function noteMcpClientRejection(options: {
  store: McpRegistrationStore
  credentials: McpClientCredentials
  error: unknown
}): Promise<McpClientRejectionOutcome> {
  const reason = clientRejectionCode(options.error)
  if (reason === undefined) return 'not_a_client_rejection'
  // A CIMD client is a URL, not a row: there is nothing stored to mark, and a
  // rejection means the authorization server refused Duet's document itself.
  if (options.credentials.method !== 'dcr') return 'no_registration'
  await options.store.invalidate(options.credentials.registrationId, reason)
  return 'marked'
}

/**
 * The two OAuth error codes that mean "this client id is no longer yours".
 * Read off the code rather than the class so a plain token-endpoint error body,
 * which is all a hand-rolled exchange has, is recognized the same way.
 */
function clientRejectionCode(error: unknown): string | undefined {
  const code =
    (error as { errorCode?: unknown; error?: unknown } | null)?.errorCode ??
    (error as { error?: unknown } | null)?.error
  return code === 'invalid_client' || code === 'unauthorized_client' ? code : undefined
}

function optional<K extends string, T>(key: K, value: T | undefined): Record<K, T> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
