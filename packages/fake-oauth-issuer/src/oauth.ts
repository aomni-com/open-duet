import { decodeGrant, DEVICE_GRANT_TYPE, encodeGrant, type GrantPayload } from './grants'
import { sha256Base64Url, signValue, verifyValue } from './signing'

/**
 * The MCP OAuth half of the fake issuer: RFC 9728 protected-resource metadata,
 * authorization server metadata, RFC 7591 registration and its RFC 7592
 * lifecycle, an authorization endpoint with a clickable consent page, and
 * RFC 7009 revocation.
 *
 * Everything here is stateless. Registrations, authorization codes and tokens
 * are all signed self-contained values, which is also the one thing this
 * fixture cannot fake: it can accept a revocation or a registration delete, but
 * it can never forget.
 */
export const MCP_SCOPES = ['mcp:tools'] as const
const AUTHORIZATION_CODE_EXPIRES_IN_SECONDS = 300

const CLIENT_PREFIX = 'fake-oauth-client-'
const REGISTRATION_PREFIX = 'fake-oauth-registration-'
const CONSENT_APPROVE = 'approve'

export interface IssuerConfig {
  plan: 'eligible' | 'ineligible'
  quotaAfterMs?: number
  now: () => number
  tokenExpiresInSeconds: number
  /**
   * Supplying this seam turns on Client ID Metadata Documents (SEP-991), which
   * every OAuth-capable server probed in slice 00 supports. The document is
   * read through the seam rather than off the network, the same way time is
   * read through `now`: a serverless instance must not depend on reaching a
   * client's host, and a test must be able to hand over the document directly.
   */
  clientMetadataFetch?: (url: string) => Promise<Response>
}

interface ClientPayload {
  registrationId: string
  issuedAt: number
  redirectUris: string[]
  clientName?: string
  scope?: string
}

/** What the authorization endpoint needs, however the client proved itself. */
interface AuthorizationClient {
  redirectUris: string[]
  clientName?: string
}

export function protectedResourceMetadata(baseUrl: string): Response {
  return Response.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
  })
}

/**
 * Served in two shapes at two paths. Only the OIDC one is ever reached through
 * `apps/api`'s path mount — `buildDiscoveryUrls` puts the other candidates at
 * the API's own root, where a fixture must never answer — and it is parsed with
 * `OpenIdProviderDiscoveryMetadataSchema`, which is why `jwks_uri`,
 * `subject_types_supported` and `id_token_signing_alg_values_supported` exist
 * here at all. Nothing in this fixture issues an id token.
 */
export function authorizationServerMetadata(baseUrl: string, config: IssuerConfig): Response {
  return Response.json({
    ...(config.clientMetadataFetch === undefined
      ? {}
      : { client_id_metadata_document_supported: true }),
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    revocation_endpoint: `${baseUrl}/revoke`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    scopes_supported: [...MCP_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', DEVICE_GRANT_TYPE],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    // No tested real server advertises this. The fixture does precisely so the
    // client's RFC 9207 check has a positive case to run against.
    authorization_response_iss_parameter_supported: true,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  })
}

export function jwks(): Response {
  return Response.json({ keys: [] })
}

export async function registerClient(
  baseUrl: string,
  body: Record<string, unknown>,
  now: number,
): Promise<Response> {
  const redirectUris = body.redirect_uris
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every(uri => typeof uri === 'string' && isAbsoluteUri(uri))
  ) {
    return registrationError(
      'invalid_redirect_uri',
      'Every redirect URI must be an exact absolute URI',
    )
  }
  if (
    (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') ||
    'client_secret' in body
  ) {
    return registrationError(
      'invalid_client_metadata',
      'Only public clients with token_endpoint_auth_method none are supported',
    )
  }

  const client: ClientPayload = {
    registrationId: crypto.randomUUID(),
    issuedAt: Math.floor(now / 1_000),
    redirectUris: redirectUris as string[],
    ...(typeof body.client_name === 'string' ? { clientName: body.client_name } : {}),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  }
  const clientId = await signValue(CLIENT_PREFIX, client)
  return Response.json(
    {
      ...body,
      client_id: clientId,
      client_id_issued_at: client.issuedAt,
      token_endpoint_auth_method: 'none',
      // Real servers may omit both. The fixture always sends them so the
      // client's RFC 7592 cleanup has something to exercise.
      registration_client_uri: `${baseUrl}/register/${clientId}`,
      registration_access_token: await signValue(REGISTRATION_PREFIX, {
        registrationId: client.registrationId,
      }),
    },
    { status: 201 },
  )
}

/**
 * RFC 7592 delete. A stateless issuer cannot forget a registration, so a 204
 * here proves only that the client sent a well-formed, correctly authenticated
 * request — never that the registration is gone.
 */
export async function deleteRegistration(clientId: string, request: Request): Promise<Response> {
  const client = await decodeClient(clientId)
  const token = await verifyValue(REGISTRATION_PREFIX, bearerToken(request.headers))
  const registrationId =
    token !== null && typeof token === 'object' && 'registrationId' in token
      ? (token as { registrationId: unknown }).registrationId
      : undefined
  if (!client || registrationId !== client.registrationId) {
    return new Response(null, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
    })
  }
  return new Response(null, { status: 204 })
}

export async function authorize(
  baseUrl: string,
  url: URL,
  config: IssuerConfig,
): Promise<Response> {
  const params = url.searchParams
  const client = await resolveClient(params.get('client_id') ?? '', config)
  const redirectUri = params.get('redirect_uri') ?? ''
  if (!client) return authorizationFault('invalid_client', 'Unknown or unsigned client_id')
  if (!client.redirectUris.includes(redirectUri)) {
    return authorizationFault('invalid_request', 'redirect_uri is not registered for this client')
  }

  const state = params.get('state') ?? undefined
  if (params.get('response_type') !== 'code') {
    return authorizationRedirect(baseUrl, redirectUri, state, {
      error: 'unsupported_response_type',
    })
  }
  const codeChallenge = params.get('code_challenge') ?? ''
  // S256 only, deliberately: two of the four real servers probed also accept
  // `plain`, and a fixture that accepted it would let a client negotiate down
  // without any test noticing.
  if (codeChallenge === '' || params.get('code_challenge_method') !== 'S256') {
    return authorizationRedirect(baseUrl, redirectUri, state, {
      error: 'invalid_request',
      error_description: 'code_challenge with code_challenge_method=S256 is required',
    })
  }

  const decision = params.get('decision')
  if (decision === null) return consentPage(baseUrl, url, client)
  if (decision !== CONSENT_APPROVE) {
    return authorizationRedirect(baseUrl, redirectUri, state, { error: 'access_denied' })
  }

  const code = await encodeGrant({
    kind: 'code',
    flowId: crypto.randomUUID(),
    createdAt: config.now(),
    clientId: params.get('client_id') ?? '',
    plan: config.plan,
    ...(config.quotaAfterMs === undefined ? {} : { quotaAfterMs: config.quotaAfterMs }),
    oauth: {
      redirectUri,
      codeChallenge,
      ...(params.get('scope') === null ? {} : { scope: params.get('scope') as string }),
      ...(params.get('resource') === null ? {} : { resource: params.get('resource') as string }),
    },
  })
  return authorizationRedirect(baseUrl, redirectUri, state, { code })
}

export async function exchangeAuthorizationCode(
  body: Record<string, unknown>,
  config: IssuerConfig,
): Promise<Response> {
  const code = await decodeGrant(stringField(body, 'code'), 'code')
  if (!code?.oauth) return tokenError('invalid_grant', 'Unknown or unsigned authorization code')
  if (code.createdAt + AUTHORIZATION_CODE_EXPIRES_IN_SECONDS * 1_000 <= config.now()) {
    return tokenError('invalid_grant', 'Authorization code expired')
  }
  if (stringField(body, 'redirect_uri') !== code.oauth.redirectUri) {
    return tokenError('invalid_grant', 'redirect_uri does not match the authorization request')
  }
  const clientId = stringField(body, 'client_id')
  if (clientId !== undefined && clientId !== code.clientId) {
    return tokenError('invalid_grant', 'client_id does not match the authorization request')
  }
  const verifier = stringField(body, 'code_verifier')
  if (verifier === undefined || (await sha256Base64Url(verifier)) !== code.oauth.codeChallenge) {
    return tokenError('invalid_grant', 'PKCE verification failed')
  }

  const issuedAt = config.now()
  return oauthTokenResponse(
    {
      ...code,
      kind: 'access',
      createdAt: issuedAt,
      oauth: { ...code.oauth, codeChallenge: undefined },
    },
    { rotateRefresh: true, refreshes: 0 },
    config,
  )
}

export async function oauthTokenResponse(
  grant: GrantPayload,
  refresh: { rotateRefresh: boolean; refreshes: number },
  config: IssuerConfig,
): Promise<Response> {
  const body: Record<string, unknown> = {
    access_token: await encodeGrant({
      ...grant,
      kind: 'access',
      refreshes: undefined,
      nonce: crypto.randomUUID(),
    }),
    token_type: 'Bearer',
    expires_in: config.tokenExpiresInSeconds,
    ...(grant.oauth?.scope === undefined ? {} : { scope: grant.oauth.scope }),
  }
  if (refresh.rotateRefresh) {
    body.refresh_token = await encodeGrant({
      ...grant,
      kind: 'refresh',
      refreshes: refresh.refreshes,
      nonce: crypto.randomUUID(),
    })
  }
  return Response.json(body, { headers: { 'cache-control': 'no-store' } })
}

/**
 * RFC 7009 §2.2: an unknown token is still a 200. Nothing is forgotten here —
 * see `deleteRegistration`.
 */
export function revoke(): Response {
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } })
}

function tokenError(error: string, description?: string): Response {
  return Response.json(
    { error, ...(description === undefined ? {} : { error_description: description }) },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  )
}

function registrationError(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status: 400 })
}

function authorizationFault(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status: 400 })
}

function authorizationRedirect(
  baseUrl: string,
  redirectUri: string,
  state: string | undefined,
  params: Record<string, string | undefined>,
): Response {
  const target = new URL(redirectUri)
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) target.searchParams.set(name, value)
  }
  if (state !== undefined) target.searchParams.set('state', state)
  // RFC 9207. No real server probed emits this; the fixture always does.
  target.searchParams.set('iss', baseUrl)
  return new Response(null, { status: 302, headers: { location: target.toString() } })
}

function consentPage(baseUrl: string, url: URL, client: AuthorizationClient): Response {
  const hidden = [...url.searchParams.entries()]
    .filter(([name]) => name !== 'decision')
    .map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`)
    .join('\n      ')
  const scope = url.searchParams.get('scope') ?? MCP_SCOPES.join(' ')
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Fake issuer — authorize</title>
  </head>
  <body>
    <h1>Authorize ${escape(client.clientName ?? 'this client')}</h1>
    <p id="fake-issuer-scope">Requested scope: ${escape(scope)}</p>
    <p id="fake-issuer-resource">Resource: ${escape(url.searchParams.get('resource') ?? 'none')}</p>
    <form method="get" action="${escape(`${baseUrl}/authorize`)}">
      ${hidden}
      <button type="submit" name="decision" value="${CONSENT_APPROVE}" id="fake-issuer-approve" data-testid="fake-issuer-approve">Approve</button>
      <button type="submit" name="decision" value="deny" id="fake-issuer-deny" data-testid="fake-issuer-deny">Deny</button>
    </form>
  </body>
</html>
`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

/**
 * A client proves itself one of two ways: a registration this issuer signed, or
 * — when Client ID Metadata Documents are enabled — an https URL whose document
 * lists the redirect it is asking for. The second needs nothing stored, which is
 * why real servers prefer it and why DCR is the cold path.
 */
async function resolveClient(
  clientId: string,
  config: IssuerConfig,
): Promise<AuthorizationClient | undefined> {
  const registered = await decodeClient(clientId)
  if (registered) return registered
  if (config.clientMetadataFetch === undefined || !isClientIdMetadataUrl(clientId)) return undefined

  let document: unknown
  try {
    const response = await config.clientMetadataFetch(clientId)
    if (!response.ok) return undefined
    document = await response.json()
  } catch {
    return undefined
  }
  if (!isRecord(document)) return undefined
  // SEP-991: the document identifies itself by the URL it was fetched from.
  if (document.client_id !== undefined && document.client_id !== clientId) return undefined
  const redirectUris = document.redirect_uris
  if (!Array.isArray(redirectUris) || !redirectUris.every(uri => typeof uri === 'string')) {
    return undefined
  }
  return {
    redirectUris: redirectUris as string[],
    ...(typeof document.client_name === 'string' ? { clientName: document.client_name } : {}),
  }
}

function isClientIdMetadataUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.pathname !== '/'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function decodeClient(clientId: string): Promise<ClientPayload | undefined> {
  const payload = await verifyValue(CLIENT_PREFIX, clientId)
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const client = payload as Record<string, unknown>
  if (typeof client.registrationId !== 'string') return undefined
  if (!Array.isArray(client.redirectUris)) return undefined
  if (!client.redirectUris.every(uri => typeof uri === 'string')) return undefined
  return client as unknown as ClientPayload
}

function isAbsoluteUri(value: string): boolean {
  try {
    return new URL(value).protocol !== ''
  } catch {
    return false
  }
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function bearerToken(headers: Headers): string | undefined {
  return headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
}

function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name]
  return typeof value === 'string' ? value : undefined
}
