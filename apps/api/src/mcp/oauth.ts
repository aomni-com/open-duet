import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { allowedIntegrationRedirect, hashApiKey, type FetchLike } from '@repo/contract'

import { fn, type ApiRouteRuntime } from '../shared'
import {
  decodeSignedDescriptor,
  encodeSignedDescriptor,
  hasExactlyKeys,
  isNonEmptyString,
} from '../signed-descriptor'
import {
  discoverMcpAuthorizationServer,
  duetMcpClientMetadata,
  fetchMcpAuthorizationServerMetadata,
  mcpClientMetadataUrl,
  mcpOAuthRedirectUri,
  noteMcpClientRejection,
  readMcpClientRegistration,
  resolveMcpClientRegistration,
  type McpAuthorizationServer,
  type McpClientCredentials,
} from './registration'
import { convexMcpRegistrationStore } from './registration-store'
import { guardedFetch, type HostResolver } from './ssrf'

/**
 * One human click, one consent round trip, one stored grant.
 *
 * This is the only place in Duet that calls the SDK's `auth()`. On a request
 * path it is a hazard — it refreshes with no expiry check and, given the chance,
 * re-registers the client inside the very call that failed — but here, under a
 * human's click and exactly once, it is what the SDK is for. Two properties
 * keep the hazards out of reach even so:
 *
 * - the provider deliberately has **no `saveClientInformation`**, which makes
 *   the SDK's own DCR structurally impossible (`client/auth.js` throws rather
 *   than registering without it), so D18's registration reuse cannot be
 *   bypassed by the library;
 * - `tokens()` always answers `undefined`, so the refresh branch is unreachable
 *   from here. Refresh belongs to slice 10's lease, which is transactional.
 */

const CONNECT_STATE_VERSION = 1 as const
const CONNECT_STATE_TTL_MS = 10 * 60 * 1_000

/**
 * The OAuth `state` parameter, in full.
 *
 * Not a second query parameter beside it: Duet builds the authorize URL, so the
 * slot the protocol already reserves for round-tripping client context is the
 * right one, and inventing another would mean a value the authorization server
 * is under no obligation to return.
 *
 * Nothing secret rides here. `state` lands in the authorization server's logs
 * and in the browser's history, which is why the PKCE verifier stays in Convex
 * and only the state's *hash* is stored beside it.
 */
export interface McpConnectStateDescriptor {
  version: typeof CONNECT_STATE_VERSION
  kind: 'mcp-connect'
  workspaceSlug: string
  /** The authorization response carries only `code` and `state`; without this
   *  the callback cannot know which row to write, and must never infer it. */
  serverId: string
  /** Correlator, not a secret: two members pressing Connect on one server
   *  produce two verifiers, and each response must find its own. */
  attempt: string
  /** Already validated by `allowedIntegrationRedirect` when this was minted. */
  destination: string
  expiresAt: number
}

const CONNECT_STATE_KEYS = [
  'version',
  'kind',
  'workspaceSlug',
  'serverId',
  'attempt',
  'destination',
  'expiresAt',
] as const

export async function encodeMcpConnectState(
  descriptor: McpConnectStateDescriptor,
  secret: string,
): Promise<string> {
  return await encodeSignedDescriptor(descriptor, secret)
}

/**
 * Every refusal here is the same refusal: this is not a state Duet minted, or
 * not one it still honours. The exact-keys check is what makes a tampered or
 * version-skewed descriptor fail closed instead of partially parsing into a
 * branch nobody wrote.
 */
export async function verifyMcpConnectState(
  value: string | undefined,
  secret: string,
  now: number,
): Promise<McpConnectStateDescriptor | null> {
  const payload = await decodeSignedDescriptor(value, secret)
  if (payload === null || payload.version !== CONNECT_STATE_VERSION) return null
  if (payload.kind !== 'mcp-connect') return null
  if (
    !hasExactlyKeys(payload, CONNECT_STATE_KEYS) ||
    !isNonEmptyString(payload.workspaceSlug) ||
    !isNonEmptyString(payload.serverId) ||
    !isNonEmptyString(payload.attempt) ||
    typeof payload.destination !== 'string' ||
    typeof payload.expiresAt !== 'number' ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= now
  ) {
    return null
  }
  return {
    version: CONNECT_STATE_VERSION,
    kind: 'mcp-connect',
    workspaceSlug: payload.workspaceSlug,
    serverId: payload.serverId,
    attempt: payload.attempt,
    destination: payload.destination,
    expiresAt: payload.expiresAt,
  }
}

/** D23's verdict on the authorization response's `iss`. */
export type AuthorizationResponseIssuerCheck = 'ok' | 'missing' | 'mismatch'

/**
 * RFC 9207, which `@modelcontextprotocol/sdk@1.29.0` does not implement at all.
 *
 * | advertised | `iss` present | action |
 * | --- | --- | --- |
 * | `true` | yes | compare |
 * | `true` | no | reject |
 * | `false`/absent | yes | compare anyway |
 * | `false`/absent | no | proceed |
 *
 * The comparison is byte-for-byte on purpose. Every normalization anyone is
 * tempted to apply — case folding the host, eliding `:443`, trimming a trailing
 * slash, decoding a percent-escape — is a rule about which *different* strings
 * count as the same issuer, and an attacker who controls one of them picks
 * whichever the normalizer collapses.
 *
 * The metadata must be the RAW discovery document. The SDK's parsed metadata is
 * a strip-mode `z.object`, and the OIDC branch does not declare this field, so read from it
 * this flag is always `undefined` and the table's first two rows never run.
 */
export function checkAuthorizationResponseIssuer(input: {
  metadata: Record<string, unknown>
  iss: string | null
  expectedIssuer: string
}): AuthorizationResponseIssuerCheck {
  if (input.iss === null) {
    return input.metadata.authorization_response_iss_parameter_supported === true ? 'missing' : 'ok'
  }
  return input.iss === input.expectedIssuer ? 'ok' : 'mismatch'
}

export interface McpOAuthDeps {
  convex: ApiRouteRuntime['convex']
  internalKey: string
  /** HMAC secret for the state descriptor — the API's own internal key. */
  secret: string
  fetchImpl: FetchLike
  resolveHost?: HostResolver
  /** This deployment's origin: the redirect URI and the CIMD `client_id`. */
  apiUrl: string
  /** The web app, for `allowedIntegrationRedirect`. */
  appUrl: string
  edgeHost: string
  now: () => number
}

const MODEL = 'domains/mcpServers/model'
const CREDENTIALS = 'domains/mcpServers/credentials'
const AUTHORIZATIONS = 'domains/mcpServers/oauth'

export class McpConsentFailedError extends Error {
  constructor(readonly failure: McpConsentFailure) {
    super(`mcp consent failed (${failure})`)
    this.name = 'McpConsentFailedError'
  }
}

export type McpConsentFailure =
  | 'invalid_state'
  | 'authorization_not_found'
  | 'issuer_missing'
  | 'issuer_mismatch'
  | 'authorization_denied'
  | 'authorization_failed'
  | 'missing_code'
  | 'redirect_not_allowed'
  | 'exchange_failed'

/**
 * The authorize leg: discovery, D7's client, PKCE, and a URL for the browser.
 *
 * Nothing is redirected from here. The API answers the URL and the web app
 * performs a **top-level** navigation to it, because a third party's consent
 * page is theirs to frame-protect and most refuse framing outright.
 */
export async function beginMcpOAuthConsent(
  deps: McpOAuthDeps,
  input: {
    workspaceId: string
    workspaceSlug: string
    server: { id: string; name: string; url: string }
    destination: string
  },
): Promise<{ authorizeUrl: string }> {
  const destination = allowedIntegrationRedirect(input.destination, {
    webAppUrl: deps.appUrl,
    workspaceSlug: input.workspaceSlug,
    edgeHost: deps.edgeHost,
  })
  if (destination === null) throw new McpConsentFailedError('redirect_not_allowed')

  const guarded = guardedFetch(deps.fetchImpl, deps.resolveHost)
  const authorizationServer = await discoverMcpAuthorizationServer({
    serverUrl: input.server.url,
    fetchImpl: deps.fetchImpl,
    ...optional('resolveHost', deps.resolveHost),
  })
  const credentials = await resolveMcpClientRegistration({
    authorizationServer,
    apiUrl: deps.apiUrl,
    store: registrationStore(deps, input.workspaceId),
    fetchImpl: deps.fetchImpl,
    ...optional('resolveHost', deps.resolveHost),
  })

  // One deadline for both halves of the attempt. The state and the row it
  // hashes to have to die together, or one of them is briefly redeemable alone.
  const expiresAt = deps.now() + CONNECT_STATE_TTL_MS
  const provider = new McpConnectProvider(deps, {
    workspaceId: input.workspaceId,
    serverId: input.server.id,
    authorizationServer,
    credentials,
    state: await encodeMcpConnectState(
      {
        version: CONNECT_STATE_VERSION,
        kind: 'mcp-connect',
        workspaceSlug: input.workspaceSlug,
        serverId: input.server.id,
        // A correlator, not a secret: it exists so two members pressing Connect
        // on one server mint two distinguishable attempts.
        attempt: crypto.randomUUID(),
        destination,
        expiresAt,
      },
      deps.secret,
    ),
    expiresAt,
    redirectTo: destination,
  })

  const result = await auth(provider, {
    serverUrl: input.server.url,
    fetchFn: guarded,
    ...optional('scope', authorizationServer.scope),
  })
  const authorizeUrl = provider.authorizeUrl
  // `AUTHORIZED` here would mean the SDK found tokens and skipped consent, which
  // `tokens()` makes impossible; anything but a captured URL is a bug, not a
  // state to paper over with a redirect to nowhere.
  if (result !== 'REDIRECT' || authorizeUrl === undefined) {
    throw new Error(`mcp consent did not produce an authorization url (${result})`)
  }
  return { authorizeUrl }
}

export interface McpConsentCallbackParams {
  state?: string
  code?: string
  iss?: string
  error?: string
}

/**
 * The callback leg, in the order that is itself the security property.
 *
 * The state is verified, the pending authorization is claimed exactly once, and
 * RFC 9207's `iss` is checked **before the code is sent anywhere**. Only then is
 * the authorization server's own `error` looked at — a response that failed the
 * issuer check may not be acted on or displayed, and that includes its
 * `error_description` and `error_uri`.
 */
export async function completeMcpOAuthConsent(
  deps: McpOAuthDeps,
  params: McpConsentCallbackParams,
): Promise<{ location: string }> {
  const descriptor = await verifyMcpConnectState(params.state, deps.secret, deps.now())
  if (descriptor === null) throw new McpConsentFailedError('invalid_state')

  const claimed = (await deps.convex.mutation(fn(`${AUTHORIZATIONS}:claimMcpOAuthAuthorization`), {
    internalKey: deps.internalKey,
    hashedState: await hashApiKey(params.state ?? ''),
    serverId: descriptor.serverId,
    now: deps.now(),
  })) as ClaimedAuthorization | null
  // Expired, already redeemed, or minted for a different server: one answer for
  // all three, because telling them apart tells a caller which states exist.
  if (claimed === null) throw new McpConsentFailedError('authorization_not_found')
  // The destination exists in two places on purpose: signed into the state, and
  // on the row the state hashes to. They are written together and must still
  // agree — a disagreement means these two halves came from different attempts.
  // Checked here, before anything is spent, rather than at the redirect: a
  // refusal that has already exchanged the code leaves a grant nobody asked for.
  if (descriptor.destination !== claimed.redirectTo) {
    throw new McpConsentFailedError('redirect_not_allowed')
  }

  const metadata = await fetchMcpAuthorizationServerMetadata({
    authorizationServerUrl: claimed.authorizationServer,
    fetchImpl: deps.fetchImpl,
    ...optional('resolveHost', deps.resolveHost),
  })
  const issuerCheck = checkAuthorizationResponseIssuer({
    metadata,
    iss: params.iss ?? null,
    expectedIssuer: claimed.expectedIssuer,
  })
  if (issuerCheck !== 'ok') {
    throw new McpConsentFailedError(
      issuerCheck === 'missing' ? 'issuer_missing' : 'issuer_mismatch',
    )
  }

  if (params.error !== undefined) {
    // Duet's own words for what happened. The authorization server's
    // `error_description` and `error_uri` are attacker-influenced text and are
    // never read, let alone shown.
    throw new McpConsentFailedError(
      params.error === 'access_denied' ? 'authorization_denied' : 'authorization_failed',
    )
  }
  if (params.code === undefined || params.code.length === 0) {
    throw new McpConsentFailedError('missing_code')
  }

  const authorizationServer: McpAuthorizationServer = {
    authorizationServerUrl: claimed.authorizationServer,
    metadata,
    ...optional('resource', claimed.resource),
  }
  // Read, never resolve: minting a client id here would register a second one
  // on the third party in the middle of a flow the first one already started.
  const credentials = await readMcpClientRegistration({
    authorizationServer,
    apiUrl: deps.apiUrl,
    store: registrationStore(deps, claimed.workspaceId),
  })
  if (credentials === null) throw new McpConsentFailedError('exchange_failed')

  const provider = new McpConnectProvider(deps, {
    workspaceId: claimed.workspaceId,
    serverId: claimed.serverId,
    authorizationServer,
    credentials,
    codeVerifier: claimed.codeVerifier,
    redirectTo: claimed.redirectTo,
  })
  try {
    await auth(provider, {
      serverUrl: claimed.server.url,
      authorizationCode: params.code,
      fetchFn: guardedFetch(deps.fetchImpl, deps.resolveHost),
    })
  } catch (error) {
    console.error('[mcp-oauth] token exchange failed', {
      server: claimed.server.name,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new McpConsentFailedError('exchange_failed')
  }

  await deps.convex.mutation(fn(`${MODEL}:setMcpServerState`), {
    internalKey: deps.internalKey,
    workspaceId: claimed.workspaceId,
    serverId: claimed.serverId,
    state: 'ready',
    now: deps.now(),
  })

  // Re-validated rather than trusted, so the allowlist is what keeps this
  // callback from being an open redirect for anyone holding a minted state.
  const location = allowedIntegrationRedirect(descriptor.destination, {
    webAppUrl: deps.appUrl,
    workspaceSlug: descriptor.workspaceSlug,
    edgeHost: deps.edgeHost,
  })
  if (location === null) throw new McpConsentFailedError('redirect_not_allowed')
  return { location }
}

interface ClaimedAuthorization {
  serverId: string
  workspaceId: string
  server: { name: string; url: string }
  codeVerifier: string
  authorizationServer: string
  expectedIssuer: string
  resource?: string
  redirectTo: string
}

function registrationStore(deps: McpOAuthDeps, workspaceId: string) {
  return convexMcpRegistrationStore({
    convex: deps.convex,
    internalKey: deps.internalKey,
    workspaceId,
    now: deps.now,
  })
}

/**
 * Duet's storage, plugged into the SDK's client seam.
 *
 * One class serves both legs because both are the same session seen twice: the
 * authorize leg writes the verifier and the callback leg reads it back. Which
 * leg is running is decided by what the caller handed over, not by a flag.
 */
class McpConnectProvider implements OAuthClientProvider {
  authorizeUrl?: string
  private resource?: string

  constructor(
    private readonly deps: McpOAuthDeps,
    private readonly session: {
      workspaceId: string
      serverId: string
      authorizationServer: McpAuthorizationServer
      credentials: McpClientCredentials
      state?: string
      expiresAt?: number
      codeVerifier?: string
      redirectTo: string
    },
  ) {
    this.resource = session.authorizationServer.resource
  }

  get redirectUrl(): string {
    return mcpOAuthRedirectUri(this.deps.apiUrl)
  }

  get clientMetadata(): OAuthClientMetadata {
    return duetMcpClientMetadata(this.deps.apiUrl) as unknown as OAuthClientMetadata
  }

  get clientMetadataUrl(): string | undefined {
    return this.session.credentials.method === 'cimd'
      ? mcpClientMetadataUrl(this.deps.apiUrl)
      : undefined
  }

  state(): string {
    if (this.session.state === undefined) throw new Error('no state for this leg')
    return this.session.state
  }

  clientInformation(): OAuthClientInformation {
    return { client_id: this.session.credentials.clientId }
  }

  /**
   * Deliberately absent: `saveClientInformation`.
   *
   * Its absence is a guard, not an omission — `authInternal` refuses to perform
   * dynamic registration when a provider cannot save the result, so the SDK's
   * `registerClient()` (which parses away the two RFC 7592 fields that make a
   * registration deletable) can never run through this provider. Registration
   * has one owner, and it is `resolveMcpClientRegistration`.
   */

  /**
   * Always `undefined`, so the SDK's refresh branch is unreachable from here.
   * A human pressing Connect is asking for consent, and refresh is a
   * transactional lease elsewhere, not a side effect of a click.
   */
  tokens(): undefined {
    return undefined
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const now = this.deps.now()
    await this.deps.convex.mutation(fn(`${CREDENTIALS}:storeMcpServerCredential`), {
      internalKey: this.deps.internalKey,
      workspaceId: this.session.workspaceId,
      serverId: this.session.serverId,
      kind: 'oauth',
      accessToken: tokens.access_token,
      tokenType: tokens.token_type ?? 'Bearer',
      ...optional('refreshToken', tokens.refresh_token),
      ...optional('scope', tokens.scope),
      // The SDK's token schema carries no absolute expiry, so it exists only if
      // it is computed here.
      ...optional(
        'accessExpiresAt',
        tokens.expires_in === undefined ? undefined : now + tokens.expires_in * 1_000,
      ),
      // RFC 8707: recorded because slice 10 must send the SAME audience on
      // refresh, and a refresh with a different one is a different grant.
      ...optional('resource', this.resource),
      authorizationServer: this.session.authorizationServer.authorizationServerUrl,
      ...optional(
        'registrationId',
        this.session.credentials.method === 'dcr'
          ? this.session.credentials.registrationId
          : undefined,
      ),
      now,
    })
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.deps.convex.mutation(fn(`${AUTHORIZATIONS}:startMcpOAuthAuthorization`), {
      internalKey: this.deps.internalKey,
      workspaceId: this.session.workspaceId,
      serverId: this.session.serverId,
      // Only the hash: the plaintext rides in `state`, which the authorization
      // server logs and the browser keeps in its history.
      hashedState: await hashApiKey(this.state()),
      codeVerifier,
      authorizationServer: this.session.authorizationServer.authorizationServerUrl,
      expectedIssuer: expectedIssuerOf(this.session.authorizationServer),
      ...optional('resource', this.resource),
      redirectTo: this.session.redirectTo,
      expiresAt: this.session.expiresAt ?? this.deps.now() + CONNECT_STATE_TTL_MS,
      now: this.deps.now(),
    })
  }

  codeVerifier(): string {
    if (this.session.codeVerifier === undefined) throw new Error('no code verifier for this leg')
    return this.session.codeVerifier
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Captured, never followed: the human's browser performs this navigation at
    // the top level, and it must not be an iframe or a server-side fetch.
    this.authorizeUrl = authorizationUrl.toString()
  }

  /**
   * The RFC 8707 audience, sent on **both** requests and identical across them.
   *
   * The SDK's default omits `resource` entirely when a server publishes no
   * protected-resource metadata; the MCP spec asks for it regardless, so the
   * server's own resource identifier is preferred and the canonical one derived
   * from the server URL is the floor.
   */
  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL> {
    const chosen = this.resource ?? resource ?? String(serverUrl)
    this.resource = chosen
    return new URL(chosen)
  }

  /**
   * Discovery, already done and handed over RAW.
   *
   * Two reasons this is not left to the SDK. It would repeat a walk that has
   * just run under the same click; and it parses authorization-server metadata
   * through a strip-mode schema that discards fields its branch does not declare, including
   * the one D23's `iss` table branches on.
   */
  discoveryState(): {
    authorizationServerUrl: string
    authorizationServerMetadata: AuthorizationServerMetadata
    resourceMetadata?: OAuthProtectedResourceMetadata
  } {
    const { authorizationServerUrl, metadata, resource } = this.session.authorizationServer
    return {
      authorizationServerUrl,
      authorizationServerMetadata: metadata as unknown as AuthorizationServerMetadata,
      ...optional(
        'resourceMetadata',
        resource === undefined
          ? undefined
          : ({
              resource,
              authorization_servers: [authorizationServerUrl],
            } as unknown as OAuthProtectedResourceMetadata),
      ),
    }
  }

  /**
   * The SDK's recovery from `invalid_client` is to forget the client and retry
   * inside the failing call — a fresh registration per rejection against a
   * flapping authorization server, and a second POST of an authorization code
   * that has already been spent. Duet records the rejection and stops; the next
   * connect, one human click later, registers deliberately.
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all' || scope === 'client') {
      await noteMcpClientRejection({
        store: registrationStore(this.deps, this.session.workspaceId),
        credentials: this.session.credentials,
        error: { error: 'invalid_client' },
      })
    }
    throw new McpConsentFailedError('exchange_failed')
  }
}

/**
 * What the callback will compare `iss` against.
 *
 * RFC 8414 makes `issuer` mandatory in the metadata document, and it — not the
 * URL the document was fetched from — is what an authorization server echoes.
 * A server that omits it leaves only one candidate worth recording.
 */
function expectedIssuerOf(authorizationServer: McpAuthorizationServer): string {
  const issuer = authorizationServer.metadata.issuer
  return typeof issuer === 'string' && issuer.length > 0
    ? issuer
    : authorizationServer.authorizationServerUrl
}

function optional<K extends string, T>(key: K, value: T | undefined): Record<K, T> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>)
}
